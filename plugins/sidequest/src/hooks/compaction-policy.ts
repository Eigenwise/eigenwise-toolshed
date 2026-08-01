#!/usr/bin/env node
import { readStdin } from './shared/input.js';
import { compactionPolicyOutput } from './shared/compaction-policy.js';

async function main(): Promise<void> {
  const output = await compactionPolicyOutput(readStdin() || {});
  if (output) process.stdout.write(output);
}

main().catch((error) => {
  console.error(`sidequest: compaction policy failed: ${String(error)}`);
});
