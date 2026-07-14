'use strict';
/**
 * sidequest - storage layer
 *
 * One shared, dependency-free store used by the CLI, the capture hook, and the
 * dashboard server. Tickets live in a central home-directory store (not inside
 * each repo), keyed by the project's absolute path, so:
 *   - a repo never gets ticket JSON committed into it by accident, and
 *   - a single dashboard can show every project's board at once.
 *
 * Layout (root defaults to ~/.claude/sidequest, override with SIDEQUEST_HOME):
 *
 *   <root>/
 *     server.json                         # { port, pid, startedAt, url } of the live dashboard
 *     projects/
 *       <slug>/
 *         meta.json                       # { path, name, createdAt, seq }
 *         tickets/<id>.json               # one file per ticket
 *         assets/<id>/<file>              # images attached to a ticket
 *
 * <slug> is "<basename>-<8 hex of a hash of the absolute path>", so two
 * different folders that happen to share a basename never collide.
 *
 * Everything here is Node stdlib only and written to fail soft where a caller
 * (the hook) needs it to: a missing/corrupt file degrades to an empty result,
 * never a throw that could break a prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { discoverExternalModels } = require('./discovery.js');

/* ------------------------------------------------------------------ *
 *  Roots and path helpers
 * ------------------------------------------------------------------ */

function homeRoot() {
  const env = process.env.SIDEQUEST_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(os.homedir(), '.claude', 'sidequest');
}

function projectsRoot() {
  return path.join(homeRoot(), 'projects');
}

function serverFile() {
  return path.join(homeRoot(), 'server.json');
}

// Windows paths are case-insensitive; normalize case for a stable hash so the
// same folder always maps to the same slug regardless of how it was typed.
function normalizeForHash(absPath) {
  const p = path.resolve(absPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function slugify(absPath) {
  const base = path
    .basename(path.resolve(absPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const hash = crypto.createHash('sha1').update(normalizeForHash(absPath)).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

// A git worktree's `.git` is a FILE, not a directory:
//     gitdir: C:/dev/repo/.git/worktrees/<name>
// Given that file, resolve the MAIN worktree root that owns it (C:\dev\repo)
// so a worktree never mints its own board. Returns null when this isn't a
// linked worktree we can trust locally, and the caller keeps today's behavior:
//   - the entry is a `.git` DIRECTORY (a real clone root) — not our job
//   - the gitdir points at `.../modules/...` (a submodule — a separate repo)
//   - the gitdir is missing/malformed, or points off THIS machine (a remote
//     clone, a container mount, another OS) so the computed root isn't real here
// Fail-soft throughout: any error returns null.
function mainWorktreeRoot(gitEntry) {
  let stat;
  try {
    stat = fs.statSync(gitEntry);
  } catch (_) {
    return null;
  }
  if (!stat.isFile()) return null; // a `.git` dir is a real repo root, leave it
  let content;
  try {
    content = fs.readFileSync(gitEntry, 'utf8');
  } catch (_) {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  // gitdir is normally absolute; resolve relative forms against the worktree dir.
  let gitdir = m[1].replace(/[/\\]+$/, '');
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(path.dirname(gitEntry), gitdir);
  // Only linked worktrees (.git/worktrees/<name>) fold home. Submodules
  // (.git/modules/<name>) and anything else stay their own board.
  const parts = gitdir.split(/[/\\]+/);
  const wtIdx = parts.lastIndexOf('worktrees');
  if (wtIdx < 1) return null;
  // parts[0..wtIdx) is `.../.git`; the main worktree root is one level above it.
  const gitDirPath = parts.slice(0, wtIdx).join(path.sep);
  const root = path.dirname(gitDirPath);
  // Trust it only if that root actually exists on THIS filesystem — otherwise
  // the worktree points at a repo that isn't here, and we must not anchor a
  // board onto a phantom path.
  try {
    if (fs.statSync(root).isDirectory()) return path.resolve(root);
  } catch (_) { /* off-machine / moved — fall through to null */ }
  return null;
}

// Resolve startDir to the root of the project the agent is actually working in,
// so a board is always anchored there — never on a worktree, and never on a bare
// subfolder. Precedence, safest-first:
//
//   1. A path inside `<root>\.claude\worktrees\<name>` (the EnterWorktree
//      convention) folds straight back to <root>. Pure string match, no fs
//      trust: the worktree checkout may carry its OWN committed `.claude`, which
//      must NOT win — keying on the outermost `.claude/worktrees` guarantees the
//      real project root regardless.
//   2. Walk up to the nearest `.git`. A `.git` FILE is a linked worktree — fold
//      it to its main worktree root (works wherever the worktree sits on disk,
//      even far from the repo, because the file points home). A `.git` DIRECTORY
//      is a real clone root and wins, so a genuine nested/vendored repo keeps its
//      own board just like before.
//   3. A worktree we can't resolve locally (gitdir missing, off-machine, a
//      submodule) or a plain non-repo folder is returned unchanged — a
//      self-contained board on the dir you're actually in. Today's behavior.
//
// Fail-soft: any fs error stops the walk and falls back to the resolved startDir.
function nearestRepoRoot(startDir) {
  const start = path.resolve(startDir);

  // (1) EnterWorktree fast path — deterministic, no filesystem trust required.
  const wt = /^(.*?)[/\\]\.claude[/\\]worktrees[/\\]/i.exec(start + path.sep);
  if (wt && wt[1]) {
    const owner = path.resolve(wt[1]);
    try {
      if (fs.statSync(owner).isDirectory()) return owner;
    } catch (_) { /* owner gone — fall through to the git walk */ }
  }

  // (2) + (3) Walk up to the enclosing `.git`.
  let dir = start;
  for (;;) {
    try {
      const entry = path.join(dir, '.git');
      if (fs.existsSync(entry)) {
        return mainWorktreeRoot(entry) || dir;
      }
    } catch (_) {
      return start;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start; // hit the filesystem root without a repo
    dir = parent;
  }
}

function projectDir(slug) {
  return path.join(projectsRoot(), slug);
}
function ticketsDir(slug) {
  return path.join(projectDir(slug), 'tickets');
}
function assetsDir(slug, id) {
  return path.join(projectDir(slug), 'assets', id);
}
function metaFile(slug) {
  return path.join(projectDir(slug), 'meta.json');
}

/* ------------------------------------------------------------------ *
 *  Low-level JSON IO (atomic-ish, fail-soft on read)
 * ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.floor(process.hrtime()[1] % 1e6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    // Windows rename onto an existing file can fail; replace explicitly.
    try {
      fs.unlinkSync(file);
    } catch (_e) {
      /* ignore */
    }
    fs.renameSync(tmp, file);
  }
}

/* ------------------------------------------------------------------ *
 *  Ids
 * ------------------------------------------------------------------ */

function newTicketId() {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString('hex');
  return `tk_${t}_${r}`;
}

/* ------------------------------------------------------------------ *
 *  Projects
 * ------------------------------------------------------------------ */

const VALID_STATUS = ['todo', 'doing', 'done'];
const VALID_PRIORITY = ['low', 'normal', 'high', 'urgent'];

// Routing identity is intentionally provider-neutral. A grade owns the capability
// slot; its runtime assignment says what actually executes work in that slot.
const VALID_MODELS = ['grade-1', 'grade-2', 'grade-3', 'grade-4'];
const LEGACY_TIER_GRADE = { haiku: 'grade-1', sonnet: 'grade-2', opus: 'grade-3', fable: 'grade-4' };
const GRADE_TIER = { 'grade-1': 'haiku', 'grade-2': 'sonnet', 'grade-3': 'opus', 'grade-4': 'fable' };
const GRADE_LABELS = { 'grade-1': 'Grade 1', 'grade-2': 'Grade 2', 'grade-3': 'Grade 3', 'grade-4': 'Grade 4' };

/* ------------------------------------------------------------------ *
 *  Grades and deprecated input aliases
 * ------------------------------------------------------------------ */

// The old provider-family names and short-lived task-shape names remain accepted
// at input boundaries only. They never appear in canonical reads or prefs files.
const EXECUTION_PROFILES = VALID_MODELS.slice();
const PROFILE_TIER = {
  routine: 'grade-1', everyday: 'grade-2', complex: 'grade-3', frontier: 'grade-4',
  haiku: 'grade-1', sonnet: 'grade-2', opus: 'grade-3', fable: 'grade-4',
};
const TIER_PROFILE = Object.assign({}, GRADE_TIER);
const CLAUDE_RUNTIMES = ['haiku', 'sonnet', 'opus', 'fable'];
const CLAUDE_RUNTIME_LABELS = {
  haiku: 'Claude Haiku', sonnet: 'Claude Sonnet',
  opus: 'Claude Opus', fable: 'Claude Fable',
};

function tierForProfile(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return VALID_MODELS.includes(s) ? s : (PROFILE_TIER[s] || null);
}

function profileForTier(v) {
  return tierForProfile(v);
}

function coerceModel(v, _prefs) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'any' || s === 'none' || s === 'null') return null;
  return VALID_MODELS.includes(s) ? s : (PROFILE_TIER[s] || null);
}

// How hard the executor should think — the reasoning-effort levels Claude Code
// supports in agent-definition frontmatter. Rides alongside `model` as the other
// half of the cost dial (model = capability tier, effort = thinking depth).
// Like model, effort is required at the entry points: "any"/"none"/"default"
// coerce to null here, and null is rejected by CLI add / dashboard POST.
// Note: Haiku has no effort support at all — routing guidance lives in the
// skill, not enforced here.
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Every grade has a stored effort row so a grade can keep its picks while its
// runtime changes. Grade 1 only *uses* that row when it resolves to an
// effort-capable runtime (a Codex backend); Claude Haiku still has no effort
// axis. Keeping the dormant row makes flipping Grade 1 Haiku → Codex → Haiku
// lossless.
const EFFORT_MODELS = VALID_MODELS.slice();

function coerceEffort(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'any' || s === 'none' || s === 'null' || s === 'default') return null;
  return VALID_EFFORTS.indexOf(s) !== -1 ? s : null;
}

/* ------------------------------------------------------------------ *
 *  Per-tier model backend
 *
 *  The ladder always ranks the four built-in TIERS (haiku<sonnet<opus<fable).
 *  A user can point any tier at a discovered Codex model (codex-gateway) so that
 *  tier's tickets actually RUN on that model — e.g. map the opus tier to Terra.
 *  This is orthogonal to scoring: a ticket is still scored + stamped by tier;
 *  the tier's backend is resolved AT SPAWN. Absent config → every tier is its
 *  own Claude model → byte-identical built-in behavior.
 *
 *  Stored as prefs.tierBackend: { haiku, sonnet, opus, fable }, each value
 *  "claude" (default), a source-qualified `source:slug`, or a legacy discovered
 *  catalog slug. A mapped model that isn't in the current catalog (gateway
 *  uninstalled / model gone) falls back to Claude with a warning, so routing can
 *  never break.
 * ------------------------------------------------------------------ */

// A discovered catalog slug: 2..32 chars, lowercase alnum + dashes, alnum-start.
const BACKEND_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// haiku has no effort axis on the ladder (its rung is effort-null), but a Codex
// model mapped to the haiku slot still needs an effort for its generated agent.
// Give that one case a sane fixed effort.
const HAIKU_BACKEND_EFFORT = 'medium';

// A discovered catalog model key: `source:slug`. Source and slug are both
// sidequest-controlled lowercase tokens, so the separator is unambiguous.
const BACKEND_KEY_RE = /^([a-z0-9][a-z0-9-]{0,31}):([a-z0-9][a-z0-9-]{1,31})$/;

function backendKey(source, slug) {
  return `${source}:${slug}`;
}

// The discovered catalog as a source-qualified key -> entry map. Legacy bare
// slug lookup stays available at resolve time for older prefs files.
function discoveredByKey() {
  const out = {};
  for (const d of discoverExternalModels()) out[backendKey(d.source, d.slug)] = d;
  return out;
}

function discoveredBySlug() {
  const out = {};
  for (const d of discoverExternalModels()) if (!(d.slug in out)) out[d.slug] = d;
  return out;
}

// Normalize a raw tierBackend patch/stored value into
// { tier: "claude"|"haiku"|"sonnet"|"opus"|"fable"|"source:slug"|legacy-slug }.
// Each tier defaults to "claude"; an explicit Claude runtime is kept, while a
// discovered-model mapping is preserved even when its catalog entry is absent.
function normalizeTierBackend(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const grade of VALID_MODELS) {
    const legacy = GRADE_TIER[grade];
    const v = src[grade] !== undefined ? src[grade] : src[legacy];
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'claude' || s === '') out[grade] = 'claude';
      else if (CLAUDE_RUNTIMES.includes(s) || BACKEND_SLUG_RE.test(s) || BACKEND_KEY_RE.test(s)) out[grade] = s;
      else out[grade] = 'claude';
    } else {
      out[grade] = 'claude';
    }
  }
  return out;
}

// Resolve, for the current prefs, what actually runs each tier: an explicitly
// selected Claude runtime, a mapped Codex model, or the tier's default Claude
// runtime. Source-qualified values resolve exactly; legacy bare slugs preserve
// the previous first-discovered match. Returns
// { byTier: {tier: {backend, source, slug, id, label}}, warnings } where backend
// is "claude" or "codex". A mapping to a now-absent model degrades to the
// tier's default Claude runtime and adds a warning.
function resolveTierBackends(tierBackend) {
  const map = normalizeTierBackend(tierBackend);
  const catalog = discoveredByKey();
  const discovered = Object.values(catalog);
  const byTier = {};
  const warnings = [];
  for (const grade of VALID_MODELS) {
    const v = map[grade];
    const legacy = GRADE_TIER[grade];
    if (v === 'claude' || CLAUDE_RUNTIMES.includes(v)) {
      const runtime = v === 'claude' ? legacy : v;
      byTier[grade] = { backend: 'claude', source: null, slug: runtime, id: runtime, label: CLAUDE_RUNTIME_LABELS[runtime] };
      continue;
    }
    const d = catalog[v] || discovered.find((entry) => entry.slug === v);
    if (d) {
      const agentSlug = discovered.filter((entry) => entry.slug === d.slug).length > 1
        ? `${d.source}-${d.slug}`
        : d.slug;
      byTier[grade] = { backend: 'codex', source: d.source, slug: d.slug, agentSlug, id: d.id, label: d.label };
    } else {
      warnings.push(`${GRADE_LABELS[grade]} is mapped to "${v}", which isn't currently available — falling back to Claude ${legacy}`);
      byTier[grade] = { backend: 'claude', source: null, slug: legacy, id: legacy, label: CLAUDE_RUNTIME_LABELS[legacy] };
    }
  }
  return { byTier, warnings };
}

// Return true when this grade's resolved runtime accepts an effort level.
// Claude Haiku has no effort axis, while every other Claude runtime and all
// Codex runtimes do.
function gradeHasEffort(grade, prefs) {
  const byTier = prefs && (prefs.tierBackendResolved || resolveTierBackends(prefs.tierBackend).byTier);
  const backend = byTier && byTier[grade];
  return !!backend && (backend.backend !== 'claude' || backend.slug !== 'haiku');
}

