import fs from 'node:fs';
import path from 'node:path';
import { stringField, type HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';

// Claude Code keys its LSP diagnostics registry per SESSION, not per agent (claude.exe 2.1.233: the pending
// registry is a WeakMap on session.root, and whichever agent next holds write tools drains it), so a file an
// executor opens in its own worktree publishes errors into the orchestrator's context. There is no interception
// seam: no setting turns it off, and a hook cannot shape an attachment. Telling the receiving agent which paths
// are not its own is the only lever, and the board is the only thing that knows which of them are in flight
// (SQ-1957, SQ-1420).
//
// A swept worktree keeps producing pushes for minutes after its directory is gone, which is the worst case
// because those diagnostics can never be true, so board records are kept past the directory here on purpose.
// They are bounded: an hours-old ended run is not still publishing, and naming it forever would make this noise.
const ENDED_RUN_WINDOW_MS = 2 * 60 * 60 * 1000;

type WorktreeLifecycle = 'live' | 'candidate' | 'ended';

interface DispatchRecord {
  worktree?: string;
  sharedTree?: boolean;
  terminalAt?: string;
  launchedAt?: string;
  preparedAt?: string;
}

interface BoardTicket {
  ref?: string;
  claim?: { by?: string } | null;
  dispatch?: DispatchRecord | null;
}

interface BoardStore {
  findProject: (reference: string) => { ok: boolean; slug?: string };
  listTickets: (slug: string) => BoardTicket[];
  claimReclaimable: (ticket: BoardTicket, now: number) => boolean;
  pendingSubmission: (ticket: BoardTicket) => boolean;
}

interface ForeignWorktree {
  worktree: string;
  ref: string;
  lifecycle: WorktreeLifecycle;
  onDisk: boolean;
}

interface CheckoutLocation {
  checkoutRoot: string;
  projectRoot: string;
}

function gitDirectory(entry: string): string | null {
  try {
    if (fs.statSync(entry).isDirectory()) return entry;
    const linkedGitDirectory = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(entry, 'utf8'))?.[1];
    return linkedGitDirectory ? path.resolve(path.dirname(entry), linkedGitDirectory.trim()) : null;
  } catch (_) {
    return null;
  }
}

