import path from 'node:path';
import { canonicalPath } from './kernel/worktree.js';
import { commandWriteTargets, ignoredTarget, isGitMutation, shellSegments, type ShellSegment } from '../hooks/shared/shell-writes.js';

export type EvidenceWriteScope = {
  evidenceMode?: boolean;
  evidenceWriteRoots?: readonly string[];
  evidenceRepositoryRoot?: string | null;
  worktree?: string | null;
};

function within(root: string, target: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function protectedRoots(scope: EvidenceWriteScope): string[] {
  return [scope.evidenceRepositoryRoot, scope.worktree].filter((root): root is string => Boolean(root));
}

export function evidencePathAllowed(target: string, scope: EvidenceWriteScope): boolean {
  if (!scope.evidenceMode || !path.isAbsolute(target)) return false;
  if (protectedRoots(scope).some((root) => within(root, target))) return false;
  return (scope.evidenceWriteRoots ?? []).some((root) => within(root, target));
}

function refusal(scope: EvidenceWriteScope): string {
  return `sidequest: evidence executor may write only under admitted roots: ${(scope.evidenceWriteRoots ?? []).join(', ') || '(no live evidence scope)'}. Repository paths remain forbidden. Close through done, without commit or submit.`;
}

function nativeTarget(base: string, target: string): string {
  const native = process.platform === 'win32' ? target.replace(/^\/([a-z])(\/|$)/i, '$1:/') : target;
  return path.resolve(base, native);
}

function segmentTargets(segment: ShellSegment, base: string): string[] {
  return [...segment.redirects, ...commandWriteTargets(segment.words)]
    .filter((target) => !ignoredTarget(target))
    .map((target) => nativeTarget(base, target));
}

function changedDirectory(segment: ShellSegment, base: string): string {
  return segment.words[0] === 'cd' && segment.words[1] ? nativeTarget(base, segment.words[1]) : base;
}

function segmentForbidden(segment: ShellSegment, base: string, scope: EvidenceWriteScope): boolean {
  return isGitMutation(segment.words) || segmentTargets(segment, base).some((target) => !evidencePathAllowed(target, scope));
}

function shellDenial(command: string, cwd: string, scope: EvidenceWriteScope): string | null {
  let base = cwd;
  for (const segment of shellSegments(command)) {
    base = changedDirectory(segment, base);
    if (segmentForbidden(segment, base, scope)) return refusal(scope);
  }
  return null;
}

type ToolGuard = (input: Record<string, unknown>, cwd: string, scope: EvidenceWriteScope) => string | null;

function fileDenial(input: Record<string, unknown>, _cwd: string, scope: EvidenceWriteScope): string | null {
  return evidencePathAllowed(String(input.file_path ?? input.path ?? ''), scope) ? null : refusal(scope);
}

const TOOL_GUARDS: Record<string, ToolGuard> = {
  Bash: (input, cwd, scope) => shellDenial(String(input.command ?? ''), cwd, scope),
  PowerShell: (input, cwd, scope) => shellDenial(String(input.command ?? ''), cwd, scope),
  Write: fileDenial, Edit: fileDenial, MultiEdit: fileDenial,
  NotebookEdit: (_input, _cwd, scope) => refusal(scope),
  Agent: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__commit: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__submit: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__integrate: (_input, _cwd, scope) => refusal(scope),
};

export function evidenceToolDenial(tool: string, input: Record<string, unknown>, cwd: string, scope: EvidenceWriteScope): string | null {
  return TOOL_GUARDS[tool]?.(input, cwd, scope) ?? null;
}
