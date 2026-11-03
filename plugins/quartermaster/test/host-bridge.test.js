'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { HostBridge } = require('../lib/host-bridge.js');
const { createMcp } = require('../lib/host-bridge-mcp.js');
const { processAlive } = require('../lib/host-bridge-store.js');

const LIB = path.resolve(__dirname, '../lib/host-bridge.js');
const MCP = path.resolve(__dirname, '../bin/quartermaster-bridge-mcp.js');
const CLI = path.resolve(__dirname, '../bin/quartermaster-bridge.js');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-host-bridge-'));
  const project = path.join(root, 'project with spaces');
  const other = path.join(root, 'other');
  const home = path.join(root, 'state');
  const log = path.join(root, 'calls.jsonl');
  const script = path.join(root, 'fake-claude.js');
  fs.mkdirSync(project); fs.mkdirSync(other);
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const session = value(args.includes('--resume') ? '--resume' : '--session-id');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 const prompt = JSON.parse(input);
 const log = process.env.QM_FIXTURE_LOG;
 const record = { args, input, cwd: process.cwd(), pid: process.pid, env: { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, ROUTE_MARKER: process.env.ROUTE_MARKER } };
 fs.appendFileSync(log, JSON.stringify(record) + '\\n');
 const sessionFile = path.join(process.cwd(), '.fixture-' + session + '.json');
 let prior = null;
 if (args.includes('--resume')) { try { prior = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch { process.stderr.write('missing prior session'); process.exit(4); } }
 fs.writeFileSync(sessionFile, JSON.stringify({ input }));
 const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
 send({ type: 'system', subtype: 'init', session_id: session, model: 'fixture-model', tools: ['Read', 'Agent'], plugins: [{ name: 'sidequest', version: 'fixture', private: 'not retained' }], mcp_servers: [{ name: 'board', status: 'connected', private: 'not retained' }] });
 send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'PRIVATE TOOL INPUT' } }] } });
 if (prompt.mode === 'hang') { setInterval(() => {}, 1000); return; }
 if (prompt.mode === 'empty') return;
 if (prompt.mode === 'malformed') { process.stdout.write('not json\\n'); return; }
 if (prompt.mode === 'overflow') { process.stdout.write('x'.repeat(20000)); return; }
 if (prompt.mode === 'exit') { process.stderr.write('token=private-fixture-token'); process.exitCode = 3; return; }
 if (prompt.mode === 'session') { send({ type: 'result', subtype: 'success', is_error: false, session_id: '00000000-0000-4000-8000-000000000001', result: 'wrong session' }); return; }
 const denied = prompt.mode === 'denied';
 const error = prompt.mode === 'error';
 send({ type: 'result', subtype: error ? 'error_max_turns' : 'success', is_error: error, session_id: session, result: JSON.stringify({ text: prompt.text || 'fixture result', prior: prior && JSON.parse(prior.input).text, resumed: args.includes('--resume') }), errors: error ? ['budget or turn limit reached'] : [], permission_denials: denied ? [{ tool_name: 'Bash', tool_input: { command: 'PRIVATE COMMAND' } }] : [] });
});
`);
  const environment = { ...process.env, QM_FIXTURE_LOG: log, ROUTE_MARKER: 'preserved', ANTHROPIC_BASE_URL: 'http://fixture.invalid', CLAUDECODE: 'stale', CLAUDE_CODE_SESSION_ID: 'stale-id', CLAUDE_PROJECT_DIR: other };
  const bridge = new HostBridge({ project, home, command: process.execPath, prefixArguments: [script], environment, ...options });
  t.after(async () => { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = (mode = 'success', extra = {}) => ({ project, requestId: randomUUID(), prompt: JSON.stringify({ mode, text: 'hello' }), ...extra });
  const lookup = (job) => ({ project, conversationId: job.conversationId, jobId: job.id });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, project, other, home, script, log, environment, bridge, request, lookup, calls };
}

async function done(f, job) { await f.bridge.wait(job.id); return f.bridge.result(f.lookup(job)); }
async function until(predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for fixture'); await new Promise((resolve) => setTimeout(resolve, 20)); } }

test('real subprocess planning and resume preserve exact stdin/cwd/session while retaining provider route', async (t) => {
  const f = fixture(t);
  const text = 'Unicode café 🎵, quotes " and backticks `, $(not-a-command)\nnext line';
  const request = f.request('success', { prompt: JSON.stringify({ mode: 'success', text }) });
  const first = f.bridge.start(request);
  assert.equal(first.state, 'queued');
  const result = await done(f, first);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.result.hostTurnSucceeded, true);
  assert.equal(result.taskOutcome, 'unverified');
  assert.equal(JSON.parse(result.result.text).text, text);
  assert.deepEqual(result.host.plugins, [{ name: 'sidequest' }]);
  assert.deepEqual(result.host.mcpServers, [{ name: 'board', status: 'connected' }]);
  assert.deepEqual(result.toolUse, { total: 1, byName: { Read: 1 } });
  assert.ok(!JSON.stringify(result).includes('PRIVATE TOOL INPUT'));
  const second = f.bridge.followup(f.request('success', { conversationId: first.conversationId, prompt: JSON.stringify({ mode: 'success', text: 'follow-up' }) }));
  const follow = await done(f, second);
  assert.equal(follow.state, 'succeeded');
  assert.equal(follow.claudeSessionId, first.claudeSessionId);
  assert.equal(JSON.parse(follow.result.text).prior, text);
  const calls = f.calls();
  assert.equal(calls[0].input, request.prompt);
  assert.equal(calls[0].cwd, f.project);
  assert.equal(calls[0].args[calls[0].args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(!calls[0].args.includes('--bare'));
  assert.ok(!calls[0].args.includes('--dangerously-skip-permissions'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], first.claudeSessionId);
  assert.deepEqual(calls[0].env, { ANTHROPIC_BASE_URL: 'http://fixture.invalid', ROUTE_MARKER: 'preserved' });
});

