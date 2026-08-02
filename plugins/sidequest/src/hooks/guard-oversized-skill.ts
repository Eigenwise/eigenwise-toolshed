import fs from 'node:fs';
import path from 'node:path';
import { isRecord, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeDeny } from './shared/output.js';

const MAX_BUNDLED_SKILL_BYTES = 256 * 1024;
const KNOWN_BUNDLED_SKILL_BYTES = new Map([['claude-api', 932 * 1024]]);
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

function directoryBytes(directory: string, limit: number): number {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      total += fs.statSync(entryPath).size;
      if (total > limit) return total;
    }
  }
  return total;
}

function main(): void {
  const input = readStdin();
  if (!input || input.tool_name !== 'Skill' || !isDispatchedExecutor(input)) return;
  const name = skillName(input);
  if (!name || !isRecord(input.tool_input)) return;
  const directory = configuredSkillDirectory(input.tool_input, name);
  const bytes = directory ? directoryBytes(directory, MAX_BUNDLED_SKILL_BYTES) : KNOWN_BUNDLED_SKILL_BYTES.get(name) || 0;
  if (bytes <= MAX_BUNDLED_SKILL_BYTES) return;
  writeDeny('PreToolUse', `sidequest: ${name} exceeds the ${MAX_BUNDLED_SKILL_BYTES}-byte executor skill budget. Loading it can overflow this executor's context. Use a targeted Read for the directly needed material, or file a research ticket.`);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
