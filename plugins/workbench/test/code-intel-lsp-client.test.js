'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  createLspClient,
  createFrameParser,
  fileToUri,
  uriToFile,
  normalizeLocations,
  REQUEST_TIMEOUT_ENV,
} = require('../lib/code-intel/lsp-client.js');

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-language-server.js');

function frame(message) {
  const json = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

test('frame parser handles split, batched, and multibyte frames', () => {
  const parser = createFrameParser();
  const first = frame({ jsonrpc: '2.0', id: 1, result: 'héllo — ünïcode' });
  const second = frame({ jsonrpc: '2.0', method: 'note', params: { value: 2 } });
  const combined = Buffer.concat([first, second]);
  const splitAt = 10;
  assert.deepEqual(parser.push(combined.slice(0, splitAt)), []);
  const remainder = parser.push(combined.slice(splitAt));
  assert.equal(remainder.length, 2);
  assert.equal(remainder[0].message.result, 'héllo — ünïcode');
  assert.equal(remainder[1].message.method, 'note');
});

test('frame parser skips a header without a content length', () => {
  const parser = createFrameParser();
  const messages = parser.push(Buffer.concat([Buffer.from('X-Junk: 1\r\n\r\n'), frame({ jsonrpc: '2.0', id: 7, result: null })]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.id, 7);
});

test('file uri round trip preserves the path', () => {
  const filePath = path.join(os.tmpdir(), 'code intel spaces', 'main.ts');
  const uri = fileToUri(filePath);
  assert.match(uri, /^file:\/\//);
  assert.ok(!uri.includes(' '));
  assert.equal(uriToFile(uri).toLowerCase(), path.resolve(filePath).toLowerCase());
});

test('normalizeLocations converts Location and LocationLink shapes to 1-based positions', () => {
  assert.deepEqual(normalizeLocations(null), []);
  const uri = fileToUri(path.join(os.tmpdir(), 'x.ts'));
  const [location] = normalizeLocations([{ uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } }]);
  assert.equal(location.line, 1);
  assert.equal(location.column, 5);
  const [link] = normalizeLocations([{ targetUri: uri, targetSelectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } }]);
  assert.equal(link.line, 3);
});

test('normalizeLocations refuses to treat non-file URI schemes as local files', () => {
  const [https] = normalizeLocations([{ uri: 'https://example.com/steal/exfiltrated.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } }]);
  assert.equal(https.file, null, 'an https URI must never become a local file path');
  assert.equal(https.line, 1, 'positions stay 1-based even for withheld locations');
  const [untitled] = normalizeLocations([{ targetUri: 'untitled:Untitled-1', targetSelectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 6 } } }]);
  assert.equal(untitled.file, null);
  assert.equal(untitled.line, 5);
});

test('uriToFile parses every file: URI spelling and rejects every non-file scheme', () => {
  const filePath = path.resolve(os.tmpdir(), 'single slash.ts');
  const tripleSlash = fileToUri(filePath);
  const singleSlash = 'file:' + tripleSlash.slice('file://'.length);
  assert.match(singleSlash, /^file:\/[^/]/, 'the fixture must exercise the single-slash RFC 8089 form');
  assert.equal(uriToFile(singleSlash).toLowerCase(), filePath.toLowerCase(), 'the single-slash file: form names the same local file');
  assert.equal(uriToFile('FILE' + tripleSlash.slice('file'.length)).toLowerCase(), filePath.toLowerCase(), 'the scheme is case-insensitive');
  assert.equal(uriToFile('file://localhost' + tripleSlash.slice('file://'.length)).toLowerCase(), filePath.toLowerCase(), 'a localhost authority means this machine');
  assert.equal(uriToFile('https://example.com/steal/exfiltrated.ts'), null);
  assert.equal(uriToFile('untitled:Untitled-1'), null);
  assert.equal(uriToFile('c:/looks/like/a/path.ts'), null, 'a bare drive-letter path is a c: scheme URI, never a local file');
  assert.equal(uriToFile('not a uri'), null);
  assert.equal(uriToFile(''), null);
  assert.equal(uriToFile('file:///bad%zzpercent'), null, 'undecodable percent escapes fail closed');
});

test('normalizeLocations keeps a single-slash file: URI as a local file', () => {
  const filePath = path.resolve(os.tmpdir(), 'x.ts');
  const singleSlash = 'file:' + fileToUri(filePath).slice('file://'.length);
  const [location] = normalizeLocations([{ uri: singleSlash, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } }]);
  assert.equal(location.file.toLowerCase(), filePath.toLowerCase());
  assert.equal(location.line, 1);
});

function makeProject() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-client-'));
  const filePath = path.join(rootDir, 'main.ts');
  fs.writeFileSync(filePath, 'const value: number = 1;\n');
  return { rootDir, filePath };
}

