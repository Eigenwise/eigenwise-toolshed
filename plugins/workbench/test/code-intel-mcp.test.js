'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  handleRequest,
  toolDescriptors,
  serverVersion,
  MAX_REQUEST_CHARS,
  MAX_RESPONSE_CHARS,
  DEFAULT_PROTOCOL_VERSION,
} = require('../lib/code-intel/mcp.js');
const registry = require('../lib/code-intel/project-registry.js');
const { NATIVE_SERVER_ENV, LANGUAGE_SERVER_ENV, registerLanguageServerLocator, unregisterLanguageServerLocator } = require('../lib/code-intel/language-server-locator.js');
const { fileToUri } = require('../lib/code-intel/lsp-client.js');

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-language-server.js');
const MCP_BIN = path.join(__dirname, '..', 'bin', 'code-intel-mcp.js');

function makeProject(prefix = 'code-intel-mcp-') {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(rootDir, 'main.ts');
  fs.writeFileSync(filePath, 'const value: number = 1;\n');
  return { rootDir, filePath };
}

function withEnv(t, overrides) {
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

async function callTool(name, args) {
  const response = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return response.result;
}

// Drives the real stdio server the way an MCP client does, and hands back the
// raw response lines so a test can assert on the exact bytes an id is echoed
// with, not on a re-serialization of them.
async function runStdioServer(rawLines) {
  const child = childProcess.spawn(process.execPath, [MCP_BIN], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env },
  });
  const responseLines = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (line) responseLines.push(line);
    }
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  for (const rawLine of rawLines) child.stdin.write(rawLine + '\n');
  child.stdin.end();
  await closed;
  return responseLines;
}

test.after(() => registry.shutdownAll());

test('initialize reports the code-intel server and plugin version', async () => {
  const response = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(response.result.serverInfo.name, 'code-intel');
  assert.equal(response.result.serverInfo.version, serverVersion());
  assert.equal(response.result.protocolVersion, '2025-03-26');
});

test('notifications and unknown methods follow JSON-RPC rules', async () => {
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
  const ping = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(ping.result, {});
  const unknown = await handleRequest({ jsonrpc: '2.0', id: 4, method: 'bogus/method' });
  assert.equal(unknown.error.code, -32601);
});

test('tools/list stays small and every tool demands an explicit root', async () => {
  const response = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = response.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['definition', 'references', 'diagnostics']);
  for (const tool of tools) {
    assert.ok(tool.inputSchema.required.includes('root'), `${tool.name} must require root`);
  }
  assert.ok(JSON.stringify(response.result).length < 8000);
  assert.deepEqual(toolDescriptors().map((tool) => tool.name), tools.map((tool) => tool.name));
});

test('argument validation rejects malformed calls with actionable messages', async (t) => {
  const { rootDir, filePath } = makeProject();
  withEnv(t, { [NATIVE_SERVER_ENV]: undefined, [LANGUAGE_SERVER_ENV]: undefined });

  const unknownTool = await callTool('typescript_hover', { root: rootDir });
  assert.equal(unknownTool.isError, true);

  const unknownArgument = await callTool('definition', { root: rootDir, file: filePath, line: 1, column: 1, extra: true });
  assert.equal(unknownArgument.isError, true);
  assert.match(unknownArgument.content[0].text, /unknown argument "extra"/);

  const missingRoot = await callTool('definition', { file: filePath, line: 1, column: 1 });
  assert.match(missingRoot.content[0].text, /root is required/);

  const zeroLine = await callTool('definition', { root: rootDir, file: filePath, line: 0, column: 1 });
  assert.match(zeroLine.content[0].text, /line must be an integer >= 1/);

  const emptyFiles = await callTool('diagnostics', { root: rootDir, files: [] });
  assert.match(emptyFiles.content[0].text, /array of 1 to 16 strings/);

  const tooManyFiles = await callTool('diagnostics', { root: rootDir, files: Array.from({ length: 17 }, () => filePath) });
  assert.equal(tooManyFiles.isError, true);
});

test('a missing root and a file outside the root are refused before any server spawns', async (t) => {
  withEnv(t, { [NATIVE_SERVER_ENV]: undefined, [LANGUAGE_SERVER_ENV]: undefined });
  const gone = await callTool('definition', { root: path.join(os.tmpdir(), 'never-existed-root'), file: 'main.ts', line: 1, column: 1 });
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /project root does not exist/);

  const projectA = makeProject('code-intel-mcp-a-');
  const projectB = makeProject('code-intel-mcp-b-');
  const outside = await callTool('definition', { root: projectA.rootDir, file: projectB.filePath, line: 1, column: 1 });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /outside the project root/);
  assert.equal(registry.activeRootCount(), 0);
});

test('a broken server override fails loud in the tool response', async (t) => {
  const { rootDir, filePath } = makeProject();
  withEnv(t, { [NATIVE_SERVER_ENV]: path.join(rootDir, 'missing.exe'), [LANGUAGE_SERVER_ENV]: undefined });
  const outcome = await callTool('diagnostics', { root: rootDir, files: [filePath] });
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.includes(NATIVE_SERVER_ENV));
});

