#!/usr/bin/env node
import { boardReconciliationReminder } from './board-reconciliation-reminder.js';
import { compactionSuggestion } from './shared/compaction.js';
import { readStdin } from './shared/input.js';
import { writeContext, writeSystemMessage } from './shared/output.js';

async function main(): Promise<void> {
  const input = readStdin();
  if (!input || input.stop_hook_active === true) return;

  const reconciliation = boardReconciliationReminder(input);
  if (reconciliation) {
    writeContext('Stop', reconciliation);
    return;
  }

  const compaction = await compactionSuggestion(input);
  if (compaction) writeSystemMessage('Stop', compaction);
}

void main().catch(() => {});