function fakeRecipe() {
  return { backend: 'typescript-language-server', command: process.execPath, args: [FAKE_SERVER, '--stdio'] };
}

function withFakeServerEnv(t, overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function readLog(logPath) {
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate, limitMs = 3000) {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > limitMs) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('client pulls diagnostics, discards pushes, and answers server requests', async (t) => {
  const { rootDir, filePath } = makeProject();
  const logPath = path.join(rootDir, 'server.log');
  withFakeServerEnv(t, { FAKE_LSP_PULL: '1', FAKE_LSP_LOG: logPath });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const diagnostics = await client.diagnostics(filePath);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 4242);

  const stats = client.discardStats();
  assert.ok(stats.notificationCount >= 2, `expected discarded chatter, got ${JSON.stringify(stats)}`);
  assert.ok(stats.publishDiagnosticCount >= 1);
  assert.ok(stats.notificationBytes > 0);

  await waitFor(() => readLog(logPath).some((record) => record.id === 'fake-server-request-1' && record.method === undefined));
  const initializeRecord = readLog(logPath).find((record) => record.method === 'initialize');
  assert.equal(initializeRecord.params.initializationOptions.disableAutomaticTypingAcquisition, true);
});

test('client resolves definitions 1-based and refreshes changed files', async (t) => {
  const { rootDir, filePath } = makeProject();
  const logPath = path.join(rootDir, 'server.log');
  withFakeServerEnv(t, { FAKE_LSP_PULL: '1', FAKE_LSP_LOG: logPath });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const definitions = await client.definition(filePath, 1, 7);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].line, 2);
  assert.equal(definitions[0].column, 3);

  fs.writeFileSync(filePath, 'const value: number = 2;\n');
  fs.utimesSync(filePath, new Date(), new Date(Date.now() + 5000));
  await client.references(filePath, 1, 7);

  const log = readLog(logPath);
  assert.ok(log.some((record) => record.method === 'textDocument/didOpen'));
  const change = log.find((record) => record.method === 'textDocument/didChange');
  assert.equal(change.params.textDocument.version, 2);
  assert.match(change.params.contentChanges[0].text, /= 2;/);
});

test('client harvests push diagnostics when the server has no pull support', async (t) => {
  const { rootDir, filePath } = makeProject();
  withFakeServerEnv(t, { FAKE_LSP_PULL: undefined, FAKE_LSP_LOG: undefined });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const firstPass = await client.diagnostics(filePath);
  assert.equal(firstPass.length, 1);
  assert.match(firstPass[0].message, /fake push diagnostic v1/);

  const secondPass = await client.diagnostics(filePath);
  assert.match(secondPass[0].message, /fake push diagnostic v2/);
});

test('concurrent same-file diagnostics both resolve with their own harvest', async (t) => {
  const { rootDir, filePath } = makeProject();
  withFakeServerEnv(t, { FAKE_LSP_PULL: undefined, FAKE_LSP_LOG: undefined });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const [firstPass, secondPass] = await Promise.all([
    client.diagnostics(filePath),
    client.diagnostics(filePath),
  ]);
  assert.match(firstPass[0].message, /fake push diagnostic v1/);
  assert.match(secondPass[0].message, /fake push diagnostic v2/);
});