test('a full tools/call round trip binds to the canonical root and reuses one client per root and language', async (t) => {
  const { rootDir, filePath } = makeProject();
  withEnv(t, { [LANGUAGE_SERVER_ENV]: FAKE_SERVER, [NATIVE_SERVER_ENV]: undefined, FAKE_LSP_PULL: '1', FAKE_LSP_LOG: undefined });
  t.after(() => registry.shutdownAll());

  const outcome = await callTool('diagnostics', { root: rootDir, files: ['main.ts'] });
  assert.equal(outcome.isError, undefined);
  const payload = JSON.parse(outcome.content[0].text);
  assert.equal(payload.root, fs.realpathSync.native(rootDir));
  assert.equal(payload.totalDiagnostics, 1);
  assert.equal(payload.files[0].diagnostics[0].code, 4242);
  assert.equal(payload.files[0].diagnostics[0].line, 3);
  assert.equal(registry.activeRootCount(), 1);

  const differentSpelling = process.platform === 'win32' ? rootDir.toUpperCase() : rootDir;
  const second = await callTool('definition', { root: differentSpelling, file: filePath, line: 1, column: 7 });
  assert.equal(second.isError, undefined);
  assert.equal(registry.activeRootCount(), 1);
});

test('clients for distinct languages share a root without eviction', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-multilanguage-');
  const pythonPath = path.join(rootDir, 'main.py');
  fs.writeFileSync(pythonPath, 'value = 1\n');
  const serverLog = path.join(rootDir, 'server.log');
  const pythonLocator = {
    extensions: ['.py'],
    locate() {
      return {
        backend: 'python-test',
        command: process.execPath,
        args: [FAKE_SERVER, '--stdio'],
        initializationOptions: {},
        languageIdFor: () => 'python',
      };
    },
  };
  registerLanguageServerLocator('python-test', pythonLocator);
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: serverLog,
  });
  t.after(() => {
    unregisterLanguageServerLocator('python-test');
    registry.shutdownAll();
  });

  const typescript = await callTool('diagnostics', { root: rootDir, files: [filePath] });
  const python = await callTool('diagnostics', { root: rootDir, files: [pythonPath] });
  assert.equal(typescript.isError, undefined, typescript.content?.[0]?.text);
  assert.equal(python.isError, undefined, python.content?.[0]?.text);
  assert.equal(registry.activeRootCount(), 2, 'one root keeps one client for each language');

  const calls = fs.readFileSync(serverLog, 'utf8').trim().split('\n').map(JSON.parse);
  const openedLanguageIds = calls
    .filter((call) => call.method === 'textDocument/didOpen')
    .map((call) => call.params.textDocument.languageId)
    .sort();
  assert.deepEqual(openedLanguageIds, ['python', 'typescript'], 'each query reaches its language-specific server');
});

test('definition and reference locations outside the bound root are withheld', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-containment-');
  const outsidePath = path.join(os.tmpdir(), 'sibling-worktree', 'secret.ts');
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: undefined,
    FAKE_LSP_EXTERNAL_LOCATION_URI: fileToUri(outsidePath),
    FAKE_LSP_LONG_INROOT_SUFFIX: String(MAX_RESPONSE_CHARS + 10_000),
  });
  t.after(() => registry.shutdownAll());

  const definition = await callTool('definition', { root: rootDir, file: filePath, line: 1, column: 7 });
  assert.equal(definition.isError, undefined, definition.content?.[0]?.text);
  assert.ok(definition.content[0].text.length <= MAX_RESPONSE_CHARS, 'an oversized claimed location path must stay bounded');
  const payload = JSON.parse(definition.content[0].text);
  assert.equal(payload.withheldOutsideRoot, 2, 'the sibling-worktree location and the nonexistent oversized path must both be withheld fail-closed');
  assert.ok(!definition.content[0].text.includes('secret.ts'), 'a sibling-worktree location must never appear in the response');
  const realRoot = fs.realpathSync.native(rootDir).toLowerCase();
  assert.equal(payload.definitions.length, 1, 'only the location that resolves to a real in-root file may be returned');
  for (const entry of payload.definitions) {
    assert.ok(entry.file.toLowerCase().startsWith(realRoot), `${entry.file.slice(0, 120)} must stay under the bound root`);
    assert.ok(entry.file.length <= 401, 'location paths must be capped');
  }

  const references = await callTool('references', { root: rootDir, file: filePath, line: 1, column: 7 });
  assert.equal(references.isError, undefined, references.content?.[0]?.text);
  const referencesPayload = JSON.parse(references.content[0].text);
  assert.equal(referencesPayload.withheldOutsideRoot, 1);
  assert.equal(referencesPayload.total, 2);
  assert.ok(!references.content[0].text.includes('secret.ts'));
});

