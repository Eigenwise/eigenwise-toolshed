#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
import { isPrimarySession, resetCompactionState } from './shared/compaction.js';

function main(): void {
  const input = readStdin();
  if (!input || !isPrimarySession(input)) return;
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!sessionId) return;
  resetCompactionState(sessionId, input.transcript_path || input.transcriptPath);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
