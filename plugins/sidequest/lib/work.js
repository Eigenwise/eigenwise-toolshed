'use strict';
/**
 * sidequest - headless worker drainer (`sidequest work`)
 *
 * Turns the board from a fan-out tool you drive into a queue that works itself:
 * read the ready set, and spawn one headless `claude -p` run per ready ticket at
 * the ticket's derived model tier. Safe next to any interactive session because
 * claiming stays atomic — a headless run that loses a claim race just no-ops.
 *
 * The planning half is pure and testable (planWork / --dry-run computes exactly
 * what WOULD be spawned without launching anything); runWork() adds the actual
 * child_process spawns on top. Node stdlib only.
 *
 * Effort note: reasoning effort is only settable via agent-definition frontmatter,
 * which a headless `-p` run has no equivalent flag for — so a headless run carries
 * the ticket's MODEL tier (via --model) but runs at that model's default effort.
 * The claim still records the derived effort for provenance. This is why headless
 * draining is the "unattended overflow" path, not a replacement for interactive
 * fan-out through the effort-pinned sidequest-exec-* agents.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WIN = process.platform === 'win32';
const store = require('./store');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'sidequest.js');
const DEFAULT_MAX = 3;      // headless runs per wave
const DEFAULT_MAX_WAVES = 5; // safety cap on how many waves one drain will chew through

// Cap a ticket's derived tier to the tiers that actually exist to spawn. `fable`
// isn't a spawnable CLI model alias, so treat opus as the ceiling for headless.
// A ticket stamps a built-in TIER. `--model fable` isn't a real `claude -p`
// alias, so a fable-derived ticket runs headless as opus; the other three tiers
// pass through. This only applies to CLAUDE-backed tiers — a tier pointed at a
// Codex model resolves to that model's id instead (see resolveSpawnModel).
const SPAWNABLE = new Set(['opus', 'sonnet', 'haiku']);
function capTier(model) {
  if (SPAWNABLE.has(model)) return model;
  if (model === 'fable') return 'opus'; // fable derivations run headless as opus
  return 'sonnet';
}

// The real model string to hand `claude -p --model` for a stamped tier: if the
// tier is pointed at a Codex model (prefs.tierBackend), the resolved gateway id;
// otherwise the capped built-in tier. resolveExec carries the backend decision.
function resolveSpawnModel(tier, effort, prefs) {
  const ex = store.resolveExec(tier, effort, prefs);
  if (ex.backend === 'codex') return ex.spawnId;      // the real gateway id
  return capTier(tier);                                // Claude tier, headless-capped
}

// Is the `claude` CLI present to spawn? A headless drain is pointless without it,
// and we'd rather say so than hang. shell:true so a Windows `claude.cmd` shim on
// PATH is found (a bare spawn misses `.cmd`/`.ps1` launchers).
function claudeCommand() {
  if (!WIN) return 'claude';
  const found = spawnSync('where.exe', ['claude.exe'], { encoding: 'utf8', timeout: 10000 });
  const first = String(found.stdout || '').split(/\r?\n/).find(Boolean);
  return first || 'claude.exe';
}

function claudeAvailable() {
  try {
    const r = spawnSync(claudeCommand(), ['--version'], { encoding: 'utf8', timeout: 10000 });
    return r.status === 0 || (r.stdout && /\d+\.\d+/.test(r.stdout));
  } catch (_) {
    return false;
  }
}

function worker(ref) {
  return `headless-${String(ref).toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;
}

// The one-ticket executor brief handed to a headless run. Mirrors the
// sidequest-exec-* protocol: claim -> read -> do -> verify -> done/release.
function executorPrompt(ref, by, tier, effort, projectPath) {
  const cli = `node "${CLI_PATH}"`;
  const proj = `--project "${projectPath}"`;
  const eff = effort ? ` --effort ${effort}` : '';
  return [
    `You are a headless sidequest executor. Work EXACTLY ONE ticket: ${ref}. Do nothing outside its scope.`,
    '',
    `1. CLAIM FIRST: ${cli} claim ${ref} --by ${by}${eff} ${proj}`,
    `   If the claim fails for ANY reason (already claimed / done / gone, or an effort mismatch), STOP immediately and report it verbatim — do NOT touch any file.`,
    `2. READ IN: ${cli} list --json ${proj} (find ${ref}) and ${cli} comments ${ref} ${proj}. A prior agent may have left the context you need.`,
    `3. DO the ticket's work — only what it specifies. Verify it the way the ticket says (run its test / syntax check / reproduction) before declaring success.`,
    `4. If it was an investigation, write findings back: ${cli} comment ${ref} -m "..." ${proj}.`,
    `5. CLOSE: ${cli} done ${ref} --by ${by} --model ${tier}${eff} ${proj}`,
    `   If you could not finish: ${cli} release ${ref} --by ${by} --status todo ${proj} and say why.`,
    '',
    `Report concisely: claim result, what changed, verification output, close confirmation.`,
  ].join('\n');
}

function planItem(t, prefs, projectPath, opts) {
  opts = opts || {};
  // A Codex-backed tier keeps its stamped tier for provenance (`fable` may map
  // to Sol and must close as fable). Only Claude-backed fable is capped to opus
  // because the headless CLI has no built-in `fable` alias.
  const backend = (t.exec && t.exec.backend) || 'claude';
  const tier = backend === 'codex' ? t.model : capTier(t.model);
  const spawnModel = resolveSpawnModel(t.model, t.effort, prefs);
  const by = worker(t.ref);
  const prompt = executorPrompt(t.ref, by, tier, t.effort, projectPath);
  const argv = ['-p', '--model', spawnModel, '--output-format', 'json'].concat(permissionArgs(opts));
  return {
    ref: t.ref, tier, effort: t.effort || null, by, prompt, argv, cwd: projectPath,
    spawnModel,
    backend,
    runsLabel: (t.exec && t.exec.runsLabel) || tier,
  };
}

// Plan exactly one ticket. This is the authoritative targeted dispatch path used
// by MCP `dispatch` and CLI `work --ref`: callers supply only a ref, never a model
// or prompt, so Sidequest owns the resolved backend and the executor protocol.
function planTicket(slug, idOrRef, opts) {
  opts = opts || {};
  const meta = store.readMeta(slug) || {};
  const projectPath = meta.path || process.cwd();
  const t = store.getTicket(slug, idOrRef);
  if (!t) return { ok: false, reason: 'missing', message: `no ticket "${idOrRef}".` };
  if (t.status === 'done') return { ok: false, reason: 'done', message: `${t.ref} is already done.` };
  if (t.status !== 'todo') return { ok: false, reason: 'not_todo', message: `${t.ref} is ${t.status}; release it to todo before dispatch.` };
  if (t.claim) return { ok: false, reason: 'claimed', message: `${t.ref} is already claimed by ${t.claim.by}.` };
  if (Array.isArray(t.blockedBy) && t.blockedBy.length) {
    return { ok: false, reason: 'blocked', message: `${t.ref} is blocked by ${t.blockedBy.join(', ')}.` };
  }
  const item = planItem(t, store.getModelPrefs(), projectPath, opts);
  return { ok: true, item };
}

// Launch one targeted executor and detach immediately. Output is written to a
// bounded-per-run log file under SIDEQUEST_HOME/dispatch; the returned pid/log
// let the caller inspect it without keeping the MCP request open. The child still
// claims atomically as step 1 of its stdin prompt.
function dispatchTicket(slug, idOrRef) {
  // Targeted dispatch is the Agent-tool replacement for gateway-backed models.
  // It always runs unattended, matching normal subagents under bypass. The MCP
  // surface deliberately exposes no permission/model/prompt override.
  const planned = planTicket(slug, idOrRef, { yolo: true });
  if (!planned.ok) return planned;
  if (!claudeAvailable()) return { ok: false, reason: 'no_claude', message: 'the `claude` CLI is not on PATH.' };
  const item = planned.item;
  const dir = path.join(store.homeRoot(), 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${item.ref.toLowerCase()}-${Date.now()}.log`);
  const fd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(claudeCommand(), item.argv, {
      cwd: item.cwd,
      detached: true,
      stdio: ['pipe', fd, fd],
      windowsHide: true,
    });
    if (child.stdin) {
      child.stdin.write(item.prompt);
      child.stdin.end();
    }
    child.unref();
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* best effort */ }
    return { ok: false, reason: 'spawn_failed', message: (e && e.message) || String(e) };
  }
  fs.closeSync(fd);
  return {
    ok: true,
    ref: item.ref,
    by: item.by,
    pid: child.pid,
    log: logPath,
    backend: item.backend,
    runsLabel: item.runsLabel,
    spawnModel: item.spawnModel,
  };
}