function withWorkingDirectory(t, directory) {
  const previousWorkingDirectory = process.cwd();
  process.chdir(directory);
  t.after(() => process.chdir(previousWorkingDirectory));
}

test('an https location is withheld even when the bound root is the process cwd', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-scheme-');
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: undefined,
    FAKE_LSP_EXTERNAL_LOCATION_URI: 'https://example.com/steal/exfiltrated.ts',
  });
  t.after(() => registry.shutdownAll());
  withWorkingDirectory(t, fs.realpathSync.native(rootDir));

  const definition = await callTool('definition', { root: rootDir, file: filePath, line: 1, column: 7 });
  assert.equal(definition.isError, undefined, definition.content?.[0]?.text);
  const payload = JSON.parse(definition.content[0].text);
  assert.equal(payload.withheldOutsideRoot, 1, 'a non-file URI must be withheld, not resolved under the cwd');
  assert.equal(payload.definitions.length, 1);
  assert.ok(!definition.content[0].text.includes('example.com'), 'a non-file URI must never appear in the response');

  const references = await callTool('references', { root: rootDir, file: filePath, line: 1, column: 7 });
  assert.equal(references.isError, undefined, references.content?.[0]?.text);
  const referencesPayload = JSON.parse(references.content[0].text);
  assert.equal(referencesPayload.withheldOutsideRoot, 1);
  assert.equal(referencesPayload.total, 2);
  assert.ok(!references.content[0].text.includes('example.com'));
});

test('a location that escapes the root through a junction is withheld even when root is cwd', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-junction-');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-mcp-junction-outside-'));
  fs.writeFileSync(path.join(outsideDir, 'escape.ts'), 'export const leaked = true;\n');
  fs.symlinkSync(outsideDir, path.join(rootDir, 'inside-link'), 'junction');
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: undefined,
    FAKE_LSP_EXTERNAL_LOCATION_URI: fileToUri(path.join(rootDir, 'inside-link', 'escape.ts')),
  });
  t.after(() => registry.shutdownAll());
  withWorkingDirectory(t, fs.realpathSync.native(rootDir));

  const definition = await callTool('definition', { root: rootDir, file: filePath, line: 1, column: 7 });
  assert.equal(definition.isError, undefined, definition.content?.[0]?.text);
  const payload = JSON.parse(definition.content[0].text);
  assert.equal(payload.withheldOutsideRoot, 1, 'a lexically in-root path whose realpath escapes the root must be withheld');
  assert.equal(payload.definitions.length, 1);
  assert.ok(!definition.content[0].text.includes('escape.ts'), 'a junction-escaping location must never appear in the response');
});

test('a location through a file symlink that targets outside the root is withheld', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-symlink-');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-mcp-symlink-outside-'));
  const outsideFile = path.join(outsideDir, 'secret-config.ts');
  fs.writeFileSync(outsideFile, 'export const secret = 1;\n');
  try {
    fs.symlinkSync(outsideFile, path.join(rootDir, 'alias.ts'), 'file');
  } catch (creationError) {
    t.skip(`file symlinks cannot be created here (${creationError.code}); the junction test covers realpath containment`);
    return;
  }
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: undefined,
    FAKE_LSP_EXTERNAL_LOCATION_URI: fileToUri(path.join(rootDir, 'alias.ts')),
  });
  t.after(() => registry.shutdownAll());
  withWorkingDirectory(t, fs.realpathSync.native(rootDir));

  const definition = await callTool('definition', { root: rootDir, file: filePath, line: 1, column: 7 });
  assert.equal(definition.isError, undefined, definition.content?.[0]?.text);
  const payload = JSON.parse(definition.content[0].text);
  assert.equal(payload.withheldOutsideRoot, 1, 'a file symlink whose realpath escapes the root must be withheld');
  assert.ok(!definition.content[0].text.includes('secret-config'), 'the symlink target must never appear in the response');
});

test('a file named ..in-root.ts is served and returned, not mistaken for parent traversal', async (t) => {
  const { rootDir } = makeProject('code-intel-mcp-dotdot-');
  const dotDotFile = path.join(rootDir, '..in-root.ts');
  fs.writeFileSync(dotDotFile, 'export const inRoot = 1;\n');
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: undefined,
    FAKE_LSP_EXTERNAL_LOCATION_URI: fileToUri(dotDotFile),
  });
  t.after(() => registry.shutdownAll());

  const definition = await callTool('definition', { root: rootDir, file: '..in-root.ts', line: 1, column: 7 });
  assert.equal(definition.isError, undefined, definition.content?.[0]?.text);
  const payload = JSON.parse(definition.content[0].text);
  assert.ok(payload.file.endsWith('..in-root.ts'), 'the request target must resolve, not be refused as parent traversal');
  assert.equal(payload.withheldOutsideRoot, undefined, 'an in-root file whose name begins with .. must not be withheld');
  assert.equal(payload.definitions.length, 2);
  for (const entry of payload.definitions) {
    assert.ok(entry.file.endsWith('..in-root.ts'), `${entry.file} must be the in-root dot-dot file`);
  }
});