// The single spawn seam: given a stamped (tier, effort), return exactly how to
// launch it — { agent, model, spawnId, dispatch }. Every route dispatches
// through the native Agent tool (dispatch: 'native-agent'):
//   - Claude-backed tier: { agent: "sidequest-exec-<effort>", model: <tier>, ... }
//     (haiku has no effort → agent null, caller spawns a plain agent with model haiku)
//   - Codex-backed tier:  { agent: "sidequest-exec-<slug>-<effort>", model: null, ... }
// The agent name is what the orchestrator spawns; `model` is the Agent-tool
// model parameter. Codex routes omit it because their generated agent pins the
// real model; Claude routes pass the selected runtime directly. spawnId is the
// resolved runtime model id, kept for non-dispatch callers that need runtime
// identity. effort is null only for a Claude Haiku runtime; a Codex-backed Haiku
// uses HAIKU_BACKEND_EFFORT for its agent.
function resolveExec(grade, effort, prefs) {
  grade = coerceModel(grade);
  prefs = prefs || getModelPrefs();
  const { byTier } = resolveTierBackends(prefs.tierBackend);
  const b = byTier[grade] || { backend: 'claude', slug: GRADE_TIER[grade], id: GRADE_TIER[grade], label: null };
  if (b.backend === 'codex') {
    const eff = effort || HAIKU_BACKEND_EFFORT;
    return { agent: `sidequest-exec-${b.agentSlug || b.slug}-${eff}`, model: null, spawnId: b.id, backend: 'codex', source: b.source, slug: b.slug, runsModel: b.slug, runsLabel: b.label || b.slug, dispatch: 'native-agent' };
  }
  const runtime = b.slug;
  if (runtime === 'haiku' || !effort) {
    return { agent: null, model: runtime, spawnId: runtime, backend: 'claude', slug: runtime, runsModel: runtime, runsLabel: b.label || CLAUDE_RUNTIME_LABELS[runtime], dispatch: 'native-agent' };
  }
  return { agent: `sidequest-exec-${effort}`, model: runtime, spawnId: runtime, backend: 'claude', slug: runtime, runsModel: runtime, runsLabel: b.label || CLAUDE_RUNTIME_LABELS[runtime], dispatch: 'native-agent' };
}

// Resolve a stamped model name to the real string handed to Claude Code at spawn
// time. A ticket stamps a TIER; if that tier is Codex-backed, the real model is
// the mapped id, else the tier maps to itself. Unknown names → null.
function resolveModelId(gradeName, prefs) {
  const grade = coerceModel(gradeName);
  return grade ? resolveExec(grade, null, prefs).spawnId : null;
}

// The routing vocabulary: tickets/filters/provenance name one of the four TIERS.
// (Codex models are per-tier backends, not independent names.) Kept for callers
// that want the valid model set + effort set.
function getModelVocab(_prefs) {
  return { models: VALID_MODELS.slice(), efforts: VALID_EFFORTS.slice() };
}

// Classify a --model filter value: 'any' (blank/any/none), 'unknown' (a
// non-empty value that's not one of the four tiers), or the resolved tier. A
// neutral profile name resolves to its tier, so `--model complex` filters the
// same set as `--model opus` (old aliases preserved, new vocabulary accepted).
function classifyModelFilter(v, _prefs) {
  if (v == null) return 'any';
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'any' || s === 'none' || s === 'null') return 'any';
  if (VALID_MODELS.indexOf(s) !== -1) return s;
  return PROFILE_TIER[s] || 'unknown';
}

/* ------------------------------------------------------------------ *
 *  Complexity-driven routing
 *
 *  The filing agent scores a ticket's complexity 1–10 (with a mandatory
 *  motivation — enforced at the entry points, like model/effort before it) and
 *  sidequest derives WHICH tier works it and HOW hard it thinks, by banding the
 *  score over the tiers the user has enabled in the model picker. Derivation
 *  happens at read time (listTickets/getTicket stamp the ticket in memory), so
 *  toggling a tier in the picker instantly re-routes every open ticket —
 *  nothing stored ever goes stale. A stored model/effort is honored only for
 *  legacy tickets that carry no complexity.
 * ------------------------------------------------------------------ */

// Capability order, weakest first — the axis the ladder scales along.
// (VALID_MODELS is unordered vocabulary; this is the ranking.)
const MODEL_CAPABILITY_ORDER = VALID_MODELS.slice();

// An integer score 1..10, or null when absent/garbage.
function coerceComplexity(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
}

// The routing bias: an integer dial ROUTING_BIAS_MIN..ROUTING_BIAS_MAX (default
// 0) that warps the complexity→tier ladder without changing which tiers are
// enabled. Negative = frugal (hold cheaper tiers for longer before escalating),
// positive = generous (escalate to pricier tiers sooner), 0 = today's neutral
// ladder. Clamped to range on write; anything unparseable degrades to 0, so a
// missing/garbage pref can never perturb the default routing.
const ROUTING_BIAS_MIN = -5;
const ROUTING_BIAS_MAX = 5;
function coerceRoutingBias(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(ROUTING_BIAS_MIN, Math.min(ROUTING_BIAS_MAX, n));
}

// Capability score for a rung: score = tierBase + effortIndex, where tierBase is
// a PER-TIER BASE OFFSET (LADDER_TIER_BASE below — keyed by tier, not a single
// uniform gap times tierRank) and effortIndex is the effort's position in the
// non-max effort list (low 0 … xhigh 3, a span of 3). SQ-87 researched real
// published benchmarks across the current model line (Sonnet 5 / Opus 4.8 /
// Fable 5) and found the two tier boundaries are NOT the same size, so a single
// constant gap applied at every boundary (the old LADDER_TIER_GAP=2) mis-modeled
// one of them:
//   - haiku(0) -> sonnet(2) -> opus(4): gap 2 at both boundaries, UNCHANGED.
//     This gap is deliberately SMALLER than the effort span (3) so
//     CAPABILITY-ADJACENT TIERS OVERLAP: a lower tier's top effort outranks the
//     next tier's bottom effort(s) (e.g. sonnet·xhigh ties opus·medium, and the
//     tie still resolves to opus — see tie-break below). SQ-87's benchmark
//     survey found a genuinely mixed sonnet/opus picture (Opus keeps a real edge
//     on SWE-bench Pro, but Sonnet wins Terminal-Bench and GDPval and ties HLE),
//     plus an effort-qualified data point that sonnet·xhigh is comparable to
//     opus·medium-to-high — so this crossover is evidence-supported and stays.
//   - opus(4) -> fable(8): gap WIDENED to 4 — the full effort span (3) plus one,
//     making this boundary fully tier-major (zero overlap). Every published
//     benchmark SQ-87 found has Fable 5 leading Opus 4.8, by a margin that GROWS
//     on harder tasks, with no observed crossover — a materially different, more
//     one-sided picture than sonnet/opus, so it doesn't belong on the same
//     constant. Under the old uniform gap, fable·low tied opus·high one tick
//     early (nothing in the evidence supports that); the widened gap fixes it —
//     fable·low now ranks strictly above opus·high, with opus·xhigh (Opus's own
//     ceiling) as the rung directly below it instead of being skipped.
// Bump a tier's offset further above its neighbor's to weaken/eliminate overlap
// there (more tier-major); pull it closer to widen the crossover band.
const LADDER_TIER_BASE = { 'grade-1': 0, 'grade-2': 2, 'grade-3': 4, 'grade-4': 8 };
// The effort axis the score indexes along (max held out — it's the sparing top
// rung, ranked separately). Position in this list == a rung's effortIndex.
const LADDER_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];

// Build the 10-rung ladder for the currently enabled prefs as ONE merged,
// capability-ranked sequence of (model, effort) rungs — not tier bands. Every
// enabled (tier × non-max effort) combo participates as a rung, scored by
// capability (see LADDER_TIER_BASE) so tiers overlap/diverge per boundary and
// crossovers happen where the evidence supports them; haiku
// carries no effort and contributes a single null rung below every richer tier's
// low rung. `max` is held out of that sequence and reserved for the very top of
// the scale ("use sparingly for the hardest tasks"). routingBias then curves how
// complexity 1..10 maps onto the sequence index (SQ-76 gamma remap), bending the
// whole combined model+effort cost curve. Returns [{ complexity: 1..10, model,
// effort }] — the shape every consumer (CLI, dashboard, read-time derivation)
// already expects.
function routingLadder(prefs) {
  prefs = prefs || getModelPrefs();

  // Resolve a tier's effort row from the per-model matrix, fail-soft to
  // all-enabled when the row (or the whole efforts object) is missing/garbage —
  // so an old flat-shape prefs object handed straight to routingLadder still
  // yields a full ladder rather than an empty one.
  const efforts = prefs.efforts && typeof prefs.efforts === 'object' ? prefs.efforts : {};
  function builtinRow(model) {
    const r = efforts[model] && typeof efforts[model] === 'object' ? efforts[model] : null;
    const row = {};
    for (const e of VALID_EFFORTS) row[e] = r ? r[e] !== false : true;
    return row;
  }
  // The enabled non-max efforts of a row (the rungs it contributes to the ranked
  // sequence). `max` is held out — it's the sparing top rung.
  function seqEffortsOf(row) {
    return LADDER_EFFORT_ORDER.filter((e) => row[e] !== false);
  }

  // ASSEMBLE the participating tiers: every enabled built-in in capability order.
  // Tiers are always the four built-ins; a Codex model is a per-tier BACKEND
  // (resolved at spawn, see resolveExec), not a rung of its own, so the ladder's
  // shape and scoring are exactly the built-in ones.
  const tiers = [];
  for (const m of MODEL_CAPABILITY_ORDER) {
    if (prefs[m] === false) continue;
    const hasEffort = gradeHasEffort(m, prefs);
    const runtimeId = resolveExec(m, null, prefs).spawnId;
    tiers.push({
      model: m,
      runtimeId,
      base: LADDER_TIER_BASE[m],
      tierRank: MODEL_CAPABILITY_ORDER.indexOf(m),
      row: hasEffort ? builtinRow(m) : null,
      haiku: !hasEffort,
    });
  }
  // Never return an empty ladder: fall back to Grade 2.
  if (!tiers.length) {
    tiers.push({ model: 'grade-2', runtimeId: resolveExec('grade-2', null, prefs).spawnId, base: LADDER_TIER_BASE['grade-2'], tierRank: MODEL_CAPABILITY_ORDER.indexOf('grade-2'), row: builtinRow('grade-2'), haiku: false });
  }

  // Grades sharing one resolved runtime contribute one effort sequence. Keep the
  // highest grade as the stamped provenance, use the cheapest grade's base for
  // cross-runtime ranking, and union their enabled effort rows.
  const runtimeGroups = [];
  for (const tier of tiers) {
    let group = runtimeGroups.find((candidate) => candidate.runtimeId === tier.runtimeId);
    if (!group) {
      group = { ...tier, row: tier.row ? { ...tier.row } : null, topBase: tier.base };
      runtimeGroups.push(group);
      continue;
    }
    group.topBase = Math.max(group.topBase, tier.base);
    if (tier.tierRank > group.tierRank) {
      group.model = tier.model;
      group.tierRank = tier.tierRank;
    }
    if (tier.row) {
      group.haiku = false;
      group.row = group.row || {};
      for (const effort of VALID_EFFORTS) {
        group.row[effort] = group.row[effort] === true || tier.row[effort] === true;
      }
    }
  }

  // ENUMERATE every enabled resolved-runtime combo programmatically and score it by capability.
  // Haiku → a single effort-null rung; every other tier (built-in or custom) →
  // one rung per enabled non-max effort IN ITS OWN ROW (so opus·medium can be
  // excluded while sonnet·medium stays). A row with ONLY max enabled has max carry
  // that tier's sequence rungs (the per-tier maxInSequence fallback).
  const seq = [];
  for (const tier of runtimeGroups) {
    if (tier.haiku) {
      seq.push({ model: tier.model, effort: null, tierRank: tier.tierRank, score: tier.base });
      continue;
    }
    let tierEfforts = seqEffortsOf(tier.row);
    if (!tierEfforts.length) {
      // Nothing but max (or nothing) left on in this row: max carries the tier's
      // sequence; a fully-empty row falls back to medium so the tier still
      // contributes a rung.
      tierEfforts = tier.row.max !== false ? ['max'] : ['medium'];
    }
    for (const eff of tierEfforts) {
      // 'max' only appears here in the only-max-enabled fallback; rank it above
      // the normal effort scale so it stays the strongest rung of its tier.
      const idx = eff === 'max' ? LADDER_EFFORT_ORDER.length : LADDER_EFFORT_ORDER.indexOf(eff);
      seq.push({ model: tier.model, effort: eff, tierRank: tier.tierRank, score: tier.base + idx });
    }
  }
  // RANK ascending by capability; exact cross-tier score ties (e.g. sonnet·high ==
  // opus·low) break by higher tier ranking, then by model name — one merged total
  // order.
  seq.sort((a, b) => (a.score - b.score) || (a.tierRank - b.tierRank) || String(a.model).localeCompare(String(b.model)));

  // MAX SPARINGLY: the tier with the highest base score owns
  // the sole ·max rung that sits ABOVE the whole sequence, reached only at the very
  // top of the complexity scale. Base ties resolve to the higher tier rank, then
  // slug — a single deterministic top tier. It exists iff that tier's OWN row has
  // max enabled AND max isn't already carrying its sequence (only-max row); haiku
  // has no ·max, so there's none when it's the only/top tier.
  let top = runtimeGroups[0];
  for (const tier of runtimeGroups) {
    if (tier.topBase > top.topBase
      || (tier.topBase === top.topBase && tier.tierRank > top.tierRank)
      || (tier.topBase === top.topBase && tier.tierRank === top.tierRank && String(tier.model) < String(top.model))) {
      top = tier;
    }
  }
  const hasMaxRung =
    !top.haiku && top.row.max !== false && seqEffortsOf(top.row).length > 0;
  const full = hasMaxRung ? seq.concat([{ model: top.model, effort: 'max' }]) : seq;

  // BIAS curves complexity → sequence index via the SQ-76 gamma remap. Reserve the
  // top complexities for the max rung: complexity 10 always, and 9 too only at the
  // most generous bias (+5); never below 9, at any bias. With no max rung, 10
  // lands the top of the normal sequence instead.
  const bias = coerceRoutingBias(prefs.routingBias);
  const gamma = Math.pow(3, -bias / 5);
  const maxCount = hasMaxRung ? (bias >= ROUTING_BIAS_MAX ? 2 : 1) : 0;
  const normalCount = 10 - maxCount;      // complexities 1..normalCount hit the sequence
  const maxIdx = full.length - 1;         // index of the max rung (only used when hasMaxRung)
  const lastNormal = seq.length - 1;      // top index of the normal sequence

  const out = [];
  for (let c = 1; c <= 10; c++) {
    let rung;
    if (hasMaxRung && c > normalCount) {
      rung = full[maxIdx];
    } else {
      // BOTTOM-WEIGHTED FLOOR BUCKETING (SQ-134): p in [0,1) uses normalCount (not
      // normalCount-1) as the divisor, so p never reaches 1 within this branch —
      // floor()ing frac*(lastNormal+1) then splits the sequence into lastNormal+1
      // equal-width buckets with the REMAINDER width falling on the cheapest
      // (lowest-index) buckets, instead of round()'s interior-weighted split. Cost
      // curves are convex, so neutral bias should be bottom-weighted. gamma still
      // bends p (bias>0 -> higher index sooner). Duplicates across adjacent
      // complexities are fine; we never index outside the enabled sequence.
      const p = (c - 1) / normalCount;
      const frac = Math.pow(p, gamma);
      let idx = Math.min(lastNormal, Math.floor(frac * (lastNormal + 1)));
      // c=10 must always hit the strongest rung. With a max rung the branch above
      // already handles c=10 (c > normalCount); without one, normalCount=10 so p
      // never quite reaches 1 here (0.9 at gamma=1) and a frugal gamma>1 can shrink
      // it further and undershoot the top rung — pin it explicitly.
      if (!hasMaxRung && c === 10) idx = lastNormal;
      rung = seq[idx];
    }
    out.push({ complexity: c, model: rung.model, effort: rung.effort });
  }
  return out;
}

