#!/usr/bin/env node
// Install-day hindsight: one bounded, prompt-free aggregate of a project's past Claude Code sessions.
// Usage: node mine.mjs [project path]
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configDirectoryOf } from './config-directory.mjs';

const WINDOW_DAYS = 90;
const SESSION_LIMIT = 60;
const MINIMUM_HUMAN_PROMPTS = 2;
const LIST_LIMIT = 25;
const NAME_LIMIT = 60;
export const OUTPUT_BUDGET_BYTES = 8192;
const DAY_MS = 86400000;

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const LEADING_CD = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9_-]*$/;
const GENERATED_IDENTIFIER = /(?=[0-9a-f]*\d)[0-9a-f]{8,}/i;
const PLAIN_NAME = /^[\w:.@/-]+$/;
const SLASH_COMMAND = /<command-name>\/?([\w:.-]+)<\/command-name>/;
// Text the harness injects into the user turn; a session made only of these was never typed by a person.
const HARNESS_TEXT = /^\s*(?:\[Request interrupted|<(?:task-notification|system-reminder|local-command-stdout|local-command-caveat|agent-message)\b)/;
// The host labels a hook's nonzero exit as a permission-rule denial; this prefix is the one reliable way to tell them apart.
const HOOK_ERROR_PREFIX = /^PreToolUse:\S+ hook error:/;

export function configDirectory(environment) {
  return configDirectoryOf(environment, homedir());
}

export function projectSlug(projectPath) {
  return path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
}

function directoryEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function belongsToProject(directoryName, slug) {
  const name = directoryName.toLowerCase();
  const wanted = slug.toLowerCase();
  return name === wanted || name.startsWith(`${wanted}--claude-worktrees-`);
}

export function transcriptDirectories(projectsRoot, slug) {
  return directoryEntries(projectsRoot)
    .filter((entry) => entry.isDirectory() && belongsToProject(entry.name, slug))
    .map((entry) => path.join(projectsRoot, entry.name));
}

// A live session can rotate or clean up a transcript between the listing and the stat.
function transcriptAt(file) {
  try {
    return { file, modifiedMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

function transcriptsIn(directory) {
  return directoryEntries(directory)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => transcriptAt(path.join(directory, entry.name)))
    .filter((transcript) => transcript !== null);
}

export function selectTranscripts(directories, nowMs) {
  const cutoffMs = nowMs - WINDOW_DAYS * DAY_MS;
  return directories.flatMap(transcriptsIn)
    .filter((transcript) => transcript.modifiedMs >= cutoffMs)
    .sort((first, second) => second.modifiedMs - first.modifiedMs)
    .slice(0, SESSION_LIMIT);
}

function leadingWords(command) {
  const words = String(command ?? '').trim().replace(LEADING_CD, '').split(/\s+/).filter(Boolean);
  const start = words.findIndex((word) => !ENVIRONMENT_ASSIGNMENT.test(word));
  return start < 0 ? [] : words.slice(start, start + 2);
}

function executableName(word) {
  return word.replace(/["']/g, '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}

function isSubcommand(word) {
  return SUBCOMMAND.test(word) && !GENERATED_IDENTIFIER.test(word);
}

/** The first two words of a shell command with every argument, path and flag dropped: "git push", "npm run". */
export function commandPrefix(command) {
  const [first, second] = leadingWords(command);
  const executable = first ? executableName(first) : '';
  if (!executable) return null;
  return second && isSubcommand(second) ? `${executable} ${second}` : executable;
}

function plainName(value) {
  const name = String(value ?? '');
  return PLAIN_NAME.test(name) ? name.slice(0, NAME_LIMIT) : null;
}

function bump(counts, key) {
  if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function createSessionTally() {
  return {
    humanPrompts: 0,
    firstMs: null,
    lastMs: null,
    pendingTools: new Map(),
    commands: new Map(),
    toolFailures: new Map(),
    denialsByTool: new Map(),
    denialsByKind: new Map(),
    hookBlocks: new Map(),
    skills: new Map(),
    slashCommands: new Map(),
  };
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function isTypedText(block) {
  return block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '' && !HARNESS_TEXT.test(block.text);
}

function isHarnessRecord(record) {
  return record.isMeta === true || record.isVisibleInTranscriptOnly === true || record.isCompactSummary === true;
}

function isHumanPrompt(record) {
  if (record.toolUseResult !== undefined || isHarnessRecord(record)) return false;
  const blocks = contentBlocks(record.message?.content);
  return !blocks.some((block) => block?.type === 'tool_result') && blocks.some(isTypedText);
}

function readHumanPrompt(tally, record) {
  tally.humanPrompts += 1;
  for (const block of contentBlocks(record.message?.content)) {
    bump(tally.slashCommands, SLASH_COMMAND.exec(String(block?.text ?? ''))?.[1]);
  }
}

function blockText(block) {
  return contentBlocks(block?.content).map((part) => String(part?.text ?? '')).join('\n');
}

function denialKind(record, block) {
  const kind = record.toolDenialKind ?? null;
  if (kind !== 'permission-rule') return kind;
  return HOOK_ERROR_PREFIX.test(blockText(block)) ? 'hook_block' : kind;
}

function readDenial(tally, tool, kind) {
  if (kind === 'hook_block') return bump(tally.hookBlocks, tool);
  bump(tally.denialsByTool, tool);
  bump(tally.denialsByKind, plainName(kind));
}

function readToolResult(tally, record, block) {
  const tool = tally.pendingTools.get(block.tool_use_id) ?? 'unknown';
  tally.pendingTools.delete(block.tool_use_id);
  const kind = denialKind(record, block);
  if (kind) return readDenial(tally, tool, kind);
  if (block.is_error === true) bump(tally.toolFailures, tool);
}

function readUserRecord(tally, record) {
  if (isHumanPrompt(record)) return readHumanPrompt(tally, record);
  for (const block of contentBlocks(record.message?.content)) {
    if (block?.type === 'tool_result') readToolResult(tally, record, block);
  }
}

function readToolUse(tally, block) {
  const tool = plainName(block.name) ?? 'unknown';
  tally.pendingTools.set(block.id, tool);
  if (SHELL_TOOLS.has(tool)) bump(tally.commands, commandPrefix(block.input?.command));
  if (tool === 'Skill') bump(tally.skills, plainName(block.input?.skill));
}

function readAssistantRecord(tally, record) {
  for (const block of contentBlocks(record.message?.content)) {
    if (block?.type === 'tool_use') readToolUse(tally, block);
  }
}

const RECORD_READERS = { user: readUserRecord, assistant: readAssistantRecord };

function noteTimestamp(tally, timestamp) {
  const timestampMs = Date.parse(timestamp ?? '');
  if (!Number.isFinite(timestampMs)) return;
  tally.firstMs = Math.min(tally.firstMs ?? timestampMs, timestampMs);
  tally.lastMs = Math.max(tally.lastMs ?? timestampMs, timestampMs);
}

export function readRecord(tally, record) {
  if (!record || record.isSidechain === true) return;
  noteTimestamp(tally, record.timestamp);
  RECORD_READERS[record.type]?.(tally, record);
}

function parseRecord(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function tallyTranscript(file) {
  const tally = createSessionTally();
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) readRecord(tally, parseRecord(line));
  } catch {
    // A transcript deleted or locked mid-scan contributes what was read before the failure.
  }
  return tally;
}

const COUNTED_LISTS = ['commands', 'toolFailures', 'denialsByTool', 'denialsByKind', 'hookBlocks', 'skills', 'slashCommands'];

export function createAggregate() {
  const aggregate = { sessionsScanned: 0, humanSessions: 0, firstMs: null, lastMs: null };
  for (const list of COUNTED_LISTS) aggregate[list] = new Map();
  return aggregate;
}

function mergeCounts(target, source) {
  for (const [name, count] of source) {
    const entry = target.get(name) ?? { count: 0, sessions: 0 };
    target.set(name, { count: entry.count + count, sessions: entry.sessions + 1 });
  }
}

function mergeSpan(aggregate, tally) {
  if (tally.firstMs === null) return;
  aggregate.firstMs = Math.min(aggregate.firstMs ?? tally.firstMs, tally.firstMs);
  aggregate.lastMs = Math.max(aggregate.lastMs ?? tally.lastMs, tally.lastMs);
}

export function addSession(aggregate, tally) {
  aggregate.sessionsScanned += 1;
  if (tally.humanPrompts < MINIMUM_HUMAN_PROMPTS) return;
  aggregate.humanSessions += 1;
  mergeSpan(aggregate, tally);
  for (const list of COUNTED_LISTS) mergeCounts(aggregate[list], tally[list]);
}

function rankedEntries(counts) {
  return [...counts]
    .map(([name, entry]) => ({ name, count: entry.count, sessions: entry.sessions }))
    .sort((first, second) => second.count - first.count || first.name.localeCompare(second.name));
}

function isoDate(milliseconds) {
  return milliseconds === null ? null : new Date(milliseconds).toISOString().slice(0, 10);
}

export function summarize(aggregate, slug) {
  const summary = {
    slug,
    window: { days: WINDOW_DAYS, sessionLimit: SESSION_LIMIT },
    sessionsScanned: aggregate.sessionsScanned,
    humanSessions: aggregate.humanSessions,
    from: isoDate(aggregate.firstMs),
    to: isoDate(aggregate.lastMs),
  };
  for (const list of COUNTED_LISTS) summary[list] = rankedEntries(aggregate[list]);
  return summary;
}

function withListLimit(summary, limit) {
  const limited = { ...summary };
  for (const list of COUNTED_LISTS) limited[list] = summary[list].slice(0, limit);
  return limited;
}

export function renderWithinBudget(summary, budgetBytes = OUTPUT_BUDGET_BYTES) {
  let limit = LIST_LIMIT;
  let text = JSON.stringify(withListLimit(summary, limit));
  while (Buffer.byteLength(text) > budgetBytes && limit > 1) {
    limit = Math.floor(limit / 2);
    text = JSON.stringify({ ...withListLimit(summary, limit), truncated: true });
  }
  return text;
}

export async function mine(projectPath, environment, nowMs) {
  const slug = projectSlug(projectPath);
  const projectsRoot = path.join(configDirectory(environment), 'projects');
  const aggregate = createAggregate();
  for (const transcript of selectTranscripts(transcriptDirectories(projectsRoot, slug), nowMs)) {
    addSession(aggregate, await tallyTranscript(transcript.file));
  }
  return summarize(aggregate, slug);
}

function isEntryPoint() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isEntryPoint()) {
  const summary = await mine(process.argv[2] ?? process.cwd(), process.env, Date.now());
  process.stdout.write(`${renderWithinBudget(summary)}\n`);
}