// Build the spawn plan for the next batch of ready work WITHOUT launching
// anything. Returns { waves, plan: [{ ref, tier, effort, by, argv, cwd }] } for
// the first wave (capped at max). Pure — the --dry-run path and the tests use it.
function planWork(slug, opts) {
  opts = opts || {};
  const meta = store.readMeta(slug) || {};
  const projectPath = meta.path || process.cwd();
  const max = Number.isFinite(Number(opts.max)) && Number(opts.max) > 0 ? Number(opts.max) : DEFAULT_MAX;
  const prefs = store.getModelPrefs();
  const waves = store.readyWaves(slug, { model: opts.model });
  const wave = waves[0] || [];
  const batch = wave.slice(0, max);
  const plan = batch.map((t) => planItem(t, prefs, projectPath, opts));
  return { waves, waveCount: waves.length, plan, dropped: Math.max(0, wave.length - batch.length) };
}

// Every Sidequest executor is unattended. Always bypass permissions so Bash,
// file edits, and board commands cannot block on a prompt in the lead session.
function permissionArgs() {
  return ['--dangerously-skip-permissions'];
}

// Spawn one headless run, resolving to a result record. Never rejects — a spawn
// failure resolves to an error result so one bad child can't sink the batch.
function spawnOne(item) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudeCommand(), item.argv, { cwd: item.cwd });
    } catch (e) {
      resolve({ ref: item.ref, ok: false, error: (e && e.message) || String(e) });
      return;
    }
    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', (d) => (out += d));
    if (child.stderr) child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ ref: item.ref, ok: false, error: (e && e.message) || String(e) }));
    child.on('close', (code) => {
      resolve({ ref: item.ref, ok: code === 0, code, stdout: out.slice(-4000), stderr: err.slice(-2000) });
    });
    // Hand the executor brief to the headless run over stdin, then close it.
    try {
      if (child.stdin) {
        child.stdin.write(item.prompt || '');
        child.stdin.end();
      }
    } catch (_) {
      /* if stdin already closed, the child.on('error') path reports it */
    }
  });
}

