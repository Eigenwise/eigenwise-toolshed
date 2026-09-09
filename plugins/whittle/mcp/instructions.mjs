import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { instructions } = require('../hooks/lib/runtime.js');

export { instructions };

export function response() {
  return { instructions: instructions(), persistence: 'none' };
}
