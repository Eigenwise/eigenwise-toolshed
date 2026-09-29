#!/usr/bin/env node
import { classify, isReadOnlyExecutor } from '../lib/exec-names.js';
import { deniedToolMatch } from '../lib/denied-tools.js';
import { isSubagent, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { isolationExpectation } from './shared/runtime-identity.js';

interface DeniedToolsStore {
  boardConfig: (slug: string) => { deniedTools?: string[]; readOnlyDeniedTools?: string[] } | null;
  getTicket: (slug: string, ref: string) => { categoryId?: string; category?: { id?: string } } | null;
  getCategory: (id: string, options: { project: string }) => { deniedTools?: string[] } | null;
}

function ticketCategoryId(ticket: ReturnType<DeniedToolsStore['getTicket']>): string {
  return ticket?.categoryId || ticket?.category?.id || '';
}

// Plugin agent frontmatter is packaged once and cannot carry one board's settings, so board and
// category denials are enforced here at call time. Read-only executors also get readOnlyDeniedTools,
// which the bundled read-only definitions never received (GH-222).
function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value : [];
}

function executorDeniedTools(store: DeniedToolsStore, project: string, ref: string, readOnly: boolean): string[] {
  const config = store.boardConfig(project) || {};
  const categoryId = ticketCategoryId(store.getTicket(project, ref));
  const category = (categoryId && store.getCategory(categoryId, { project })) || {};
  return [...listOf(config.deniedTools), ...listOf(category.deniedTools), ...(readOnly ? listOf(config.readOnlyDeniedTools) : [])];
}

function ticketDenial(input: HookInput, executor: string, toolName: string): { ref: string; pattern: string } | null {
  const found = isolationExpectation(input, stringField(input, 'agent_id', 'agentId'), executor, false, stringField(input, 'cwd'));
  if (!found || found.terminal) return null;
  const store = require(runtimeModule('store')) as DeniedToolsStore;
  const pattern = deniedToolMatch(toolName, executorDeniedTools(store, found.project, found.ref, isReadOnlyExecutor(executor)));
  return pattern ? { ref: found.ref, pattern } : null;
}

function main(input: HookInput): void {
  const executor = stringField(input, 'agent_type', 'agentType');
  if (!isSubagent(input) || classify(executor).kind === 'unknown') return;
  const toolName = stringField(input, 'tool_name');
  const denial = ticketDenial(input, executor, toolName);
  if (denial) {
    writeDeny('PreToolUse', `sidequest: ${toolName} is denied to executors on ${denial.ref} by the board deniedTools setting (${denial.pattern}). Finish the ticket with the remaining tools; when it needs ${toolName}, comment why on the ticket and release it.`);
  }
}

try {
  const input = readStdin();
  if (input) main(input);
} catch (_) {
  process.exit(0);
}
