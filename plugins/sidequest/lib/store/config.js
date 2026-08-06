"use strict";
function createConfig({ DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS, DELIVERY_MODES, execFileSync, fs, getProjectCategories, isTrackedBuildOutput, packageBuildOutputs, packageRootForScope, path, projectRoutingProfile, readMeta, routingProfileEntries, MAX_INTEGRATION_VERIFY_TIMEOUT_MS, WORKTREE_SETUP_MAX_LENGTH, withMetaLock, putProject }) {
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
  function normalizeAutoApproveTestScope(value) {
    if (value == null) return true;
    if (typeof value !== "boolean") throw new Error("autoApproveTestScope must be a boolean.");
    return value;
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
    const branch = normalizeIntegrationBranch(requested.branch ?? override ?? meta.integrationBranch);
    const upstream = mode === "local" ? branch : `origin/${branch}`;
    const ref = mode === "local" ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`;
    if (!integrationBranchExists(meta.path, ref)) {
      throw new Error(`Configured integration ref "${ref}" for branch "${branch}" does not exist. Create or fetch it, or set integrationBranch with board-config --integration-branch <branch>.`);
    }
    return { mode, upstream, branch };
  }
  function integrationTargetCommit(absPath, target) {
    return execFileSync("git", ["rev-parse", "--verify", `${target.upstream}^{commit}`], {
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
      generatedPairs: normalizeGeneratedPairs(meta.generatedPairs),
      integrationMode: normalizeIntegrationMode(meta.integrationMode),
      integrationBranch: normalizeIntegrationBranch(meta.integrationBranch),
      delivery: normalizeDeliveryMode(meta.delivery),
      integrationVerifyTimeoutMs: normalizeIntegrationVerifyTimeoutMs(meta.integrationVerifyTimeoutMs),
      worktreeIsolation: normalizeWorktreeIsolation(meta.worktreeIsolation),
      autoApproveTestScope: normalizeAutoApproveTestScope(meta.autoApproveTestScope == null ? meta.autoApprovePluginTests : meta.autoApproveTestScope),
      worktreeSetup: normalizeWorktreeSetup(meta.worktreeSetup),
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
  function setBoardConfig(slug, patch) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: "not_found" };
      if (!patch || typeof patch !== "object") return { ok: true, config: boardConfig(slug) };
      if (Object.prototype.hasOwnProperty.call(patch, "name")) {
        meta.name = normalizeBoardName(patch.name);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "alwaysInScope")) {
        meta.alwaysInScope = normalizeAlwaysInScope(patch.alwaysInScope);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "readOnlyDeniedTools")) {
        meta.readOnlyDeniedTools = normalizeReadOnlyDeniedTools(patch.readOnlyDeniedTools);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "generatedPairs")) {
        meta.generatedPairs = normalizeGeneratedPairs(patch.generatedPairs);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "integrationMode")) {
        meta.integrationMode = normalizeIntegrationMode(patch.integrationMode);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "integrationBranch")) {
        meta.integrationBranch = normalizeIntegrationBranch(patch.integrationBranch);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "delivery")) {
        meta.delivery = normalizeDeliveryMode(patch.delivery);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "integrationVerifyTimeoutMs")) {
        meta.integrationVerifyTimeoutMs = normalizeIntegrationVerifyTimeoutMs(patch.integrationVerifyTimeoutMs);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "worktreeIsolation")) {
        meta.worktreeIsolation = normalizeWorktreeIsolation(patch.worktreeIsolation);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "autoApproveTestScope")) {
        meta.autoApproveTestScope = normalizeAutoApproveTestScope(patch.autoApproveTestScope);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "worktreeSetup")) {
        meta.worktreeSetup = normalizeWorktreeSetup(patch.worktreeSetup);
      }
      putProject(slug, meta);
      return { ok: true, config: boardConfig(slug) };
    });
  }
  function effectiveScope(slug, files) {
    const config = boardConfig(slug);
    const generatedConfig = Object.assign({ path: readMeta(slug)?.path }, config);
    const generatedPairs = [...config && config.generatedPairs || [], ...derivedGeneratedPairs(generatedConfig, files)];
    const paired = trackedGeneratedPaths(Object.assign({}, generatedConfig, { generatedPairs }), files);
    return Array.from(/* @__PURE__ */ new Set([...Array.isArray(files) ? files : [], ...config && config.alwaysInScope || [], ...paired]));
  }
  return { defaultProjectName, normalizeAlwaysInScope, normalizeReadOnlyDeniedTools, normalizeGeneratedPairPath, normalizeGeneratedPairs, generatedPathFor, trackedGeneratedPaths, derivedGeneratedPairs, defaultAlwaysInScope, normalizeDeliveryMode, normalizeIntegrationMode, normalizeIntegrationBranch, normalizeWorktreeIsolation, normalizeAutoApproveTestScope, normalizeWorktreeSetup, normalizeIntegrationVerifyTimeoutMs, hasOriginRemote, integrationBranchExists, integrationTarget, integrationTargetCommit, normalizeBoardName, boardConfig, setBoardConfig, effectiveScope };
}
module.exports = { createConfig };
