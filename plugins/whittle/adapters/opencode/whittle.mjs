import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { instructions } = require('../../hooks/lib/runtime.js');

export function injectNextMessage(_input = {}, output = { system: [] }) {
  const policy = instructions();
  if (!policy) return '';
  if (!Array.isArray(output.system)) output.system = [];
  if (output.system.some((part) => typeof part === 'string' && part.includes(policy))) return '';
  if (output.system.length) output.system[output.system.length - 1] += '\n\n' + policy;
  else output.system.push(policy);
  return policy;
}

export default async () => ({
  'experimental.chat.system.transform': async (input, output) => injectNextMessage(input, output),
});