test('a single-slash file: URI naming an in-root file is kept, not withheld as non-file', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-single-slash-');
  const linkedFile = path.join(rootDir, 'linked.ts');
  fs.writeFileSync(linkedFile, 'export const linked = 1;\n');
  const singleSlashUri = 'file:' + fileToUri(linkedFile).slice('file://'.length);
  assert.match(singleSlashUri, /^file:\/[^/]/, 'the fixture must exercise the single-slash RFC 8089 form');
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: undefined,
    FAKE_LSP_EXTERNAL_LOCATION_URI: singleSlashUri,
  });
  t.after(() => registry.shutdownAll());

  const definition = await callTool('definition', { root: rootDir, file: filePath, line: 1, column: 7 });
  assert.equal(definition.isError, undefined, definition.content?.[0]?.text);
  const payload = JSON.parse(definition.content[0].text);
  assert.equal(payload.withheldOutsideRoot, undefined, 'a single-slash file: URI to an in-root file must not be withheld');
  assert.equal(payload.definitions.length, 2);
  assert.ok(payload.definitions.some((entry) => entry.file.toLowerCase().endsWith('linked.ts')));
});

test('a single oversized diagnostic stays inside the response budget', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-budget-');
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: undefined,
    FAKE_LSP_HUGE_CODE: String(MAX_RESPONSE_CHARS + 10_000),
  });
  t.after(() => registry.shutdownAll());

  const outcome = await callTool('diagnostics', { root: rootDir, files: [filePath] });
  assert.equal(outcome.isError, undefined, outcome.content?.[0]?.text);
  assert.ok(outcome.content[0].text.length <= MAX_RESPONSE_CHARS, `response must stay bounded, got ${outcome.content[0].text.length} chars`);
  const payload = JSON.parse(outcome.content[0].text);
  assert.ok(payload.files[0].diagnostics[0].code.length <= 401, 'a runaway diagnostic code must be capped');
});

test('error responses stay inside the response budget', async (t) => {
  const { rootDir } = makeProject('code-intel-mcp-error-budget-');
  withEnv(t, { [NATIVE_SERVER_ENV]: undefined, [LANGUAGE_SERVER_ENV]: undefined });

  const oversizedFile = 'a'.repeat(MAX_RESPONSE_CHARS + 10_000);
  const definition = await callTool('definition', { root: rootDir, file: oversizedFile, line: 1, column: 1 });
  assert.equal(definition.isError, true);
  assert.ok(definition.content[0].text.length <= MAX_RESPONSE_CHARS, `a malformed file error must stay bounded, got ${definition.content[0].text.length} chars`);
  assert.match(definition.content[0].text, /file not found/);

  const diagnostics = await callTool('diagnostics', { root: rootDir, files: [oversizedFile] });
  assert.equal(diagnostics.isError, true);
  assert.ok(diagnostics.content[0].text.length <= MAX_RESPONSE_CHARS, `a malformed files entry error must stay bounded, got ${diagnostics.content[0].text.length} chars`);

  const hugeArgumentName = 'k'.repeat(MAX_RESPONSE_CHARS + 10_000);
  const unknownArgument = await callTool('definition', { root: rootDir, file: 'main.ts', line: 1, column: 1, [hugeArgumentName]: true });
  assert.equal(unknownArgument.isError, true);
  assert.ok(unknownArgument.content[0].text.length <= MAX_RESPONSE_CHARS, `an unknown-argument error must stay bounded, got ${unknownArgument.content[0].text.length} chars`);

  const unknownTool = await callTool('t'.repeat(MAX_RESPONSE_CHARS + 10_000), { root: rootDir });
  assert.equal(unknownTool.isError, true);
  assert.ok(unknownTool.content[0].text.length <= MAX_RESPONSE_CHARS, `an unknown-tool error must stay bounded, got ${unknownTool.content[0].text.length} chars`);
  assert.equal(registry.activeRootCount(), 0, 'malformed requests must be refused before any server spawns');
});

