'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { NATIVE_SERVER_ENV } = require('../lib/code-intel/language-server-locator.js');

const MCP_BIN = path.join(__dirname, '..', 'bin', 'code-intel-mcp.js');
const NATIVE_EXECUTABLE = path.join(
  __dirname, '..', '..', 'sidequest', 'node_modules',
  '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib',
  process.platform === 'win32' ? 'tsc.exe' : 'tsc',
);
const nativeAvailable = fs.existsSync(NATIVE_EXECUTABLE);

function writeProject(rootDir, marker) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, types: [] },
    include: ['*.ts'],
  }));
  fs.writeFileSync(path.join(rootDir, 'util.ts'), `export function ${marker}Helper(): number {\n  return 1;\n}\n`);
  fs.writeFileSync(path.join(rootDir, 'main.ts'), `import { ${marker}Helper } from './util';\nexport const ${marker}Broken: string = ${marker}Helper();\n`);
}

function startServer() {
  const child = childProcess.spawn(process.execPath, [MCP_BIN], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, [NATIVE_SERVER_ENV]: NATIVE_EXECUTABLE },
  });
  const received = [];
  const waiters = new Map();
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (!line) continue;
      const message = JSON.parse(line);
      received.push(message);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });
  let nextId = 1;
  const sentIds = new Set();
  function request(method, params) {
    const id = nextId++;
    sentIds.add(id);
    return new Promise((resolve, reject) => {
      waiters.set(id, resolve);
      const timer = setTimeout(() => reject(new Error(`${method} response never arrived`)), 90_000);
      timer.unref();
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return { child, request, received, sentIds };
}

function toolPayload(response) {
  assert.equal(response.result.isError, undefined, response.result.content?.[0]?.text);
  return JSON.parse(response.result.content[0].text);
}

function assertOnlyUnderRoot(payloadFiles, rootDir) {
  const comparableRoot = fs.realpathSync.native(rootDir).toLowerCase();
  for (const filePath of payloadFiles) {
    assert.ok(filePath.toLowerCase().startsWith(comparableRoot), `${filePath} leaked outside ${rootDir}`);
  }
}

test('parent and two worktrees each receive only their own pull results, with zero pushed bytes', { skip: nativeAvailable ? false : 'native TypeScript LSP binary is not installed under plugins/sidequest/node_modules' }, async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-e2e-'));
  const parentRoot = path.join(baseDir, 'parentProject');
  const alphaRoot = path.join(baseDir, 'agentWorktreeAlpha');
  const betaRoot = path.join(baseDir, 'agentWorktreeBeta');
  writeProject(parentRoot, 'parentOwned');
  writeProject(alphaRoot, 'alphaOwned');
  writeProject(betaRoot, 'betaOwned');

  const server = startServer();
  try {
    const initialize = await server.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initialize.result.serverInfo.name, 'code-intel');

    const parentDiagnostics = toolPayload(await server.request('tools/call', {
      name: 'diagnostics',
      arguments: { root: parentRoot, files: ['main.ts'] },
    }));
    const alphaDiagnostics = toolPayload(await server.request('tools/call', {
      name: 'diagnostics',
      arguments: { root: alphaRoot, files: ['main.ts'] },
    }));
    const betaDiagnostics = toolPayload(await server.request('tools/call', {
      name: 'diagnostics',
      arguments: { root: betaRoot, files: [path.join(betaRoot, 'main.ts')] },
    }));

    for (const [payload, rootDir] of [[parentDiagnostics, parentRoot], [alphaDiagnostics, alphaRoot], [betaDiagnostics, betaRoot]]) {
      assert.equal(payload.backend, 'typescript-native');
      assert.equal(payload.totalDiagnostics, 1);
      assert.equal(payload.files[0].diagnostics[0].code, 2322);
      assert.equal(payload.files[0].diagnostics[0].line, 2);
      assertOnlyUnderRoot([payload.root, ...payload.files.map((entry) => entry.file)], rootDir);
    }
    const crossMarkers = { parent: 'alphaOwned|betaOwned', alpha: 'parentOwned|betaOwned', beta: 'parentOwned|alphaOwned' };
    assert.doesNotMatch(JSON.stringify(parentDiagnostics), new RegExp(crossMarkers.parent));
    assert.doesNotMatch(JSON.stringify(alphaDiagnostics), new RegExp(crossMarkers.alpha));
    assert.doesNotMatch(JSON.stringify(betaDiagnostics), new RegExp(crossMarkers.beta));

    const parentMain = fs.readFileSync(path.join(parentRoot, 'main.ts'), 'utf8');
    const usageColumn = parentMain.split('\n')[1].indexOf('parentOwnedHelper()') + 2;
    const definition = toolPayload(await server.request('tools/call', {
      name: 'definition',
      arguments: { root: parentRoot, file: 'main.ts', line: 2, column: usageColumn },
    }));
    assert.ok(definition.definitions.some((entry) => entry.file.toLowerCase().endsWith('util.ts')));
    assertOnlyUnderRoot(definition.definitions.map((entry) => entry.file), parentRoot);

    const alphaUtil = fs.readFileSync(path.join(alphaRoot, 'util.ts'), 'utf8');
    const helperColumn = alphaUtil.indexOf('alphaOwnedHelper') + 2;
    const references = toolPayload(await server.request('tools/call', {
      name: 'references',
      arguments: { root: alphaRoot, file: 'util.ts', line: 1, column: helperColumn },
    }));
    assert.ok(references.total >= 2);
    assertOnlyUnderRoot(references.references.map((entry) => entry.file), alphaRoot);

    fs.writeFileSync(path.join(parentRoot, 'main.ts'), parentMain.replace(': string', ': number'));
    fs.utimesSync(path.join(parentRoot, 'main.ts'), new Date(), new Date(Date.now() + 5000));
    const parentAfterFix = toolPayload(await server.request('tools/call', {
      name: 'diagnostics',
      arguments: { root: parentRoot, files: ['main.ts'] },
    }));
    assert.equal(parentAfterFix.totalDiagnostics, 0, 'the on-disk fix must be re-checked, not served stale');

    const staleRoot = await server.request('tools/call', {
      name: 'diagnostics',
      arguments: { root: path.join(baseDir, 'sweptWorktree'), files: ['main.ts'] },
    });
    assert.equal(staleRoot.result.isError, true);
    assert.match(staleRoot.result.content[0].text, /project root does not exist/);

    const unsolicited = server.received.filter((message) => message.method !== undefined || !server.sentIds.has(message.id));
    assert.equal(unsolicited.length, 0, `pushed bytes must be zero, saw: ${JSON.stringify(unsolicited).slice(0, 400)}`);

    const exited = new Promise((resolve) => server.child.on('exit', resolve));
    server.child.stdin.end();
    assert.equal(await exited, 0, 'the MCP server must shut its language servers down and exit cleanly');
  } finally {
    if (server.child.exitCode === null) server.child.kill();
  }
});