test('a stale earlier-version push does not satisfy a newer harvest', async (t) => {
  const { rootDir, filePath } = makeProject();
  withFakeServerEnv(t, { FAKE_LSP_PULL: undefined, FAKE_LSP_LOG: undefined, FAKE_LSP_STALE_PUSH: '1' });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const firstPass = await client.diagnostics(filePath);
  assert.match(firstPass[0].message, /fake push diagnostic v1/);
  const secondPass = await client.diagnostics(filePath);
  assert.match(secondPass[0].message, /fake push diagnostic v2/);
});

test('an aborted request rejects promptly, sends $/cancelRequest, and leaves the server alive', async (t) => {
  const { rootDir, filePath } = makeProject();
  const logPath = path.join(rootDir, 'server.log');
  withFakeServerEnv(t, { FAKE_LSP_PULL: '1', FAKE_LSP_LOG: logPath });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const cancellation = new AbortController();
  const hung = client.definition(filePath, 999, 1, cancellation.signal);
  await waitFor(() => fs.existsSync(logPath) && readLog(logPath).some((record) => record.method === 'textDocument/definition'));
  cancellation.abort();
  await assert.rejects(() => hung, /cancelled by the requesting tool call/);
  assert.equal(client.isAlive(), true, 'cancellation must not kill the language server');
  await waitFor(() => readLog(logPath).some((record) => record.method === '$/cancelRequest'));
  const definitions = await client.definition(filePath, 1, 7);
  assert.equal(definitions.length, 1);
});

test('an aborted push-harvest wait disarms promptly instead of waiting out the harvest timer', async (t) => {
  const { rootDir, filePath } = makeProject();
  withFakeServerEnv(t, { FAKE_LSP_PULL: undefined, FAKE_LSP_LOG: undefined, FAKE_LSP_PUSH_DELAY_MS: '5000' });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const cancellation = new AbortController();
  const startedAt = Date.now();
  const harvest = client.diagnostics(filePath, cancellation.signal);
  setTimeout(() => cancellation.abort(), 50).unref();
  await assert.rejects(() => harvest, /cancelled by the requesting tool call/);
  assert.ok(Date.now() - startedAt < 4000, 'cancellation must not wait for the delayed push');
});

test('a cancelled call during a hung initialize settles promptly and leaves the root client alive', async (t) => {
  const { rootDir, filePath } = makeProject();
  withFakeServerEnv(t, { [REQUEST_TIMEOUT_ENV]: '2000' });
  const client = createLspClient({
    rootDir,
    recipe: { backend: 'typescript-language-server', command: process.execPath, args: ['-e', 'process.stdin.resume()'] },
  });
  t.after(() => client.kill('test finished'));

  const cancellation = new AbortController();
  const startedAt = Date.now();
  const hung = client.diagnostics(filePath, cancellation.signal);
  setTimeout(() => cancellation.abort(), 50).unref();
  await assert.rejects(() => hung, /cancelled by the requesting tool call/);
  assert.ok(Date.now() - startedAt < 1500, 'cancellation must not wait out the initialize timeout');
  assert.equal(client.isAlive(), true, 'a cancelled wait during initialize must not kill the shared root client');
});

test('a same-file refresh after the harvest is armed makes the earlier push stale', async (t) => {
  const { rootDir, filePath } = makeProject();
  const logPath = path.join(rootDir, 'server.log');
  withFakeServerEnv(t, { FAKE_LSP_PULL: undefined, FAKE_LSP_LOG: logPath, FAKE_LSP_PUSH_DELAY_MS: '500' });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const harvest = client.diagnostics(filePath);
  await waitFor(() => fs.existsSync(logPath) && readLog(logPath).some((record) => record.method === 'textDocument/didOpen'));
  fs.writeFileSync(filePath, 'const value: number = 2;\n');
  fs.utimesSync(filePath, new Date(), new Date(Date.now() + 5000));
  await client.definition(filePath, 1, 7);
  const harvested = await harvest;
  assert.match(harvested[0].message, /fake push diagnostic v2/, 'a push for the pre-refresh document must not satisfy the armed harvest');
});

