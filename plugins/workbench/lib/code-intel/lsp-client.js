'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const HARVEST_WAIT_LIMIT_MS = 15_000;
const REQUEST_TIMEOUT_ENV = 'WORKBENCH_CODE_INTEL_TIMEOUT_MS';

function requestTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env[REQUEST_TIMEOUT_ENV] || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

function createFrameParser() {
  let buffered = Buffer.alloc(0);
  return {
    push(chunk) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
      const messages = [];
      for (;;) {
        const headerEnd = buffered.indexOf('\r\n\r\n');
        if (headerEnd === -1) return messages;
        const header = buffered.slice(0, headerEnd).toString('utf8');
        const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
        if (!lengthMatch) {
          buffered = buffered.slice(headerEnd + 4);
          continue;
        }
        const bodyLength = Number(lengthMatch[1]);
        if (buffered.length < headerEnd + 4 + bodyLength) return messages;
        const body = buffered.slice(headerEnd + 4, headerEnd + 4 + bodyLength).toString('utf8');
        buffered = buffered.slice(headerEnd + 4 + bodyLength);
        try {
          messages.push({ message: JSON.parse(body), bytes: bodyLength });
        } catch {
          continue;
        }
      }
    },
  };
}

function fileToUri(filePath) {
  let joined = path
    .resolve(filePath)
    .replace(/\\/g, '/')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  if (!joined.startsWith('/')) joined = '/' + joined;
  return 'file://' + joined;
}

const URI_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

// RFC 8089 spells local file URIs three ways: the authority form
// file://host/p (an empty or localhost authority means this machine), the
// single-slash form file:/p, and the bare form file:p. Real servers emit more
// than one spelling, so the scheme is parsed instead of matching one spelling.
// Every non-file scheme, and anything unparseable, maps to null so callers
// withhold it rather than resolve the raw string as a cwd-relative path.
function uriToFile(uri) {
  const schemeMatch = URI_SCHEME.exec(uri);
  if (!schemeMatch || schemeMatch[1].toLowerCase() !== 'file') return null;
  let rest = uri.slice(schemeMatch[0].length);
  let authority = '';
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const authorityEnd = rest.indexOf('/');
    if (authorityEnd === -1) {
      authority = rest;
      rest = '/';
    } else {
      authority = rest.slice(0, authorityEnd);
      rest = rest.slice(authorityEnd);
    }
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (authority && authority.toLowerCase() !== 'localhost') {
    return path.normalize('\\\\' + authority + decoded);
  }
  if (/^\/[a-zA-Z]:/.test(decoded)) decoded = decoded.slice(1);
  return path.normalize(decoded);
}

function filePathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function cancellationError(what) {
  const error = new Error(`${what} was cancelled by the requesting tool call.`);
  error.cancelled = true;
  return error;
}

function normalizeLocations(result) {
  if (!result) return [];
  const rawLocations = Array.isArray(result) ? result : [result];
  const locations = [];
  for (const raw of rawLocations) {
    const uri = raw.targetUri || raw.uri;
    const range = raw.targetSelectionRange || raw.targetRange || raw.range;
    if (!uri || !range) continue;
    locations.push({
      // uriToFile maps every non-file URI scheme to null so the response
      // layer withholds and counts it instead of resolving the raw URI
      // string as a path relative to the process cwd.
      file: uriToFile(uri),
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    });
  }
  return locations;
}