// Drain the ready set by spawning headless runs, wave by wave, until the board
// is clear or the wave cap is hit. Re-reads `ready` between waves so tickets a
// finished wave unblocks get picked up. Returns a summary.
async function runWork(slug, opts, log) {
  opts = opts || {};
  log = log || (() => {});
  if (!claudeAvailable()) {
    return { ok: false, reason: 'no_claude', message: 'the `claude` CLI is not on PATH — cannot spawn headless runs.' };
  }
  const maxWaves = Number.isFinite(Number(opts.maxWaves)) && Number(opts.maxWaves) > 0 ? Number(opts.maxWaves) : DEFAULT_MAX_WAVES;
  const results = [];
  let wavesRun = 0;
  for (let w = 0; w < (opts.singleWave ? 1 : maxWaves); w++) {
    const { plan } = planWork(slug, opts);
    if (!plan.length) break;
    wavesRun++;
    log(`wave ${wavesRun}: launching ${plan.length} headless run(s) — ${plan.map((p) => `${p.ref}·${p.tier}`).join(', ')}`);
    const waveResults = await Promise.all(plan.map(spawnOne));
    results.push(...waveResults);
    // If nothing in this wave actually completed, stop rather than spin.
    if (!waveResults.some((r) => r.ok)) break;
  }
  return { ok: true, wavesRun, results };
}

module.exports = {
  planWork, runWork, planTicket, dispatchTicket, capTier, resolveSpawnModel,
  claudeAvailable, claudeCommand, executorPrompt, CLI_PATH,
};
