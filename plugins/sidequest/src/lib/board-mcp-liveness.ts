import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath } from './kernel/worktree.js';

// The Agent guard bundles this module, so the board server and the hook read one marker format even when the
// installed runtime lib is mid-upgrade. Markers are keyed by server pid and record the project: a session id
// rotates on /clear, resume, and compaction while the same server keeps answering (GH-257, GH-310).
const MARKER_PREFIX = 'board-mcp-';
const MARKER_SUFFIX = '.json';

export interface BoardMcpMarker {
  pid: number;
  sessionId: string;
  project: string;
  file: string;
}

export type BoardMcpObservation =
  | { state: 'live' | 'rotated' | 'exited'; marker: BoardMcpMarker }
  | { state: 'absent'; directory: string }
  | { state: 'unreadable'; directory: string; detail: string };

export function boardMcpMarkerDirectory(): string {
  const home = process.env.SIDEQUEST_HOME || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'tmp', 'state');
}

function ownMarkerFile(): string {
  return path.join(boardMcpMarkerDirectory(), `${MARKER_PREFIX}pid-${process.pid}${MARKER_SUFFIX}`);
}

export function writeBoardMcpLiveness(sessionId: string, project: string): void {
  const file = ownMarkerFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, project: project ? canonicalPath(project) : '' }));
  } catch (_) {}
}

export function clearBoardMcpLiveness(): void {
  try {
    fs.rmSync(ownMarkerFile(), { force: true });
  } catch (_) {}
}

function stringProperty(value: object, key: string): string | null {
  const property: unknown = Reflect.get(value, key);
  return typeof property === 'string' ? property : null;
}

// Servers before the pid-keyed format named the marker by session id and recorded only the pid.
function legacySessionId(name: string): string {
  return decodeURIComponent(name.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length));
}

function readMarker(directory: string, name: string): BoardMcpMarker[] {
  const file = path.join(directory, name);
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === null || typeof value !== 'object' || !Number.isInteger(Reflect.get(value, 'pid'))) return [];
    const sessionId = stringProperty(value, 'sessionId') ?? legacySessionId(name);
    return [{ pid: Number(Reflect.get(value, 'pid')), sessionId, project: stringProperty(value, 'project') ?? '', file }];
  } catch (_) {
    return [];
  }
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function observeMarkers(markers: BoardMcpMarker[], sessionId: string, projectKey: string, directory: string): BoardMcpObservation {
  const candidates = markers.filter((marker) => marker.sessionId === sessionId || (projectKey !== '' && marker.project === projectKey));
  const live = candidates.find((marker) => processAlive(marker.pid));
  if (live) return { state: live.sessionId === sessionId ? 'live' : 'rotated', marker: live };
  const exited = candidates.find((marker) => marker.sessionId === sessionId) || candidates[0];
  return exited ? { state: 'exited', marker: exited } : { state: 'absent', directory };
}

export function observeBoardMcp(sessionId: string, project: string): BoardMcpObservation {
  const directory = boardMcpMarkerDirectory();
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.startsWith(MARKER_PREFIX) && name.endsWith(MARKER_SUFFIX));
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? error.code : '';
    return code === 'ENOENT' ? { state: 'absent', directory } : { state: 'unreadable', directory, detail: String(error) };
  }
  const markers = names.flatMap((name) => readMarker(directory, name));
  return observeMarkers(markers, sessionId, project ? canonicalPath(project) : '', directory);
}
