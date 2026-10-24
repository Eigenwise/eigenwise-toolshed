'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const supervision = require('../lib/process-supervision.js');

function installedFixture(root, version) {
  const install = path.join(root, 'plugins', 'cache', 'fixture', 'model-gateway', version);
  fs.mkdirSync(path.join(install, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return install;
}

function birthFile(directory, birth) {
  const identity = crypto.createHash('sha256').update(birth.startedAt).digest('hex');
  return path.join(directory, `${birth.pid}-${identity}.json`);
}

function cleanupFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-worker-ownership-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const older = installedFixture(home, '0.49.0');
  const current = installedFixture(home, '0.50.0');
  const worker = { pid: 702, parentPid: 1, startedAt: 'worker-birth', command: `node "${path.join(older, 'bin', 'model-gateway.js')}" serve-worker` };
  const parent = { pid: 700, startedAt: 'parent-birth', command: 'node fixture-parent' };
  const supervisor = { pid: 701, parentPid: 1, startedAt: 'healthy-birth', command: `node "${path.join(current, 'bin', 'model-gateway.js')}" serve-shim` };
  const birth = { schemaVersion: 1, pid: worker.pid, startedAt: worker.startedAt, command: worker.command,
    installRoot: older, version: '0.49.0', parent };
  const directory = path.join(home, 'worker-births');
  fs.mkdirSync(directory);
  const file = birthFile(directory, birth);
  fs.writeFileSync(file, JSON.stringify(birth));
  const live = new Map([[702, worker], [701, supervisor], [700, null]]);
  const processes = new Map([[1, { pid: 1, parentPid: null }], [701, supervisor], [702, worker]]);
  const signals = [];
  const options = { windows: false, directory, currentInstallRoot: current, currentVersion: '0.50.0',
    processTable: () => processes, inspectProcess: (pid) => live.get(pid),
    terminate: (pid) => { signals.push(pid); return true; } };
  return { birth, worker, parent, supervisor, file, directory, live, processes, signals, options,
    save: () => fs.writeFileSync(file, JSON.stringify(birth)),
    reap: () => supervision.reapGatewayOrphans(701, options) };
}

test('a recorded stale worker is reaped after its real birth parent disappeared, not followed through that dead parent', (t) => {
  const f = cleanupFixture(t);
  assert.deepEqual(f.reap(), [702]);
  assert.deepEqual(f.signals, [702]);
  assert.equal(fs.existsSync(f.file), true, 'a requested TERM is not proof of exit');
  f.live.set(702, null);
  assert.deepEqual(f.reap(), []);
  assert.equal(fs.existsSync(f.file), false, 'only confirmed absence retires this birth record');
});

for (const [label, mutate] of [
  ['no record', (f) => fs.unlinkSync(f.file)],
  ['invalid JSON', (f) => fs.writeFileSync(f.file, '{')],
  ['missing start identity', (f) => { f.birth.startedAt = null; f.save(); }],
  ['unsupported birth schema', (f) => { f.birth.schemaVersion = 2; f.save(); }],
  ['unrecognized worker command', (f) => { f.birth.command = 'node not-a-gateway serve-worker'; f.save(); }],
  ['not a worker command', (f) => { f.birth.command = f.birth.command.replace('serve-worker', 'serve-shim'); f.save(); }],
  ['missing install manifest', (f) => fs.unlinkSync(path.join(f.birth.installRoot, '.claude-plugin', 'plugin.json'))],
  ['invalid installed version', (f) => fs.writeFileSync(path.join(f.birth.installRoot, '.claude-plugin', 'plugin.json'), '{"version":"unknown"}')],
  ['renamed record file', (f) => fs.renameSync(f.file, path.join(f.directory, 'unrelated.json'))],
  ['invalid PID', (f) => { f.birth.pid = -702; f.save(); }],
  ['non-numeric PID', (f) => { f.birth.pid = '702'; f.save(); }],
  ['unparseable recorded version', (f) => { f.birth.version = 'unknown'; f.save(); }],
  ['missing install root', (f) => { f.birth.installRoot = null; f.save(); }],
  ['missing version', (f) => { f.birth.version = null; f.save(); }],
  ['unknown supervisor start', (f) => { f.supervisor.startedAt = null; }],
  ['missing parent identity', (f) => { f.birth.parent = null; f.save(); }],
  ['unrecorded parent start', (f) => { f.birth.parent.startedAt = null; f.save(); }],
  ['same version', (f) => { f.options.currentVersion = f.birth.version; }],
  ['newer worker version', (f) => { f.options.currentVersion = '0.48.0'; }],
  ['unreadable current version', (f) => { f.options.currentVersion = 'unknown'; }],
  ['foreign install', (f) => { f.options.currentInstallRoot = path.join(f.directory, 'foreign', 'model-gateway'); }],
  ['wrong recorded install root', (f) => { f.birth.installRoot = f.options.currentInstallRoot; f.save(); }],
  ['changed installed version', (f) => { f.birth.version = '0.48.0'; f.save(); }],
  ['unknown worker inspection', (f) => f.live.set(702, undefined)],
  ['unknown parent inspection', (f) => f.live.set(700, undefined)],
  ['still-live birth parent', (f) => f.live.set(700, f.parent)],
  ['unreadable live parent start', (f) => f.live.set(700, { pid: 700, startedAt: null })],
  ['PID reused with another command', (f) => { f.worker.command = 'node foreign-worker'; }],
  ['current worker under protected supervisor', (f) => { f.worker.parentPid = 701; }],
  ['missing candidate ancestry', (f) => f.processes.delete(702)],
  ['missing root ancestry', (f) => f.processes.delete(1)],
  ['cyclic ancestry', (f) => { f.worker.parentPid = 702; }],
  ['unknown parent value', (f) => { f.worker.parentPid = undefined; }],
  ['failed process snapshot', (f) => { f.options.processTable = () => null; }],
  ['throwing process snapshot', (f) => { f.options.processTable = () => { throw new Error('probe unavailable'); }; }],
  ['throwing identity probe', (f) => { f.options.inspectProcess = () => { throw new Error('probe unavailable'); }; }],
  ['missing protected supervisor', (f) => f.processes.delete(701)],
  ['unknown protected supervisor', (f) => f.live.set(701, undefined)],
]) {
  test(`protected cleanup fails closed for ${label}`, (t) => {
    const f = cleanupFixture(t);
    mutate(f);
    assert.deepEqual(f.reap(), []);
    assert.deepEqual(f.signals, []);
  });
}

test('a reused parent PID proves the recorded parent epoch ended', (t) => {
  const f = cleanupFixture(t);
  f.live.set(700, { ...f.parent, startedAt: 'replacement-parent-birth' });
  assert.deepEqual(f.reap(), [702]);
});

test('a worker PID reused after its recorded birth retires only the obsolete record without a signal', (t) => {
  const f = cleanupFixture(t);
  f.live.set(702, { ...f.worker, startedAt: 'replacement-worker-birth' });
  assert.deepEqual(f.reap(), []);
  assert.deepEqual(f.signals, []);
  assert.equal(fs.existsSync(f.file), false);
});

test('fresh worker identity is verified immediately before signaling', (t) => {
  const f = cleanupFixture(t);
  const events = [];
  let workerQueries = 0;
  f.options.inspectProcess = (pid) => {
    events.push(`inspect:${pid}`);
    if (pid !== 702) return f.live.get(pid);
    workerQueries += 1;
    return workerQueries === 1 ? f.worker : { ...f.worker, startedAt: 'reused-before-TERM' };
  };
  f.options.terminate = () => assert.fail('the fresh identity is a different process');
  assert.deepEqual(f.reap(), []);
  assert.ok(workerQueries >= 2, JSON.stringify(events));
});

test('unknown evidence never deletes a retained birth record', (t) => {
  const f = cleanupFixture(t);
  f.live.set(702, undefined);
  assert.deepEqual(f.reap(), []);
  assert.equal(fs.existsSync(f.file), true);
});

test('a failed termination leaves the exact birth record for a later attempt', (t) => {
  const f = cleanupFixture(t);
  f.options.terminate = () => false;
  assert.deepEqual(f.reap(), []);
  assert.equal(fs.existsSync(f.file), true);
});

test('ESRCH during a verified termination is benign and the birth is removed only after absence', (t) => {
  const f = cleanupFixture(t);
  f.options.terminate = () => {
    f.live.set(702, null);
    throw Object.assign(new Error('already exited'), { code: 'ESRCH' });
  };
  assert.deepEqual(f.reap(), []);
  assert.equal(fs.existsSync(f.file), false);
});

test('a newer replacement birth record cannot be deleted by an older cleanup pass', (t) => {
  const f = cleanupFixture(t);
  const replacement = { ...f.birth, command: 'changed-record-content' };
  f.options.terminate = () => {
    fs.writeFileSync(f.file, JSON.stringify(replacement));
    f.live.set(702, null);
    return true;
  };
  assert.deepEqual(f.reap(), [702]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), replacement);
});