function checkoutLocation(start: string): CheckoutLocation | null {
  let current = path.resolve(start);
  for (;;) {
    const found = gitDirectory(path.join(current, '.git'));
    if (found) {
      if (path.basename(found) === '.git') return { checkoutRoot: current, projectRoot: current };
      const commonGitDirectory = path.resolve(found, '..', '..');
      if (path.basename(commonGitDirectory) === '.git') return { checkoutRoot: current, projectRoot: path.dirname(commonGitDirectory) };
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function agentWorktreeRoots(projectRoot: string): string[] {
  try {
    const worktrees = require(runtimeModule('worktrees')) as { agentWorktreeRoots: (repository: string) => string[] };
    return worktrees.agentWorktreeRoots(projectRoot);
  } catch (_) {
    // Sidequest's own root moved outside the project in SQ-1425; this one is the harness's own isolation
    // directory, which is still inside it. Both leak diagnostics, so a missing runtime must not silence either.
    return [path.join(projectRoot, '.claude', 'worktrees')];
  }
}

function endedRecently(dispatch: DispatchRecord, now: number): boolean {
  const at = Date.parse(String(dispatch.terminalAt || dispatch.launchedAt || dispatch.preparedAt || ''));
  return Number.isFinite(at) && now - at <= ENDED_RUN_WINDOW_MS;
}

// The board's own lease verdict, not the age of the claim: a claim it calls reclaimable is a dead executor whose
// diagnostics can only be stale, while a live one is mid-refactor and its errors are expected (SQ-1957).
function lifecycleOf(store: BoardStore, ticket: BoardTicket, dispatch: DispatchRecord, now: number): WorktreeLifecycle {
  if (!dispatch.terminalAt) return ticket.claim?.by && !store.claimReclaimable(ticket, now) ? 'live' : 'ended';
  return store.pendingSubmission(ticket) ? 'candidate' : 'ended';
}

function boardWorktrees(projectRoot: string, now: number): ForeignWorktree[] {
  try {
    const store = require(runtimeModule('store')) as BoardStore;
    const project = store.findProject(projectRoot);
    if (!project.ok || !project.slug) return [];
    return store.listTickets(project.slug).flatMap((ticket) => {
      const dispatch = ticket.dispatch;
      const worktree = String(dispatch?.worktree || '').trim();
      if (!dispatch || !worktree || dispatch.sharedTree !== false) return [];
      const lifecycle = lifecycleOf(store, ticket, dispatch, now);
      if (lifecycle === 'ended' && !endedRecently(dispatch, now)) return [];
      return [{ worktree, ref: String(ticket.ref || ''), lifecycle, onDisk: fs.existsSync(worktree) }];
    });
  } catch (_) {
    return [];
  }
}

// A directory the board has never heard of still leaks, so it is reported rather than skipped, and its lifecycle
// is read as ended rather than guessed at from its name.
function unclaimedWorktreeDirectories(roots: string[]): ForeignWorktree[] {
  return roots.flatMap((root) => {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('agent-'))
        .map((entry) => ({ worktree: path.join(root, entry.name), ref: '', lifecycle: 'ended' as WorktreeLifecycle, onDisk: true }));
    } catch (_) {
      return [];
    }
  });
}

function foreignWorktrees(location: CheckoutLocation, roots: string[], now: number): ForeignWorktree[] {
  const own = comparablePath(location.checkoutRoot);
  const byPath = new Map<string, ForeignWorktree>();
  for (const candidate of [...boardWorktrees(location.projectRoot, now), ...unclaimedWorktreeDirectories(roots)]) {
    const key = comparablePath(candidate.worktree);
    if (key === own || byPath.has(key)) continue;
    byPath.set(key, candidate);
  }
  return [...byPath.values()];
}

function refList(worktrees: ForeignWorktree[]): string {
  const refs = worktrees.map((entry) => entry.ref).filter(Boolean).sort();
  return refs.length ? refs.join(', ') : 'an unnamed dispatch';
}

function warningFor(worktrees: ForeignWorktree[], roots: string[]): string {
  const live = worktrees.filter((entry) => entry.lifecycle === 'live');
  const candidates = worktrees.filter((entry) => entry.lifecycle === 'candidate');
  const gone = worktrees.filter((entry) => !entry.onDisk);
  const sentences = [
    `sidequest: ${worktrees.length} foreign agent worktree${worktrees.length === 1 ? '' : 's'} in play, and Claude Code delivers their LSP diagnostics into YOUR context because that registry is keyed per session, not per agent.`,
    `Nothing under ${roots.join(' or ')} is yours.`,
  ];
  if (gone.length) sentences.push(`${gone.length} of those ${gone.length === 1 ? 'paths is' : 'paths are'} already gone from disk, and a diagnostic naming a path that no longer exists is always false.`);
  if (live.length) sentences.push(`${live.length} hold${live.length === 1 ? 's' : ''} a live claim (${refList(live)}): errors there are expected mid-refactor state and never outrank that executor's own verify.`);
  if (candidates.length) sentences.push(`Actionable exception: ${refList(candidates)} hold${candidates.length === 1 ? 's' : ''} a candidate awaiting integration, so a diagnostic in that worktree outweighs an executor's \`verify passed\` and is worth reading before you integrate.`);
  sentences.push('Keep error-severity diagnostics in your own files actionable.');
  return sentences.join(' ');
}

export function diagnosticWorktreeWarning(input: HookInput, now: number = Date.now()): string {
  const start = stringField(input, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const location = checkoutLocation(start);
  if (!location) return '';
  const roots = agentWorktreeRoots(location.projectRoot);
  const worktrees = foreignWorktrees(location, roots, now);
  return worktrees.length ? warningFor(worktrees, roots) : '';
}
