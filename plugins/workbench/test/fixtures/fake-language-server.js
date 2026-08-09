'use strict';

const fs = require('node:fs');

const advertisePullDiagnostics = process.env.FAKE_LSP_PULL === '1';
const logPath = process.env.FAKE_LSP_LOG || '';
const pushDelayMs = Number.parseInt(process.env.FAKE_LSP_PUSH_DELAY_MS || '50', 10);
const stalePushFirst = process.env.FAKE_LSP_STALE_PUSH === '1';
const unversionedPush = process.env.FAKE_LSP_UNVERSIONED_PUSH === '1';
const externalLocationUri = process.env.FAKE_LSP_EXTERNAL_LOCATION_URI || '';
const longInRootSuffixLength = Number.parseInt(process.env.FAKE_LSP_LONG_INROOT_SUFFIX || '0', 10);
const hugeDiagnosticCodeLength = Number.parseInt(process.env.FAKE_LSP_HUGE_CODE || '0', 10);
const escapeHeavyDiagnosticCount = Number.parseInt(process.env.FAKE_LSP_ESCAPE_HEAVY_COUNT || '0', 10);

function log(record) {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function pullDiagnosticItems() {
  if (escapeHeavyDiagnosticCount > 0) {
    const items = [];
    for (let index = 0; index < escapeHeavyDiagnosticCount; index += 1) {
      items.push({
        range: { start: { line: index, character: 0 }, end: { line: index, character: 9 } },
        severity: 1,
        code: 4242,
        // 390 quote characters: escaping doubles them in the compact payload
        // and doubles them again inside the response envelope's JSON string.
        message: '"'.repeat(390),
      });
    }
    return items;
  }
  return [{
    range: { start: { line: 2, character: 1 }, end: { line: 2, character: 9 } },
    severity: 1,
    code: hugeDiagnosticCodeLength > 0 ? 'x'.repeat(hugeDiagnosticCodeLength) : 4242,
    message: 'fake pull diagnostic',
  }];
}

function publishDiagnosticsMessage(uri, version) {
  const params = {
    uri,
    version,
    diagnostics: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      severity: 2,
      code: 7777,
      message: `fake push diagnostic v${version}`,
    }],
  };
  // TypeScript 5 may publish without a version; the message label still
  // names the document generation the push was computed from.
  if (unversionedPush) delete params.version;
  return { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params };
}

function pushDiagnosticsFor(uri, version) {
  setTimeout(() => {
    if (stalePushFirst && version > 1) writeMessage(publishDiagnosticsMessage(uri, version - 1));
    writeMessage(publishDiagnosticsMessage(uri, version));
  }, pushDelayMs);
}

function handleMessage(message) {
  log(message);
  if (message.method === undefined) return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    const capabilities = { definitionProvider: true, referencesProvider: true };
    if (advertisePullDiagnostics) capabilities.diagnosticProvider = { identifier: 'fake', interFileDependencies: true };
    writeMessage({ jsonrpc: '2.0', id, result: { capabilities } });
    writeMessage({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: 'fake server chatter' } });
    writeMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///unrelated/rogue.ts',
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'rogue push that must be discarded' }],
      },
    });
    writeMessage({ jsonrpc: '2.0', id: 'fake-server-request-1', method: 'client/registerCapability', params: { registrations: [] } });
    return;
  }
  if (method === 'textDocument/didOpen') {
    if (!advertisePullDiagnostics) pushDiagnosticsFor(params.textDocument.uri, params.textDocument.version);
    return;
  }
  if (method === 'textDocument/didChange') {
    if (!advertisePullDiagnostics) pushDiagnosticsFor(params.textDocument.uri, params.textDocument.version);
    return;
  }
  if (method === 'textDocument/definition') {
    if (params.position.line === 998) return;
    const result = [{ uri: params.textDocument.uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } } }];
    if (externalLocationUri) {
      result.unshift({ uri: externalLocationUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } });
    }
    if (longInRootSuffixLength > 0) {
      result.push({
        uri: params.textDocument.uri + '/' + 'a'.repeat(longInRootSuffixLength),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      });
    }
    writeMessage({ jsonrpc: '2.0', id, result });
    return;
  }
  if (method === 'textDocument/references') {
    const result = [
      { uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } },
      { uri: params.textDocument.uri, range: { start: { line: 4, character: 6 }, end: { line: 4, character: 10 } } },
    ];
    if (externalLocationUri) {
      result.unshift({ uri: externalLocationUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } });
    }
    writeMessage({ jsonrpc: '2.0', id, result });
    return;
  }
  if (method === 'textDocument/diagnostic') {
    writeMessage({ jsonrpc: '2.0', id, result: { kind: 'full', items: pullDiagnosticItems() } });
    return;
  }
  if (method === 'shutdown') {
    writeMessage({ jsonrpc: '2.0', id, result: null });
    return;
  }
  if (method === 'exit') process.exit(0);
  if (id !== undefined) writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unhandled method ${method}` } });
}

let buffered = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffered.slice(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffered = buffered.slice(headerEnd + 4);
      continue;
    }
    const bodyLength = Number(match[1]);
    if (buffered.length < headerEnd + 4 + bodyLength) return;
    const body = buffered.slice(headerEnd + 4, headerEnd + 4 + bodyLength).toString('utf8');
    buffered = buffered.slice(headerEnd + 4 + bodyLength);
    handleMessage(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
