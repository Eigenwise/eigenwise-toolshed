#!/usr/bin/env node
import { readStdin } from './shared/input.js';
import { compactionPolicyOutput } from './shared/compaction-policy.js';

async function main(): Promise<void> {
  const input = readStdin() || {};
  if (input.hook_event_name !== 'PreCompact' || input.trigger !== 'auto') return;
  const output = await compactionPolicyOutput(input);
  if (output) process.stdout.write(output);
}

main().catch((error) => {
  console.error(`sidequest: compaction policy failed: ${String(error)}`);
});