test('idempotent request replays in another owner return the original job and reject changed payloads', async (t) => {
  const f = fixture(t);
  const second = new HostBridge({ project: f.project, home: f.home, command: process.execPath, prefixArguments: [f.script], environment: f.environment });
  t.after(() => second.close());
  const request = f.request();
  const first = f.bridge.start(request);
  const replay = second.start(request);
  assert.equal(replay.id, first.id);
  assert.equal(replay.conversationId, first.conversationId);
  assert.throws(() => second.start({ ...request, prompt: 'different payload' }), /different payload/);
  await done(f, first);
  assert.equal(second.start(request).id, first.id);
  assert.equal(f.calls().length, 1);
  const followRequest = f.request('success', { conversationId: first.conversationId });
  const follow = f.bridge.followup(followRequest);
  assert.equal(second.followup(followRequest).id, follow.id);
  await done(f, follow);
  assert.equal(f.calls().length, 2);
});

test('all bridge operations expose the same versioned handoff identity and conservative receiver lifecycle', async (t) => {
  const f = fixture(t);
  const first = f.bridge.start(f.request('hang'));
  const identity = (receipt, turn) => {
    assert.equal(receipt.contract, 'eigenwise.agent-handoff'); assert.equal(receipt.version, 1); assert.equal(receipt.adapter, 'claude-code');
    assert.equal(receipt.project, f.project); assert.equal(receipt.requestId, turn.requestId); assert.equal(receipt.conversationId, first.conversationId); assert.equal(receipt.turnId, turn.id);
    assert.equal(receipt.receiver.ownership, 'bridge-owned'); assert.equal(receipt.receiver.sessionId, first.claudeSessionId);
    assert.equal(receipt.workOutcome, 'unverified'); assert.ok(receipt.acceptedAt);
    assert.ok(!Object.hasOwn(receipt, 'prompt')); assert.ok(!Object.hasOwn(receipt, 'result')); assert.ok(!Object.hasOwn(receipt, 'toolUse'));
  };
  identity(first.handoff, first); assert.equal(first.handoff.safeToResume, false);
  assert.equal(first.handoff.hostStopped, null); assert.equal(first.handoff.receiver.observed, false);
  await until(() => f.bridge.status(f.lookup(first)).hostStarted);
  const status = f.bridge.status(f.lookup(first));
  identity(status.handoff, first); assert.equal(status.handoff.hostStopped, false); assert.equal(status.handoff.safeToResume, false);
  assert.ok(status.handoff.startedAt);
  const cancelled = f.bridge.cancel(f.lookup(first)); identity(cancelled.handoff, first);
  assert.equal(cancelled.handoff.safeToResume, false);
  const stopped = await done(f, first); identity(stopped.handoff, first);
  assert.equal(stopped.handoff.hostStopped, true); assert.equal(stopped.handoff.terminal, true); assert.ok(stopped.handoff.finishedAt);
  const follow = f.bridge.followup(f.request('success', { conversationId: first.conversationId, adapter: 'claude-code' }));
  identity(follow.handoff, follow); assert.notEqual(follow.handoff.turnId, first.handoff.turnId);
  const final = await done(f, follow); identity(final.handoff, follow);
  assert.equal(final.handoff.safeToResume, true); assert.equal(final.handoff.hostStopped, true);
});