test('an unversioned push satisfies a harvest while the tracked file has not advanced', async (t) => {
  const { rootDir, filePath } = makeProject();
  withFakeServerEnv(t, { FAKE_LSP_PULL: undefined, FAKE_LSP_LOG: undefined, FAKE_LSP_UNVERSIONED_PUSH: '1' });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const harvested = await client.diagnostics(filePath);
  assert.match(harvested[0].message, /fake push diagnostic v1/, 'a TypeScript 5 push may validly omit its version and must still be harvested');
});

test('after a same-file refresh, a delayed unversioned push no longer satisfies the armed harvest', async (t) => {
  const { rootDir, filePath } = makeProject();
  const logPath = path.join(rootDir, 'server.log');
  withFakeServerEnv(t, {
    FAKE_LSP_PULL: undefined,
    FAKE_LSP_LOG: logPath,
    FAKE_LSP_PUSH_DELAY_MS: '500',
    FAKE_LSP_UNVERSIONED_PUSH: '1',
    [REQUEST_TIMEOUT_ENV]: '2000',
  });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  const harvest = client.diagnostics(filePath);
  await waitFor(() => fs.existsSync(logPath) && readLog(logPath).some((record) => record.method === 'textDocument/didOpen'));
  fs.writeFileSync(filePath, 'const value: number = 2;\n');
  fs.utimesSync(filePath, new Date(), new Date(Date.now() + 5000));
  await client.definition(filePath, 1, 7);
  await assert.rejects(
    () => harvest,
    /timed out after 2000ms waiting/,
    'an unversioned push generated before the same-file refresh must not satisfy the armed harvest',
  );
  assert.ok(client.discardStats().publishDiagnosticCount >= 2, 'the refused unversioned pushes must be discarded and counted');
  assert.equal(client.isAlive(), true, 'refusing a stale unversioned push must not kill the language server');
});

test('a terminated language-server stdin settles a request without a later uncaught exception', async (t) => {
  const { rootDir, filePath } = makeProject();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.pid = 1;
  child.kill = () => {};
  let writes = 0;
  stdin.on('data', (chunk) => {
    writes += 1;
    if (writes === 1) stdout.write(frame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
  });
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => child;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });
  const uncaught = [];
  const recordUncaught = (error) => uncaught.push(error);
  process.on('uncaughtExceptionMonitor', recordUncaught);
  t.after(() => process.off('uncaughtExceptionMonitor', recordUncaught));
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  await client.ready();
  const definition = client.definition(filePath, 1, 7);
  await waitFor(() => writes >= 4);
  const closedPipe = new Error('broken pipe');
  closedPipe.code = 'EPIPE';
  stdin.emit('error', closedPipe);
  await assert.rejects(() => definition, /stdin write failed: broken pipe/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(uncaught, []);
  assert.equal(client.isAlive(), false);
});

test('a timed-out request kills the server process to cancel the work', async (t) => {
  const { rootDir, filePath } = makeProject();
  withFakeServerEnv(t, { [REQUEST_TIMEOUT_ENV]: '500', FAKE_LSP_PULL: '1', FAKE_LSP_LOG: undefined });
  const client = createLspClient({ rootDir, recipe: fakeRecipe() });
  t.after(() => client.kill('test finished'));

  await assert.rejects(() => client.definition(filePath, 999, 1), /timed out after 500ms.*killed to cancel/s);
  assert.equal(client.isAlive(), false);
  await assert.rejects(() => client.definition(filePath, 1, 1), /not running/);
});

test('a client whose command cannot start reports the failure', async (t) => {
  const { rootDir, filePath } = makeProject();
  const client = createLspClient({
    rootDir,
    recipe: { backend: 'typescript-native', command: path.join(rootDir, 'missing-binary'), args: [] },
  });
  t.after(() => client.kill('test finished'));
  await assert.rejects(() => client.definition(filePath, 1, 1), /failed to start|not running|exited/);
});
