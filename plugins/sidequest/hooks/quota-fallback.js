'use strict';

const fs = require('fs');
const path = require('path');

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

function projectFromPrompt(prompt) {
  const matches = [...String(prompt || '').matchAll(/--project\s+"([^"]+)"|--project[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? (match[1] || match[2] || null) : null;
}

function tokenFromPrompt(prompt) {
  const matches = [...String(prompt || '').matchAll(/--token\s+([^\s`"']+)/g)];
  const match = matches.at(-1);
  return match ? match[1] : null;
}

function dispatchLaunches(prompt) {
  const text = String(prompt || '');
  const headings = [...text.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const sectioned = headings.map((match, index) => {
    const section = text.slice(match.index, headings[index + 1] ? headings[index + 1].index : text.length);
    return { ref: match[1].toUpperCase(), token: tokenFromPrompt(section) };
  }).filter((launch) => launch.token);
  if (sectioned.length) return sectioned;

  const refs = [...new Set((text.match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()))];
  const tokens = [...text.matchAll(/--token\s+([^\s`"']+)/g)].map((match) => match[1]);
  if (refs.length === tokens.length) return refs.map((ref, index) => ({ ref, token: tokens[index] }));
  return refs.length === 1 && tokens.length === 1 ? [{ ref: refs[0], token: tokens[0] }] : [];
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  if (input.tool_name !== 'Agent') return;
  const toolInput = input.tool_input || {};
  const launches = dispatchLaunches(toolInput.prompt);
  const projectArg = projectFromPrompt(toolInput.prompt) || input.cwd || process.env.CLAUDE_PROJECT_DIR;
  if (!launches.length || !projectArg || !toolInput.subagent_type) return;

  const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  const error = String(input.error || '');
  if (!store.claudeQuotaFailure(error)) return;
  const project = store.findProject(projectArg);
  if (!project.ok) return;

  const recovered = [];
  for (const launch of launches) {
    const result = store.recoverDispatchQuotaFailure(project.slug, launch.ref, {
      token: launch.token,
      executor: toolInput.subagent_type,
      sessionId: input.session_id || input.sessionId || null,
      error,
      source: 'agent-launch-failure',
    });
    if (result.ok) recovered.push({ ref: launch.ref, recovery: result.recovery });
  }
  if (!recovered.length) return;

  const routes = recovered.map(({ ref, recovery }) => `${ref} → ${recovery.model}·${recovery.effort}`).join(', ');
  const refs = recovered.map(({ ref }) => ref).join(', ');
  const message = `sidequest: Claude quota blocked ${refs} before claim. Prepared the configured fallback dispatch (${routes}) with a fresh token and kept the failed primary attempt in the dispatch ledger. Run dispatch again for each ref and spawn the returned spec. Category policy is unchanged.`;
  process.stdout.write(JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: message,
    },
  }));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
