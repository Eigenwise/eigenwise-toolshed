import { isRecord, readStdin, stringField } from './shared/input.js';
import { writeJson } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

interface Launch {
  ref: string;
  token: string;
}

interface Recovery {
  model: string;
  effort: string;
}

function projectFromPrompt(prompt: unknown): string | null {
  const matches = [...String(prompt || '').matchAll(/--project\s+"([^"]+)"|--project[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || match[2] || null : null;
}

function tokenFromPrompt(prompt: unknown): string | null {
  const matches = [...String(prompt || '').matchAll(/--token\s+([^\s`"']+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || null : null;
}

function dispatchLaunches(prompt: unknown): Launch[] {
  const text = String(prompt || '');
  const headings = [...text.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const sectioned = headings.map((match, index) => {
    const next = headings[index + 1];
    const section = text.slice(match.index, next ? next.index : text.length);
    return { ref: (match[1] || '').toUpperCase(), token: tokenFromPrompt(section) };
  }).filter((launch): launch is Launch => Boolean(launch.ref && launch.token));
  if (sectioned.length) return sectioned;

  const refs = [...new Set((text.match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()))];
  const tokens = [...text.matchAll(/--token\s+([^\s`"']+)/g)].map((match) => match[1] || '');
  if (refs.length === tokens.length) return refs.map((ref, index) => ({ ref, token: tokens[index] || '' }));
  return refs.length === 1 && tokens.length === 1 ? [{ ref: refs[0] || '', token: tokens[0] || '' }] : [];
}

function main(): void {
  const input = readStdin();
  if (!input || input.tool_name !== 'Agent' || !isRecord(input.tool_input)) return;
  const toolInput = input.tool_input;
  const launches = dispatchLaunches(toolInput.prompt);
  const projectArg = projectFromPrompt(toolInput.prompt) || stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR;
  const executor = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : '';
  if (!launches.length || !projectArg || !executor) return;

  const store = require(runtimeModule('store')) as {
    claudeQuotaFailure: (error: string) => boolean;
    findProject: (project: string) => { ok: boolean; slug?: string };
    recoverDispatchQuotaFailure: (slug: string, ref: string, options: Record<string, unknown>) => { ok: boolean; recovery?: Recovery };
  };
  const error = stringField(input, 'error');
  if (!store.claudeQuotaFailure(error)) return;
  const project = store.findProject(projectArg);
  if (!project.ok || !project.slug) return;

  const recovered: Array<{ ref: string; recovery: Recovery }> = [];
  for (const launch of launches) {
    const result = store.recoverDispatchQuotaFailure(project.slug, launch.ref, {
      token: launch.token,
      executor,
      sessionId: stringField(input, 'session_id', 'sessionId') || null,
      error,
      source: 'agent-launch-failure',
    });
    if (result.ok && result.recovery) recovered.push({ ref: launch.ref, recovery: result.recovery });
  }
  if (!recovered.length) return;

  const routes = recovered.map(({ ref, recovery }) => `${ref} → ${recovery.model}·${recovery.effort}`).join(', ');
  const refs = recovered.map(({ ref }) => ref).join(', ');
  const message = `sidequest: Claude quota blocked ${refs} before claim. Prepared the configured fallback dispatch (${routes}) with a fresh token and kept the failed primary attempt in the dispatch ledger. Run dispatch again for each ref and spawn the returned spec. Category policy is unchanged.`;
  writeJson({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: message },
  });
}

try {
  main();
} catch (_) {
  process.exit(0);
}