test('default adapter remains compatible with prior replay hashes and unsupported adapters never launch', async (t) => {
  const f = fixture(t);
  const request = f.request();
  const first = f.bridge.start(request); await done(f, first);
  const { createHash } = require('node:crypto');
  const originalHash = createHash('sha256').update(JSON.stringify({ project: f.project, operation: 'start', conversationId: null, prompt: request.prompt, profile: null, timeoutMs: 120000, maxTurns: 12 })).digest('hex');
  assert.equal(f.bridge.store.readRequest(f.project, request.requestId).payloadHash, originalHash);
  assert.equal(f.bridge.start({ ...request, adapter: 'claude-code' }).id, first.id);
  assert.throws(() => f.bridge.start({ ...request, adapter: 'codex' }), /Unsupported agent adapter/);
  assert.throws(() => f.bridge.followup(f.request('success', { conversationId: first.conversationId, adapter: 'pi' })), /Unsupported agent adapter/);
  assert.equal(f.calls().length, 1);
  const args = f.calls()[0].args;
  for (const flag of ['--adapter', '--model', '--provider']) assert.ok(!args.includes(flag), flag);
});

test('receipt resume assessment describes its named turn while the current conversation lock remains authoritative', async (t) => {
  const f = fixture(t);
  const first = f.bridge.start(f.request()); await done(f, first);
  const next = f.bridge.followup(f.request('hang', { conversationId: first.conversationId }));
  await until(() => f.bridge.status(f.lookup(next)).hostStarted);
  const earlierReceipt = f.bridge.result(f.lookup(first)).handoff;
  assert.equal(earlierReceipt.hostStopped, true);
  assert.equal(earlierReceipt.safeToResume, true);
  assert.equal(f.bridge.status(f.lookup(next)).handoff.safeToResume, false);
  assert.throws(() => f.bridge.followup(f.request('success', { conversationId: first.conversationId })), /active turn/);
  f.bridge.cancel(f.lookup(next)); await done(f, next);
});

test('project pins, owned IDs and serialized conversation turns reject crossed routing', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.bridge.start(f.request('success', { project: f.other })), /bound to another project/);
  assert.throws(() => f.bridge.start(f.request('success', { requestId: '../outside' })), /requestId/);
  assert.throws(() => f.bridge.followup(f.request('success', { conversationId: randomUUID() })), /unknown for this project/);
  const first = f.bridge.start(f.request('hang'));
  await until(() => f.calls().length === 1);
  const otherOwner = new HostBridge({ project: f.project, home: f.home, command: process.execPath, prefixArguments: [f.script], environment: f.environment });
  t.after(() => otherOwner.close());
  assert.throws(() => otherOwner.followup(f.request('success', { conversationId: first.conversationId })), /active turn/);
  assert.throws(() => otherOwner.cancel(f.lookup(first)), /owning MCP connection/);
  f.bridge.cancel(f.lookup(first));
  assert.equal((await done(f, first)).state, 'cancelled');
  assert.equal(f.calls().length, 1);
});