// { model, effort } for a score under the current (or given) prefs, or null
// for a null/invalid score.
function deriveRouting(complexity, prefs) {
  const c = coerceComplexity(complexity);
  if (!c) return null;
  const rung = routingLadder(prefs)[c - 1];
  return { model: rung.model, effort: rung.effort };
}

// Stamp a ticket's derived model/effort in memory from its complexity (when it
// has one), plus a resolved `exec` telling a spawner exactly how to launch it
// (which agent, which model param) given the current per-tier backend map. Reads
// are the single seam every consumer goes through, so chips, claim filters, waves
// AND the orchestrator's spawn all reflect the ladder + backend of the moment —
// no separate tier→backend lookup at spawn, which is what prevents backend drift.
function applyDerivedRouting(t, prefs) {
  if (!t) return t;
  if (t.complexity) {
    prefs = prefs || getModelPrefs();
    const r = deriveRouting(t.complexity, prefs);
    if (r) {
      t.model = r.model;
      t.effort = r.effort;
      const ex = resolveExec(r.model, r.effort, prefs);
      // exec: what to spawn. backend "codex" flags the card chip's Codex mark and
      // tells the orchestrator to announce which model actually runs (runsLabel).
      // dispatch advertises the execution path: every route is native Agent
      // dispatch (model: null on a Codex route means omit the Agent model param).
      t.exec = { agent: ex.agent, model: ex.model, backend: ex.backend, runsModel: ex.runsModel, runsLabel: ex.runsLabel, dispatch: ex.dispatch };
    }
  } else if (coerceModel(t.model)) {
    // Legacy no-complexity ticket: normalize deprecated tier aliases on read.
    t.model = coerceModel(t.model);
    prefs = prefs || getModelPrefs();
    const ex = resolveExec(t.model, t.effort || null, prefs);
    t.exec = { agent: ex.agent, model: ex.model, backend: ex.backend, runsModel: ex.runsModel, runsLabel: ex.runsLabel, dispatch: ex.dispatch };
  }
  t.profile = t.model || null;
  return t;
}

// A user story groups several tickets. Its colour is what the board uses to tint
// every member card, so the eight defaults are muted, distinct hues that read on
// the cream paper (and against each other). New stories cycle through them; the
// user can override with any hex or one of the named aliases below.
const STORY_PALETTE = ['#c2683f', '#3f8f8a', '#7a5ba8', '#7d8a3f', '#b45573', '#4a72a8', '#c19a3e', '#4f8f6a'];
const STORY_COLOR_NAMES = {
  terracotta: '#c2683f', teal: '#3f8f8a', violet: '#7a5ba8', olive: '#7d8a3f',
  rose: '#b45573', steel: '#4a72a8', amber: '#c19a3e', green: '#4f8f6a',
};

// Normalize a requested story colour to a #rrggbb string, or null if it isn't a
// hex (#rgb / #rrggbb) or a known name — callers fall back to autoStoryColor().
function parseStoryColor(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (STORY_COLOR_NAMES[s]) return STORY_COLOR_NAMES[s];
  if (/^#?[0-9a-f]{6}$/.test(s)) return '#' + s.replace(/^#/, '');
  if (/^#?[0-9a-f]{3}$/.test(s)) {
    const h = s.replace(/^#/, '');
    return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return null;
}
function autoStoryColor(index) {
  const n = STORY_PALETTE.length;
  return STORY_PALETTE[(((index || 0) % n) + n) % n];
}

function defaultProjectName(absPath) {
  return path.basename(path.resolve(absPath)) || 'project';
}

// Register (or refresh) a project and return { slug, dir, meta }. Creates the
// directory tree on first use. `name` overrides the display name (defaults to
// the folder basename).
function ensureProject(absPath, name) {
  const resolved = path.resolve(absPath);
  const slug = slugify(resolved);
  const dir = projectDir(slug);
  ensureDir(ticketsDir(slug));
  const mf = metaFile(slug);
  let meta = readJson(mf, null);
  if (!meta || typeof meta !== 'object') {
    meta = { path: resolved, name: name || defaultProjectName(resolved), createdAt: new Date().toISOString(), seq: 0, storySeq: 0 };
    writeJson(mf, meta);
  } else {
    // ensureProject runs on ordinary reads/writes, so restoring a board is
    // unarchiveProject's job. Keep meta.archivedAt intact here.
    let dirty = false;
    if (meta.path !== resolved) { meta.path = resolved; dirty = true; }
    if (name && meta.name !== name) { meta.name = name; dirty = true; }
    if (!meta.name) { meta.name = defaultProjectName(resolved); dirty = true; }
    if (typeof meta.seq !== 'number') { meta.seq = 0; dirty = true; }
    if (typeof meta.storySeq !== 'number') { meta.storySeq = 0; dirty = true; }
    if (dirty) writeJson(mf, meta);
  }
  return { slug, dir, meta };
}

function readMeta(slug) {
  return readJson(metaFile(slug), null);
}

function metaLockPath(slug) {
  return path.join(projectDir(slug), '.meta.lock');
}

// Locked read-modify-write so two concurrent createTicket calls never mint the
// same human-facing SQ-N ref (a bare read+increment+write here would race).
// acquireLock already retries internally on contention; if it still can't get
// the lock (e.g. a wedged/unwritable dir), fall back to an unlocked bump rather
// than blocking ticket creation entirely.
function nextSeq(slug) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    const mf = metaFile(slug);
    const meta = readJson(mf, null) || { seq: 0 };
    meta.seq = (typeof meta.seq === 'number' ? meta.seq : 0) + 1;
    writeJson(mf, meta);
    return meta.seq;
  } finally {
    if (locked) releaseLock(lock);
  }
}

// The story counter is a second monotonic sequence on the same meta.json,
// minting US-1, US-2, … independently of the SQ-N ticket refs. Shares the meta
// lock with nextSeq so a concurrent ticket + story creation can't clobber each
// other's write.
function nextStorySeq(slug) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    const mf = metaFile(slug);
    const meta = readJson(mf, null) || { storySeq: 0 };
    meta.storySeq = (typeof meta.storySeq === 'number' ? meta.storySeq : 0) + 1;
    writeJson(mf, meta);
    return meta.storySeq;
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Turn a board's per-project notifications on or off. When off, the board is
// muted: queueEventNotification below drops every background event for it, even
// with a dashboard tab open. Stored on meta.json (absent == on), behind the meta
// lock so it can't race a seq bump.
function setProjectNotify(slug, on) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    const mf = metaFile(slug);
    const meta = readJson(mf, null);
    if (!meta) return { ok: false, reason: 'not_found' };
    meta.notify = on !== false;
    writeJson(mf, meta);
    return { ok: true, notify: meta.notify };
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Board-level archive is a reversible meta.json stamp. Project files and tickets
// remain in place, and repeat calls keep the original archive timestamp.
function archiveProject(slug) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    const mf = metaFile(slug);
    const meta = readJson(mf, null);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (meta.archivedAt) return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: true };
    meta.archivedAt = new Date().toISOString();
    writeJson(mf, meta);
    return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: false };
  } finally {
    if (locked) releaseLock(lock);
  }
}

function unarchiveProject(slug) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    const mf = metaFile(slug);
    const meta = readJson(mf, null);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (!meta.archivedAt) return { ok: true, slug, wasArchived: false };
    delete meta.archivedAt;
    writeJson(mf, meta);
    return { ok: true, slug, wasArchived: true };
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Permanent deletion is deliberately strict: callers must already have the exact
// stored slug. This avoids turning an untrusted display name or path into a new
// project lookup at a destructive boundary.
function deleteProjectExact(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return { ok: false, reason: 'not_found' };
  const dir = projectDir(slug);
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  let exists = false;
  try {
    exists = !!readJson(metaFile(slug), null);
  } finally {
    // The lock file lives inside the board directory. Release it before removal so
    // Windows never holds an open handle on a child of the tree being deleted.
    if (locked) releaseLock(lock);
  }
  if (!exists) return { ok: false, reason: 'not_found' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, slug };
}

// List every registered project with live ticket counts. Sorted by most recent
// activity so the busiest board floats to the top of the switcher. By default,
// archived boards are hidden. Pass { archived: true } to list only archived
// boards, or { all: true } for internal resolution.
function listProjects(opts) {
  opts = opts || {};
  const root = projectsRoot();
  let slugs = [];
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    const meta = readMeta(slug);
    if (!meta) continue;
    const archivedAt = meta.archivedAt || null;
    if (!opts.all && (opts.archived ? !archivedAt : !!archivedAt)) continue;
    const tickets = listTickets(slug);
    const counts = { todo: 0, doing: 0, done: 0 };
    let archived = 0;
    let lastActivity = meta.createdAt || null;
    for (const t of tickets) {
      if (t.updatedAt && (!lastActivity || t.updatedAt > lastActivity)) lastActivity = t.updatedAt;
      if (t.archived) { archived++; continue; } // archived tickets don't count toward the board
      if (counts[t.status] != null) counts[t.status]++;
    }
    out.push({
      slug,
      name: meta.name || slug,
      path: meta.path || '',
      counts,
      total: tickets.length - archived,
      archived,
      open: counts.todo + counts.doing,
      lastActivity,
      notify: meta.notify !== false, // per-project notification switch (absent == on)
      stories: listStories(slug).length,
      archivedAt,
    });
  }
  out.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return out;
}

// Resolve a caller-supplied --project reference to the ONE already-registered
// board it names — an exact slug, a case-insensitive display NAME, or a
// filesystem path. NEVER creates or matches anything outside the registered
// set (see SQ-86): a name is not a slug, so a bare display name used to miss
// the slug lookup, fall into ensureProject(), and get treated as a raw path
// resolved against cwd — silently minting a phantom empty board that happened
// to share the real project's display name (or a real one's if two directories
// share a basename, e.g. "BMR" run from both C:\dev\BMR and C:\dev\BMR\BMR).
// Returns { ok:true, slug, meta } on a clean match, or { ok:false, reason,
// ...} for the caller (the CLI) to turn into a hard error:
//   - reason 'ambiguous' + matches: 2+ registered boards share that NAME —
//     the caller must re-run with the disambiguating path.
//   - reason 'not_found' + known: nothing matched — known is the list of
//     registered display names to surface in the error.
function findProject(ref) {
  const arg = String(ref == null ? '' : ref).trim();
  const all = listProjects({ all: true });
  if (!arg) return { ok: false, reason: 'not_found', known: all.map((p) => p.name) };

  // 1. An exact slug of an existing board (the historical fast path — a few
  // internal callers, like the dashboard, already pass a real slug).
  const bySlugMeta = readMeta(arg);
  if (bySlugMeta) return { ok: true, slug: arg, meta: bySlugMeta };

  // 2. A case-insensitive exact match on the display NAME.
  const wantedName = arg.toLowerCase();
  const byName = all.filter((p) => String(p.name).trim().toLowerCase() === wantedName);
  if (byName.length === 1) {
    const meta = readMeta(byName[0].slug);
    if (meta) return { ok: true, slug: byName[0].slug, meta };
  } else if (byName.length > 1) {
    return { ok: false, reason: 'ambiguous', matches: byName };
  }

  // 3. A filesystem path matching an ALREADY-REGISTERED project's path. Never
  // registers a new one at this path — that would just reopen the SQ-86 hole.
  const wantedPath = normalizeForHash(path.resolve(arg));
  const byPath = all.find((p) => p.path && normalizeForHash(path.resolve(p.path)) === wantedPath);
  if (byPath) {
    const meta = readMeta(byPath.slug);
    if (meta) return { ok: true, slug: byPath.slug, meta };
  }

  return { ok: false, reason: 'not_found', known: all.map((p) => p.name) };
}

// Fold one board (src) entirely into another (dest): move every ticket, story,
// and attached asset over, then delete the source board. Used to collapse the
// duplicate boards that older versions minted when the CLI ran from a subfolder
// (see nearestRepoRoot / SQ-94). The renumbering rules that make this safe:
//   - Ticket SQ-n / story US-n refs are re-minted ABOVE dest's live counters
//     (via nextSeq/nextStorySeq), so they never collide with dest's own refs.
//   - Stable ids (tk_… / st_…) are kept as-is. They're globally unique, so the
//     ticket/story JSON drops into dest without a filename clash, the assets
//     folder (keyed by ticket id) copies 1:1, and a ticket's storyId (which
//     points at a story's stable id, never its ref) still resolves after the
//     move — no membership is orphaned.
//   - Intra-board links (links[].ref, which point by SQ-ref) are rewritten
//     through the old->new ref map so dependencies survive the renumber.
// dryRun computes and returns the same mapping without touching disk. Returns
// { tickets, stories, mapping: [{ from, to, title }] }.
function mergeProject(srcSlug, destSlug, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  if (srcSlug === destSlug) throw new Error('source and destination are the same board');
  if (!readMeta(srcSlug)) throw new Error(`source board "${srcSlug}" does not exist`);
  if (!readMeta(destSlug)) throw new Error(`destination board "${destSlug}" does not exist`);

  // Oldest-first so re-minted refs preserve the source's creation order.
  const tickets = listTickets(srcSlug).slice().sort((a, b) => seqOfRef(a.ref) - seqOfRef(b.ref));
  const stories = listStories(srcSlug); // listStories already returns oldest-first

  // Plan the ref renumbering up front so link remapping can see every mapping.
  const refMap = {}; // OLD-TICKET-REF (upper) -> NEW-TICKET-REF
  const ticketPlan = [];
  for (const t of tickets) {
    const newRef = dryRun ? `SQ-?` : `SQ-${nextSeq(destSlug)}`;
    if (t.ref) refMap[String(t.ref).toUpperCase()] = newRef;
    ticketPlan.push({ ticket: t, newRef });
  }
  const storyPlan = [];
  for (const s of stories) {
    const newRef = dryRun ? `US-?` : `US-${nextStorySeq(destSlug)}`;
    storyPlan.push({ story: s, newRef });
  }

  const mapping = ticketPlan.map(({ ticket, newRef }) => ({ from: ticket.ref, to: newRef, title: ticket.title }));
  if (dryRun) return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };

  // Stories first, so a moved ticket's storyId still finds its story in dest.
  for (const { story, newRef } of storyPlan) {
    const moved = Object.assign({}, story, { ref: newRef });
    writeJson(storyFile(destSlug, moved.id), moved);
  }
  for (const { ticket, newRef } of ticketPlan) {
    const links = Array.isArray(ticket.links)
      ? ticket.links.map((l) => Object.assign({}, l, { ref: refMap[String(l.ref).toUpperCase()] || l.ref }))
      : [];
    const moved = Object.assign({}, ticket, { ref: newRef, links });
    writeJson(ticketFile(destSlug, moved.id), moved);
    const srcAssets = assetsDir(srcSlug, ticket.id);
    if (fs.existsSync(srcAssets)) {
      try {
        fs.cpSync(srcAssets, assetsDir(destSlug, ticket.id), { recursive: true });
      } catch (_) {
        /* an unreadable asset folder shouldn't abort the whole merge */
      }
    }
  }

  // Everything is copied into dest — retire the source board.
  try {
    fs.rmSync(projectDir(srcSlug), { recursive: true, force: true });
  } catch (_) {
    /* best effort; the tickets already live in dest */
  }
  return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
}

// Pull the numeric sequence out of an "SQ-12" ref for ordering; junk sorts last.
function seqOfRef(ref) {
  const m = /(\d+)\s*$/.exec(String(ref || ''));
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/* ------------------------------------------------------------------ *
 *  Assets (images attached to a ticket)
 * ------------------------------------------------------------------ */

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'image')).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '');
  return base || 'image';
}