test('an oversized JSON-RPC id and initialize protocolVersion stay inside the complete envelope budget', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-envelope-');
  withEnv(t, { [NATIVE_SERVER_ENV]: undefined, [LANGUAGE_SERVER_ENV]: undefined });

  const oversizedId = 'i'.repeat(MAX_RESPONSE_CHARS + 10_000);
  const refused = await handleRequest({ jsonrpc: '2.0', id: oversizedId, method: 'ping' });
  assert.ok(
    JSON.stringify(refused).length <= MAX_RESPONSE_CHARS,
    `the complete serialized envelope must stay bounded, got ${JSON.stringify(refused).length} chars`,
  );
  assert.equal(refused.id, null, 'an id too large to echo is answered with the JSON-RPC null id');
  assert.equal(refused.error.code, -32600);

  const refusedCall = await handleRequest({
    jsonrpc: '2.0',
    id: oversizedId,
    method: 'tools/call',
    params: { name: 'definition', arguments: { root: rootDir, file: filePath, line: 1, column: 1 } },
  });
  assert.equal(refusedCall.error.code, -32600);
  assert.ok(JSON.stringify(refusedCall).length <= MAX_RESPONSE_CHARS);
  assert.equal(registry.activeRootCount(), 0, 'a request refused for its id must be refused before any server spawns');

  const oversizedProtocol = await handleRequest({
    jsonrpc: '2.0',
    id: 9,
    method: 'initialize',
    params: { protocolVersion: 'p'.repeat(MAX_RESPONSE_CHARS + 10_000) },
  });
  assert.ok(
    JSON.stringify(oversizedProtocol).length <= MAX_RESPONSE_CHARS,
    `the complete serialized initialize envelope must stay bounded, got ${JSON.stringify(oversizedProtocol).length} chars`,
  );
  assert.equal(oversizedProtocol.id, 9);
  assert.equal(
    oversizedProtocol.result.protocolVersion,
    DEFAULT_PROTOCOL_VERSION,
    'a protocol version the server cannot honor gets the server\'s own version, never an echo',
  );
});

test('a successful tools/call envelope stays inside the complete serialized budget', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-success-envelope-');
  withEnv(t, {
    [LANGUAGE_SERVER_ENV]: FAKE_SERVER,
    [NATIVE_SERVER_ENV]: undefined,
    FAKE_LSP_PULL: '1',
    FAKE_LSP_LOG: undefined,
    FAKE_LSP_ESCAPE_HEAVY_COUNT: '100',
  });
  t.after(() => registry.shutdownAll());

  const response = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'diagnostics', arguments: { root: rootDir, files: [filePath] } },
  });
  assert.equal(response.result.isError, undefined, response.result.content?.[0]?.text);
  assert.ok(
    JSON.stringify(response).length <= MAX_RESPONSE_CHARS,
    `the complete serialized success envelope must stay bounded, got ${JSON.stringify(response).length} chars`,
  );
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.truncated, true, 'an escape-heavy diagnostic list must shrink to fit the envelope');
  assert.ok(payload.files[0].diagnostics.length >= 1, 'shrinking must keep at least one diagnostic');
});

test('an object or array JSON-RPC id is refused before dispatch, cancellation, or echo', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-id-shape-');
  withEnv(t, { [NATIVE_SERVER_ENV]: undefined, [LANGUAGE_SERVER_ENV]: undefined });

  const objectId = await handleRequest({ jsonrpc: '2.0', id: { sneaky: 'x'.repeat(60) }, method: 'ping' });
  assert.equal(objectId.id, null, 'an object id is never echoed back');
  assert.equal(objectId.error.code, -32600);
  assert.ok(!JSON.stringify(objectId).includes('sneaky'), 'no fragment of the invalid id may appear in the response');

  const arrayId = await handleRequest({ jsonrpc: '2.0', id: [7], method: 'tools/list' });
  assert.equal(arrayId.id, null, 'an array id is never echoed back');
  assert.equal(arrayId.error.code, -32600);

  const refusedCall = await handleRequest({
    jsonrpc: '2.0',
    id: ['tricky'],
    method: 'tools/call',
    params: { name: 'definition', arguments: { root: rootDir, file: filePath, line: 1, column: 1 } },
  });
  assert.equal(refusedCall.id, null);
  assert.equal(refusedCall.error.code, -32600);
  assert.equal(registry.activeRootCount(), 0, 'a request refused for its id shape must be refused before any server spawns');
});

test('a no-id message is a notification and never receives a response frame', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-notification-');
  withEnv(t, { [NATIVE_SERVER_ENV]: undefined, [LANGUAGE_SERVER_ENV]: undefined });

  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'ping' }), null, 'a no-id ping gets no frame');
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'tools/list' }), null, 'a no-id tools/list gets no frame');
  assert.equal(
    await handleRequest({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    null,
    'a no-id initialize gets no frame',
  );
  assert.equal(
    await handleRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'definition', arguments: { root: rootDir, file: filePath, line: 1, column: 1 } },
    }),
    null,
    'a tools/call notification gets no frame',
  );
  assert.equal(registry.activeRootCount(), 0, 'a tools/call notification must not spawn a server nobody can hear');
});