function createLspClient({ rootDir, recipe, onExit }) {
  const timeoutMs = requestTimeoutMs();
  const parser = createFrameParser();
  const pendingRequests = new Map();
  const openFiles = new Map();
  const harvestWaiters = new Map();
  const harvestQueues = new Map();
  const discarded = { notificationCount: 0, notificationBytes: 0, publishDiagnosticCount: 0 };
  let droppedLateResponses = 0;
  let nextRequestId = 1;
  let alive = true;
  let lastUsedAt = Date.now();
  let capabilities = null;
  let readyPromise = null;
  let indexProgressActive = recipe.backend === 'clangd';
  let indexProgressObserved = false;

  const child = childProcess.spawn(recipe.command, recipe.args, {
    cwd: rootDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  function stdinWriteFailed(error) {
    const detail = error && error.message ? `: ${error.message}` : '';
    markDead(new Error(`${recipe.backend} stdin write failed${detail}`));
  }

  function writeMessage(message) {
    if (!alive) return;
    const json = JSON.stringify(message);
    try {
      child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`, (error) => {
        if (error) stdinWriteFailed(error);
      });
    } catch (error) {
      stdinWriteFailed(error);
    }
  }

  function releaseSettlementHooks(entry) {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
  }

  function markDead(error) {
    if (!alive) return;
    alive = false;
    for (const [, entry] of pendingRequests) {
      releaseSettlementHooks(entry);
      entry.reject(error);
    }
    pendingRequests.clear();
    for (const [, waiter] of harvestWaiters) {
      releaseSettlementHooks(waiter);
      waiter.reject(error);
    }
    harvestWaiters.clear();
    if (onExit) onExit();
  }

  function kill(reason) {
    const error = new Error(`${recipe.backend} for ${rootDir} was stopped: ${reason}`);
    try {
      child.kill();
    } catch {}
    markDead(error);
  }

  child.stdin.on('error', stdinWriteFailed);
  child.on('error', (spawnError) => {
    markDead(new Error(`${recipe.backend} failed to start (${recipe.command}): ${spawnError.message}`));
  });
  child.on('exit', (code, signal) => {
    markDead(new Error(`${recipe.backend} for ${rootDir} exited (code ${code}, signal ${signal}). Retry to restart it.`));
  });

  function respondToServerRequest(message) {
    const result = message.method === 'workspace/configuration' && Array.isArray(message.params?.items)
      ? message.params.items.map(() => null)
      : null;
    writeMessage({ jsonrpc: '2.0', id: message.id, result });
  }

  function handleIncoming({ message, bytes }) {
    if (message.method !== undefined && message.id !== undefined) {
      respondToServerRequest(message);
      return;
    }
    if (message.method !== undefined) {
      if (message.method === '$/progress' && message.params?.token === 'backgroundIndexProgress') {
        indexProgressObserved = true;
        indexProgressActive = message.params?.value?.kind !== 'end';
      }
      if (message.method === 'textDocument/publishDiagnostics') {
        const pushedFile = uriToFile(message.params?.uri || '');
        const key = pushedFile === null ? null : filePathKey(pushedFile);
        const waiter = key === null ? undefined : harvestWaiters.get(key);
        const pushedVersion = message.params?.version;
        // Staleness is judged against the file's tracked version at push
        // time, not a version captured when the waiter was armed: another
        // same-file operation may refresh the document while a harvest is
        // pending, and a push for the pre-refresh document must not
        // satisfy it. TypeScript 5 may validly publish without a version;
        // such a push is trusted only while the tracked version still
        // equals the one this waiter's harvest announced, because after
        // any advance it could describe the pre-refresh document.
        const trackedVersion = key === null ? undefined : openFiles.get(key)?.version;
        const pushHasVersion = typeof pushedVersion === 'number';
        const staleForWaiter = waiter
          && typeof trackedVersion === 'number'
          && (pushHasVersion
            ? pushedVersion < trackedVersion
            : typeof waiter.armedTrackedVersion === 'number' && trackedVersion > waiter.armedTrackedVersion);
        if (waiter && !staleForWaiter) {
          harvestWaiters.delete(key);
          releaseSettlementHooks(waiter);
          waiter.resolve(message.params?.diagnostics || []);
          return;
        }
        discarded.publishDiagnosticCount += 1;
      }
      discarded.notificationCount += 1;
      discarded.notificationBytes += bytes;
      return;
    }
    const entry = pendingRequests.get(message.id);
    if (!entry) {
      droppedLateResponses += 1;
      return;
    }
    pendingRequests.delete(message.id);
    releaseSettlementHooks(entry);
    if (message.error) {
      entry.reject(new Error(`${recipe.backend} error ${message.error.code}: ${message.error.message}`));
    } else {
      entry.resolve(message.result);
    }
  }

  child.stdout.on('data', (chunk) => {
    for (const framed of parser.push(chunk)) handleIncoming(framed);
  });

  function request(method, params, signal) {
    if (!alive) return Promise.reject(new Error(`${recipe.backend} for ${rootDir} is not running. Retry to restart it.`));
    if (signal && signal.aborted) return Promise.reject(cancellationError(method));
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, signal: signal || null, onAbort: null };
      entry.timer = setTimeout(() => {
        pendingRequests.delete(id);
        releaseSettlementHooks(entry);
        reject(new Error(`${method} timed out after ${timeoutMs}ms; the ${recipe.backend} process for ${rootDir} was killed to cancel the request. Retry to restart it.`));
        kill(`${method} timed out`);
      }, timeoutMs);
      entry.timer.unref();
      if (signal) {
        entry.onAbort = () => {
          pendingRequests.delete(id);
          clearTimeout(entry.timer);
          notify('$/cancelRequest', { id });
          reject(cancellationError(method));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      pendingRequests.set(id, entry);
      writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method, params) {
    writeMessage({ jsonrpc: '2.0', method, params });
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = request('initialize', {
        processId: process.pid,
        rootUri: fileToUri(rootDir),
        workspaceFolders: [{ uri: fileToUri(rootDir), name: path.basename(rootDir) }],
        initializationOptions: recipe.initializationOptions || { disableAutomaticTypingAcquisition: true },
        capabilities: {
          textDocument: {
            definition: {},
            references: {},
            diagnostic: {},
            publishDiagnostics: {},
          },
          workspace: { workspaceFolders: true },
          window: { workDoneProgress: true },
        },
      }).then((result) => {
        capabilities = result?.capabilities || {};
        notify('initialized', {});
      });
      readyPromise.catch(() => {});
    }
    return readyPromise;
  }

  // initialize is shared by every caller on this root, so an abort releases
  // only the aborting caller's wait; the initialize request stays in flight
  // for later callers, and a genuinely hung server is still reaped by the
  // initialize request timeout.
  function readyUnlessCancelled(method, signal) {
    const pending = ready();
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(cancellationError(method));
    return new Promise((resolve, reject) => {
      const settleOnAbort = () => reject(cancellationError(method));
      signal.addEventListener('abort', settleOnAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', settleOnAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', settleOnAbort);
          reject(error);
        },
      );
    });
  }

  function supportsPullDiagnostics() {
    return Boolean(capabilities && capabilities.diagnosticProvider);
  }

  function readFileText(filePath) {
    return fs.readFileSync(filePath, 'utf8');
  }

  function openOrRefreshFile(filePath) {
    const key = filePathKey(filePath);
    const stat = fs.statSync(filePath);
    const tracked = openFiles.get(key);
    if (!tracked) {
      const uri = fileToUri(filePath);
      openFiles.set(key, { uri, version: 1, mtimeMs: stat.mtimeMs, filePath });
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: recipe.languageIdFor ? recipe.languageIdFor(filePath) : 'typescript', version: 1, text: readFileText(filePath) },
      });
      return true;
    }
    if (tracked.mtimeMs !== stat.mtimeMs) {
      tracked.version += 1;
      tracked.mtimeMs = stat.mtimeMs;
      notify('textDocument/didChange', {
        textDocument: { uri: tracked.uri, version: tracked.version },
        contentChanges: [{ text: readFileText(filePath) }],
      });
      return true;
    }
    return false;
  }

  function refreshTrackedFiles() {
    for (const [key, tracked] of openFiles) {
      let stat = null;
      try {
        stat = fs.statSync(tracked.filePath);
      } catch {}
      if (!stat) {
        notify('textDocument/didClose', { textDocument: { uri: tracked.uri } });
        openFiles.delete(key);
        continue;
      }
      if (stat.mtimeMs !== tracked.mtimeMs) {
        tracked.version += 1;
        tracked.mtimeMs = stat.mtimeMs;
        notify('textDocument/didChange', {
          textDocument: { uri: tracked.uri, version: tracked.version },
          contentChanges: [{ text: readFileText(tracked.filePath) }],
        });
      }
    }
  }

  function positionParams(filePath, line, column) {
    return {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: column - 1 },
    };
  }

  async function definition(filePath, line, column, signal) {
    await readyUnlessCancelled('textDocument/definition', signal);
    lastUsedAt = Date.now();
    refreshTrackedFiles();
    openOrRefreshFile(filePath);
    return normalizeLocations(await request('textDocument/definition', positionParams(filePath, line, column), signal));
  }

  async function references(filePath, line, column, signal) {
    await readyUnlessCancelled('textDocument/references', signal);
    lastUsedAt = Date.now();
    refreshTrackedFiles();
    openOrRefreshFile(filePath);
    const params = positionParams(filePath, line, column);
    params.context = { includeDeclaration: true };
    return normalizeLocations(await request('textDocument/references', params, signal));
  }

  function armHarvestWaiter(filePath, signal) {
    const key = filePathKey(filePath);
    const waitMs = Math.min(timeoutMs, HARVEST_WAIT_LIMIT_MS);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, signal: signal || null, onAbort: null };
      waiter.timer = setTimeout(() => {
        harvestWaiters.delete(key);
        releaseSettlementHooks(waiter);
        reject(new Error(`diagnostics for ${filePath} timed out after ${waitMs}ms waiting for the ${recipe.backend} to analyze it. Retry once the project has loaded.`));
      }, waitMs);
      waiter.timer.unref();
      if (signal) {
        waiter.onAbort = () => {
          harvestWaiters.delete(key);
          clearTimeout(waiter.timer);
          reject(cancellationError(`diagnostics for ${filePath}`));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      harvestWaiters.set(key, waiter);
    });
  }

  // One harvest per file at a time: a second concurrent call waits for the first
  // push to be consumed instead of overwriting its armed waiter (which would leave
  // the first call pending forever and hand its push to the wrong caller).
  function queueSameFileHarvest(key, runHarvest) {
    const previous = harvestQueues.get(key) || Promise.resolve();
    const run = previous.then(runHarvest, runHarvest);
    const settled = run.then(() => {}, () => {});
    harvestQueues.set(key, settled);
    settled.then(() => {
      if (harvestQueues.get(key) === settled) harvestQueues.delete(key);
    });
    return run;
  }

  function harvestPushDiagnostics(filePath, signal) {
    if (!alive) return Promise.reject(new Error(`${recipe.backend} for ${rootDir} is not running. Retry to restart it.`));
    if (signal && signal.aborted) return Promise.reject(cancellationError(`diagnostics for ${filePath}`));
    const key = filePathKey(filePath);
    const harvest = armHarvestWaiter(filePath, signal);
    if (!openOrRefreshFile(filePath)) {
      const tracked = openFiles.get(key);
      tracked.version += 1;
      notify('textDocument/didChange', {
        textDocument: { uri: tracked.uri, version: tracked.version },
        contentChanges: [{ text: readFileText(filePath) }],
      });
    }
    // Recorded in the same synchronous body that armed the waiter, before
    // any push can be handled, so every armed waiter carries the version
    // its own didOpen/didChange announced.
    const waiter = harvestWaiters.get(key);
    if (waiter) waiter.armedTrackedVersion = openFiles.get(key).version;
    return harvest;
  }

  async function diagnostics(filePath, signal) {
    await readyUnlessCancelled(`diagnostics for ${filePath}`, signal);
    lastUsedAt = Date.now();
    refreshTrackedFiles();
    if (supportsPullDiagnostics()) {
      openOrRefreshFile(filePath);
      const report = await request('textDocument/diagnostic', { textDocument: { uri: fileToUri(filePath) } }, signal);
      return (report && report.items) || [];
    }
    return queueSameFileHarvest(filePathKey(filePath), () => harvestPushDiagnostics(filePath, signal));
  }

  return {
    backend: recipe.backend,
    ready,
    definition,
    references,
    diagnostics,
    supportsPullDiagnostics,
    kill,
    isAlive: () => alive,
    touch: () => {
      lastUsedAt = Date.now();
    },
    lastUsedAt: () => lastUsedAt,
    pid: () => child.pid,
    discardStats: () => ({ ...discarded, droppedLateResponses }),
    indexStatus: () => ({ active: indexProgressActive, observed: indexProgressObserved }),
  };
}

module.exports = {
  createLspClient,
  createFrameParser,
  fileToUri,
  uriToFile,
  filePathKey,
  requestTimeoutMs,
  normalizeLocations,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_ENV,
};
