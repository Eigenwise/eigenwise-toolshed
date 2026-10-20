import { readStdin, isRecord, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { evidenceToolDenial, type EvidenceWriteScope } from '../lib/evidence-writes.js';

function main(): void {
  const input = readStdin();
  if (!input) throw new Error('evidence guard requires a snapshot-bound request');
  const scope: EvidenceWriteScope = isRecord(input.scope) ? input.scope : {};
  const argumentsInput = isRecord(input.tool_input) ? input.tool_input : {};
  const denial = evidenceToolDenial(stringField(input, 'tool_name'), argumentsInput, stringField(input, 'cwd'), scope);
  if (denial) writeDeny('PreToolUse', denial);
}

main();