// Copy a source image into a ticket's asset folder and return the stored
// filename (deduped on collision). Throws on an unreadable source so the CLI
// can report it; callers that must not throw wrap this.
function copyAsset(slug, id, srcPath) {
  const src = path.resolve(srcPath);
  const data = fs.readFileSync(src); // throws if missing -> surfaced by CLI
  const dir = assetsDir(slug, id);
  ensureDir(dir);
  let fname = sanitizeFilename(path.basename(src));
  if (!path.extname(fname)) fname += '.png';
  let dest = path.join(dir, fname);
  let n = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(fname);
    const stem = fname.slice(0, -ext.length || undefined);
    dest = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  fs.writeFileSync(dest, data);
  return path.basename(dest);
}

function assetPath(slug, id, filename) {
  // Guard against path traversal in a filename coming from the HTTP layer.
  const safe = path.basename(String(filename));
  return path.join(assetsDir(slug, id), safe);
}

// Save raw image bytes (e.g. a screenshot pasted into the dashboard) into a
// ticket's asset folder, deduping the filename. Returns the stored filename.
function saveAssetData(slug, id, name, buffer) {
  const dir = assetsDir(slug, id);
  ensureDir(dir);
  let fname = sanitizeFilename(name || 'pasted.png');
  if (!path.extname(fname)) fname += '.png';
  let dest = path.join(dir, fname);
  let n = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(fname);
    const stem = fname.slice(0, -ext.length || undefined);
    dest = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  fs.writeFileSync(dest, buffer);
  return path.basename(dest);
}

/* ------------------------------------------------------------------ *
 *  Tickets
 * ------------------------------------------------------------------ */

function ticketFile(slug, id) {
  return path.join(ticketsDir(slug), `${path.basename(String(id))}.json`);
}

function listTickets(slug) {
  let files = [];
  try {
    files = fs.readdirSync(ticketsDir(slug)).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  const prefs = getModelPrefs(); // one read; the ladder is the same for every ticket in the pass
  for (const f of files) {
    const t = readJson(path.join(ticketsDir(slug), f), null);
    if (t && t.id) out.push(applyDerivedRouting(t, prefs));
  }
  // Newest first by order (falls back to createdAt); the UI re-groups by column.
  out.sort((a, b) => (b.order || 0) - (a.order || 0));
  return out;
}

function getTicket(slug, idOrRef) {
  const direct = readJson(ticketFile(slug, idOrRef), null);
  if (direct && direct.id) return applyDerivedRouting(direct, null);
  // Allow lookup by human ref like "SQ-4" (case-insensitive).
  const wanted = String(idOrRef).toUpperCase();
  for (const t of listTickets(slug)) {
    if (String(t.ref).toUpperCase() === wanted) return t;
  }
  return null;
}

function coerceStatus(s, fallback) {
  s = String(s || '').toLowerCase();
  return VALID_STATUS.includes(s) ? s : fallback;
}
function coercePriority(p, fallback) {
  p = String(p || '').toLowerCase();
  return VALID_PRIORITY.includes(p) ? p : fallback;
}

const EXECUTOR_ANCHORS_MAX = 4000;
const EXECUTOR_VERIFY_MAX = 1000;

// Per-ticket executor context stays deliberately small: this data may be passed
// through a Windows command surface with an 8191-character ceiling. Keep the
// anchors as written so the eventual executor prompt can carry them verbatim.
function executorText(value, max, label) {
  if (value == null) return '';
  const text = String(value);
  if (text.length > max) throw new Error(`${label} exceeds the ${max}-character executor-context limit.`);
  return text;
}

function ticketPlanningWarnings(ticket) {
  if (!ticket || Number(ticket.complexity) < 4) return [];
  const missing = [];
  if (!String(ticket.executorAnchors || '').trim()) missing.push('executor anchors');
  if (!String(ticket.executorVerify || '').trim()) missing.push('verify command');
  if (!Array.isArray(ticket.files) || !ticket.files.length) missing.push('file scope');
  if (!missing.length) return [];
  return [`Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: ${missing.join(', ')}.`];
}

function createTicket(slug, fields) {
  fields = fields || {};
  const id = newTicketId();
  const seq = nextSeq(slug);
  const now = new Date().toISOString();

  const assets = [];
  const imgs = Array.isArray(fields.images) ? fields.images : [];
  for (const src of imgs) {
    try {
      assets.push(copyAsset(slug, id, src));
    } catch (e) {
      // Record which image could not be attached; the CLI surfaces this.
      if (fields.onAssetError) fields.onAssetError(src, e);
    }
  }
  for (const d of asDataImages(fields.imagesData)) {
    try {
      assets.push(saveAssetData(slug, id, d.name, d.buffer));
    } catch (_) {
      /* skip a bad upload */
    }
  }

  const ticket = {
    id,
    ref: `SQ-${seq}`,
    title: String(fields.title || 'Untitled').trim().slice(0, 300) || 'Untitled',
    description: String(fields.description || '').trim(),
    status: coerceStatus(fields.status, 'todo'),
    priority: coercePriority(fields.priority, 'normal'),
    labels: normalizeLabels(fields.labels),
    storyId: coerceStoryId(slug, fields.storyId), // the user story this ticket belongs to (null = none)
    complexity: coerceComplexity(fields.complexity), // 1..10 score the routing is derived from (entry points require it)
    complexityWhy: String(fields.complexityWhy || '').trim().slice(0, 1000), // the mandatory motivation for the score
    model: coerceModel(fields.model), // legacy direct tag (a built-in tier); overridden at read time when complexity is set
    effort: coerceEffort(fields.effort),          // legacy direct tag; overridden at read time when complexity is set
    files: normalizeFiles(fields.files),          // declared file scope, for parallel-wave planning
    executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors'),
    executorVerify: executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command'),
    assets,
    comments: [],              // [{ id, by, body, kind: 'comment'|'question', at }]
    links: [],                 // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,               // { by, at } when an agent has claimed it to work on
    assignee: normalizeAssignee(fields.assignee), // who it's assigned to (usually the human "you"); distinct from an agent claim
    archived: false,           // hidden from the board (kept, restorable) once true
    archivedAt: null,
    source: String(fields.source || 'manual'),
    // Who/what last touched this ticket, and how. The dashboard uses these to
    // decide whether a change was made by the user (source "dashboard") or by
    // Claude/the CLI in the background, and whether it was a status change.
    lastEventType: 'created',
    lastEventSource: String(fields.source || 'manual'),
    createdAt: now,
    updatedAt: now,
    order: Date.now(),
  };
  writeJson(ticketFile(slug, id), ticket);
  queueEventNotification(slug, ticket, 'created', ticket.lastEventSource);
  return ticket;
}

// Decode an optional [{ name, base64 }] list (dashboard image paste/drop) into
// [{ name, buffer }]. Data-URL prefixes are stripped. Bad entries are dropped.
function asDataImages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || typeof d.base64 !== 'string') continue;
    const b64 = d.base64.replace(/^data:[^;]+;base64,/, '');
    try {
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length) out.push({ name: d.name, buffer });
    } catch (_) {
      /* skip */
    }
  }
  return out;
}

function normalizeLabels(labels) {
  if (!labels) return [];
  const arr = Array.isArray(labels) ? labels : String(labels).split(',');
  const seen = new Set();
  const out = [];
  for (const l of arr) {
    const v = String(l).trim().slice(0, 40);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.slice(0, 12);
}

// A ticket's declared file scope: the repo-relative paths (or directory
// prefixes) it expects to touch. Purely declarative — nothing enforces it —
// but it lets readyWaves() partition ready work into parallel-safe waves
// mechanically instead of the orchestrator eyeballing "no shared files".
function normalizeFiles(files) {
  if (!files) return [];
  const arr = Array.isArray(files) ? files : String(files).split(',');
  const seen = new Set();
  const out = [];
  for (const f of arr) {
    const v = String(f).trim().replace(/\\/g, '/').replace(/\/+$/, '').slice(0, 200);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.slice(0, 20);
}

// Do two declared scopes collide? A path conflicts with an equal path or with
// one that is a directory-prefix of it (case-insensitive, "/"-normalized).
// Empty scopes never conflict mechanically — "no declaration" means "no
// information", and the skill tells the orchestrator how to treat that.
function scopesOverlap(filesA, filesB) {
  const a = normalizeFiles(filesA).map((f) => f.toLowerCase());
  const b = normalizeFiles(filesB).map((f) => f.toLowerCase());
  if (!a.length || !b.length) return false;
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
    }
  }
  return false;
}

// Partition the ready set into waves an orchestrator can fan out one wave at a
// time: within a wave no two tickets' declared scopes overlap. Greedy first-fit
// in priority order, so wave 1 is "start these now", wave 2 "after wave 1",
// etc. Tickets with no declared files never mechanically conflict (see above).
function readyWaves(slug, opts) {
  const ready = readyTickets(slug, opts);
  const waves = [];
  for (const t of ready) {
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((w) => scopesOverlap(w.files, t.files))) {
        wave.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([t]);
  }
  return waves;
}

// An assignee is a free-form name (the human "you", or an agent). Empty/blank
// clears it back to null (unassigned).
function normalizeAssignee(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  return s || null;
}

// Apply a partial update. Only known fields are written; unknown keys ignored.
// Locked (like every other mutator) so a concurrent comment/claim/link append
// can never be silently overwritten by an update whose read predates it.
function updateTicket(slug, idOrRef, patch) {
  const found = getTicket(slug, idOrRef);
  if (!found) return null;
  patch = patch || {};
  const apply = (t) => {
    const prevStatus = t.status;
    if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
    if (patch.description != null) t.description = String(patch.description).trim();
    if (patch.status != null) t.status = coerceStatus(patch.status, t.status);
    if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
    if (patch.labels != null) t.labels = normalizeLabels(patch.labels);
    if (patch.storyId !== undefined) t.storyId = coerceStoryId(slug, patch.storyId);
    if (patch.model !== undefined) { const m = coerceModel(patch.model); if (m) t.model = m; }     // never clears the tier: an invalid/'any'/'none' patch leaves it unchanged
    if (patch.effort !== undefined) { const e = coerceEffort(patch.effort); if (e) t.effort = e; } // same for effort: once set it can only change to another valid level
    // Complexity can move to another valid score, never clear; a fresh motivation
    // rides along whenever one is provided (the CLI demands one on change).
    if (patch.complexity !== undefined) { const c = coerceComplexity(patch.complexity); if (c) t.complexity = c; }
    if (patch.complexityWhy !== undefined && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1000);
    if (patch.files !== undefined) t.files = normalizeFiles(patch.files);
    if (patch.executorAnchors !== undefined) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors');
    if (patch.executorVerify !== undefined) t.executorVerify = executorText(patch.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command');
    // A provenance stamp may ride along a patch (e.g. the dashboard completing a
    // ticket). Permissive like the routing fields above: a valid stamp is set, a
    // bad one is ignored rather than thrown (the data layer never crashes a write).
    if (patch.workedBy !== undefined) {
      try { const w = makeWorkedBy(patch.workedBy); if (w) t.workedBy = w; } catch (_) { /* ignore an invalid stamp on a patch */ }
    }
    if (patch.assignee !== undefined) t.assignee = normalizeAssignee(patch.assignee);
    if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
    // Attach any newly supplied images (by path from the CLI, or base64 from the
    // dashboard). Also allow removing an attached asset by filename.
    const imgs = Array.isArray(patch.images) ? patch.images : [];
    for (const src of imgs) {
      try {
        t.assets.push(copyAsset(slug, t.id, src));
      } catch (e) {
        if (patch.onAssetError) patch.onAssetError(src, e);
      }
    }
    for (const d of asDataImages(patch.imagesData)) {
      try {
        t.assets.push(saveAssetData(slug, t.id, d.name, d.buffer));
      } catch (_) {
        /* skip */
      }
    }
    if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
      const drop = new Set(patch.removeAssets.map((f) => path.basename(String(f))));
      t.assets = t.assets.filter((a) => {
        if (!drop.has(a)) return true;
        try {
          fs.unlinkSync(assetPath(slug, t.id, a));
        } catch (_) {
          /* ignore */
        }
        return false;
      });
    }
    // Record the event: a status move vs. a plain edit, and who made it. Source
    // defaults to "cli" (the CLI / a subagent), so only the dashboard tags itself.
    t.lastEventType = t.status !== prevStatus ? 'status' : 'edit';
    t.lastEventSource = patch.source ? String(patch.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return t;
  };
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock); // best-effort: still applies the update if contention outlasts the retries
  try {
    const t = getTicket(slug, found.id); // fresh read, under the lock when we have it
    if (!t) return null;
    return apply(t);
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Locked so a delete can never yank the ticket/lock file out from under a
// concurrent addComment/claimTicket that still believes it holds the lock.
function deleteTicket(slug, idOrRef) {
  const found = getTicket(slug, idOrRef);
  if (!found) return false;
  const deletedRef = found.ref;
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock);
  let ok = true;
  try {
    try {
      fs.unlinkSync(ticketFile(slug, found.id));
    } catch (_) {
      ok = false;
    }
    if (ok) {
      try {
        fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
      } catch (_) {
        /* best effort */
      }
    }
  } finally {
    if (locked) releaseLock(lock); // also removes the lock file itself
  }
  if (!ok) return false;
  // Drop any links other tickets had pointing at the one we just removed, so no
  // dangling "blocked-by SQ-deleted" leaves a ticket falsely blocked forever.
  try {
    for (const other of listTickets(slug)) {
      if (Array.isArray(other.links) && other.links.some((l) => upperRef(l.ref) === upperRef(deletedRef))) {
        stripLinksTo(slug, other.id, deletedRef);
      }
    }
  } catch (_) {
    /* best effort */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Archiving: put finished work out of the way without deleting it
 *
 *  An archived ticket is kept (and fully restorable) but hidden from the board,
 *  the counts, and `next`. This is how "clear out the Done column" works without
 *  losing the record.
 * ------------------------------------------------------------------ */

function setArchived(slug, idOrRef, archived, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    t.archived = !!archived;
    t.archivedAt = archived ? new Date().toISOString() : null;
    t.lastEventType = archived ? 'archived' : 'restored';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    return { ok: true, ticket: t };
  });
}

function archiveTicket(slug, idOrRef, opts) {
  return setArchived(slug, idOrRef, true, opts);
}
function unarchiveTicket(slug, idOrRef, opts) {
  return setArchived(slug, idOrRef, false, opts);
}

// Archive every done, not-yet-archived ticket in a project. Returns the refs.
function archiveAllDone(slug, opts) {
  const refs = [];
  for (const t of listTickets(slug)) {
    if (t.status === 'done' && !t.archived) {
      const res = setArchived(slug, t.id, true, opts);
      if (res.ok) refs.push(res.ticket.ref);
    }
  }
  return { ok: true, archived: refs };
}

function listArchived(slug) {
  return listTickets(slug).filter((t) => t.archived);
}
function listActive(slug) {
  return listTickets(slug).filter((t) => !t.archived);
}

/* ------------------------------------------------------------------ *
 *  Claiming: safe hand-off of a ticket to a worker (agent)
 *
 *  Several agents (or Claude sessions / dashboard tabs) can share a board, so a
 *  ticket must be *claimed* before anyone works it, and the claim must be
 *  atomic: two workers can never both win the same ticket. We serialize the
 *  check-and-set with a per-ticket lock file created via O_EXCL (an atomic
 *  "create only if absent" on every mainstream filesystem). The lock is held
 *  only for the few milliseconds it takes to re-read the ticket and stamp the
 *  claim; the claim itself lives on the ticket as `claim: { by, at }`.
 *
 *  Because the claim is checked against a *fresh* read under the lock, "don't
 *  pick it up before checking it's still there" is guaranteed: if the ticket was
 *  deleted, finished, or grabbed by another worker in the meantime, the claim
 *  fails instead of double-working it.
 * ------------------------------------------------------------------ */

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function priorityRank(p) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? PRIORITY_RANK[p] : 9;
}