test('disk lock independently excludes a second owner even if conversation state appears terminal', async (t) => {
  const f = fixture(t);
  const first = f.bridge.start(f.request()); await done(f, first);
  const unlock = f.bridge.store.lock(f.project, first.conversationId, randomUUID(), randomUUID());
  try { assert.throws(() => f.bridge.followup(f.request('success', { conversationId: first.conversationId })), /active turn/); }
  finally { unlock(); }
  assert.equal(f.calls().length, 1);
});

for (const [mode, state, code] of [['error', 'failed', 'host_error'], ['denied', 'blocked_permissions', 'permission_denied'], ['malformed', 'failed', 'invalid_output'], ['empty', 'failed', 'missing_result'], ['exit', 'failed', 'missing_result'], ['session', 'failed', 'session_mismatch']]) {
  test(`a real ${mode} host response cannot become successful task completion`, async (t) => {
    const f = fixture(t);
    const result = await done(f, f.bridge.start(f.request(mode)));
    assert.equal(result.state, state);
    assert.equal(result.error.code, code);
    assert.equal(result.taskOutcome, 'unverified');
    assert.ok(!JSON.stringify(result).includes('PRIVATE COMMAND'));
    assert.ok(!JSON.stringify(result).includes('private-fixture-token'));
  });
}

test('timeout, output limit, cancellation and orderly owner close terminate only live owned children', async (t) => {
  const f = fixture(t, { maxOutputBytes: 4096 });
  const timeout = await done(f, f.bridge.start(f.request('hang', { timeoutMs: 200 })));
  assert.equal(timeout.state, 'failed'); assert.equal(timeout.error.code, 'timeout');
  assert.equal(processAlive(f.calls()[0].pid), false);
  const overflow = await done(f, f.bridge.start(f.request('overflow')));
  assert.equal(overflow.error.code, 'output_limit');
  const cancelled = f.bridge.start(f.request('hang'));
  await until(() => f.calls().length === 3);
  f.bridge.cancel(f.lookup(cancelled));
  assert.equal((await done(f, cancelled)).state, 'cancelled');
  const closing = f.bridge.start(f.request('hang'));
  await until(() => f.calls().length === 4);
  await f.bridge.close();
  assert.equal(f.bridge.result(f.lookup(closing)).state, 'interrupted');
  for (const call of f.calls()) assert.equal(processAlive(call.pid), false);
});

test('work profile keeps native policy and permission denials remain explicit', async (t) => {
  const f = fixture(t);
  await done(f, f.bridge.start(f.request('success', { profile: 'work' })));
  const args = f.calls()[0].args;
  for (const forbidden of ['--permission-mode', '--tools', '--allowedTools', '--allow-dangerously-skip-permissions', '--dangerously-skip-permissions']) assert.ok(!args.includes(forbidden), forbidden);
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
});

test('tree termination failure falls back to its actual owned child and never parks indefinitely', async (t) => {
  const f = fixture(t, { terminateTree: (child, callback) => callback(Object.assign(new Error('fixture failure'), { code: 'EPERM' })), terminationTimeoutMs: 100 });
  const job = f.bridge.start(f.request('hang'));
  await until(() => f.calls().length === 1);
  f.bridge.cancel(f.lookup(job));
  const result = await done(f, job);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.termination.treeError, 'EPERM');
  assert.equal(result.termination.fallbackRequested, true);
  assert.equal(processAlive(f.calls()[0].pid), false);
});

