import { isRecord, readStdin, stringField } from './shared/input.js';
import { writeSystemMessage } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

interface Launch {
  ref: string;
  tokenFile: string;
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

function dispatchLaunches(prompt: unknown): Launch[] {
  return [...String(prompt || '').matchAll(/briefing\s+(SQ-\d+)\s+--token-file\s+(?:"([^"]+)"|(\S+))/gi)]
    .map((match) => ({ ref: (match[1] || '').toUpperCase(), tokenFile: match[2] || match[3] || '' }))
    .filter((launch): launch is Launch => Boolean(launch.ref && launch.tokenFile));
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
    recordDispatchAgentFailure: (slug: string, ref: string, options: Record<string, unknown>) => { ok: boolean; claimReleased?: boolean; dispatchBindingCleared?: boolean; ticket?: { dispatch?: { failureShape?: string } } };
  };
  const error = stringField(input, 'error');
  const project = store.findProject(projectArg);
  if (!project.ok || !project.slug) return;

  if (store.claudeQuotaFailure(error)) {
    const recovered: Array<{ ref: string; recovery: Recovery }> = [];
    for (const launch of launches) {
      const result = store.recoverDispatchQuotaFailure(project.slug, launch.ref, {
        tokenFile: launch.tokenFile,
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
    writeSystemMessage('PostToolUseFailure', message);
    return;
  }

  const failed: Array<{ ref: string; failureShape: string; claimReleased: boolean; dispatchBindingCleared: boolean }> = [];
  for (const launch of launches) {
    const result = store.recordDispatchAgentFailure(project.slug, launch.ref, {
      tokenFile: launch.tokenFile,
      executor,
      sessionId: stringField(input, 'session_id', 'sessionId') || null,
      taskName: stringField(toolInput, 'name') || null,
      agentId: stringField(input, 'agent_id', 'agentId') || null,
      agentName: stringField(input, 'agent_name', 'agentName') || null,
      error,
      source: 'agent-terminal-failure',
    });
    const failureShape = result.ticket?.dispatch?.failureShape;
    if (result.ok && failureShape) failed.push({ ref: launch.ref, failureShape, claimReleased: result.claimReleased === true, dispatchBindingCleared: result.dispatchBindingCleared === true });
  }
  if (!failed.length) return;

  const outcomes = failed.map(({ ref, failureShape }) => `${ref} (${failureShape})`).join(', ');
  const released = failed.filter((failure) => failure.claimReleased).map((failure) => failure.ref);
  const cleared = failed.filter((failure) => failure.dispatchBindingCleared).map((failure) => failure.ref);
  const message = released.length || cleared.length
    ? `sidequest: Agent terminated with an observed terminal failure for ${outcomes}. Released ${released.concat(cleared).join(', ')} immediately; re-dispatch to continue from its preserved checkpoint or worktree.`
    : `sidequest: Agent terminated with an observed terminal failure for ${outcomes}. Its terminal evidence is recorded, but the claim still needs recovery before it can be dispatched again.`;
  writeSystemMessage('PostToolUseFailure', message);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