// How long a claim stays valid without being refreshed before another worker
// may take it over (a crashed/abandoned worker must never wedge a ticket).
function claimTtlMs() {
  const min = Number(process.env.SIDEQUEST_CLAIM_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 60) * 60 * 1000;
}

function isClaimStale(claim) {
  if (!claim || !claim.at) return true;
  const t = Date.parse(claim.at);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > claimTtlMs();
}

function ticketLockPath(slug, id) {
  return path.join(ticketsDir(slug), '.' + path.basename(String(id)) + '.lock');
}

// A tiny synchronous pause. The lock is contended only under genuinely
// simultaneous claims and is held for microseconds, so this never runs long.
function busyWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

// Acquire a short-lived exclusive lock for a ticket. A lock file older than a
// few seconds is treated as abandoned (holder crashed mid-claim) and reclaimed,
// so a crash can never permanently wedge a ticket.
function acquireLock(lockPath) {
  const STALE_LOCK_MS = 5000;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, String(process.pid) + ' ' + new Date().toISOString());
      } catch (_) {
        /* ignore */
      }
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return false;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch (_) {
            /* ignore */
          }
          continue;
        }
      } catch (_) {
        continue; // lock vanished between open and stat: retry immediately
      }
      busyWait(5);
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (_) {
    /* ignore */
  }
}

function withTicketLock(slug, id, fn) {
  const lock = ticketLockPath(slug, id);
  if (!acquireLock(lock)) return { ok: false, reason: 'busy' };
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

// Atomically claim a ticket for worker `by`. Refuses (ok:false) if the ticket is
// gone, already done, or actively claimed by someone else — unless that claim is
// stale or opts.force is set. On success sets claim and moves it to "doing"
// (unless opts.status === false).
function claimTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id); // fresh read, under the lock
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'claimed', ticket: t, claim: held };
    }
    t.claim = { by, at: new Date().toISOString() };
    if (opts.status !== false) t.status = coerceStatus(opts.status || 'doing', t.status);
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    // Tie this claim to the worker's session so a SessionEnd/SubagentStop hook can
    // release it immediately instead of waiting out the TTL. No-op without a session id.
    if (opts.sessionId) registerWorker(opts.sessionId, slug, t.id, by);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
}

// Release a claim. Only the owner (or a stale claim) may release unless
// opts.force; opts.status optionally moves the ticket at the same time.
function releaseTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    // A ticket that finished is done — never yanked back to another status by a
    // release racing behind it. This closes a TOCTOU window: a caller (notably
    // reconcileSession, which pre-checks status on an unlocked read taken before
    // it could get this lock) can be scheduled between a completeTicket() clearing
    // the claim and this fresh read; without this guard, the empty claim would
    // vacuously pass the ownership check below and opts.status would stomp the
    // ticket straight back to "todo", silently un-completing finished work.
    // Mirrors claimTicket's own "done" refusal just above.
    if (t.status === 'done' && !opts.force) return { ok: false, reason: 'done', ticket: t };
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    }
    t.claim = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (opts.workedBy) t.workedBy = opts.workedBy; // self-reported provenance stamp (done transition only)
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    // Drop this claim from the session registry — it's no longer outstanding, so a
    // later reconcile of the same session won't try to touch it (keyed on the
    // ticket, so a blank `by` on the done doesn't matter). No-op without a session id.
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
}

// Build the provenance stamp recorded when a ticket is completed — which model
// tier (or the Codex model that actually backed it) and reasoning effort worked
// it, plus who and when. Returns null when no model is supplied. A supplied model
// must be a VALID_MODELS tier OR a discovered catalog slug (a Codex-backed tier
// records the real model that ran); effort, if present, a VALID_EFFORTS level
// (null/omitted allowed — haiku has no effort). Anything else throws.
function makeWorkedBy(input, _prefs) {
  if (!input) return null;
  const rawModel = input.model;
  if (rawModel == null || String(rawModel).trim() === '') return null; // no stamp when not provided
  const model = coerceModel(rawModel) || String(rawModel).trim().toLowerCase();
  const known = VALID_MODELS.indexOf(model) !== -1 || !!PROFILE_TIER[model] || !!discoveredBySlug()[model];
  if (!known) {
    throw new Error(`invalid model "${rawModel}" — expected one of: ${VALID_MODELS.join(', ')} (or a discovered Codex model)`);
  }
  let effort = null;
  const rawEffort = input.effort;
  if (rawEffort != null && String(rawEffort).trim() !== '') {
    const e = String(rawEffort).trim().toLowerCase();
    if (VALID_EFFORTS.indexOf(e) === -1) {
      throw new Error(`invalid effort "${rawEffort}" — expected one of: ${VALID_EFFORTS.join(', ')} (or omit for none)`);
    }
    effort = e;
  }
  const by = input.by != null && String(input.by).trim() ? String(input.by).trim() : null;
  const at = input.at && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
  return { model, effort, by, at };
}

// Complete a ticket: mark it done and clear its claim. An optional { model,
// effort } (from `done --model … --effort …`) is recorded as a workedBy
// provenance stamp; invalid values throw before anything is written.
function completeTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  const workedBy = makeWorkedBy({ model: opts.model, effort: opts.effort, by });
  return releaseTicket(slug, idOrRef, by, Object.assign({}, opts, { status: 'done', workedBy }));
}

// True when a ticket may be handed to a worker running as tier `want`: either the
// worker didn't specify a tier, or the tags match. Every ticket now carries a
// tier, so a filtered tier-X worker only gets exact-tier matches (no untagged
// pass-through).
function modelMatches(ticketModel, want) {
  return !want || ticketModel === want;
}

// The tickets that are ready to be worked right now: not done, not archived, not
// actively claimed, and not blocked by an unfinished ticket. This is the set to
// fan subagents out over (each still claims before working). Priority-ordered.
// opts.model restricts to that tier's work (exact-tier matches only).
function readyTickets(slug, opts) {
  opts = opts || {};
  const want = coerceModel(opts.model); // one of the four tiers; unknown/blank → null (no filter)
  return listTickets(slug)
    .filter((t) => !t.archived)
    .filter((t) => t.status !== 'done')
    .filter((t) => !t.claim || isClaimStale(t.claim))
    .filter((t) => !isBlocked(slug, t))
    .filter((t) => modelMatches(t.model, want))
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
}

// Atomically claim the best available ticket in a project: highest priority
// first, oldest-first within a priority. Skips done tickets and ones actively
// claimed by another worker. Returns { ok:true, ticket } or { reason:'empty' }.
function claimNext(slug, by, opts) {
  opts = opts || {};
  by = String(by || 'agent');
  const want = coerceModel(opts.model); // one of the four tiers; unknown/blank → null (no filter)
  const candidates = listTickets(slug)
    .filter((t) => !t.archived)
    .filter((t) => t.status !== 'done')
    .filter((t) => !t.claim || isClaimStale(t.claim) || t.claim.by === by)
    .filter((t) => !opts.priority || t.priority === String(opts.priority).toLowerCase())
    .filter((t) => modelMatches(t.model, want)) // a tier-X worker only claims X-tagged work
    .filter((t) => opts.includeBlocked || !isBlocked(slug, t)) // never auto-hand-out blocked work
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
  for (const cand of candidates) {
    const res = claimTicket(slug, cand.id, by, { source: opts.source, sessionId: opts.sessionId });
    if (res.ok) return res;
    // Lost the race or it changed under us — try the next candidate.
  }
  return { ok: false, reason: 'empty' };
}

// Assign (or, with a null/blank assignee, unassign) a ticket. Assignment is a
// persistent "who owns this" marker — unlike claimTicket it has no TTL, does not
// move the ticket to "doing", and does not gate ready/next. It's how a human
// takes a ticket for themselves (assignee "you") or an agent hands one back.
function assignTicket(slug, idOrRef, assignee, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    t.assignee = normalizeAssignee(assignee);
    t.lastEventType = 'edit';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    return { ok: true, ticket: t };
  });
}

/* ------------------------------------------------------------------ *
 *  Stories (a user story groups tickets and tints their cards)
 *
 *  Stored one JSON file per story under projects/<slug>/stories/, minted US-1,
 *  US-2, … from meta.storySeq — deliberately parallel to how tickets live under
 *  tickets/ with SQ-N refs. A ticket points at its story by the story's stable
 *  id (ticket.storyId), never its ref, so renumbering or ref lookups can't orphan
 *  the link. Lower-contention than tickets (created/edited rarely, one human),
 *  so these use a plain read-modify-write rather than the per-item lock tickets need.
 * ------------------------------------------------------------------ */

function storiesDir(slug) {
  return path.join(projectDir(slug), 'stories');
}
function storyFile(slug, id) {
  return path.join(storiesDir(slug), `${path.basename(String(id))}.json`);
}
function newStoryId() {
  return 'st_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

// Every story in a project, oldest-first (US-1 before US-2) so a legend/filter
// reads in creation order. Fail-soft to [] when the folder doesn't exist yet.
function listStories(slug) {
  let files = [];
  try {
    files = fs.readdirSync(storiesDir(slug)).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    const s = readJson(path.join(storiesDir(slug), f), null);
    if (s && s.id) out.push(s);
  }
  out.sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}

// Look up a story by its stable id or its human ref (US-4, case-insensitive).
function getStory(slug, idOrRef) {
  const direct = readJson(storyFile(slug, idOrRef), null);
  if (direct && direct.id) return direct;
  const wanted = String(idOrRef).toUpperCase();
  for (const s of listStories(slug)) {
    if (String(s.ref).toUpperCase() === wanted) return s;
  }
  return null;
}

// Resolve a caller-supplied story reference (a US-ref, a raw id, "none"/"null",
// or null) to a valid story id in this project, or null if it clears / doesn't
// resolve. This is the single guard both createTicket and updateTicket run
// storyId through, so a ticket can never point at a story that isn't there.
function coerceStoryId(slug, val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') return null;
  const story = getStory(slug, s);
  return story ? story.id : null;
}

function createStory(slug, fields) {
  fields = fields || {};
  const id = newStoryId();
  const seq = nextStorySeq(slug);
  const now = new Date().toISOString();
  const story = {
    id,
    ref: `US-${seq}`,
    title: String(fields.title || 'Untitled story').trim().slice(0, 200) || 'Untitled story',
    description: String(fields.description || '').trim(),
    // A requested colour wins if it parses; otherwise cycle the palette by the
    // sequence number so successive stories stay visually distinct.
    color: parseStoryColor(fields.color) || autoStoryColor(seq - 1),
    createdAt: now,
    updatedAt: now,
    order: Date.now(),
  };
  writeJson(storyFile(slug, id), story);
  return story;
}

// Apply a partial update to a story. An unparseable colour is ignored rather
// than blanking the existing one.
function updateStory(slug, idOrRef, patch) {
  const s = getStory(slug, idOrRef);
  if (!s) return null;
  patch = patch || {};
  if (patch.title != null) s.title = String(patch.title).trim().slice(0, 200) || s.title;
  if (patch.description != null) s.description = String(patch.description).trim();
  if (patch.color != null) {
    const c = parseStoryColor(patch.color);
    if (c) s.color = c;
  }
  if (patch.order != null && Number.isFinite(Number(patch.order))) s.order = Number(patch.order);
  s.updatedAt = new Date().toISOString();
  writeJson(storyFile(slug, s.id), s);
  return s;
}

// Delete a story and detach it from its member tickets (clearing storyId, the
// same way deleteTicket strips dangling links) so no card is left tinted by a
// story that no longer exists.
function deleteStory(slug, idOrRef) {
  const s = getStory(slug, idOrRef);
  if (!s) return false;
  try {
    fs.unlinkSync(storyFile(slug, s.id));
  } catch (_) {
    return false;
  }
  try {
    for (const t of listTickets(slug)) {
      if (t.storyId === s.id) updateTicket(slug, t.id, { storyId: null, source: 'cli' });
    }
  } catch (_) {
    /* best effort — the story file is already gone */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Comments
 *
 *  Each ticket carries a thread of comments. A comment of kind "question" is how
 *  an agent (or the user) flags that it needs a reply — the dashboard treats it
 *  as a higher-signal notification. Appends happen under the ticket lock so two
 *  simultaneous comments never clobber each other.
 * ------------------------------------------------------------------ */

const COMMENT_KINDS = ['comment', 'question'];
// The hard storage cap for a single comment body. A body over this used to be
// silently sliced to fit (SQ-173), so the tail of a long note vanished with no
// signal to the caller. addComment now rejects an over-cap body instead of
// truncating, so the write is either stored whole or fails loudly.
const COMMENT_BODY_MAX = 4000;

function newCommentId() {
  return 'c_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// Comment bodies are stored verbatim except for control bytes that have no place
// in prose. A raw NUL is the offender behind SQ-174: an author describing a
// NUL-separated key (e.g. `source + '\0' + slug`) can smuggle a literal 0x00
// into the body, and a NUL is a C-string terminator that silently truncates or
// corrupts anything downstream that treats the body as a C string. Read back,
// that lone NUL among hundreds of intact spaces looked like "a space turned into
// \x00" (it never was: spaces are 0x20 and are left untouched). Strip the C0
// control range and DEL, keeping only the whitespace that legitimately appears
// in prose (tab, newline, carriage return). This runs at the one shared write
// path, so the MCP `comment`/`ask` tools, the CLI `comment` command, and the
// dashboard all get the same normalization.
function stripControlChars(s) {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function addComment(slug, idOrRef, fields) {
  fields = fields || {};
  const body = stripControlChars(String(fields.body || '')).trim();
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > COMMENT_BODY_MAX) {
    return { ok: false, reason: 'too_long', max: COMMENT_BODY_MAX, length: body.length };
  }
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (!Array.isArray(t.comments)) t.comments = [];
    const kind = COMMENT_KINDS.indexOf(String(fields.kind)) !== -1 ? String(fields.kind) : 'comment';
    const source = fields.source ? String(fields.source) : 'cli';
    const comment = {
      id: newCommentId(),
      by: String(fields.by || 'agent'),
      kind,
      body, // over-cap bodies are rejected above, never silently truncated
      source, // 'cli' (agent) or 'dashboard' (the human) — who needsResponse() listens for
      at: new Date().toISOString(),
    };
    t.comments.push(comment);
    t.lastEventType = kind === 'question' ? 'question' : 'comment';
    t.lastEventSource = source;
    t.updatedAt = comment.at;
    writeJson(ticketFile(slug, t.id), t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, { commentBody: comment.body });
    return { ok: true, ticket: t, comment };
  });
}

// True while the most recent agent-asked question (kind=question, source=cli)
// has not yet been followed by any comment from the dashboard (the human). An
// agent-authored follow-up comment in between (e.g. a note-to-self) does not
// count as an answer — only the human replying does.
function needsResponse(ticket) {
  const comments = (ticket && Array.isArray(ticket.comments)) ? ticket.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.source === 'dashboard') return false;
    if (c.kind === 'question') return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 *  Links / dependencies
 *
 *  A link is stored on both tickets with the correct direction, so either side
 *  can see the relationship. User-facing verbs map onto three stored types:
 *  blocks / blocked-by / related. "A depends-on B" == "A blocked-by B" (B must
 *  finish first) == "B blocks A".
 * ------------------------------------------------------------------ */

const LINK_TYPES = ['blocks', 'blocked-by', 'related'];

// Map a user verb to [typeStoredOnFrom, typeStoredOnTo].
function linkTypePair(verb) {
  switch (String(verb || '').toLowerCase().replace(/_/g, '-')) {
    case 'blocks':
    case 'blocking':
      return ['blocks', 'blocked-by'];
    case 'blocked-by':
    case 'blockedby':
    case 'depends-on':
    case 'dependson':
    case 'depends':
    case 'needs':
    case 'after':
      return ['blocked-by', 'blocks'];
    case 'related':
    case 'related-to':
    case 'relates-to':
    case 'relates':
      return ['related', 'related'];
    default:
      return null;
  }
}

function upperRef(r) {
  return String(r).toUpperCase();
}

// Add one directed link to a single ticket (idempotent), under its lock.
function addLinkToTicket(slug, idOrRef, type, otherRef) {
  const found = getTicket(slug, idOrRef);
  if (!found) return;
  withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return;
    if (!Array.isArray(t.links)) t.links = [];
    const ref = upperRef(otherRef);
    if (!t.links.some((l) => l.type === type && upperRef(l.ref) === ref)) {
      t.links.push({ type, ref });
      t.updatedAt = new Date().toISOString();
      writeJson(ticketFile(slug, t.id), t);
    }
  });
}

