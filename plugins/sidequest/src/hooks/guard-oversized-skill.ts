import fs from 'node:fs';
import path from 'node:path';
import { isRecord, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeDeny } from './shared/output.js';

const MAX_ENTRY_SKILL_BYTES = 256 * 1024;
const SKILL_DIRECTORY_ENV = ['CLAUDE_BUNDLED_SKILLS_DIR', 'CLAUDE_CODE_BUNDLED_SKILLS_DIR', 'SIDEQUEST_BUNDLED_SKILLS_DIR'];
const SKILL_PATH_FIELDS = ['skill_path', 'skillPath', 'path'];

function isDispatchedExecutor(input: HookInput): boolean {
  const agentType = stringField(input, 'agent_type', 'agentType');
  return /^sidequest-exec-dispatch(?:-readonly)?(?:-(?:low|medium|high|xhigh|max))?$/.test(agentType);
}

function skillName(input: HookInput): string | null {
  if (!isRecord(input.tool_input)) return null;
  const value = input.tool_input.skill;
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(value)) return null;
  return value;
}

function configuredSkillDirectory(toolInput: Record<string, unknown>, name: string): string | null {
  for (const field of SKILL_PATH_FIELDS) {
    const value = toolInput[field];
    if (typeof value !== 'string') continue;
    const directory = path.resolve(value);
    if (path.basename(directory) === name && fs.existsSync(directory)) return directory;
  }
  for (const variable of SKILL_DIRECTORY_ENV) {
    const root = process.env[variable];
    if (!root) continue;
    const directory = path.resolve(root, name);
    if (fs.existsSync(directory)) return directory;
  }
  return null;
}

function entryFileBytes(directory: string): number {
  return fs.statSync(path.join(directory, 'SKILL.md')).size;
}

function main(): void {
  const input = readStdin();
  if (!input || input.tool_name !== 'Skill' || !isDispatchedExecutor(input)) return;
  const name = skillName(input);
  if (!name || !isRecord(input.tool_input)) return;
  const directory = configuredSkillDirectory(input.tool_input, name);
  if (!directory) return;
  const bytes = entryFileBytes(directory);
  if (bytes <= MAX_ENTRY_SKILL_BYTES) return;
  writeDeny('PreToolUse', `sidequest: ${name} exceeds the ${MAX_ENTRY_SKILL_BYTES}-byte executor skill budget. Loading it can overflow this executor's context. Use a targeted Read for the directly needed material.`);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