test('POSIX process-table parser executes on every CI platform with explicit windows:false', async () => {
  const table = await supervision.processTableAsync({ windows: false,
    commandResult: async (command, args) => {
      assert.equal(command, 'ps');
      assert.ok(args.includes('-eo'));
      return { status: 0, stdout: '1 0 Sun Oct 18 00:00:00 2026 init\n702 1 Sun Oct 18 00:00:00 2026 node fixture' };
    } });
  assert.equal(table.get(1).parentPid, null);
  assert.equal(table.get(702).parentPid, 1);
});

test('Windows birth-parent PID reuse into the protected supervisor never authorizes stopping its live child', (t) => {
  const f = cleanupFixture(t);
  f.options.windows = true;
  f.birth.parent.pid = 701;
  f.worker.parentPid = 701;
  f.save();
  assert.deepEqual(f.reap(), []);
  assert.deepEqual(f.signals, []);
});

test('Windows parent PID reuse with unknown current ancestry is not a proven lost-parent root', (t) => {
  const f = cleanupFixture(t);
  f.options.windows = true;
  f.worker.parentPid = 700;
  f.live.set(700, { ...f.parent, startedAt: 'reused-parent-birth' });
  assert.deepEqual(f.reap(), []);
  assert.deepEqual(f.signals, []);
});