test('a present null id is a request and its response echoes null', async () => {
  const ping = await handleRequest({ jsonrpc: '2.0', id: null, method: 'ping' });
  assert.ok(ping && 'id' in ping && ping.id === null, 'a null-id ping must be answered with id null');
  assert.deepEqual(ping.result, {});
  const listed = await handleRequest({ jsonrpc: '2.0', id: null, method: 'tools/list' });
  assert.equal(listed.id, null);
  assert.ok(Array.isArray(listed.result.tools));
  const initialized = await handleRequest({ jsonrpc: '2.0', id: null, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(initialized.id, null);
  assert.equal(initialized.result.serverInfo.name, 'code-intel');
  const unknown = await handleRequest({ jsonrpc: '2.0', id: null, method: 'bogus/method' });
  assert.equal(unknown.id, null);
  assert.equal(unknown.error.code, -32601);
});

test('a malformed cancellation payload is refused before lookup and never aborts an in-flight call', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-cancel-guard-');
  withEnv(t, { [LANGUAGE_SERVER_ENV]: FAKE_SERVER, [NATIVE_SERVER_ENV]: undefined, FAKE_LSP_PULL: '1', FAKE_LSP_LOG: undefined });
  t.after(() => registry.shutdownAll());

  const hung = handleRequest({
    jsonrpc: '2.0',
    id: null,
    method: 'tools/call',
    params: { name: 'definition', arguments: { root: rootDir, file: filePath, line: 999, column: 1 } },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: { sneaky: 'cancel' } } }), null);
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: ['null'] } }), null);
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: null }), null);
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);
  const sentinel = Symbol('still-pending');
  const raced = await Promise.race([hung, new Promise((resolve) => setTimeout(() => resolve(sentinel), 200))]);
  assert.equal(raced, sentinel, 'the null-id call must still be in flight after every malformed cancellation');
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: null } }), null);
  assert.equal(await hung, null, 'requestId null must cancel the null-id call with no response frame');
  assert.equal(registry.activeRootCount(), 1, 'cancellation must not kill the root client');

  const completed = await handleRequest({
    jsonrpc: '2.0',
    id: null,
    method: 'tools/call',
    params: { name: 'definition', arguments: { root: rootDir, file: filePath, line: 1, column: 7 } },
  });
  assert.equal(completed.id, null, 'a completing null-id tools/call must echo id null');
  assert.equal(completed.result.isError, undefined, completed.result.content?.[0]?.text);
});

test('a non-finite numeric id is refused instead of echoing as a lying null', async () => {
  const raw = JSON.parse('{"jsonrpc":"2.0","id":1e400,"method":"ping"}');
  assert.equal(raw.id, Infinity, 'raw JSON 1e400 must parse to Infinity for this fixture to mean anything');
  const overflow = await handleRequest(raw);
  assert.equal(overflow.id, null, 'an Infinity id must be refused with the null id, never echoed');
  assert.equal(overflow.error.code, -32600);
  const negative = await handleRequest({ jsonrpc: '2.0', id: -Infinity, method: 'tools/list' });
  assert.equal(negative.id, null);
  assert.equal(negative.error.code, -32600);
  const notANumber = await handleRequest({ jsonrpc: '2.0', id: NaN, method: 'ping' });
  assert.equal(notANumber.id, null);
  assert.equal(notANumber.error.code, -32600);
});

test('an invalid top-level id on a cancellation frame is refused before any abort side effect', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-cancel-frame-');
  withEnv(t, { [LANGUAGE_SERVER_ENV]: FAKE_SERVER, [NATIVE_SERVER_ENV]: undefined, FAKE_LSP_PULL: '1', FAKE_LSP_LOG: undefined });
  t.after(() => registry.shutdownAll());

  const hung = handleRequest({
    jsonrpc: '2.0',
    id: 77,
    method: 'tools/call',
    params: { name: 'definition', arguments: { root: rootDir, file: filePath, line: 999, column: 1 } },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const objectFrame = await handleRequest({ jsonrpc: '2.0', id: { sneaky: 'frame' }, method: 'notifications/cancelled', params: { requestId: 77 } });
  assert.ok(objectFrame, 'an object-id cancellation frame must be refused with a response, not honored silently');
  assert.equal(objectFrame.id, null);
  assert.equal(objectFrame.error.code, -32600);
  assert.ok(!JSON.stringify(objectFrame).includes('sneaky'), 'no fragment of the invalid id may appear in the response');
  const arrayFrame = await handleRequest({ jsonrpc: '2.0', id: [77], method: 'notifications/cancelled', params: { requestId: 77 } });
  assert.equal(arrayFrame.id, null);
  assert.equal(arrayFrame.error.code, -32600);
  const sentinel = Symbol('still-pending');
  const raced = await Promise.race([hung, new Promise((resolve) => setTimeout(() => resolve(sentinel), 200))]);
  assert.equal(raced, sentinel, 'request 77 must still be in flight after invalid-id cancellation frames');
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77 } }), null);
  assert.equal(await hung, null, 'a no-id cancellation with a valid requestId still cancels its call');
  assert.equal(registry.activeRootCount(), 1, 'cancellation must not kill the root client');
});

