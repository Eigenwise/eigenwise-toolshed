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

function markerField(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function markerText(value: unknown, key: string, fallback: string): string {
  const text = markerField(value, key);
  return typeof text === 'string' ? text : fallback;
}

// Pid 0 probes as alive on Windows, so only a positive pid counts.
function markerPid(value: unknown): number {
  const pid = markerField(value, 'pid');
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : 0;
}

// Servers before the pid-keyed format named the marker by session id and recorded only the pid.
function legacySessionId(name: string): string {
  return decodeURIComponent(name.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length));
}

function readMarker(directory: string, name: string): BoardMcpMarker[] {
  const file = path.join(directory, name);
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = markerPid(value);
    if (!pid) return [];
    return [{ pid, sessionId: markerText(value, 'sessionId', legacySessionId(name)), project: markerText(value, 'project', ''), file }];
  } catch (_) {
    return [];
  }
}

function processAlive(pid: number): boolean {
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

function isMarkerName(name: string): boolean {
  return name.startsWith(MARKER_PREFIX) && name.endsWith(MARKER_SUFFIX);
}

function unlistableMarkers(error: unknown, directory: string): BoardMcpObservation {
  const code = error instanceof Error && 'code' in error ? error.code : '';
  return code === 'ENOENT' ? { state: 'absent', directory } : { state: 'unreadable', directory, detail: String(error) };
}

export function observeBoardMcp(sessionId: string, project: string): BoardMcpObservation {
  const directory = boardMcpMarkerDirectory();
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter(isMarkerName);
  } catch (error: unknown) {
    return unlistableMarkers(error, directory);
  }
  const markers = names.flatMap((name) => readMarker(directory, name));
  return observeMarkers(markers, sessionId, project ? canonicalPath(project) : '', directory);
}