// Link two tickets by a verb, writing the correct direction on each side.
function linkTickets(slug, fromRef, verb, toRef) {
  const pair = linkTypePair(verb);
  if (!pair) return { ok: false, reason: 'bad_type' };
  const from = getTicket(slug, fromRef);
  const to = getTicket(slug, toRef);
  if (!from) return { ok: false, reason: 'from_not_found' };
  if (!to) return { ok: false, reason: 'to_not_found' };
  if (from.id === to.id) return { ok: false, reason: 'self' };
  addLinkToTicket(slug, from.id, pair[0], to.ref);
  addLinkToTicket(slug, to.id, pair[1], from.ref);
  return { ok: true, from: getTicket(slug, from.id), to: getTicket(slug, to.id), type: pair[0] };
}

// Remove every link between two tickets (both directions).
function unlinkTickets(slug, aRef, bRef) {
  const a = getTicket(slug, aRef);
  const b = getTicket(slug, bRef);
  if (!a || !b) return { ok: false, reason: 'not_found' };
  stripLinksTo(slug, a.id, b.ref);
  stripLinksTo(slug, b.id, a.ref);
  return { ok: true };
}

function stripLinksTo(slug, idOrRef, otherRef) {
  const found = getTicket(slug, idOrRef);
  if (!found) return;
  withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !Array.isArray(t.links)) return;
    const ref = upperRef(otherRef);
    const kept = t.links.filter((l) => upperRef(l.ref) !== ref);
    if (kept.length !== t.links.length) {
      t.links = kept;
      t.updatedAt = new Date().toISOString();
      writeJson(ticketFile(slug, t.id), t);
    }
  });
}

// The refs a ticket is blocked-by that are not yet done (i.e. genuinely blocking).
function openBlockers(slug, ticket) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out = [];
  for (const l of ticket.links) {
    if (l.type !== 'blocked-by') continue;
    const blocker = getTicket(slug, l.ref);
    if (blocker && blocker.status !== 'done') out.push(blocker.ref);
  }
  return out;
}

function isBlocked(slug, ticket) {
  return openBlockers(slug, ticket).length > 0;
}

// Resolve a ticket's open blockers against an in-memory ref->ticket index
// (uppercased refs), instead of openBlockers()'s per-link getTicket fallback:
// links store "SQ-n" refs while ticket files are named by id, so the per-link
// path degenerates into a full-board rescan per link.
function openBlockersFromIndex(index, ticket) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out = [];
  for (const l of ticket.links) {
    if (l.type !== 'blocked-by') continue;
    const blocker = index.get(String(l.ref).toUpperCase());
    if (blocker && blocker.status !== 'done') out.push(blocker.ref);
  }
  return out;
}

// A compact projection of a ticket for orchestration reads (`--brief` on the
// CLI, `brief: true` over MCP): everything an orchestrator needs to route,
// batch, and spawn, none of the bodies. A full ticket carries its whole
// description and comment thread, which an orchestrator scanning a board pays
// for on every read without needing; the executor working the ticket reads the
// full record instead. opts.blockedBy short-circuits the blocker lookup when
// the caller already knows it (the ready set is unblocked by construction);
// opts.index resolves blockers in memory. Bare briefTicket(slug, t) still
// works but pays the per-link scan.
function briefTicket(slug, t, opts) {
  opts = opts || {};
  let blockedBy;
  if (Array.isArray(opts.blockedBy)) blockedBy = opts.blockedBy;
  else if (opts.index) blockedBy = openBlockersFromIndex(opts.index, t);
  else blockedBy = openBlockers(slug, t);
  return {
    ref: t.ref,
    title: t.title,
    status: t.status,
    priority: t.priority,
    complexity: t.complexity || null,
    profile: t.profile || null,
    model: t.model || null,
    backend: t.exec ? t.exec.backend : null,
    runsModel: t.exec ? t.exec.runsModel : null,
    runsLabel: t.exec ? t.exec.runsLabel : null,
    executor: t.exec ? t.exec.agent : null,
    effort: t.effort || null,
    files: Array.isArray(t.files) ? t.files : [],
    claim: t.claim && t.claim.by ? { by: t.claim.by, at: t.claim.at, stale: isClaimStale(t.claim) } : null,
    blockedBy,
    comments: Array.isArray(t.comments) ? t.comments.length : 0,
    awaitingReply: needsResponse(t),
  };
}

// A list cursor is just the next row offset, carried as an opaque decimal
// string. Kept transparent (not base64) so `--cursor 150` is usable by hand and
// a script can pipe nextCursor straight back. Garbage or a negative decodes to
// the first page rather than throwing.
function decodeListCursor(cursor) {
  if (cursor == null || cursor === '') return 0;
  const n = Math.floor(Number(cursor));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Slice one page out of the filtered tickets and report where the next page
// starts. Three page modes, in precedence order:
//   - all: the whole set from the cursor, no cap (the escape hatch).
//   - limit: an exact page size (start .. start+limit).
//   - maxChars: a size-budgeted page — accumulate rows until the serialized
//     cost would cross the budget (always keep at least one, so a lone fat row
//     still advances the cursor and iteration can't stall).
//   - none of the above: the whole set from the cursor (CLI default / small
//     board — one call returns everything, backward compatible).
// nextCursor is the next offset as a string, or null when the page reaches the
// end. Because each page is a contiguous slice and the next cursor is exactly
// where it stopped, following nextCursor to exhaustion yields every ticket once.
function pageTickets(tickets, opts) {
  const total = tickets.length;
  const start = Math.min(decodeListCursor(opts.cursor), total);
  const limit = opts.limit != null ? Math.max(0, Math.floor(Number(opts.limit)) || 0) : null;
  const budget = opts.maxChars != null && Number(opts.maxChars) > 0 ? Number(opts.maxChars) : null;

  let end;
  if (opts.all) {
    end = total;
  } else if (limit != null) {
    end = Math.min(start + limit, total);
  } else if (budget != null) {
    let size = 0;
    end = start;
    while (end < total) {
      // Size against the SAME pretty serialization the transports emit
      // (JSON.stringify(payload, null, 2)), so the budget is in real output
      // chars. +8 covers the array indent / comma-newline overhead per row.
      const cost = JSON.stringify(tickets[end], null, 2).length + 8;
      if (end > start && size + cost > budget) break;
      size += cost;
      end++;
    }
  } else {
    end = total;
  }

  const page = tickets.slice(start, end);
  const nextCursor = end < total ? String(end) : null;
  return { tickets: page, total, returned: page.length, nextCursor };
}

// The one board-read payload both transports (CLI --json and MCP) serve, so
// their shapes cannot drift: filtering, the brief projection, the blocker
// index, and paging (limit/cursor/maxChars -> total/returned/nextCursor) all
// live here and nowhere else.
function listPayload(slug, opts) {
  opts = opts || {};
  const all = listTickets(slug);
  let tickets = opts.archived ? all.filter((t) => t.archived) : all.filter((t) => !t.archived);
  if (opts.status) {
    const statuses = (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status) => String(status).toLowerCase());
    tickets = tickets.filter((t) => statuses.includes(t.status));
  }
  if (opts.brief) {
    // Blockers may live outside the filtered set, so index the whole board.
    const index = new Map(all.map((t) => [String(t.ref).toUpperCase(), t]));
    tickets = tickets.map((t) => briefTicket(slug, t, { index }));
  }
  return pageTickets(tickets, opts);
}

// Same for the ready read. Waves are ALWAYS arrays of refs (both transports,
// brief or not) — full tickets ride only in `tickets`, so nothing is
// serialized twice and the field has one shape. Ready tickets are unblocked by
// construction, so brief projections skip the blocker lookup outright.
function readyPayload(slug, opts) {
  opts = opts || {};
  let tickets = readyTickets(slug, { model: opts.model });
  const waves = readyWaves(slug, { model: opts.model }).map((wave) => wave.map((t) => t.ref));
  if (opts.brief) tickets = tickets.map((t) => briefTicket(slug, t, { blockedBy: [] }));
  return { tickets, waves };
}

/* ------------------------------------------------------------------ *
 *  Notifications
 *
 *  A single, persistent, per-user queue (one notifications.json under
 *  projectsRoot(), a sibling to the project dirs). Unlike the old client-side
 *  toasts/badges — which were derived on the fly from ticket diffs and lost on
 *  reload — these survive a server restart, because reminders must be able to
 *  fire even when no dashboard tab is open. Appends/mutations go through a single
 *  queue lock so two writers can never clobber each other, mirroring the
 *  read-modify-write-under-lock pattern used for tickets.
 * ------------------------------------------------------------------ */

const NOTIFICATION_KINDS = ['question', 'comment', 'created', 'status', 'reminder'];

// The four background-event kinds a user can opt in/out of from the dashboard's
// settings popover (a 'reminder' notification isn't optional this way — only
// *when* it fires is, via fireAt). Kept server-side, not just in the dashboard's
// localStorage, so the queue below can honor the same opt-outs even when no
// dashboard tab is open to gate on the client's behalf.
const NOTIFY_PREF_DEFAULTS = { question: true, comment: true, created: true, status: true };

// How many *read* notifications to retain. Unread ones are always kept; this
// only caps the tail of already-seen history so the file can't grow forever.
const MAX_READ_KEPT = 100;

function notificationsFile() {
  return path.join(projectsRoot(), 'notifications.json');
}
function notificationsLockPath() {
  return path.join(projectsRoot(), '.notifications.lock');
}