test('unconfirmed termination is a bounded failure retaining child ownership and the conversation lock', async (t) => {
  const f = fixture(t, { terminateTree: (child, callback) => callback(Object.assign(new Error('fixture failure'), { code: 'EPERM' })), killChild: () => false, terminationTimeoutMs: 100 });
  const job = f.bridge.start(f.request('hang'));
  await until(() => f.calls().length === 1);
  const child = f.bridge.active.get(job.id).child;
  try {
    f.bridge.cancel(f.lookup(job));
    const status = await f.bridge.wait(job.id);
    assert.equal(status.state, 'failed');
    assert.equal(status.error.code, 'termination_unconfirmed');
    assert.equal(status.terminationPending, true);
    assert.equal(status.handoff.terminal, true);
    assert.equal(status.handoff.hostStopped, null);
    assert.equal(status.handoff.resumeBlocked, true);
    assert.equal(status.handoff.safeToResume, false);
    assert.equal(processAlive(child.pid), true);
    assert.equal(f.bridge.active.has(job.id), true);
    assert.throws(() => f.bridge.followup(f.request('success', { conversationId: job.conversationId })), /active turn/);
  } finally {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGKILL'); await closed;
  }
  assert.equal(f.bridge.result(f.lookup(job)).state, 'failed');
  assert.equal(f.bridge.active.has(job.id), false);
});

test('dead-owner restart marks a durable unfinished job interrupted and request replay never relaunches', async (t) => {
  const f = fixture(t);
  const request = f.request();
  const first = f.bridge.start(request); await done(f, first);
  const job = f.bridge.store.read(f.project, 'jobs', first.id);
  job.state = 'running'; job.ownerPid = 2147483647;
  delete job.finishedAt;
  f.bridge.store.write(f.project, 'jobs', job);
  const restarted = new HostBridge({ project: f.project, home: f.home, command: process.execPath, prefixArguments: [f.script], environment: f.environment });
  t.after(() => restarted.close());
  const status = restarted.status(f.lookup(first));
  assert.equal(status.state, 'interrupted');
  assert.equal(restarted.start(request).id, first.id);
  assert.equal(f.calls().length, 1);
});

test('dead-owner terminal persistence before unlock releases only its exactly matching stale lock', async (t) => {
  const f = fixture(t);
  const first = f.bridge.start(f.request()); await done(f, first);
  const job = f.bridge.store.read(f.project, 'jobs', first.id);
  job.ownerPid = 2147483647;
  f.bridge.store.write(f.project, 'jobs', job);
  const lock = path.join(f.bridge.store.projectDirectory(f.project), 'locks', `${job.conversationId}.json`);
  fs.writeFileSync(lock, JSON.stringify({ jobId: job.id, ownerId: job.ownerId, ownerPid: job.ownerPid }));
  assert.equal(f.bridge.status(f.lookup(first)).state, 'succeeded');
  assert.equal(fs.existsSync(lock), false);
  const follow = f.bridge.followup(f.request('success', { conversationId: first.conversationId }));
  assert.equal((await done(f, follow)).state, 'succeeded');
  assert.equal(f.calls().length, 2);
});

test('dead-owner unconfirmed termination releases stale ownership but blocks resuming that conversation', async (t) => {
  const f = fixture(t);
  const request = f.request();
  const first = f.bridge.start(request); await done(f, first);
  const job = f.bridge.store.read(f.project, 'jobs', first.id);
  job.ownerPid = 2147483647; job.state = 'failed'; job.terminationPending = true;
  f.bridge.store.write(f.project, 'jobs', job);
  const lock = path.join(f.bridge.store.projectDirectory(f.project), 'locks', `${job.conversationId}.json`);
  fs.writeFileSync(lock, JSON.stringify({ jobId: job.id, ownerId: job.ownerId, ownerPid: job.ownerPid }));
  const recovered = f.bridge.status(f.lookup(first));
  assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.resumeBlocked, true);
  assert.equal(recovered.terminationUnconfirmed, true); assert.equal(fs.existsSync(lock), false);
  assert.equal(f.bridge.start(request).id, first.id);
  assert.throws(() => f.bridge.followup(f.request('success', { conversationId: first.conversationId })), /cannot be resumed/);
  assert.equal(f.calls().length, 1);
});

