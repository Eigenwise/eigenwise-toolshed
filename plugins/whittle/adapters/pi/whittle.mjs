import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { instructions } = require('../../hooks/lib/runtime.js');

export function injectBeforeAgent(event = {}) {
  const policy = instructions();
  if (!policy || event.systemPrompt?.includes(policy)) return undefined;
  return { systemPrompt: (event.systemPrompt ? event.systemPrompt + '\n\n' : '') + policy };
}

export default function whittleExtension(pi) {
  pi.on('before_agent_start', async (event) => injectBeforeAgent(event));
}