function newNotificationId() {
  return 'nt_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// Fail-soft read: a missing/corrupt file degrades to an empty queue.
function readNotifications() {
  const data = readJson(notificationsFile(), null);
  return data && Array.isArray(data.notifications) ? data.notifications : [];
}
function writeNotifications(list) {
  writeJson(notificationsFile(), { notifications: list });
}

// Serialize every mutation on the queue behind one lock (best-effort, like the
// ticket mutators: still applies if contention outlasts the retries).
function withNotificationsLock(fn) {
  const lock = notificationsLockPath();
  const locked = acquireLock(lock);
  try {
    return fn();
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Drop the oldest read notifications past the cap; never touches unread ones.
function pruneReadList(list) {
  const read = list.filter((n) => n.readAt);
  if (read.length <= MAX_READ_KEPT) return list;
  read.sort((a, b) => String(b.readAt).localeCompare(String(a.readAt)));
  const dropIds = new Set(read.slice(MAX_READ_KEPT).map((n) => n.id));
  return list.filter((n) => !dropIds.has(n.id));
}

// List notifications, newest first. opts: { projectSlug, kind, unreadOnly,
// includePending, limit }. A reminder scheduled for the future (fireAt > now) is
// hidden until it's due unless includePending is set.
function listNotifications(opts) {
  opts = opts || {};
  const now = Date.now();
  let list = readNotifications();
  if (opts.projectSlug) list = list.filter((n) => n.projectSlug === opts.projectSlug);
  if (opts.kind) list = list.filter((n) => n.kind === opts.kind);
  if (opts.unreadOnly) list = list.filter((n) => !n.readAt);
  if (!opts.includePending) {
    list = list.filter((n) => !(n.fireAt && Number.isFinite(Date.parse(n.fireAt)) && Date.parse(n.fireAt) > now));
  }
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (opts.limit != null && Number.isFinite(Number(opts.limit))) list = list.slice(0, Number(opts.limit));
  return list;
}

// Append a notification and return it. Unknown kinds coerce to "comment".
// fireAt is only meaningful for reminders (a scheduled future time); everything
// else leaves it null. Prunes read history in the same locked write.
function addNotification(fields) {
  fields = fields || {};
  const kind = NOTIFICATION_KINDS.indexOf(String(fields.kind)) !== -1 ? String(fields.kind) : 'comment';
  const now = new Date().toISOString();
  const notification = {
    id: newNotificationId(),
    kind,
    title: String(fields.title || '').slice(0, 300),
    body: String(fields.body || '').slice(0, 4000),
    projectSlug: fields.projectSlug ? String(fields.projectSlug) : null,
    ticketRef: fields.ticketRef ? String(fields.ticketRef) : null,
    ticketId: fields.ticketId ? String(fields.ticketId) : null,
    createdAt: now,
    readAt: null,
    fireAt: fields.fireAt ? String(fields.fireAt) : null,
    // Only set by queueEventNotification(), purely to dedupe a background-event
    // notification against the ticket mutation that produced it; unused/null
    // for a manually-scheduled reminder.
    ticketEventAt: fields.ticketEventAt ? String(fields.ticketEventAt) : null,
    // Set by fireDueReminders() the first tick after a reminder's fireAt has
    // passed. Purely bookkeeping — visibility in the live queue already follows
    // from fireAt <= now (see listNotifications), so nothing reads this to
    // decide whether to show the notification. It just marks "the scheduler has
    // seen this one go off", which is what a restart-safe scheduler needs to be
    // idempotent about.
    firedAt: null,
  };
  return withNotificationsLock(() => {
    const list = readNotifications();
    list.push(notification);
    writeNotifications(pruneReadList(list));
    return notification;
  });
}

/* ------------------------------------------------------------------ *
 *  Notify prefs (server-side mirror of the dashboard's opt-in/out settings)
 *
 *  A tiny sibling file to notifications.json. The dashboard used to keep this
 *  purely in localStorage, which meant the client had to be open to gate a
 *  background event; now the queue below checks the same server-side copy so
 *  an opted-out kind is never enqueued in the first place, tab or no tab.
 * ------------------------------------------------------------------ */

function notifyPrefsFile() {
  return path.join(projectsRoot(), 'notify-prefs.json');
}

// Read the saved opt-in/out settings. Missing/corrupt file -> all on, matching
// the dashboard's own NOTIFY_DEFAULTS.
function getNotifyPrefs() {
  const saved = readJson(notifyPrefsFile(), null);
  const merged = Object.assign({}, NOTIFY_PREF_DEFAULTS, saved && typeof saved === 'object' ? saved : {});
  const out = {};
  for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = merged[k] !== false;
  return out;
}

// Persist a partial or full set of opt-in/out prefs. Unknown keys are dropped.
function setNotifyPrefs(patch) {
  const next = Object.assign({}, getNotifyPrefs(), patch || {});
  const out = {};
  for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = next[k] !== false;
  writeJson(notifyPrefsFile(), out);
  return out;
}

/* ------------------------------------------------------------------ *
 *  Model prefs (which agent tiers AND effort levels the user wants offered)
 *
 *  A per-user allowlist over VALID_MODELS *and* VALID_EFFORTS, stored like
 *  notify-prefs. This is a UI/routing preference, not a data rule: the dashboard
 *  hides disabled tiers from its Model picker, routingLadder drops disabled
 *  effort levels from the within-band spread, and the skill tells the
 *  orchestrator to treat a disabled tier/effort as unavailable — but coerceModel
 *  / coerceEffort stay permissive, so a ticket already tagged with a disabled
 *  tier/effort keeps its tag (and still renders) rather than losing data.
 * ------------------------------------------------------------------ */

function modelPrefsFile() {
  return path.join(projectsRoot(), 'model-prefs.json');
}

// The provider-neutral EXECUTION-PLAN view over the tier prefs (SQ-188): one
// entry per profile with its tier, enabled flag, resolved runtime (backend +
// what actually runs, with a human label), its effort row, and which
// complexities the CURRENT ladder routes to it. Derived on every read, never
// persisted — the tier-keyed file stays the storage shape, so a legacy prefs
// file (tier booleans, per-tier effort matrix, tierBackend) maps into profiles
// losslessly by construction, and the tested ladder stays the routing truth.
function deriveProfilesView(prefs) {
  const byTier = prefs.tierBackendResolved || resolveTierBackends(prefs.tierBackend).byTier;
  const ladder = routingLadder(prefs);
  const out = {};
  for (const grade of VALID_MODELS) {
    const b = byTier[grade] || { backend: 'claude', slug: GRADE_TIER[grade], id: GRADE_TIER[grade], label: null };
    const runtime = b.slug || GRADE_TIER[grade];
    const complexities = ladder.filter((r) => r.model === grade).map((r) => r.complexity);
    out[grade] = {
      grade,
      label: GRADE_LABELS[grade],
      enabled: prefs[grade] !== false,
      backend: b.backend,
      runsModel: runtime,
      runsLabel: b.label || CLAUDE_RUNTIME_LABELS[runtime],
      efforts: gradeHasEffort(grade, prefs) ? Object.assign({}, (prefs.efforts && prefs.efforts[grade]) || {}) : null,
      complexities,
      range: complexities.length ? [complexities[0], complexities[complexities.length - 1]] : null,
    };
  }
  return out;
}

// Translate a profile-keyed patch into the tier-keyed shape setModelPrefs has
// always persisted. Accepted profile forms, all optional and all additive over
// the existing tier/effort/tierBackend keys (which keep working unchanged):
//   { profiles: { everyday: false } }                      → { sonnet: false }
//   { profiles: { complex: { enabled, backend, efforts } } }
//       enabled → the tier boolean; backend ("claude"|slug) → tierBackend[tier];
//       efforts (partial row) → efforts[tier] (ignored for routine/haiku)
//   { routine: false }                                     → { haiku: false }
//   { tierBackend: { frontier: <slug> } }                  → tierBackend.fable
// Only the translation lives here; guards, merging, and persistence are the
// existing tier-keyed logic below, so nothing profile-shaped ever hits disk.
// PRECEDENCE: an explicit tier-keyed value in the same patch always beats a
// profile-derived one. This matters because getModelPrefs() now returns
// `profiles` alongside the tier keys, and the dashboard PUTs the whole object
// back — a stale profile echo riding a legacy-shaped patch must never clobber
// the tier toggle the user actually flipped.
function translateProfilePatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = Object.assign({}, patch);
  const src = patch.profiles && typeof patch.profiles === 'object' ? patch.profiles : null;
  delete out.profiles;
  const explicitBackend = patch.tierBackend && typeof patch.tierBackend === 'object' ? patch.tierBackend : {};
  const explicitEfforts = patch.efforts && typeof patch.efforts === 'object' ? patch.efforts : {};
  if (src) {
    for (const alias of Object.keys(src)) {
      const grade = coerceModel(alias);
      if (!grade) continue;
      const v = src[alias];
      if (v && typeof v === 'object') {
        if ('enabled' in v && !(grade in patch)) out[grade] = v.enabled !== false;
        if ('backend' in v && !(grade in explicitBackend)) out.tierBackend = Object.assign({}, out.tierBackend, { [grade]: v.backend });
        if (v.efforts && typeof v.efforts === 'object') {
          out.efforts = Object.assign({}, out.efforts, { [grade]: Object.assign({}, v.efforts, explicitEfforts[grade]) });
        }
      } else if (!(grade in patch)) out[grade] = v !== false;
    }
  }
  for (const alias of Object.keys(PROFILE_TIER)) {
    if (!(alias in out)) continue;
    const grade = PROFILE_TIER[alias];
    const v = out[alias];
    delete out[alias];
    if (typeof v !== 'object' && !(grade in patch)) out[grade] = v !== false;
  }
  if (out.tierBackend && typeof out.tierBackend === 'object') {
    const tb = Object.assign({}, out.tierBackend);
    for (const alias of Object.keys(PROFILE_TIER)) {
      if (alias in tb) {
        const grade = PROFILE_TIER[alias];
        if (!(grade in explicitBackend)) tb[grade] = tb[alias];
        delete tb[alias];
      }
    }
    out.tierBackend = tb;
  }
  return out;
}

// Missing/corrupt file -> every tier enabled, every effort enabled in every
// model row, routing on, and a neutral (0) bias. `routing` is the master switch:
// when false the skill's model/effort enforcement stands down and the main agent
// may work any ticket itself (tags become informational). `routingBias` (-5..+5)
// warps the complexity ladder routingLadder() derives from the enabled tiers
// (see coerceRoutingBias).
//
// Effort is a PER-MODEL MATRIX, not global booleans: `efforts` is one row per
// non-haiku tier ({ sonnet:{low..max}, opus:{...}, fable:{...} }) so a single
// (model, effort) combo like opus·medium can be excluded while sonnet·medium
// stays. Haiku has no efforts row (no effort axis). The flat effort keys
// (low/medium/high/xhigh/max) are NOT present on the returned object anymore.
//
// Migration on read: a legacy file that predates the matrix has no `efforts`
// object but may carry the old flat effort keys — seed EVERY model row from
// those flat values so an existing allowlist survives the upgrade unchanged.
function getModelPrefs() {
  const saved = readJson(modelPrefsFile(), null);
  const merged = saved && typeof saved === 'object' ? saved : {};
  const out = {};
  for (const grade of VALID_MODELS) {
    const legacy = GRADE_TIER[grade];
    out[grade] = merged[grade] !== false && merged[legacy] !== false;
  }

  const savedEfforts = merged.efforts && typeof merged.efforts === 'object' ? merged.efforts : null;
  // Only fall back to legacy flat keys when there's no matrix at all.
  const hasLegacyFlat = !savedEfforts && VALID_EFFORTS.some((e) => e in merged);
  out.efforts = {};
  for (const m of EFFORT_MODELS) {
    const legacy = GRADE_TIER[m];
    const savedRow = savedEfforts && (merged.efforts[m] || merged.efforts[legacy]) && typeof (merged.efforts[m] || merged.efforts[legacy]) === 'object'
      ? (merged.efforts[m] || merged.efforts[legacy]) : null;
    const row = {};
    for (const e of VALID_EFFORTS) {
      if (savedRow) row[e] = savedRow[e] !== false;
      else if (hasLegacyFlat) row[e] = merged[e] !== false; // broadcast the old global flag into this row
      else row[e] = true;
    }
    out.efforts[m] = row;
  }
  out.routing = merged.routing !== false;
  out.routingBias = coerceRoutingBias(merged.routingBias);

  // Per-tier model backend (1.36.0): tierBackend maps each tier to "claude"
  // (default) or a discovered Codex slug. `discovered` (the current catalog) is
  // resolved fresh on every read for the dashboard's dropdown options, and
  // `tierBackendWarnings` names any tier whose mapped model isn't available now.
  //
  // The 1.35.0 `customOverrides`/`custom` keys are obsolete: strip them from the
  // persisted file the first time we see one (only Kenny's machine ever wrote
  // them), so an old file doesn't carry dead state forever.
  out.tierBackend = normalizeTierBackend(merged.tierBackend);
  const resolvedBackends = resolveTierBackends(out.tierBackend);
  out.tierBackendResolved = resolvedBackends.byTier;
  out.tierBackendWarnings = resolvedBackends.warnings;
  out.discovered = discoverExternalModels();

  out.profiles = deriveProfilesView(out);
  if (JSON.stringify(merged) !== JSON.stringify(persistedPrefs(out))) writeJson(modelPrefsFile(), persistedPrefs(out));
  return out;
}

// Persist a partial or full set. Unknown keys are dropped; refuses to disable
// every tier at once (the last enabled tier stays on) so routing always has
// somewhere to go.
//
// Accepts BOTH effort shapes in the patch: a nested `efforts` object (partial
// rows allowed, merged per-key over the current matrix) AND legacy flat effort
// keys (low/medium/…), which broadcast to EVERY model row — an old dashboard tab
// PUTs the whole flat object, and this keeps it working. Only the nested matrix
// is written to disk. Per-row guard mirrors the tier guard: each model row keeps
// at least one effort enabled (fallback medium). The `routing` switch and
// `routingBias` dial carry through independently; routingBias clamps on write.
function persistedPrefs(prefs) {
  const out = {};
  for (const grade of VALID_MODELS) out[grade] = prefs[grade] !== false;
  out.efforts = prefs.efforts;
  out.routing = prefs.routing !== false;
  out.routingBias = coerceRoutingBias(prefs.routingBias);
  out.tierBackend = normalizeTierBackend(prefs.tierBackend);
  return out;
}

function setModelPrefs(patch) {
  const cur = getModelPrefs();
  // Profile-keyed patches (the neutral execution-plan vocabulary, SQ-188) are
  // translated to tier keys up front; everything below — guards, merging, and
  // the persisted tier-keyed shape — is unchanged.
  patch = translateProfilePatch(patch || {});
  const out = {};

  // Tiers: carried from the current set unless the patch names them.
  for (const m of VALID_MODELS) out[m] = (m in patch) ? patch[m] !== false : cur[m];
  if (!VALID_MODELS.some((m) => out[m])) out['grade-2'] = true;

  // Efforts: start from the current matrix, layer any legacy flat keys over every
  // row, then layer a nested patch row per-key on top (nested wins over flat).
  const patchEfforts = patch.efforts && typeof patch.efforts === 'object' ? patch.efforts : null;
  const flatKeys = VALID_EFFORTS.filter((e) => e in patch);
  out.efforts = {};
  for (const m of EFFORT_MODELS) {
    const row = Object.assign({}, cur.efforts[m]);
    for (const e of flatKeys) row[e] = patch[e] !== false;
    const legacy = GRADE_TIER[m];
    const pr = patchEfforts && (patchEfforts[m] || patchEfforts[legacy]) && typeof (patchEfforts[m] || patchEfforts[legacy]) === 'object'
      ? (patchEfforts[m] || patchEfforts[legacy]) : null;
    if (pr) for (const e of VALID_EFFORTS) { if (e in pr) row[e] = pr[e] !== false; }
    if (!VALID_EFFORTS.some((e) => row[e])) row.medium = true; // per-row guard: never leave a tier effortless
    out.efforts[m] = row;
  }

  out.routing = (patch.routing !== undefined) ? patch.routing !== false : cur.routing;
  out.routingBias = coerceRoutingBias(patch.routingBias !== undefined ? patch.routingBias : cur.routingBias);

  // Per-tier backend (1.36.0): `patch.tierBackend` is a partial map keyed by
  // tier, each value "claude" (or the tier name / "") to clear a mapping, or a
  // discovered slug to point that tier at a Codex model. Merged per-tier over the
  // current map; omitting it preserves the current mapping. Any 1.35.0
  // `customOverrides`/`custom` in the patch is ignored (dead shape). `discovered`
  // and the resolved backends are re-derived on read, never persisted.
  const mergedBackend = Object.assign({}, cur.tierBackend);
  if (patch.tierBackend && typeof patch.tierBackend === 'object') {
    for (const grade of VALID_MODELS) {
      const legacy = GRADE_TIER[grade];
      if (grade in patch.tierBackend) mergedBackend[grade] = patch.tierBackend[grade];
      else if (legacy in patch.tierBackend) mergedBackend[grade] = patch.tierBackend[legacy];
    }
  }
  out.tierBackend = normalizeTierBackend(mergedBackend);

  writeJson(modelPrefsFile(), persistedPrefs(out));

  // Resolve after the write so the persisted file carries only tierBackend, while
  // the returned object also has the derived catalog + resolution for callers.
  const resolvedBackends = resolveTierBackends(out.tierBackend);
  out.tierBackendResolved = resolvedBackends.byTier;
  out.tierBackendWarnings = resolvedBackends.warnings;
  out.discovered = discoverExternalModels();
  out.profiles = deriveProfilesView(out);
  return out;
}

// Build the title/body for a background-event notification, mirroring the
// dashboard's own maybeNotify() toast copy so a persisted inbox entry reads the
// same as the desktop toast the user may also have seen for the same event.
function eventNotificationCopy(ticket, kind, extra) {
  extra = extra || {};
  const ref = ticket.ref;
  if (kind === 'question') return { title: `❓ Question · ${ref}`, body: extra.commentBody || ticket.title };
  if (kind === 'comment') {
    return { title: `💬 Comment · ${ref}`, body: extra.commentBody ? `${extra.commentBody}  —  ${ticket.title}` : ticket.title };
  }
  if (kind === 'created') return { title: `New side quest · ${ref}`, body: ticket.title };
  return { title: `${ref} → ${ticket.status}`, body: ticket.title }; // 'status'
}

// The server-side counterpart to the dashboard's old isBackgroundChange(): a
// mutation made by something other than the dashboard itself (Claude/the CLI),
// of a kind the user hasn't opted out of, gets a durable inbox entry. Called
// right where each mutator below stamps lastEventType/lastEventSource, so it
// fires exactly once per real event — no polling/diffing needed — and works
// even with no dashboard tab open (the whole point: reminders and this queue
// now share one seam instead of the client deriving toasts from ticket diffs).
// Dedupes on ticketId+kind+the ticket's own updatedAt so a retried mutation (or
// any other double-call) can never enqueue the same event twice.
function queueEventNotification(slug, ticket, kind, source, extra) {
  if (!ticket || !source || String(source) === 'dashboard') return null; // your own action never notifies you
  if (NOTIFY_PREF_DEFAULTS[kind] == null) return null; // not an opt-in-able kind (e.g. 'edit'/'archived')
  if (!getNotifyPrefs()[kind]) return null; // opted out for this kind, globally
  const pmeta = readMeta(slug);
  if (pmeta && pmeta.notify === false) return null; // this whole board is muted
  const eventAt = ticket.updatedAt;
  const dup = readNotifications().some((n) => n.ticketId === ticket.id && n.kind === kind && n.ticketEventAt === eventAt);
  if (dup) return null;
  const copy = eventNotificationCopy(ticket, kind, extra);
  return addNotification({
    kind,
    title: copy.title,
    body: copy.body,
    projectSlug: slug,
    ticketRef: ticket.ref,
    ticketId: ticket.id,
    ticketEventAt: eventAt,
  });
}

// Mark one notification read (idempotent). Returns the updated record, or null
// if no such id.
function markRead(id) {
  return withNotificationsLock(() => {
    const list = readNotifications();
    let updated = null;
    for (const n of list) {
      if (n.id === id) {
        if (!n.readAt) n.readAt = new Date().toISOString();
        updated = n;
        break;
      }
    }
    if (updated) writeNotifications(list);
    return updated;
  });
}

// Mark every unread notification read. Returns how many were flipped.
function markAllRead() {
  return withNotificationsLock(() => {
    const list = readNotifications();
    const now = new Date().toISOString();
    let count = 0;
    for (const n of list) {
      if (!n.readAt) {
        n.readAt = now;
        count++;
      }
    }
    if (count) writeNotifications(list);
    return count;
  });
}

// Remove a notification outright. Returns true if one was removed.
function dismiss(id) {
  return withNotificationsLock(() => {
    const list = readNotifications();
    const kept = list.filter((n) => n.id !== id);
    if (kept.length === list.length) return false;
    writeNotifications(kept);
    return true;
  });
}

// Trim read history down to the cap. Returns how many were removed.
function pruneRead() {
  return withNotificationsLock(() => {
    const list = readNotifications();
    const pruned = pruneReadList(list);
    const removed = list.length - pruned.length;
    if (removed) writeNotifications(pruned);
    return removed;
  });
}

/* ------------------------------------------------------------------ *
 *  Reminders
 *
 *  A reminder *is* a notification (kind: 'reminder') whose fireAt is set in
 *  the future — listNotifications() above already hides those from the normal
 *  feed and shows them (unread) the instant fireAt passes. That means the
 *  "pending -> live" transition needs no explicit step: it's a pure function
 *  of the wall clock re-evaluated on every read, so it survives a server
 *  restart for free (nothing in memory to lose — it's re-derived from the
 *  persisted fireAt every time). What's left for this section: a per-ticket
 *  lookup so the dashboard can render a "bell in 1h" chip and offer to cancel
 *  it, and a small idempotent tick the running server can call periodically.
 * ------------------------------------------------------------------ */

// ticketId -> the single soonest still-pending (fireAt in the future) reminder
// for that ticket, built from one read of the notifications file. A ticket
// only ever has at most one pending reminder (setReminder enforces that), but
// this tolerates more turning up (e.g. hand-edited data) by picking the
// earliest.
function pendingReminders() {
  const now = Date.now();
  const map = new Map();
  for (const n of readNotifications()) {
    if (n.kind !== 'reminder' || !n.ticketId) continue;
    if (!n.fireAt || !Number.isFinite(Date.parse(n.fireAt)) || Date.parse(n.fireAt) <= now) continue;
    const existing = map.get(n.ticketId);
    if (!existing || Date.parse(n.fireAt) < Date.parse(existing.fireAt)) map.set(n.ticketId, n);
  }
  return map;
}

// The pending reminder for a single ticket, or null.
function getPendingReminder(ticketId) {
  if (!ticketId) return null;
  return pendingReminders().get(ticketId) || null;
}

// Schedule (or reschedule) a reminder on a ticket. fireAt must parse to a
// moment in the future. At most one pending reminder per ticket — setting a
// new one cancels whatever was pending, same as "snoozing" it.
function setReminder(slug, idOrRef, fireAt) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  const when = fireAt ? new Date(String(fireAt)) : null;
  if (!when || Number.isNaN(when.getTime())) return { ok: false, reason: 'bad_fireAt' };
  if (when.getTime() <= Date.now()) return { ok: false, reason: 'in_past' };
  cancelReminder(slug, ticket.id);
  const notification = addNotification({
    kind: 'reminder',
    title: 'Reminder: ' + ticket.title,
    body: ticket.ref + ' — ' + ticket.title,
    projectSlug: slug,
    ticketRef: ticket.ref,
    ticketId: ticket.id,
    fireAt: when.toISOString(),
  });
  return { ok: true, notification };
}

// Cancel whatever reminder is currently pending on a ticket. Not finding one
// isn't an error — cancelling a reminder that already fired (or never
// existed) is a no-op the caller can treat as success.
function cancelReminder(slug, idOrRef) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  return withNotificationsLock(() => {
    const list = readNotifications();
    const now = Date.now();
    let removed = 0;
    const kept = list.filter((n) => {
      const pending = n.kind === 'reminder' && n.ticketId === ticket.id &&
        n.fireAt && Number.isFinite(Date.parse(n.fireAt)) && Date.parse(n.fireAt) > now;
      if (pending) { removed++; return false; }
      return true;
    });
    if (removed) writeNotifications(kept);
    return { ok: true, removed };
  });
}