test('Windows can prove a lost birth parent without POSIX reparenting, but POSIX requires a rooted current chain', (t) => {
  const f = cleanupFixture(t);
  f.worker.parentPid = f.birth.parent.pid;
  assert.deepEqual(f.reap(), []);
  f.options.windows = true;
  assert.deepEqual(f.reap(), [702]);
});

test('a parent change between the snapshot and final inspection prevents a signal', (t) => {
  const f = cleanupFixture(t);
  let calls = 0;
  f.options.inspectProcess = (pid) => {
    if (pid !== 702) return f.live.get(pid);
    calls += 1;
    return calls === 1 ? f.worker : { ...f.worker, parentPid: 701 };
  };
  assert.deepEqual(f.reap(), []);
  assert.deepEqual(f.signals, []);
});

test('non-files in the birth directory are not followed as ownership records', (t) => {
  const f = cleanupFixture(t);
  fs.mkdirSync(path.join(f.directory, 'not-a-record'));
  assert.deepEqual(f.reap(), [702]);
});

test('a missing birth directory is an empty cleanup, not a process scan', (t) => {
  const f = cleanupFixture(t);
  fs.rmSync(f.directory, { recursive: true });
  assert.deepEqual(f.reap(), []);
  assert.deepEqual(f.signals, []);
});

test('protected worker termination requests one exact PID, with no tree command or escalation on any platform', () => {
  const signals = [];
  const signal = (pid, value) => { signals.push([pid, value]); return true; };
  assert.equal(supervision.signalOrphanWorker(702, signal), true);
  assert.deepEqual(signals, [[702, 'SIGTERM']]);
});

test('identity probes distinguish confirmed ESRCH from denied or inconclusive inspection', () => {
  const inspectProcess = () => null;
  assert.equal(supervision.probeWorkerIdentity(702, { inspectProcess, kill: () => true }), undefined);
  const failure = (code) => () => { throw Object.assign(new Error('probe'), { code }); };
  assert.equal(supervision.probeWorkerIdentity(702, { inspectProcess, kill: failure('EPERM') }), undefined);
  assert.equal(supervision.probeWorkerIdentity(702, { inspectProcess, kill: failure('ESRCH') }), null);
  const live = { pid: 702, startedAt: 'birth', command: 'fixture' };
  assert.equal(supervision.probeWorkerIdentity(702, { inspectProcess: () => live, kill: () => assert.fail('not an absence probe') }), live);
});

function birthWriterFixture(t) {
  const f = cleanupFixture(t);
  const { STATE } = require('../lib/runtime.js');
  fs.mkdirSync(STATE, { recursive: true });
  const directory = path.join(STATE, 'worker-births');
  fs.rmSync(directory, { recursive: true, force: true });
  t.after(() => { supervision.removePid('shim', 702); fs.rmSync(directory, { recursive: true, force: true }); });
  const worker = { ...f.worker, parentPid: process.pid };
  const parent = { ...f.parent, pid: process.pid };
  const options = { inspectProcess: async (pid) => pid === worker.pid ? worker : parent };
  return { ...f, worker, parent, options, directory,
    write: (name = 'shim') => supervision.writePidRecordAsync(name, 702, options),
    files: () => fs.readdirSync(directory) };
}

