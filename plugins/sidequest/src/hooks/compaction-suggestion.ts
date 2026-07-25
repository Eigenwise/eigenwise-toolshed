#!/usr/bin/env node
import { readStdin } from './shared/input.js';
import { compactionSuggestion } from './shared/compaction.js';
import { writeJson } from './shared/output.js';

async function main(): Promise<void> {
  const input = readStdin();
  if (!input) return;
  const message = await compactionSuggestion(input);
  if (message) writeJson({ systemMessage: message });
}

void main().catch(() => {});