test('notifications/cancelled settles the pending tool call with no response and keeps the root client alive', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-cancel-');
  withEnv(t, { [LANGUAGE_SERVER_ENV]: FAKE_SERVER, [NATIVE_SERVER_ENV]: undefined, FAKE_LSP_PULL: '1', FAKE_LSP_LOG: undefined });
  t.after(() => registry.shutdownAll());

  const startedAt = Date.now();
  const hung = handleRequest({
    jsonrpc: '2.0',
    id: 77,
    method: 'tools/call',
    params: { name: 'definition', arguments: { root: rootDir, file: filePath, line: 999, column: 1 } },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77 } }), null);
  assert.equal(await hung, null, 'a cancelled call must produce no response');
  assert.ok(Date.now() - startedAt < 10_000, 'cancellation must settle well before the request timeout');
  assert.equal(registry.activeRootCount(), 1, 'cancellation must not kill the root client');

  const followUp = await callTool('definition', { root: rootDir, file: filePath, line: 1, column: 7 });
  assert.equal(followUp.isError, undefined, followUp.content?.[0]?.text);
});

test('the sweep reaps clients whose root was removed or gutted by a worktree sweep', async (t) => {
  const { rootDir } = makeProject('code-intel-mcp-stale-');
  fs.mkdirSync(path.join(rootDir, 'locked-husk'));
  withEnv(t, { [LANGUAGE_SERVER_ENV]: FAKE_SERVER, [NATIVE_SERVER_ENV]: undefined, FAKE_LSP_PULL: '1', FAKE_LSP_LOG: undefined });
  t.after(() => registry.shutdownAll());

  const bound = registry.clientForRoot(rootDir);
  assert.ok(!bound.error);
  assert.equal(registry.activeRootCount(), 1);

  registry.sweep();
  assert.equal(registry.activeRootCount(), 1, 'a live root must survive the sweep');

  fs.rmSync(path.join(rootDir, 'main.ts'));
  registry.sweep();
  assert.equal(registry.activeRootCount(), 0, 'a file-less husk root must be reaped');
  assert.equal(bound.client.isAlive(), false);
});

test('the stdio server echoes every supported id exactly and refuses one it cannot round-trip', async () => {
  const responseLines = await runStdioServer([
    '{"jsonrpc":"2.0","id":42,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1e3,"method":"ping"}',
    '[{"jsonrpc":"2.0","id":7,"method":"ping"},{"jsonrpc":"2.0","id":"kept-string","method":"ping"}]',
    '{"jsonrpc":"2.0","id":null,"method":"ping"}',
    '{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1.5,"method":"ping"}',
  ]);
  for (const line of responseLines) {
    assert.equal(JSON.parse(line).jsonrpc, '2.0', `every response frame must stay valid JSON, got: ${line}`);
  }

  const answered = responseLines.filter((line) => JSON.parse(line).result !== undefined);
  const expectedEchoes = [
    '{"jsonrpc":"2.0","id":42,"result":{}}',
    '{"jsonrpc":"2.0","id":1000,"result":{}}',
    '{"jsonrpc":"2.0","id":7,"result":{}}',
    '{"jsonrpc":"2.0","id":"kept-string","result":{}}',
    '{"jsonrpc":"2.0","id":null,"result":{}}',
  ];
  assert.equal(answered.length, expectedEchoes.length, `every supported id must be answered once, got: ${responseLines.join(' | ')}`);
  for (const expected of expectedEchoes) {
    assert.ok(answered.includes(expected), `the response frame ${expected} must be written byte for byte, got: ${answered.join(' | ')}`);
  }

  const refusals = responseLines.map((line) => JSON.parse(line)).filter((message) => message.error !== undefined);
  assert.equal(refusals.length, 2, `an unsafe integer and a fraction must each be refused, got: ${responseLines.join(' | ')}`);
  for (const refusal of refusals) {
    assert.equal(refusal.id, null, 'an id that cannot round-trip is answered with the null id, never echoed');
    assert.equal(refusal.error.code, -32600);
  }
  assert.ok(
    !responseLines.some((line) => line.includes('9007199254740992') || line.includes('1.5')),
    `a refused id must never be echoed, in its own spelling or a rounded one, got: ${responseLines.join(' | ')}`,
  );
});

test('a numeric id is usable only as a safe integer, and a refused one never reaches a tool', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-numeric-id-');
  withEnv(t, { [NATIVE_SERVER_ENV]: undefined, [LANGUAGE_SERVER_ENV]: undefined });

  for (const usable of [0, 1, -7, 1000, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    const response = await handleRequest({ jsonrpc: '2.0', id: usable, method: 'ping' });
    assert.equal(response.error, undefined, `${usable} is a safe integer and must be answered`);
    assert.equal(response.id, usable, 'a usable numeric id is echoed as the value it arrived as');
  }
  for (const unusable of [1.5, 0.1, 9007199254740992, -9007199254740992, 1e300]) {
    const response = await handleRequest({ jsonrpc: '2.0', id: unusable, method: 'ping' });
    assert.equal(response.id, null, `${unusable} cannot round-trip and must be refused with the null id`);
    assert.equal(response.error.code, -32600);
  }

  const refusedCall = await handleRequest({
    jsonrpc: '2.0',
    id: 1.5,
    method: 'tools/call',
    params: { name: 'definition', arguments: { root: rootDir, file: filePath, line: 1, column: 1 } },
  });
  assert.equal(refusedCall.error.code, -32600);
  assert.equal(registry.activeRootCount(), 0, 'a request refused for its id must be refused before any server spawns');
});