test('recovery never removes a lock belonging to a different owner identity', async (t) => {
  const f = fixture(t);
  const first = f.bridge.start(f.request()); await done(f, first);
  const job = f.bridge.store.read(f.project, 'jobs', first.id); job.ownerPid = 2147483647;
  f.bridge.store.write(f.project, 'jobs', job);
  const lock = path.join(f.bridge.store.projectDirectory(f.project), 'locks', `${job.conversationId}.json`);
  fs.writeFileSync(lock, JSON.stringify({ jobId: job.id, ownerId: randomUUID(), ownerPid: job.ownerPid }));
  f.bridge.status(f.lookup(first));
  assert.equal(fs.existsSync(lock), true);
  assert.throws(() => f.bridge.followup(f.request('success', { conversationId: first.conversationId })), /active turn/);
  fs.unlinkSync(lock);
});

test('a crash after request reservation is recovered as interrupted without starting a replacement host', async (t) => {
  const f = fixture(t);
  const request = f.request();
  const first = f.bridge.start(request); await done(f, first);
  const requestFile = f.bridge.store.recordPath(f.project, 'requests', request.requestId);
  const reservation = JSON.parse(fs.readFileSync(requestFile));
  reservation.job.ownerPid = 2147483647;
  reservation.job.hostStarted = false;
  fs.writeFileSync(requestFile, JSON.stringify(reservation));
  fs.unlinkSync(f.bridge.store.recordPath(f.project, 'jobs', first.id));
  const replay = f.bridge.start(request);
  assert.equal(replay.id, first.id); assert.equal(replay.state, 'interrupted');
  assert.equal(f.calls().length, 1);
  assert.throws(() => f.bridge.followup(f.request('success', { conversationId: first.conversationId })), /never started a Claude host/);
});

test('a missing host executable is a durable failed job rather than a successful launch', async (t) => {
  const f = fixture(t, { command: path.join(os.tmpdir(), `no-claude-${randomUUID()}.exe`), prefixArguments: [] });
  const job = f.bridge.start(f.request());
  const result = await done(f, job);
  assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'spawn_error');
  assert.equal(result.hostStarted, false);
});

