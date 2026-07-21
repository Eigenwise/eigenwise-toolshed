"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stableClaudeName, stableDispatchName } = require("./exec-names.js");
const crypto = require("crypto");
const store = require("./store.js");
const { spawnDescription } = store;
const TEMPLATE_PATH = path.join(__dirname, "..", "scripts", "_exec-template.md");
const LEGACY_MARKER = "<!-- generated-by: sidequest-agentsync -->";
const MARKER = "<!-- generated-by: sidequest-agentsync gen2 -->";
const TEMP_MARKER = "<!-- generated-by: sidequest-native-agent -->";
const TEMP_PREFIX = "sidequest-native-";
const TICKET_PREFIX = "sidequest-ticket-";
const RELOAD_NOTICE = "Reload plugins before spawning newly created temporary native agents.";
const RESTART_NOTICE = RELOAD_NOTICE;
const ARTIFACT_LIFECYCLE_MARKER = "[sidequest-artifact-mode]";
const NON_MAX_EFFORTS = ["low", "medium", "high", "xhigh"];
const EXEC_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EXEC_MAX_TURNS = { low: 50, medium: 100, high: 150, xhigh: 200, max: 250 };
function execMaxTurns(effort) {
  const raw = process.env.SIDEQUEST_EXEC_MAX_TURNS;
  if (raw != null && String(raw).trim() !== "") {
    const n = Number(String(raw).trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  return EXEC_MAX_TURNS[effort] || EXEC_MAX_TURNS.medium;
}
function defaultAgentsDir() {
  const explicit = process.env.SIDEQUEST_AGENTS_DIR;
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim());
  const home = process.env.SIDEQUEST_HOME;
  if (home && String(home).trim()) return path.join(path.resolve(String(home).trim()), "agents");
  return path.join(os.homedir(), ".claude", "agents");
}
const DISPATCH_MODEL_ID = "claude-codex-auto";
const ROUTE_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ROUTE_MARKER_RE = /^\[sidequest-route model=[a-z0-9][a-z0-9.-]{0,63} effort=(low|medium|high|xhigh|max)\]$/;
function routeMarker(dispatchModel, effort) {
  const model = String(dispatchModel || "");
  const markerEffort = String(effort || "");
  if (!ROUTE_MODEL_RE.test(model)) throw new Error(`dispatch model id is not marker-safe: ${dispatchModel}`);
  if (!EXEC_EFFORTS.includes(markerEffort)) throw new Error(`dispatch effort is not marker-safe: ${effort}`);
  const marker = `[sidequest-route model=${model} effort=${markerEffort}]`;
  if (!ROUTE_MARKER_RE.test(marker)) throw new Error("dispatch route marker does not match the gateway grammar.");
  return marker;
}
function workflowRecipe(category, resolved) {
  const exec = resolved && resolved.exec;
  if (!category || !exec) throw new Error("A resolved category route is required.");
  const recipe = {
    project: category.project,
    category: category.id,
    categoryName: category.name,
    backend: exec.backend,
    route: { model: resolved.model, effort: resolved.effort },
    runsLabel: exec.runsLabel,
    agent: null,
    effortCarrier: null,
    warnings: Array.isArray(resolved.warnings) ? resolved.warnings.slice() : []
  };
  if (exec.backend === "codex") {
    recipe.agent = {
      model: DISPATCH_MODEL_ID,
      promptPrefix: `${routeMarker(exec.dispatchModel, resolved.effort)}

`
    };
    recipe.effortCarrier = "marker";
  } else {
    recipe.agent = { model: exec.model, promptPrefix: "" };
    recipe.effortCarrier = "none";
  }
  return recipe;
}
function renderExecAgent({ name, effort, modelId, marker, extraNote, ticketBrief: ticketBrief2 }) {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  return template.split("{{NAME}}").join(String(name)).split("{{EFFORT}}").join(String(effort)).split("{{MODEL_FRONTMATTER}}").join(modelId ? `
model: ${modelId}` : "").split("{{MAX_TURNS}}").join(String(execMaxTurns(String(effort)))).split("{{MARKER}}").join(marker || "").split("{{EXTRA_NOTE}}").join(extraNote || "").split("{{TICKET_BRIEF}}").join(ticketBrief2 || "");
}
function dispatchNote(effort) {
  return `

_This agent is the shared Sidequest executor for every Codex-backed route at \`${effort}\` effort. Its \`model: ${DISPATCH_MODEL_ID}\` pin is virtual: the codex-gateway shim resolves the real Codex model from the \`[sidequest-route model=... effort=...]\` line in your spawn prompt, whose effort mirrors this def frontmatter for gateway-side audit, so NEVER write, quote, or echo such a line anywhere else. If the gateway reports a missing route marker, stop and report it — the orchestrator must redispatch. Refuse a batch whose tickets are stamped with different models: one spawn carries exactly one route marker. The \`effort\` frontmatter above is forwarded to the model's reasoning effort._`;
}
function renderDispatchAgent(effort) {
  return renderExecAgent({
    name: stableDispatchName(effort),
    effort,
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: dispatchNote(effort)
  });
}
function refToken(ref) {
  return String(ref || "ticket").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}
function runtimeToken(runtime) {
  return String(runtime || "").toLowerCase().replace(/^codex-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function nativeAgentName(ref, runtime, nonce) {
  const ticket = refToken(ref);
  const token = runtimeToken(runtime);
  const base = token ? `${TEMP_PREFIX}${ticket}-${token}` : `${TEMP_PREFIX}${ticket}`;
  if (nonce == null || nonce === "") return base;
  const suffix = String(nonce).toLowerCase();
  if (!/^[a-z0-9]{6,32}$/.test(suffix)) throw new Error("native agent nonce must be 6-32 lowercase alphanumeric characters.");
  return `${base}-${suffix}`;
}
function temporaryAgentFile(name, dir) {
  if (!String(name || "").startsWith(TEMP_PREFIX)) {
    throw new Error("temporary agent name must use a Sidequest temporary prefix.");
  }
  return path.join(dir || defaultAgentsDir(), `${name}.md`);
}
function nativeAgentSource(spec) {
  const tools = Array.isArray(spec.tools) && spec.tools.length ? spec.tools : ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "SendMessage"];
  if (!tools.every((tool) => /^[A-Za-z][A-Za-z0-9:_-]*$/.test(String(tool)))) throw new Error("native agent tools must be valid tool names.");
  const model = String(spec.modelId || "").trim();
  const effort = String(spec.effort || "").trim();
  const runtime = String(spec.runtime || spec.runsModel || "").trim();
  if (!model || /[\r\n]/.test(model)) throw new Error("native agent model id is required and must be one line.");
  if (!NON_MAX_EFFORTS.includes(effort)) throw new Error(`native agent effort must be one of: ${NON_MAX_EFFORTS.join(", ")}.`);
  if (!runtime || /[\r\n]/.test(runtime)) throw new Error("native agent runtime must be a concrete one-line model identifier.");
  const session = String(spec.sessionId || "").replace(/[\r\n]/g, "");
  return [
    "---",
    `name: ${spec.name}`,
    "description: Temporary Sidequest native executor. Removed after this run.",
    `model: ${model}`,
    `effort: ${effort}`,
    `tools: ${tools.join(", ")}`,
    "permissionMode: bypassPermissions",
    "---",
    TEMP_MARKER,
    `<!-- sidequest-native-session: ${session} -->`,
    `<!-- sidequest-native-runtime: ${runtime} -->`,
    "You are a temporary Sidequest executor. Follow the exact task prompt from your parent. Stay within its ticket scope, verify the requested behavior, and report concise evidence. The parent owns orchestration. Before ending after success or failure, run the cleanup command supplied in your task prompt.",
    ""
  ].join("\n");
}
function waitForNativeAgentReload(waitMs) {
  const ms = Number.isFinite(Number(waitMs)) ? Math.max(0, Number(waitMs)) : 175;
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const COMMENT_DIGEST_MAX_CHARS = 2400;
const COMMENT_DIGEST_MAX_COMMENTS = 4;
const COMMENT_DIGEST_BODY_MAX_CHARS = 500;
function clippedText(value, max, suffix) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max - suffix.length)}${suffix}`;
}
function ticketCommentsDigest(comments) {
  if (!Array.isArray(comments) || !comments.length) return "(No ticket comments were recorded.)";
  const selected = comments.slice(-COMMENT_DIGEST_MAX_COMMENTS).reverse();
  const entries = selected.map((comment) => {
    const by = clippedText(comment && comment.by ? comment.by : "unknown", 80, "…");
    const body = clippedText(comment && comment.body ? comment.body : String(comment || ""), COMMENT_DIGEST_BODY_MAX_CHARS, "… [read the full thread]");
    return `- Comment by ${by}: ${body}`;
  });
  if (comments.length > selected.length) entries.push(`- ${comments.length - selected.length} earlier comment(s) omitted; read the full thread.`);
  return clippedText(entries.join("\n"), COMMENT_DIGEST_MAX_CHARS, "\n[Digest truncated; read the full thread.]");
}
function ticketBrief(ticket, nonce, marker) {
  const category = ticket.category || {};
  const parts = [
    "",
    "## This ticket",
    `Ref: ${ticket.ref}`,
    `Title: ${ticket.title || "(Untitled ticket)"}`,
    `Description:
${ticket.description || "(No additional description was recorded.)"}`,
    `Anchors:
${ticket.executorAnchors || "(No anchors were recorded.)"}`,
    `Verify command:
${ticket.executorVerify || "(No exact verify command was recorded.)"}`,
    `Comments digest (bounded handoff context; read the full thread before acting on unresolved risks or questions):
${ticketCommentsDigest(ticket.comments)}`,
    `Category executor instructions:
${category.contract || "(No category-specific executor instructions were recorded.)"}`,
    "Dispatch claim guard:",
    `Claim this ticket with \`--token ${nonce}\`. A token refusal means this dispatch was superseded or you are not its prepared executor. Stop and report that refusal.`
  ];
  if (store.sharedTreeArtifactMode(ticket)) {
    parts.push(
      "Artifact lifecycle exception:",
      `${ARTIFACT_LIFECYCLE_MARKER}
This shared-tree artifact ticket may leave verified changes in its declared scope and close with done. Do not commit or submit it. All project source remains read-only.`
    );
  }
  if (marker) {
    parts.push("Model route (gateway dispatch marker — never write another):", marker);
  }
  return parts.join("\n\n");
}
function renderTicketBriefing(ticket, nonce) {
  if (typeof nonce !== "string" || !nonce.trim() || /[\r\n]/.test(nonce)) {
    throw new Error("dispatch briefing nonce is required and must be a non-empty one-line string.");
  }
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  const marker = resolved && resolved.backend === "codex" && resolved.dispatchModel ? routeMarker(resolved.dispatchModel, ticket.effort) : null;
  return ticketBrief(ticket, nonce.trim(), marker);
}
function ticketIsolation(ticket, sharedTree) {
  const hasDeclaredScope = Array.isArray(ticket && ticket.files) && ticket.files.length > 0;
  if (!hasDeclaredScope) return null;
  return sharedTree === true ? null : "worktree";
}
function withProjectIdentity(prompt, projectPath) {
  const text = String(prompt || "").trim();
  if (!text) throw new Error("Agent spawn prompt is required.");
  const project = String(projectPath || "").trim();
  if (!project) return text;
  return `${text}

Dispatch board identity: --project "${project.replace(/"/g, '\\"')}"`;
}
function quotedShellArgument(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}
function dispatchLauncherPath() {
  return path.join(store.homeRoot(), "sidequest-launcher.js");
}
function dispatchLauncherSource() {
  return `'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function compareVersions(left, right) {
  const parts = (value) => String(value || '').split(/[^0-9]+/).map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function currentSidequestCli() {
  const claudeHome = process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const installs = registry.plugins?.['sidequest@eigenwise-toolshed'] || [];
  const candidates = installs
    .filter((install) => install?.installPath)
    .map((install) => ({ ...install, script: path.join(install.installPath, 'bin', 'sidequest.js') }))
    .filter((install) => fs.existsSync(install.script));
  candidates.sort((left, right) => compareVersions(right.version, left.version)
    || String(right.lastUpdated || '').localeCompare(String(left.lastUpdated || '')));
  return candidates[0]?.script;
}

const script = currentSidequestCli();
if (!script) throw new Error("Sidequest is not installed in Claude Code's plugin registry.");
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
`;
}
function ensureDispatchLauncher() {
  const filePath = dispatchLauncherPath();
  const source = dispatchLauncherSource();
  let current = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch (_) {
  }
  if (current !== source) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 448 });
    fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 384 });
  }
  return filePath;
}
function renderDispatchStub(ticket, nonce, projectPath) {
  const briefing = renderTicketBriefing(ticket, nonce);
  const project = String(projectPath || "").trim();
  if (!project) throw new Error("Dispatch board project path is required.");
  const marker = briefing.match(/^\[sidequest-route [^\n]+\]$/m)?.[0];
  const command = [
    "node",
    quotedShellArgument(ensureDispatchLauncher()),
    "briefing",
    String(ticket.ref),
    "--token",
    String(nonce).trim(),
    "--project",
    quotedShellArgument(project)
  ].join(" ");
  return [
    ...marker ? [marker, ""] : [],
    `Prepared Sidequest executor: ${ticket.dispatchExecutor}.`,
    `Ticket: ${ticket.ref}.`,
    `Dispatch board identity: --project ${quotedShellArgument(project)}.`,
    "",
    `FIRST action: run \`${command}\` and execute exactly what it prints.`
  ].join("\n");
}
function agentSpawn(name, isolation, model, agentType, prompt, description) {
  return Object.assign(
    { subagent_type: agentType || name, name, mode: "bypassPermissions" },
    description ? { description } : {},
    isolation ? { isolation } : {},
    model ? { model } : {},
    prompt ? { prompt } : {}
  );
}
function createNativeAgent(spec, opts) {
  opts = opts || {};
  spec = spec || {};
  if (spec.agentType) {
    const name2 = nativeAgentName(spec.ref, spec.runtime, spec.nonce);
    const model = spec.spawnModel == null ? null : String(spec.spawnModel).trim();
    return {
      name: name2,
      file: null,
      fallback: true,
      spawn: agentSpawn(name2, spec.isolation, model, String(spec.agentType), spec.prompt, spec.description),
      cleanup: { name: name2, sessionId: spec.sessionId || null }
    };
  }
  const dir = opts.dir || defaultAgentsDir();
  fs.mkdirSync(dir, { recursive: true });
  const runtime = spec.runtime != null ? spec.runtime : spec.runsModel;
  const explicitNonce = spec.nonce != null ? spec.nonce : null;
  let name = nativeAgentName(spec.ref, runtime, explicitNonce);
  if (explicitNonce == null && fs.existsSync(temporaryAgentFile(name, dir))) {
    name = nativeAgentName(spec.ref, runtime, crypto.randomBytes(4).toString("hex"));
  }
  let file = temporaryAgentFile(name, dir);
  for (let attempt = 0; ; attempt++) {
    const source = nativeAgentSource(Object.assign({}, spec, { name }));
    try {
      fs.writeFileSync(file, source, { flag: "wx" });
      break;
    } catch (err) {
      if (err && err.code === "EEXIST" && explicitNonce == null && attempt < 25) {
        name = nativeAgentName(spec.ref, runtime, crypto.randomBytes(4).toString("hex"));
        file = temporaryAgentFile(name, dir);
        continue;
      }
      throw err;
    }
  }
  waitForNativeAgentReload(opts.waitMs);
  return {
    name,
    file,
    spawn: agentSpawn(name, spec.isolation, spec.spawnModel, void 0, spec.prompt, spec.description),
    cleanup: { name, sessionId: spec.sessionId || null }
  };
}
function cleanupNativeAgents(opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const name = opts.name ? String(opts.name) : null;
  const sessionId = opts.sessionId == null ? null : String(opts.sessionId);
  let removed = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => (f.startsWith(TEMP_PREFIX) || f.startsWith(TICKET_PREFIX)) && f.endsWith(".md"));
  } catch (_) {
    return { removed };
  }
  for (const fileName of files) {
    if (name && fileName !== `${name}.md`) continue;
    const file = path.join(dir, fileName);
    let source = "";
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (_) {
      continue;
    }
    if (!source.includes(TEMP_MARKER)) continue;
    if (sessionId && !source.includes(`<!-- sidequest-native-session: ${sessionId} -->`)) continue;
    if (opts.staleBefore != null) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (_) {
        continue;
      }
      if (stat.mtimeMs >= Number(opts.staleBefore)) continue;
    }
    try {
      fs.unlinkSync(file);
      removed++;
    } catch (_) {
    }
  }
  return { removed };
}
function hasStableMarker(source) {
  return source.includes(MARKER) || source.includes(LEGACY_MARKER);
}
const INSTALL_HASH_FILE = ".sidequest-install-hash";
function stableInstallHash() {
  let version = "0.0.0";
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8")).version || version;
  } catch (_) {
  }
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const maxTurnsOverride = String(process.env.SIDEQUEST_EXEC_MAX_TURNS || "").trim();
  return crypto.createHash("sha256").update(JSON.stringify({ version, template, marker: MARKER, dispatchModel: DISPATCH_MODEL_ID, maxTurns: EXEC_MAX_TURNS, maxTurnsOverride })).digest("hex");
}
function installHashPath(dir) {
  return path.join(dir || defaultAgentsDir(), INSTALL_HASH_FILE);
}
function readInstallHash(dir) {
  try {
    return fs.readFileSync(installHashPath(dir), "utf8").trim();
  } catch (_) {
    return "";
  }
}
function writeInstallHash(dir, hash) {
  fs.writeFileSync(installHashPath(dir), hash + "\n");
}
function syncExecAgentsIfChanged(_prefs, opts) {
  const dir = opts && opts.dir ? opts.dir : defaultAgentsDir();
  const installHash = stableInstallHash();
  if (readInstallHash(dir) === installHash) {
    return { written: 0, removed: 0, unchanged: 0, skipped: true, installHash };
  }
  const result = syncExecAgents(_prefs, { dir });
  return Object.assign({}, result, { skipped: false, installHash });
}
function syncExecAgents(_prefs, opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const wanted = /* @__PURE__ */ new Map();
  for (const effort of EXEC_EFFORTS) {
    wanted.set(`${stableDispatchName(effort)}.md`, renderDispatchAgent(effort));
    wanted.set(`${stableClaudeName(effort)}.md`, renderExecAgent({
      name: stableClaudeName(effort),
      effort,
      marker: MARKER
    }));
  }
  let existing = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    existing = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch (_) {
    existing = [];
  }
  let written = 0;
  let removed = 0;
  let unchanged = 0;
  for (const [filename, content] of wanted) {
    const filePath = path.join(dir, filename);
    let prev = null;
    try {
      prev = fs.readFileSync(filePath, "utf8");
    } catch (_) {
      prev = null;
    }
    if (prev !== null && !hasStableMarker(prev)) continue;
    if (prev === content) {
      unchanged++;
      continue;
    }
    fs.writeFileSync(filePath, content);
    written++;
  }
  const wantedNames = new Set(wanted.keys());
  for (const filename of existing) {
    if (wantedNames.has(filename)) continue;
    const filePath = path.join(dir, filename);
    let body = null;
    try {
      body = fs.readFileSync(filePath, "utf8");
    } catch (_) {
      continue;
    }
    if (body == null || !hasStableMarker(body)) continue;
    try {
      fs.unlinkSync(filePath);
      removed++;
    } catch (_) {
    }
  }
  writeInstallHash(dir, stableInstallHash());
  return { written, removed, unchanged };
}
module.exports = {
  LEGACY_MARKER,
  MARKER,
  TEMP_MARKER,
  TEMP_PREFIX,
  TICKET_PREFIX,
  RELOAD_NOTICE,
  RESTART_NOTICE,
  ARTIFACT_LIFECYCLE_MARKER,
  NON_MAX_EFFORTS,
  EXEC_MAX_TURNS,
  DISPATCH_MODEL_ID,
  execMaxTurns,
  ticketCommentsDigest,
  COMMENT_DIGEST_MAX_CHARS,
  routeMarker,
  workflowRecipe,
  renderDispatchAgent,
  renderExecAgent,
  renderTicketBriefing,
  createNativeAgent,
  cleanupNativeAgents,
  nativeAgentName,
  nativeAgentSource,
  withProjectIdentity,
  renderDispatchStub,
  ensureDispatchLauncher,
  agentSpawn,
  spawnDescription,
  ticketIsolation,
  syncExecAgents,
  syncExecAgentsIfChanged,
  stableInstallHash,
  defaultAgentsDir
};
