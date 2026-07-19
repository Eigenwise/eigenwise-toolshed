'use strict';

const { estimateRequestBodyBytes } = require('../lib/observability/request-body.js');

const DISPATCH_TOOLS = new Set(['Agent', 'Task']);

function buildPreflightOutput(payload, suppliedEstimate) {
  if (!payload || payload.hook_event_name !== 'PreToolUse' || !DISPATCH_TOOLS.has(payload.tool_name)) return null;
  const estimate = suppliedEstimate === undefined
    ? estimateRequestBodyBytes(payload.transcript_path)
    : suppliedEstimate;
  if (!estimate || !estimate.warning) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: 'Request body is near the 32MB limit. Run /compact before spawning executors.',
    },
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const output = buildPreflightOutput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {}
}

if (require.main === module) main();

module.exports = { buildPreflightOutput };