test('store rejects record schema drift, path traversal and symlink escape', async (t) => {
  const f = fixture(t);
  const first = f.bridge.start(f.request()); await done(f, first);
  assert.throws(() => f.bridge.status({ project: f.project, conversationId: '../outside' }), /conversationId/);
  const file = f.bridge.store.recordPath(f.project, 'jobs', first.id);
  const job = JSON.parse(fs.readFileSync(file)); job.schemaVersion = 999; fs.writeFileSync(file, JSON.stringify(job));
  assert.throws(() => f.bridge.status(f.lookup(first)), /schemaVersion/);
  job.schemaVersion = 1; fs.writeFileSync(file, JSON.stringify(job));
  const escaped = path.join(f.root, 'escaped'); fs.mkdirSync(escaped);
  const linked = path.join(f.root, 'linked-store');
  try { fs.symlinkSync(escaped, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Symlink creation unavailable; path/schema checks still ran.'); return; } throw error; }
  assert.throws(() => new HostBridge({ home: linked }), /refuses a link/);
});

test('MCP validates schemas, returns nonblocking job handles and exposes only the pinned project', async (t) => {
  const f = fixture(t);
  const mcp = createMcp({ bridge: f.bridge });
  const call = (name, args) => mcp.handle({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } });
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(listed.result.tools.length, 5);
  assert.ok(listed.result.tools[0].inputSchema.required.includes('requestId'));
  assert.deepEqual(listed.result.tools[0].inputSchema.properties.adapter.enum, ['claude-code']);
  const invalid = await call('quartermaster_bridge_start', { prompt: 'x', requestId: randomUUID(), permissionMode: 'bypassPermissions' });
  assert.equal(invalid.result.isError, true);
  const unsupported = await call('quartermaster_bridge_start', { prompt: 'x', requestId: randomUUID(), adapter: 'codex' });
  assert.equal(unsupported.result.isError, true);
  const request = f.request('hang'); delete request.project;
  request.adapter = 'claude-code';
  const response = await call('quartermaster_bridge_start', request);
  const job = JSON.parse(response.result.content[0].text);
  assert.equal(job.state, 'queued');
  assert.equal(job.handoff.contract, 'eigenwise.agent-handoff');
  assert.equal(job.handoff.adapter, 'claude-code');
  const cancelled = await call('quartermaster_bridge_cancel', { conversationId: job.conversationId, jobId: job.id });
  assert.equal(cancelled.result.isError, false);
  await f.bridge.wait(job.id);
  assert.equal(f.bridge.result(f.lookup(job)).state, 'cancelled');
});

function startSurface(f, entry) {
  const preload = path.join(f.root, 'preload.cjs');
  fs.writeFileSync(preload, `const bridgeModule = require(${JSON.stringify(LIB)}); const Base = bridgeModule.HostBridge; bridgeModule.HostBridge = class extends Base { constructor(options) { super({ ...options, command: process.execPath, prefixArguments: [${JSON.stringify(f.script)}] }); } };`);
  return spawn(process.execPath, ['--require', preload, entry, ...(entry === MCP ? ['--project', f.project] : [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...f.environment, QUARTERMASTER_BRIDGE_HOME: f.home } });
}

test('real stdio MCP initialization/tool calls and stdin shutdown leave no live child', async (t) => {
  const f = fixture(t);
  const child = startSurface(f, MCP);
  let buffer = ''; const replies = []; let errors = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const exit = new Promise((resolve) => child.once('close', resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  send(1, 'initialize', { protocolVersion: '2025-06-18' });
  send(2, 'tools/list', {});
  send(3, 'tools/call', { name: 'quartermaster_bridge_start', arguments: f.request('hang') });
  await until(() => replies.length === 3 && f.calls().length === 1);
  assert.equal(replies.find((reply) => reply.id === 1).result.serverInfo.name, 'quartermaster-host-bridge');
  assert.equal(replies.find((reply) => reply.id === 2).result.tools.length, 5);
  const job = JSON.parse(replies.find((reply) => reply.id === 3).result.content[0].text);
  child.stdin.end();
  assert.equal(await exit, 0, errors);
  assert.equal(processAlive(f.calls()[0].pid), false);
  assert.equal(f.bridge.result(f.lookup(job)).state, 'interrupted');
});

test('two independent MCP processes racing the same request launch exactly one Claude host', async (t) => {
  const f = fixture(t);
  const peers = [startSurface(f, MCP), startSurface(f, MCP)];
  const outputs = peers.map(() => []);
  const errors = peers.map(() => '');
  const exits = peers.map((peer, index) => {
    let buffer = '';
    peer.stdout.on('data', (chunk) => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { outputs[index].push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
    peer.stderr.on('data', (chunk) => { errors[index] += chunk; });
    return new Promise((resolve) => peer.once('close', resolve));
  });
  t.after(async () => { for (const peer of peers) peer.stdin.end(); await Promise.all(exits); });
  const request = f.request('hang');
  for (const peer of peers) peer.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quartermaster_bridge_start', arguments: request } })}\n`);
  await until(() => outputs.every((items) => items.length === 1) && f.calls().length === 1);
  const jobs = outputs.map((items) => { assert.equal(items[0].result.isError, false, JSON.stringify(items)); return JSON.parse(items[0].result.content[0].text); });
  assert.equal(jobs[0].id, jobs[1].id); assert.equal(jobs[0].conversationId, jobs[1].conversationId);
  assert.equal(f.calls().length, 1);
  for (const peer of peers) peer.stdin.end();
  const codes = await Promise.all(exits);
  assert.deepEqual(codes, [0, 0], errors.join('\n'));
  assert.equal(processAlive(f.calls()[0].pid), false);
});

test('CLI runs the same bridge and returns queued plus terminal JSON with stdin intact', async (t) => {
  const f = fixture(t);
  const preload = path.join(f.root, 'cli-preload.cjs');
  fs.writeFileSync(preload, `const bridgeModule = require(${JSON.stringify(LIB)}); const Base = bridgeModule.HostBridge; bridgeModule.HostBridge = class extends Base { constructor(options) { super({ ...options, command: process.execPath, prefixArguments: [${JSON.stringify(f.script)}] }); } };`);
  const request = f.request();
  const child = spawn(process.execPath, ['--require', preload, CLI, 'start', '--project', f.project, '--request', request.requestId, '--adapter', 'claude-code'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...f.environment, QUARTERMASTER_BRIDGE_HOME: f.home } });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
  const exit = new Promise((resolve) => child.once('close', resolve));
  child.stdin.end(request.prompt);
  assert.equal(await exit, 0, errors);
  const lines = output.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2); assert.equal(lines[0].state, 'queued'); assert.equal(lines[1].state, 'succeeded');
  assert.equal(lines[0].handoff.adapter, 'claude-code'); assert.equal(lines[1].handoff.safeToResume, true);
  assert.equal(f.calls()[0].input, request.prompt);
});

test('CLI refuses an unsupported adapter before reading a message or launching any host', async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, [CLI, 'start', '--project', f.project, '--request', randomUUID(), '--adapter', 'codex', '--message-file', path.join(f.root, 'does-not-exist')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...f.environment, QUARTERMASTER_BRIDGE_HOME: f.home } });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
  const exit = new Promise((resolve) => child.once('close', resolve));
  child.stdin.end();
  assert.equal(await exit, 1);
  assert.equal(output, ''); assert.match(errors, /Unsupported agent adapter.*no fallback/);
  assert.equal(f.calls().length, 0);
});

test('CLI exact replays succeed for a previous owner’s completed turn and honestly accept a pending turn', async (t) => {
  const f = fixture(t);
  const preload = path.join(f.root, 'cli-replay-preload.cjs');
  fs.writeFileSync(preload, `const bridgeModule = require(${JSON.stringify(LIB)}); const Base = bridgeModule.HostBridge; bridgeModule.HostBridge = class extends Base { constructor(options) { super({ ...options, command: process.execPath, prefixArguments: [${JSON.stringify(f.script)}] }); } };`);
  const run = async (request) => {
    const child = spawn(process.execPath, ['--require', preload, CLI, 'start', '--project', f.project, '--request', request.requestId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...f.environment, QUARTERMASTER_BRIDGE_HOME: f.home } });
    let output = ''; let error = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    const exit = new Promise((resolve) => child.once('close', resolve));
    child.stdin.end(request.prompt);
    assert.equal(await exit, 0, error);
    return output.trim().split('\n').map(JSON.parse);
  };
  const completeRequest = f.request();
  const complete = f.bridge.start(completeRequest); await done(f, complete);
  const completedReplay = await run(completeRequest);
  assert.equal(completedReplay[0].id, complete.id);
  assert.equal(completedReplay[1].terminal, true); assert.equal(completedReplay[1].state, 'succeeded');
  const pendingRequest = f.request('hang');
  const pending = f.bridge.start(pendingRequest); await until(() => f.calls().length === 2);
  const pendingReplay = await run(pendingRequest);
  assert.equal(pendingReplay[0].id, pending.id);
  assert.equal(pendingReplay[1].terminal, false); assert.equal(pendingReplay[1].accepted, true);
  assert.equal(pendingReplay[1].state, 'running');
  assert.equal(f.calls().length, 2);
  f.bridge.cancel(f.lookup(pending)); await done(f, pending);
});
