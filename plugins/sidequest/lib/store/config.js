"use strict";
const { normalizeDeniedTools } = require("../denied-tools.js");
const { VERIFICATION_ENVIRONMENTS } = require("../kernel/verification.js");
const DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS = 7 * 24;
const DEFAULT_WORKTREE_RECOVERY_RETENTION_AGE_HOURS = 14 * 24;
function createConfig({ DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS, DELIVERY_MODES, execFileSync, fs, getProjectCategories, integrationTargetRef, isInScope, isTrackedBuildOutput, packageBuildOutputs, packageRootForScope, path, projectRoutingProfile, readMeta, routingProfileEntries, MAX_INTEGRATION_VERIFY_TIMEOUT_MS, WORKTREE_SETUP_MAX_LENGTH, withMetaLock, putProject }) {
  function defaultProjectName(absPath) {
    return path.basename(path.resolve(absPath)) || "project";
  }
  function normalizeAlwaysInScope(paths) {
    if (!Array.isArray(paths)) throw new Error("alwaysInScope must be an array of repo-relative paths.");
    const seen = /* @__PURE__ */ new Set();
    const normalized = [];
    for (const value of paths) {
      const item = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
      const relative = item.replace(/\/+$/, "");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw new Error(`alwaysInScope path must stay inside the board repo: ${value}`);
      }
      const key = process.platform === "win32" ? relative.toLowerCase() : relative;
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push(item);
      }
    }
    return normalized;
  }
  function normalizeReadOnlyDeniedTools(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error("readOnlyDeniedTools must be an array of tool patterns.");
    const seen = /* @__PURE__ */ new Set();
    const normalized = [];
    for (const entry of value) {
      const pattern = String(entry || "").trim();
      if (!pattern) throw new Error("readOnlyDeniedTools entries must be non-empty tool patterns.");
      if (!pattern.startsWith("mcp__")) throw new Error(`readOnlyDeniedTools patterns must target MCP tools: ${entry}`);
      if (!seen.has(pattern)) {
        seen.add(pattern);
        normalized.push(pattern);
      }
    }
    return normalized;
  }
  function normalizeGeneratedPairPath(value, name) {
    const item = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!item || item === ".." || item.startsWith("../") || path.isAbsolute(item) || item.includes("/../")) {
      throw new Error(`generatedPairs ${name} pattern must stay inside the board repo: ${value}`);
    }
    return item;
  }
  function normalizeGeneratedPairs(pairs) {
    if (pairs == null) return [];
    if (!Array.isArray(pairs)) throw new Error("generatedPairs must be an array of { from, to } patterns.");
    const seen = /* @__PURE__ */ new Set();
    const normalized = [];
    for (const pair of pairs) {
      if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
        throw new Error("generatedPairs entries must be { from, to } patterns.");
      }
      const from = normalizeGeneratedPairPath(pair.from, "from");
      const to = normalizeGeneratedPairPath(pair.to, "to");
      if ((from.match(/\*/g) || []).length !== (to.match(/\*/g) || []).length) {
        throw new Error(`generatedPairs patterns must use the same number of * placeholders: ${from} -> ${to}`);
      }
      const key = `${from}\0${to}`;
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push({ from, to });
      }
    }
    return normalized;
  }
  function generatedPathFor(source, pair) {
    const sourcePath = String(source || "").replace(/\\/g, "/");
    if (!sourcePath || sourcePath.includes("*")) return null;
    const parts = String(pair.from).split("*");
    const expression = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+)")}$`);
    const match = sourcePath.match(expression);
    if (!match) return null;
    return String(pair.to).split("*").map((part, index) => `${part}${index < match.length - 1 ? match[index + 1] : ""}`).join("");
  }
  function trackedGeneratedPaths(config, files) {
    if (!config || !config.path || !Array.isArray(config.generatedPairs) || !config.generatedPairs.length || !Array.isArray(files)) return [];
    const candidates = Array.from(new Set(files.flatMap((file) => config.generatedPairs.map((pair) => generatedPathFor(file, pair)).filter(Boolean))));
    return candidates.filter((candidate) => isTrackedBuildOutput(config.path, path.resolve(config.path, candidate)));
  }
  function relativePathWithin(root, target) {
    const relative = path.relative(String(root), String(target));
    if (relative === "") return ".";
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replace(/\\/g, "/") : null;
  }
  function derivedGeneratedPairs(config, files) {
    if (!config || !config.path || !Array.isArray(files)) return [];
    const pairs = /* @__PURE__ */ new Map();
    for (const file of files) {
      const packageRoot = packageRootForScope(config.path, file);
      if (!packageRoot) continue;
      const sourcePath = path.resolve(config.path, String(file));
      const sourceFile = relativePathWithin(config.path, sourcePath);
      if (!sourceFile) continue;
      for (const output of packageBuildOutputs(packageRoot)) {
        const sourceDirectory = String(output.sourceDirectory || "").trim();
        if (!sourceDirectory) continue;
        const sourceRoot = path.resolve(packageRoot, sourceDirectory.startsWith("src/") ? sourceDirectory : path.join("src", sourceDirectory));
        const outputRelative = relativePathWithin(sourceRoot, sourcePath);
        const sourceExtension = String(output.sourceExtension || ".ts");
        const outputExtension = String(output.outputExtension || ".js");
        if (outputRelative == null || outputRelative !== "." && !outputRelative.endsWith(sourceExtension)) continue;
        const compiledRelative = outputRelative === "." ? "." : `${outputRelative.slice(0, -sourceExtension.length)}${outputExtension}`;
        const outputPath = path.resolve(packageRoot, output.directory, compiledRelative);
        const outputFile = relativePathWithin(config.path, outputPath);
        if (outputFile) pairs.set(`${sourceFile}\0${outputFile}`, { from: sourceFile, to: outputFile });
      }
    }
    return [...pairs.values()];
  }
  function defaultAlwaysInScope(absPath) {
    try {
      return fs.statSync(path.join(absPath, "docs")).isDirectory() ? ["docs/"] : [];
    } catch (_) {
      return [];
    }
  }
  function normalizeDeliveryMode(mode) {
    const value = String(mode || "merge").trim().toLowerCase();
    if (!DELIVERY_MODES.includes(value)) {
      throw new Error('delivery must be "merge", "replay", or "apply".');
    }
    return value;
  }
  function normalizeIntegrationMode(mode) {
    const value = String(mode || "auto").trim().toLowerCase();
    if (!["auto", "local", "remote"].includes(value)) {
      throw new Error('integrationMode must be "auto", "local", or "remote".');
    }
    return value;
  }
  function normalizeIntegrationBranch(value) {
    const branch = String(value == null ? "main" : value).trim();
    if (!branch || branch === "@" || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.includes("//") || branch.includes("/.") || branch.endsWith(".lock") || branch.includes("..") || branch.includes("@{") || /[\s~^:?*\[\\]/.test(branch)) {
      throw new Error("integrationBranch must be a valid Git branch name.");
    }
    return branch;
  }
  function normalizeWorktreeIsolation(value) {
    if (value == null) return true;
    if (typeof value !== "boolean") throw new Error("worktreeIsolation must be a boolean.");
    return value;
  }
  function normalizeVerifyEnvironment(value) {
    const environment = String(value == null ? "isolated" : value).trim().toLowerCase();
    if (!VERIFICATION_ENVIRONMENTS.includes(environment)) {
      throw new Error('verifyEnvironment must be "isolated" or "shared".');
    }
    return environment;
  }
  function normalizeWorktreeBase(value) {
    const base = String(value == null ? "auto" : value).trim().toLowerCase();
    if (!["auto", "origin-main", "local-main"].includes(base)) {
      throw new Error('worktreeBase must be "auto", "origin-main", or "local-main".');
    }
    return base;
  }
  function normalizeNotIntegratedSalvageAgeHours(value) {
    if (value == null || value === "") return DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS;
    const hours = Number(value);
    if (!Number.isInteger(hours) || hours < DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS) {
      throw new Error(`notIntegratedSalvageAgeHours must be a whole number of at least ${DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS} hours.`);
    }
    return hours;
  }
  function normalizeWorktreeRecoveryRetentionAgeHours(value) {
    if (value == null || value === "") return DEFAULT_WORKTREE_RECOVERY_RETENTION_AGE_HOURS;
    const hours = Number(value);
    if (!Number.isInteger(hours) || hours < 1) {
      throw new Error("worktreeRecoveryRetentionAgeHours must be a whole number of at least 1 hour.");
    }
    return hours;
  }
  function normalizeAutoApproveTestScope(value) {
    if (value == null) return true;
    if (typeof value !== "boolean") throw new Error("autoApproveTestScope must be a boolean.");
    return value;
  }
  function normalizeAutoApproveScope(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error("autoApproveScope must be an array of repo-relative glob patterns.");
    const seen = /* @__PURE__ */ new Set();
    const normalized = [];
    for (const entry of value) {
      const pattern = String(entry || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (!pattern || pattern === ".." || pattern.startsWith("../") || pattern.includes("/../") || path.isAbsolute(pattern)) {
        throw new Error(`autoApproveScope pattern must stay inside the board repo: ${entry}`);
      }
      const key = process.platform === "win32" ? pattern.toLowerCase() : pattern;
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push(pattern);
      }
    }
    return normalized;
  }
  function normalizeWorktreeSetup(value) {
    if (value == null || String(value).trim() === "") return null;
    const setup = String(value);
    if (/[\r\n]/.test(setup)) throw new Error("worktreeSetup must be a one-line command.");
    if (setup.length > WORKTREE_SETUP_MAX_LENGTH) {
      throw new Error(`worktreeSetup exceeds the ${WORKTREE_SETUP_MAX_LENGTH}-character board-config limit.`);
    }
    return setup;
  }
  function normalizeWorktreeDependencyPaths(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error("worktreeDependencyPaths must be an array of { path, mode } entries.");
    const normalized = value.map(normalizeWorktreeDependencyPath);
    const keys = /* @__PURE__ */ new Set();
    for (const dependency of normalized) {
      const key = platformPathKey(dependency.path);
      if (keys.has(key)) throw new Error(`worktreeDependencyPaths cannot configure the same path twice: ${dependency.path}`);
      keys.add(key);
    }
    return normalized;
  }
  function platformPathKey(value) {
    return process.platform === "win32" ? value.toLowerCase() : value;
  }
  function normalizeWorktreeDependencyPath(value) {
    const entry = worktreeDependencyEntry(value);
    const mode = worktreeDependencyMode(entry.mode);
    const dependencyPath = path.posix.normalize(String(entry.path ?? "").trim().replace(/\\/g, "/")).replace(/\/+$/, "");
    const refusal = worktreeDependencyPathRefusal(dependencyPath, mode);
    if (refusal) throw new Error(`worktreeDependencyPaths ${refusal}: ${entry.path}`);
    return { path: dependencyPath, mode };
  }
  function worktreeDependencyEntry(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
    throw new Error("worktreeDependencyPaths entries must be { path, mode }.");
  }
  function worktreeDependencyMode(value) {
    const mode = String(value ?? "").trim().toLowerCase();
    if (mode === "link" || mode === "copy") return mode;
    throw new Error(`worktreeDependencyPaths mode must be "link" or "copy": ${value}`);
  }
  function worktreeDependencyPathRefusal(dependencyPath, mode) {
    if (path.isAbsolute(dependencyPath)) return 'path must be relative to the board repo, because each worktree places it at the same relative spot; for a sibling checkout use "../<name>" with mode link';
    if (dependencyPath === "." || dependencyPath === "") return "path must name a file or directory inside the board repo";
    return outsideRepoDependencyRefusal(dependencyPath.split("/"), mode);
  }
  function outsideRepoDependencyRefusal(segments, mode) {
    if (segments[0] !== "..") return null;
    if (mode === "copy") return "copy mode must stay inside the board repo, because a copy outside it would be shared by every worktree and never cleaned up; use mode link for a sibling checkout";
    const leavesByOneLevel = segments.length > 1 && segments[1] !== "..";
    return leavesByOneLevel ? null : 'link path may leave the board repo by one level only ("../<name>"), because the link lands in the worktree root beside the worktree';
  }
  function normalizeIntegrationVerifyTimeoutMs(value) {
    if (value == null || value === "") return DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS;
    const timeoutMs = Number(value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_INTEGRATION_VERIFY_TIMEOUT_MS) {
      throw new Error(`integrationVerifyTimeoutMs must be an integer from 1 to ${MAX_INTEGRATION_VERIFY_TIMEOUT_MS}.`);
    }
    return timeoutMs;
  }
  function hasOriginRemote(absPath) {
    try {
      execFileSync("git", ["remote", "get-url", "origin"], { cwd: absPath, encoding: "utf8", windowsHide: true, stdio: "pipe" });
      return true;
    } catch (_) {
      return false;
    }
  }
  function integrationBranchExists(absPath, ref) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: absPath,
        encoding: "utf8",
        windowsHide: true,
        stdio: "pipe"
      });
      return true;
    } catch (_) {
      return false;
    }
  }
  function integrationTarget(slug, override) {
    const meta = readMeta(slug);
    if (!meta) return null;
    const requested = override && typeof override === "object" ? override : {};
    const configured = normalizeIntegrationMode(requested.mode ?? meta.integrationMode);
    const mode = configured === "auto" ? hasOriginRemote(meta.path) ? "remote" : "local" : configured;
    const branch = normalizeIntegrationBranch(requested.branch ?? (typeof override === "string" ? override : meta.integrationBranch));
    const upstream = mode === "local" ? branch : `origin/${branch}`;
    const target = { mode, upstream, branch };
    const ref = integrationTargetRef(target);
    if (!integrationBranchExists(meta.path, ref)) {
      throw new Error(`Configured integration ref "${ref}" for branch "${branch}" does not exist. Create or fetch it, or set integrationBranch with board-config --integration-branch <branch>.`);
    }
    return target;
  }
  function integrationTargetCommit(absPath, target) {
    return execFileSync("git", ["rev-parse", "--verify", `${integrationTargetRef(target) || target.upstream}^{commit}`], {
      cwd: absPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe"
    }).trim();
  }
  function normalizeBoardName(value) {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name) throw new Error("Board name cannot be empty.");
    return name;
  }
  function boardConfig(slug) {
    const meta = readMeta(slug);
    if (!meta) return null;
    const selected = projectRoutingProfile(slug);
    if (!selected) throw new Error(`Project "${slug}" does not have a routing profile.`);
    const layer = getProjectCategories(slug);
    const byKind = Object.fromEntries(["ADD", "OVERRIDE", "DETACH", "DISABLE"].map((kind) => [kind, layer.rows.filter((row) => row.kind === kind).length]));
    return {
      name: meta.name,
      alwaysInScope: Array.isArray(meta.alwaysInScope) ? normalizeAlwaysInScope(meta.alwaysInScope) : defaultAlwaysInScope(meta.path),
      readOnlyDeniedTools: normalizeReadOnlyDeniedTools(meta.readOnlyDeniedTools),
      deniedTools: normalizeDeniedTools(meta.deniedTools),
      generatedPairs: normalizeGeneratedPairs(meta.generatedPairs),
      integrationMode: normalizeIntegrationMode(meta.integrationMode),
      integrationBranch: normalizeIntegrationBranch(meta.integrationBranch),
      delivery: normalizeDeliveryMode(meta.delivery),
      integrationVerifyTimeoutMs: normalizeIntegrationVerifyTimeoutMs(meta.integrationVerifyTimeoutMs),
      worktreeIsolation: normalizeWorktreeIsolation(meta.worktreeIsolation),
      verifyEnvironment: normalizeVerifyEnvironment(meta.verifyEnvironment),
      worktreeBase: normalizeWorktreeBase(meta.worktreeBase),
      notIntegratedSalvageAgeHours: normalizeNotIntegratedSalvageAgeHours(meta.notIntegratedSalvageAgeHours),
      worktreeRecoveryRetentionAgeHours: normalizeWorktreeRecoveryRetentionAgeHours(meta.worktreeRecoveryRetentionAgeHours),
      autoApproveTestScope: normalizeAutoApproveTestScope(meta.autoApproveTestScope == null ? meta.autoApprovePluginTests : meta.autoApproveTestScope),
      autoApproveScope: normalizeAutoApproveScope(meta.autoApproveScope),
      worktreeSetup: normalizeWorktreeSetup(meta.worktreeSetup),
      worktreeDependencyPaths: normalizeWorktreeDependencyPaths(meta.worktreeDependencyPaths),
      profile: {
        id: selected.profile.id,
        name: selected.profile.name,
        revision: selected.profile.revision,
        entryCount: routingProfileEntries(selected.profile.id).length
      },
      overrides: {
        count: layer.rows.length,
        byKind,
        foreignBaseCount: layer.rows.filter((row) => row.baseProfileId && row.baseProfileId !== selected.profile.id).length,
        items: layer.rows
      },
      warnings: [...selected.warnings, ...layer.warnings]
    };
  }
  const BOARD_CONFIG_NORMALIZERS = {
    name: normalizeBoardName,
    alwaysInScope: normalizeAlwaysInScope,
    readOnlyDeniedTools: normalizeReadOnlyDeniedTools,
    deniedTools: normalizeDeniedTools,
    generatedPairs: normalizeGeneratedPairs,
    integrationMode: normalizeIntegrationMode,
    integrationBranch: normalizeIntegrationBranch,
    delivery: normalizeDeliveryMode,
    integrationVerifyTimeoutMs: normalizeIntegrationVerifyTimeoutMs,
    worktreeIsolation: normalizeWorktreeIsolation,
    verifyEnvironment: normalizeVerifyEnvironment,
    worktreeBase: normalizeWorktreeBase,
    notIntegratedSalvageAgeHours: normalizeNotIntegratedSalvageAgeHours,
    worktreeRecoveryRetentionAgeHours: normalizeWorktreeRecoveryRetentionAgeHours,
    autoApproveTestScope: normalizeAutoApproveTestScope,
    autoApproveScope: normalizeAutoApproveScope,
    worktreeSetup: normalizeWorktreeSetup,
    worktreeDependencyPaths: normalizeWorktreeDependencyPaths
  };
  function boardConfigPatchEntries(patch) {
    return patch && typeof patch === "object" ? Object.entries(patch) : [];
  }
  function setBoardConfig(slug, patch) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: "not_found" };
      const entries = boardConfigPatchEntries(patch);
      if (!entries.length) return { ok: true, config: boardConfig(slug) };
      for (const [key, value] of entries) {
        const normalize = BOARD_CONFIG_NORMALIZERS[key];
        if (normalize) meta[key] = normalize(value);
      }
      putProject(slug, meta);
      return { ok: true, config: boardConfig(slug) };
    });
  }
  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }
  function alwaysInScopeBeside(config, files) {
    return arrayOrEmpty(config.alwaysInScope).filter((entry) => !files.some((file) => isInScope(file, [entry])));
  }
  function effectiveScope(slug, filesOrTicket) {
    const ticket = Array.isArray(filesOrTicket) ? null : filesOrTicket;
    const files = arrayOrEmpty(ticket ? ticket.files : filesOrTicket);
    const config = boardConfig(slug) || {};
    const generatedConfig = Object.assign({ path: readMeta(slug)?.path }, config);
    const generatedPairs = [...arrayOrEmpty(config.generatedPairs), ...derivedGeneratedPairs(generatedConfig, files)];
    const paired = trackedGeneratedPaths(Object.assign({}, generatedConfig, { generatedPairs }), files);
    return Array.from(/* @__PURE__ */ new Set([...files, ...arrayOrEmpty(ticket?.scopeResolution?.granted), ...alwaysInScopeBeside(config, files), ...paired]));
  }
  return { defaultProjectName, normalizeAlwaysInScope, normalizeReadOnlyDeniedTools, normalizeGeneratedPairPath, normalizeGeneratedPairs, generatedPathFor, trackedGeneratedPaths, derivedGeneratedPairs, defaultAlwaysInScope, normalizeDeliveryMode, normalizeIntegrationMode, normalizeIntegrationBranch, normalizeWorktreeIsolation, normalizeVerifyEnvironment, normalizeWorktreeBase, normalizeNotIntegratedSalvageAgeHours, normalizeWorktreeRecoveryRetentionAgeHours, normalizeAutoApproveTestScope, normalizeAutoApproveScope, normalizeWorktreeSetup, normalizeWorktreeDependencyPaths, normalizeIntegrationVerifyTimeoutMs, hasOriginRemote, integrationBranchExists, integrationTarget, integrationTargetCommit, normalizeBoardName, boardConfig, setBoardConfig, effectiveScope };
}
module.exports = { createConfig };