// Called periodically (and once at boot) by the running dashboard server.
// Marks any reminder whose fireAt has passed as fired — idempotent bookkeeping
// only, since the notification is already showing up (unread) in the live
// feed by virtue of fireAt <= now (see listNotifications). Re-reading the
// persisted fireAt on every call is what makes this restart-safe: a reminder
// due while the server was down is caught on the very next tick after it
// comes back up, with no separate "replay" logic needed.
function fireDueReminders() {
  return withNotificationsLock(() => {
    const list = readNotifications();
    const now = Date.now();
    let fired = 0;
    for (const n of list) {
      if (n.kind !== 'reminder' || n.firedAt) continue;
      if (!n.fireAt || !Number.isFinite(Date.parse(n.fireAt)) || Date.parse(n.fireAt) > now) continue;
      n.firedAt = new Date().toISOString();
      fired++;
    }
    if (fired) writeNotifications(list);
    return fired;
  });
}

/* ------------------------------------------------------------------ *
 *  Worker registry (session -> the claims it holds)
 *
 *  The claim TTL (default 60 min) is the backstop that frees a crashed worker's
 *  ticket. But when a *session* ends cleanly, we know its claims are dead right
 *  then — no reason to make a dependent wait out the TTL. The SessionEnd hook
 *  fires on that boundary; it has the session id but a claim is tagged
 *  only with an opaque `--by`. This tiny registry is the missing link: it maps a
 *  session id to the claims taken under it, so reconcileSession() can release
 *  exactly those (and only those — never another live session's) on the spot.
 *
 *  One file, projects/workers.json, a sibling to notifications.json:
 *    { sessions: { <sessionId>: { updatedAt, claims: [{ slug, ticketId, by, at }] } } }
 *
 *  Fail-soft throughout: a missing/garbage file degrades to an empty registry,
 *  and any hiccup here must never break a claim (the TTL still covers us). The
 *  registry is an OPTIMIZATION over the TTL, not a new source of truth — nothing
 *  reads it to decide whether a claim is valid, only to speed up releasing it.
 * ------------------------------------------------------------------ */

// Sessions untouched for this long with no live claims are pruned on write, so
// the file can't grow forever from sessions that ended without a reconcile hook.
const WORKER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function workersFile() {
  return path.join(projectsRoot(), 'workers.json');
}
function workersLockPath() {
  return path.join(projectsRoot(), '.workers.lock');
}
function readWorkers() {
  const d = readJson(workersFile(), null);
  return d && typeof d === 'object' && d.sessions && typeof d.sessions === 'object' ? d : { sessions: {} };
}
function writeWorkers(obj) {
  writeJson(workersFile(), obj);
}
function withWorkersLock(fn) {
  const lock = workersLockPath();
  const locked = acquireLock(lock);
  try {
    return fn();
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Drop sessions with no claims left, and any whose last activity is older than
// the TTL (a session that ended without its reconcile hook ever firing). Mutates
// and returns the registry object.
function pruneWorkers(w) {
  const cutoff = Date.now() - WORKER_SESSION_TTL_MS;
  for (const sid of Object.keys(w.sessions)) {
    const s = w.sessions[sid];
    const claims = s && Array.isArray(s.claims) ? s.claims : [];
    const ts = s && s.updatedAt ? Date.parse(s.updatedAt) : NaN;
    if (!claims.length || (Number.isFinite(ts) && ts < cutoff)) delete w.sessions[sid];
  }
  return w;
}

// Record that `sessionId` now holds a claim on (slug, ticketId) under worker id
// `by`. Idempotent per (slug, ticketId). No-op without a session id — the whole
// feature is dormant (and the TTL covers everything) until an id starts flowing.
function registerWorker(sessionId, slug, ticketId, by) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const now = new Date().toISOString();
      const s = w.sessions[sessionId] || (w.sessions[sessionId] = { updatedAt: now, claims: [] });
      s.updatedAt = now;
      if (!Array.isArray(s.claims)) s.claims = [];
      if (!s.claims.some((c) => c.slug === slug && c.ticketId === ticketId)) {
        s.claims.push({ slug, ticketId, by: by || null, at: now });
      }
      writeWorkers(pruneWorkers(w));
    });
  } catch (_) {
    /* the TTL is the backstop — a registry write failure must never break a claim */
  }
}

// Forget a claim (the worker finished or dropped it). No-op without a session id.
function unregisterClaim(sessionId, slug, ticketId) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s || !Array.isArray(s.claims)) return;
      s.claims = s.claims.filter((c) => !(c.slug === slug && c.ticketId === ticketId));
      s.updatedAt = new Date().toISOString();
      writeWorkers(pruneWorkers(w));
    });
  } catch (_) {
    /* best effort */
  }
}

// Record that the SubagentStop hook already surfaced a runaway note for this exact
// claim, keyed on the claim's OWN start time so a later re-claim of the same ticket
// counts as a fresh flaggable run. Returns true the FIRST time and false on every
// repeat. Without this, each subsequent SubagentStop in the session re-emitted the
// same note as additionalContext — which re-woke the stopping child and turned one
// long run into a nag loop. Fail-open (returns true) if the registry can't be read:
// better a rare duplicate note than a swallowed real one.
function markLongRunFlagged(sessionId, slug, ticketId, claimAt) {
  if (!sessionId || !slug || !ticketId) return true;
  let first = true;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s) return; // no registered claims here — nothing to dedupe against
      const key = `${slug}\u0000${ticketId}\u0000${claimAt || ''}`;
      if (!Array.isArray(s.flagged)) s.flagged = [];
      if (s.flagged.indexOf(key) !== -1) {
        first = false;
        return;
      }
      s.flagged.push(key);
      s.updatedAt = new Date().toISOString();
      writeWorkers(w);
    });
  } catch (_) {
    return true;
  }
  return first;
}

// Release every claim registered to `sessionId` that is still genuinely held by
// that session's worker and not finished — moving each ticket back to `todo` and
// leaving a note. This is what the SessionEnd hook calls. Safe by construction:
// it only touches tickets the registry attributes to THIS session,
// and skips any that were completed or re-claimed by someone else in the interim.
// Idempotent — the session's registry entry is cleared as part of the pass, so a
// second call finds nothing. Returns { ok, released: [ref...] }.
function reconcileSession(sessionId, opts) {
  opts = opts || {};
  const reason = opts.reason ? String(opts.reason) : 'worker session ended';
  const source = opts.source ? String(opts.source) : 'cli';
  const released = [];
  if (!sessionId) return { ok: true, released };

  // Snapshot this session's claims and clear its registry entry in one locked
  // step, so a concurrent reconcile of the same session can't double-release.
  let claims = [];
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      claims = s && Array.isArray(s.claims) ? s.claims.slice() : [];
      if (s) {
        delete w.sessions[sessionId];
        writeWorkers(w);
      }
    });
  } catch (_) {
    return { ok: true, released };
  }

  for (const c of claims) {
    let t;
    try {
      t = getTicket(c.slug, c.ticketId);
    } catch (_) {
      continue;
    }
    if (!t || t.archived || t.status === 'done') continue; // finished work is left alone
    if (!t.claim || !t.claim.by) continue; // already released
    if (c.by && t.claim.by !== c.by) continue; // re-claimed by someone else since — not ours to touch
    try {
      const res = releaseTicket(c.slug, c.ticketId, t.claim.by, { status: 'todo', source });
      if (res && res.ok) {
        released.push(t.ref);
        try {
          addComment(c.slug, c.ticketId, {
            by: 'sidequest',
            kind: 'comment',
            source,
            body: `↩️ Auto-released to **todo**: ${reason} (was claimed by \`${t.claim.by}\`). It's back in the ready pool for another worker.`,
          });
        } catch (_) {
          /* the release is what matters; the note is a courtesy */
        }
      }
    } catch (_) {
      /* one bad ticket must not abort the rest of the reconcile */
    }
  }
  return { ok: true, released };
}

// Read-only view of the claims the registry attributes to `sessionId`, each with
// the claim's OWN start `at` timestamp — the raw material a SubagentStop hook uses
// to spot a runaway (long-running) executor post-hoc. Unlike reconcileSession this
// mutates NOTHING: it snapshots the registry entry and resolves each claim's ticket
// ref/status for naming, skipping tickets that have since vanished. Returns [] for
// an unknown/absent session. Fail-soft: any hiccup degrades to []. Like the rest of
// the registry it is a convenience over the TTL, never a source of truth about
// whether a claim is valid. Shape: [{ slug, ticketId, ref, by, at, status, held }].
function sessionClaims(sessionId) {
  const out = [];
  if (!sessionId) return out;
  let claims = [];
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[String(sessionId)];
      claims = s && Array.isArray(s.claims) ? s.claims.slice() : [];
    });
  } catch (_) {
    return out;
  }
  for (const c of claims) {
    let ref = null;
    let status = null;
    let held = false;
    try {
      const t = getTicket(c.slug, c.ticketId);
      if (t) {
        ref = t.ref;
        status = t.status;
        held = !!(t.claim && t.claim.by && (!c.by || t.claim.by === c.by));
      }
    } catch (_) {
      /* a bad ticket read just yields a bare entry — the `at` still stands */
    }
    out.push({ slug: c.slug, ticketId: c.ticketId, ref, by: c.by || null, at: c.at || null, status, held });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Server lockfile (used by CLI + server to find/reuse a running dashboard)
 * ------------------------------------------------------------------ */

function readServerInfo() {
  return readJson(serverFile(), null);
}
function writeServerInfo(info) {
  writeJson(serverFile(), info);
}
function clearServerInfo() {
  try {
    fs.unlinkSync(serverFile());
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  VALID_STATUS,
  VALID_PRIORITY,
  VALID_MODELS,
  VALID_EFFORTS,
  EXECUTOR_ANCHORS_MAX,
  EXECUTOR_VERIFY_MAX,
  ticketPlanningWarnings,
  MODEL_CAPABILITY_ORDER,
  EXECUTION_PROFILES,
  profileForTier,
  tierForProfile,
  deriveProfilesView,
  coerceComplexity,
  coerceModel,
  routingLadder,
  deriveRouting,
  applyDerivedRouting,
  getModelVocab,
  resolveModelId,
  resolveExec,
  resolveTierBackends,
  normalizeTierBackend,
  classifyModelFilter,
  getModelPrefs,
  setModelPrefs,
  homeRoot,
  projectsRoot,
  serverFile,
  slugify,
  nearestRepoRoot,
  mainWorktreeRoot,
  projectDir,
  ensureProject,
  readMeta,
  listProjects,
  findProject,
  archiveProject,
  unarchiveProject,
  deleteProjectExact,
  mergeProject,
  setProjectNotify,
  copyAsset,
  saveAssetData,
  assetPath,
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  claimTicket,
  releaseTicket,
  completeTicket,
  makeWorkedBy,
  claimNext,
  assignTicket,
  readyTickets,
  readyWaves,
  scopesOverlap,
  normalizeFiles,
  STORY_PALETTE,
  STORY_COLOR_NAMES,
  listStories,
  getStory,
  createStory,
  updateStory,
  deleteStory,
  addComment,
  needsResponse,
  linkTickets,
  unlinkTickets,
  openBlockers,
  isBlocked,
  briefTicket,
  listPayload,
  readyPayload,
  archiveTicket,
  unarchiveTicket,
  archiveAllDone,
  listArchived,
  listActive,
  isClaimStale,
  normalizeLabels,
  NOTIFICATION_KINDS,
  listNotifications,
  addNotification,
  markRead,
  markAllRead,
  dismiss,
  pruneRead,
  getNotifyPrefs,
  setNotifyPrefs,
  pendingReminders,
  getPendingReminder,
  setReminder,
  cancelReminder,
  fireDueReminders,
  readServerInfo,
  writeServerInfo,
  clearServerInfo,
  registerWorker,
  unregisterClaim,
  markLongRunFlagged,
  reconcileSession,
  sessionClaims,
};
