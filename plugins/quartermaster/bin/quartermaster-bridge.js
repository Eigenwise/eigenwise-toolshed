#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { HostBridge, MAX_PROMPT_BYTES } = require('../lib/host-bridge.js');
const { normalizeAdapter } = require('../lib/agent-handoff.js');

const USAGE = `quartermaster-bridge — project-bound Claude orchestrator conversations

  node quartermaster-bridge.js start --project <absolute-directory> --request <uuid> [--message-file <file>] [--adapter claude-code] [--profile plan|work] [--timeout-ms <n>] [--max-turns <n>]
  node quartermaster-bridge.js followup --project <absolute-directory> --request <uuid> --conversation <uuid> [--message-file <file>] [--adapter claude-code] [--profile plan|work]
  node quartermaster-bridge.js status|result|cancel --project <absolute-directory> --conversation <uuid> [--job <uuid>]

Without --message-file, start/followup read the message from stdin. They print a queued
job JSON immediately and keep this process alive until a second, terminal JSON result.
An exact retry owned by another process returns its accepted handle and current result;
terminal:false is still pending and exits successfully without claiming completion.
The owning process controls its child; cancel through the owning MCP connection for
nonblocking jobs. CLI cancel never kills another process's PID recovered from disk.
Retry an uncertain call with the same --request UUID and exact payload to retrieve
the original job without launching Claude again. Changed payloads require a new UUID.
Default plan uses native plan permissions and Read/Glob/Grep built-ins. work preserves
the current host policy; actions that would prompt are denied. No permission bypass,
provider/model override, --bare, native executor replacement or live TUI attachment.
Normal Claude plugins/hooks/MCP/auth still load. Project binding is not a sandbox.
Host success remains unverified task delivery. State: QUARTERMASTER_BRIDGE_HOME or
<Quartermaster state>/host-bridge. Host binary: QUARTERMASTER_BRIDGE_CLAUDE or claude.
Responses retain their native fields and add an eigenwise.agent-handoff v1 receipt.
Check handoff.hostStopped and handoff.safeToResume: terminal alone does not prove
the host stopped. The optional adapter is claude-code; unsupported adapters refuse
without fallback. This adapter selection does not change the model or provider.
`;

function message(file) {
  const descriptor = file ? fs.openSync(file, 'r') : 0;
  const chunks = [];
  let bytes = 0;
  try {
    const buffer = Buffer.alloc(16384);
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > MAX_PROMPT_BYTES) throw new Error(`Message exceeds the ${MAX_PROMPT_BYTES}-byte input limit.`);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { if (file) fs.closeSync(descriptor); }
}

function parse(argv) {
  const [operation, ...args] = argv;
  if (!operation || ['--help', '-h', 'help'].includes(operation)) return { help: true };
  if (!['start', 'followup', 'status', 'result', 'cancel'].includes(operation)) throw new Error(`Unknown bridge operation: ${operation}`);
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!['--project', '--request', '--conversation', '--job', '--message-file', '--adapter', '--profile', '--timeout-ms', '--max-turns'].includes(flag) || args[index + 1] == null || Object.hasOwn(flags, flag)) throw new Error(`Invalid or repeated bridge option: ${flag}`);
    flags[flag] = args[index + 1];
  }
  if (!flags['--project']) throw new Error('--project is required.');
  if (Object.hasOwn(flags, '--adapter')) {
    if (!['start', 'followup'].includes(operation)) throw new Error('--adapter is supported only for start and followup.');
    normalizeAdapter(flags['--adapter']);
  }
  const request = { project: flags['--project'], ...(flags['--request'] ? { requestId: flags['--request'] } : {}), ...(flags['--conversation'] ? { conversationId: flags['--conversation'] } : {}), ...(flags['--job'] ? { jobId: flags['--job'] } : {}), ...(Object.hasOwn(flags, '--adapter') ? { adapter: flags['--adapter'] } : {}), ...(flags['--profile'] ? { profile: flags['--profile'] } : {}), ...(flags['--timeout-ms'] ? { timeoutMs: Number(flags['--timeout-ms']) } : {}), ...(flags['--max-turns'] ? { maxTurns: Number(flags['--max-turns']) } : {}) };
  if (['start', 'followup'].includes(operation)) request.prompt = message(flags['--message-file']);
  return { operation, request };
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parse(argv);
  if (parsed.help) { process.stdout.write(USAGE); return; }
  const bridge = new HostBridge({ project: parsed.request.project });
  const shutdown = () => { void bridge.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const initial = bridge[parsed.operation](parsed.request);
    process.stdout.write(`${JSON.stringify(initial)}\n`);
    if (['start', 'followup'].includes(parsed.operation)) {
      await bridge.wait(initial.id);
      const result = bridge.result({ ...parsed.request, conversationId: initial.conversationId, jobId: initial.id });
      process.stdout.write(`${JSON.stringify({ ...result, ...(!result.terminal ? { accepted: true } : {}) })}\n`);
      if (result.terminal && result.state !== 'succeeded') process.exitCode = 1;
    }
  } finally {
    await bridge.close();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main, parse, USAGE };