test('a cancellation naming an equivalent numeric spelling settles the in-flight call', async (t) => {
  const { rootDir, filePath } = makeProject('code-intel-mcp-equivalent-id-');
  withEnv(t, { [LANGUAGE_SERVER_ENV]: FAKE_SERVER, [NATIVE_SERVER_ENV]: undefined, FAKE_LSP_PULL: '1', FAKE_LSP_LOG: undefined });
  t.after(() => registry.shutdownAll());

  const hungCallFrame = (rawId) => JSON.parse(
    `{"jsonrpc":"2.0","id":${rawId},"method":"tools/call","params":{"name":"definition","arguments":{"root":${JSON.stringify(rootDir)},"file":${JSON.stringify(filePath)},"line":999,"column":1}}}`,
  );
  const cancelFrame = (rawRequestId) => JSON.parse(
    `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":${rawRequestId}}}`,
  );
  const sentinel = Symbol('still-pending');

  const hung = handleRequest(hungCallFrame('1e3'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await handleRequest(cancelFrame('1000')), null);
  const raced = await Promise.race([hung, new Promise((resolve) => setTimeout(() => resolve(sentinel), 400))]);
  assert.equal(raced, null, 'cancellation requestId:1000 must settle the in-flight id:1e3 call with no response');

  const secondHung = handleRequest(hungCallFrame('10e2'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1000 } }), null);
  const secondRaced = await Promise.race([secondHung, new Promise((resolve) => setTimeout(() => resolve(sentinel), 400))]);
  assert.equal(secondRaced, null, 'a plain embedder requestId 1000 must settle the in-flight id:10e2 call');

  const distinct = handleRequest(hungCallFrame('1001'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await handleRequest(cancelFrame('1000')), null);
  const survived = await Promise.race([distinct, new Promise((resolve) => setTimeout(() => resolve(sentinel), 200))]);
  assert.equal(survived, sentinel, 'a cancellation for 1000 must leave the neighboring id 1001 in flight');
  assert.equal(await handleRequest(cancelFrame('1001')), null);
  assert.equal(await distinct, null, 'cancelling 1001 settles the surviving call');
  assert.equal(registry.activeRootCount(), 1, 'cancellation must not kill the root client');
});

test('an oversized raw line is refused unparsed with a bounded null-id error and no side effects', async () => {
  const oversizedPing = `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"${'a'.repeat(1_000_000)}"}}`;
  assert.ok(oversizedPing.length > 1_000_000, 'the probe must exceed one million characters');
  const justOver = `{"jsonrpc":"2.0","id":2,"method":"ping","params":{"pad":"${'b'.repeat(MAX_REQUEST_CHARS)}"}}`;
  const exactFitPrefix = '{"jsonrpc":"2.0","id":3,"method":"ping","params":{"pad":"';
  const exactFitSuffix = '"}}';
  const exactFit = exactFitPrefix
    + 'c'.repeat(MAX_REQUEST_CHARS - exactFitPrefix.length - exactFitSuffix.length)
    + exactFitSuffix;
  assert.equal(exactFit.length, MAX_REQUEST_CHARS, 'the boundary probe must sit exactly at the limit');

  const responseLines = await runStdioServer([
    oversizedPing,
    justOver,
    exactFit,
    '{"jsonrpc":"2.0","id":4,"method":"ping"}',
  ]);
  const parsed = responseLines.map((line) => JSON.parse(line));
  const refusals = parsed.filter((message) => message.error !== undefined);
  assert.equal(
    refusals.length,
    2,
    `each oversized line must be refused exactly once, got: ${responseLines.map((line) => line.slice(0, 120)).join(' | ')}`,
  );
  for (const refusal of refusals) {
    assert.equal(refusal.id, null, 'an unparsed line has no id to echo');
    assert.equal(refusal.error.code, -32600);
    assert.ok(JSON.stringify(refusal).length <= 1024, 'the refusal itself must stay bounded');
    assert.ok(!JSON.stringify(refusal).includes('aaa'), 'no fragment of the oversized line may be echoed');
    assert.ok(!JSON.stringify(refusal).includes('bbb'), 'no fragment of the oversized line may be echoed');
  }
  assert.ok(
    parsed.every((message) => message.id !== 1 && message.id !== 2),
    'an oversized frame must never be parsed or answered under its own id',
  );
  const answeredIds = parsed.filter((message) => message.result !== undefined).map((message) => message.id).sort((left, right) => left - right);
  assert.deepEqual(answeredIds, [3, 4], 'the exact-limit frame and the follow-up must both be answered normally');
});