test('the existing async shim PID writer saves the actual worker and parent birth identities separately', async (t) => {
  const f = birthWriterFixture(t);
  await f.write();
  const [file] = f.files();
  const record = JSON.parse(fs.readFileSync(path.join(f.directory, file), 'utf8'));
  assert.deepEqual(record, { schemaVersion: 1, pid: 702, command: f.worker.command, startedAt: f.worker.startedAt,
    installRoot: f.birth.installRoot, version: f.birth.version, parent: f.parent });
  assert.equal(file, path.basename(birthFile(f.directory, record)));
});

for (const [label, mutate] of [
  ['missing worker', (f) => { f.options.inspectProcess = async () => null; }],
  ['missing worker start', (f) => { f.worker.startedAt = null; }],
  ['missing worker command', (f) => { f.worker.command = null; }],
  ['not our child', (f) => { f.worker.parentPid = 799; }],
  ['missing parent', (f) => { f.options.inspectProcess = async (pid) => pid === 702 ? f.worker : null; }],
  ['wrong parent identity', (f) => { f.parent.pid = 799; }],
  ['not a gateway worker', (f) => { f.worker.command = 'node unrelated'; }],
  ['stopped writer', (f) => { f.options.stillActive = () => false; }],
  ['replaced PID record', (f) => { f.options.stillActive = () => { fs.writeFileSync(supervision.pidFile('shim'), '703'); return true; }; }],
]) {
  test(`the birth writer does not invent ownership for ${label}`, async (t) => {
    const f = birthWriterFixture(t);
    mutate(f);
    await f.write();
    assert.equal(fs.existsSync(f.directory), false);
    supervision.removePid('shim');
  });
}

for (const [label, result, expected] of [
  ['timeout', { timedOut: true }, undefined],
  ['failed query', { status: 1 }, null],
  ['malformed Windows JSON', { status: 0, stdout: '{' }, null],
]) {
  test(`process table ${label} remains unknown without inventing ancestry`, async () => {
    assert.equal(await supervision.processTableAsync({ windows: true, commandResult: async () => result }), expected);
  });
}

test('Windows table output accepts explicit root zero and a single CIM object', async () => {
  const table = await supervision.processTableAsync({ windows: true,
    commandResult: async () => ({ status: 0, stdout: JSON.stringify({ ProcessId: 702, ParentProcessId: 0, CommandLine: 'fixture', CreationDate: 'birth' }) }) });
  assert.equal(table.get(702).parentPid, null);
  assert.equal(table.get(702).startedAt, 'birth');
});

test('confirmed orphan walks preserve the supervisor and reject unknown or cyclic ancestry', () => {
  const processes = new Map([[1, { parentPid: null }], [701, { parentPid: 1 }], [702, { parentPid: 1 }]]);
  assert.equal(supervision.isConfirmedOrphan(702, 701, processes), true);
  assert.equal(supervision.isConfirmedOrphan(701, 701, processes), false);
  assert.equal(supervision.isConfirmedOrphan(799, 701, processes), false);
  processes.set(702, { parentPid: 702 });
  assert.equal(supervision.isConfirmedOrphan(702, 701, processes), false);
});

test('deliberate stop cleanup retains existing recorded-PID success and refusal behavior', () => {
  const calls = [];
  const options = { windows: false, recordedPid: (name) => ({ guardian: 701, shim: 702, proxy: 703 })[name],
    readRecord: (name) => ({ name }),
    kill: (pid, metadata) => { calls.push([pid, metadata.record.name]); return pid !== 702; } };
  assert.deepEqual(supervision.reapGatewayOrphans(null, options), [701, 703]);
  assert.deepEqual(calls, [[701, 'guardian'], [702, 'shim'], [703, 'proxy']]);
  options.recordedPid = () => null;
  assert.deepEqual(supervision.reapGatewayOrphans(null, options), []);
});

test('an empty Windows process table is not malformed or a made-up root', async () => {
  const table = await supervision.processTableAsync({ windows: true, commandResult: async () => ({ status: 0, stdout: '' }) });
  assert.equal(table.size, 0);
});

test('POSIX process-table parser discards malformed rows without inventing root entries', async () => {
  const table = await supervision.processTableAsync({ windows: false, commandResult: async () => ({ status: 0, stdout: 'not a process' }) });
  assert.equal(table.size, 0);
});

for (const value of [undefined, null, '', 'invalid', -1, 1.5]) {
  test(`native Windows parent data ${String(value)} does not become a proven root`, async () => {
    const table = await supervision.processTableAsync({ windows: true,
      commandResult: async () => ({ status: 0, stdout: JSON.stringify([{ ProcessId: 702, ParentProcessId: value }]) }) });
    assert.equal(table.get(702).parentPid, undefined);
  });
}
