'use strict';

const { spawn, execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { BridgeStore, SCHEMA_VERSION, TERMINAL, identifier, canonicalProject, projectKey } = require('./host-bridge-store.js');
const { normalizeAdapter, handoffReceipt } = require('./agent-handoff.js');
const { createResultCollector } = require('./host-bridge-results.js');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function redact(value, maximum = 16000) {
  return String(value || '').replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b(?:sk-|sk_ant_|sk-ant-)[a-z0-9_-]{12,}/gi, '[redacted]')
    .replace(/((?:api[_-]?key|auth(?:orization)?|token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, '$1[redacted]')
    .slice(0, maximum);
}

function childEnvironment(source) {
  const excluded = new Set(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_PARENT_SESSION_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_CODE_AGENT_ID']);
  return Object.fromEntries(Object.entries(source).filter(([name]) => !excluded.has(name.toUpperCase())));
}

function requestOptions(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Bridge request must be an object.');
  normalizeAdapter(request.adapter);
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > MAX_PROMPT_BYTES) throw new Error(`prompt must contain text and be at most ${MAX_PROMPT_BYTES} UTF-8 bytes.`);
  const profile = request.profile || 'plan';
  if (!['plan', 'work'].includes(profile)) throw new Error('profile must be plan or work.');
  return { profile, timeoutMs: boundedInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 900000, 'timeoutMs'), maxTurns: boundedInteger(request.maxTurns, 12, 1, 100, 'maxTurns') };
}

function summary(job) {
  const { result, ...status } = job;
  return { ...status, handoff: handoffReceipt(job, { terminal: TERMINAL.has(job.state) }) };
}

class HostBridge {
  constructor(options = {}) {
    this.store = options.store || new BridgeStore({ home: options.home });
    this.command = options.command || process.env.QUARTERMASTER_BRIDGE_CLAUDE || 'claude';
    this.prefixArguments = options.prefixArguments || [];
    this.environment = childEnvironment(options.environment || process.env);
    this.maxOutputBytes = options.maxOutputBytes || MAX_OUTPUT_BYTES;
    this.maxConcurrent = options.maxConcurrent || 2;
    this.terminationTimeoutMs = options.terminationTimeoutMs || 2000;
    this.terminateTree = options.terminateTree;
    this.killChild = options.killChild || ((child) => child.kill('SIGKILL'));
    this.ownerId = randomUUID();
    this.project = options.project ? canonicalProject(options.project) : null;
    this.active = new Map();
    this.closed = false;
  }

  context(request) {
    const project = canonicalProject(request.project || this.project);
    if (this.project && projectKey(project) !== projectKey(this.project)) throw new Error('This bridge server is bound to another project. Its project binding is routing, not a filesystem sandbox.');
    this.store.recover(project, new Set(this.active.keys()));
    return project;
  }

  start(request) {
    if (this.closed) throw new Error('Bridge is shutting down.');
    const options = requestOptions(request);
    const project = this.context(request);
    const replay = this.replay(project, request, 'start', options);
    if (replay) return replay;
    const conversation = this.store.newConversation(project, options.profile, false);
    return this.enqueue(project, conversation, request, options, false);
  }

  followup(request) {
    if (this.closed) throw new Error('Bridge is shutting down.');
    const options = requestOptions(request);
    const project = this.context(request);
    const replay = this.replay(project, request, 'followup', options);
    if (replay) return replay;
    const conversation = this.store.read(project, 'conversations', identifier(request.conversationId, 'conversationId'));
    // A profile change is explicit; omitted follow-ups retain the existing profile.
    if (request.profile == null) options.profile = conversation.profile;
    if (conversation.activeJobId) {
      const prior = this.store.read(project, 'jobs', conversation.activeJobId);
      if (!TERMINAL.has(prior.state)) throw new Error('This bridge conversation already has an active turn.');
      if (prior.resumeBlocked) throw new Error('This conversation cannot be resumed because its previous host termination was not confirmed. No stored PID will be killed; use a fresh bridge conversation after checking the old host.');
      if (!prior.hostStarted) throw new Error('This conversation never started a Claude host; create a new bridge conversation.');
    }
    return this.enqueue(project, conversation, request, options, true);
  }

  payloadHash(project, request, operation, options) {
    identifier(request.requestId, 'requestId');
    return createHash('sha256').update(JSON.stringify({ project, operation, conversationId: request.conversationId || null, prompt: request.prompt, profile: request.profile || null, timeoutMs: options.timeoutMs, maxTurns: options.maxTurns })).digest('hex');
  }

  replayRecord(project, record, payloadHash) {
    if (record.payloadHash !== payloadHash) throw new Error('requestId was already used with a different payload. Reuse the exact request or generate a new UUID.');
    try { return summary(this.store.read(project, 'jobs', record.job.id)); }
    catch (error) {
      if (!error.message.startsWith('Bridge conversation/job is unknown')) throw error;
      return summary(record.job);
    }
  }

  replay(project, request, operation, options) {
    const hash = this.payloadHash(project, request, operation, options);
    const prior = this.store.readRequest(project, request.requestId);
    return prior ? this.replayRecord(project, prior, hash) : null;
  }

  enqueue(project, conversation, request, options, resume) {
    if (this.active.size >= this.maxConcurrent) throw new Error(`Bridge concurrency limit (${this.maxConcurrent}) reached; wait for a running job.`);
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = { schemaVersion: SCHEMA_VERSION, id, conversationId: conversation.id, claudeSessionId: conversation.claudeSessionId, requestId: request.requestId, project, profile: options.profile, state: 'queued', ownerId: this.ownerId, ownerPid: process.pid, createdAt: now, updatedAt: now, timeoutMs: options.timeoutMs, maxTurns: options.maxTurns, resume, hostStarted: false, taskOutcome: 'unverified', permissionDenials: [] };
    const payloadHash = this.payloadHash(project, request, resume ? 'followup' : 'start', options);
    const reservation = this.store.reserveRequest(project, { schemaVersion: SCHEMA_VERSION, id: request.requestId, project, payloadHash, conversation, job });
    if (!reservation.created) return this.replayRecord(project, reservation.record, payloadHash);
    let unlock;
    try { unlock = this.store.lock(project, conversation.id, id, this.ownerId); }
    catch (error) {
      job.state = 'failed'; job.finishedAt = now; job.error = { code: 'conversation_busy', message: error.message };
      this.store.write(project, 'jobs', job);
      if (!resume) this.store.write(project, 'conversations', conversation);
      throw error;
    }
    try {
      this.store.write(project, 'jobs', job);
      conversation.activeJobId = id;
      conversation.profile = options.profile;
      conversation.updatedAt = now;
      this.store.write(project, 'conversations', conversation);
    } catch (error) { unlock(); throw error; }
    let resolve;
    const completion = new Promise((done) => { resolve = done; });
    const active = { job, child: null, unlock, resolve, completion, terminal: false, stopping: null };
    this.active.set(id, active);
    setImmediate(() => { if (!active.terminal && !active.stopping) this.launch(active, request.prompt, options); });
    return summary(job);
  }

  launch(active, prompt, options) {
    const { job } = active;
    const args = [...this.prefixArguments, '--print', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--max-turns', String(options.maxTurns)];
    if (options.profile === 'plan') args.push('--permission-mode', 'plan', '--tools', 'Read,Glob,Grep');
    args.push(job.resume ? '--resume' : '--session-id', job.claudeSessionId);
    let child;
    try {
      child = spawn(this.command, args, { cwd: job.project, env: this.environment, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
      active.child = child;
    } catch (error) { this.finish(active, 'failed', { code: 'spawn_error', message: `Could not start Claude (${error.code || 'unknown'}).` }); return; }
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    const results = createResultCollector({ sessionId: job.claudeSessionId, sanitizeText: redact });
    let stderr = '';
    let parseError = false;
    const persist = () => {
      job.updatedAt = new Date().toISOString();
      try { this.store.write(job.project, 'jobs', job); }
      catch { fail('persistence_error', 'Could not persist bridge job state. The host was stopped.'); }
    };
    const fail = (code, message) => this.stop(active, 'failed', { code, message });
    const event = (value) => {
      if (!value || typeof value !== 'object') { parseError = true; return; }
      if (value.type === 'result') {
        const error = results.record(value);
        job.resultDiagnostics = results.diagnostics;
        job.resultErrors = results.errors;
        job.permissionDenials = results.permissionDenials;
        persist();
        if (error) fail(error.code, error.message);
        return;
      }
      if (value.session_id && value.session_id !== job.claudeSessionId) { fail('session_mismatch', 'Claude returned a different session ID; this bridge will not resume it.'); return; }
      if (value.type === 'system' && value.subtype === 'init') {
        job.hostStarted = true;
        const names = (items) => Array.isArray(items) ? items.slice(0, 100).map((item) => typeof item === 'string' ? redact(item, 120) : { name: redact(item?.name, 120), ...(item?.status ? { status: redact(item.status, 80) } : {}) }) : [];
        job.host = { sessionId: value.session_id || null, model: redact(value.model, 160), plugins: names(value.plugins), mcpServers: names(value.mcp_servers), tools: names(value.tools) };
        persist();
      }
      const uses = value.type === 'assistant' && Array.isArray(value.message?.content)
        ? value.message.content.filter((item) => item?.type === 'tool_use') : [];
      if (uses.length) {
        job.toolUse ||= { total: 0, byName: Object.create(null) };
        for (const use of uses.slice(0, 100)) {
          const name = redact(use.name || 'unknown', 120);
          job.toolUse.total = Math.min(100000, job.toolUse.total + 1);
          if (Object.hasOwn(job.toolUse.byName, name) || Object.keys(job.toolUse.byName).length < 100) job.toolUse.byName[name] = Math.min(100000, (job.toolUse.byName[name] || 0) + 1);
        }
        persist();
      }
    };
    child.once('spawn', () => {
      job.state = 'running'; job.startedAt = new Date().toISOString(); persist();
      active.timer = setTimeout(() => fail('timeout', `Claude exceeded the ${options.timeoutMs}ms bridge timeout.`), options.timeoutMs);
    });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > this.maxOutputBytes) { fail('output_limit', `Claude exceeded the ${this.maxOutputBytes}-byte output limit.`); return; }
      buffer += decoder.write(chunk);
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
        if (line) { try { event(JSON.parse(line)); } catch { parseError = true; } }
      }
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > this.maxOutputBytes) fail('output_limit', `Claude exceeded the ${this.maxOutputBytes}-byte output limit.`);
      if (stderr.length < 8000) stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { active.spawnError = error.code || 'unknown'; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(active.timer);
      job.exitCode = exitCode; job.signal = signal;
      buffer += decoder.end();
      if (buffer.trim()) { try { event(JSON.parse(buffer)); } catch { parseError = true; } }
      const result = results.lastResult;
      if (result) {
        job.hostStarted = job.hostStarted || Boolean(result.session_id);
        job.result = { subtype: redact(result.subtype, 100), text: redact(result.result, this.maxOutputBytes), errors: results.errors.flatMap((entry) => entry.messages).slice(0, 20), sessionId: result.session_id, hostTurnSucceeded: !active.stopping && !parseError && !results.hasErrors && !results.hasDenials && result.subtype === 'success' && result.is_error === false && exitCode === 0, taskOutcome: 'unverified' };
      }
      if (active.stopping) { this.finish(active, active.stopping.state, active.stopping.error); return; }
      if (active.spawnError) { this.finish(active, 'failed', { code: 'spawn_error', message: `Could not start Claude (${active.spawnError}).` }); return; }
      if (stderr) job.diagnostic = redact(stderr, 2000);
      if (parseError || !result) { this.finish(active, 'failed', { code: parseError ? 'invalid_output' : 'missing_result', message: 'Claude did not produce a valid terminal result envelope.' }); return; }
      if (results.hasDenials) { this.finish(active, 'blocked_permissions', { code: 'permission_denied', message: 'Claude reported tool permission denials in one or more results. The bridge did not escalate permissions.' }); return; }
      if (exitCode !== 0 || results.hasErrors || result.subtype !== 'success' || result.is_error !== false) { this.finish(active, 'failed', { code: 'host_error', message: 'Claude reported an unsuccessful host turn in one or more results. See the bounded final response and per-result errors; task outcome remains unverified.' }); return; }
      this.finish(active, 'succeeded');
    });
    child.stdin.end(prompt);
  }

  kill(active) {
    const child = active.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const fallback = (error) => {
      if (active.terminal || child.exitCode !== null || child.signalCode !== null) return;
      if (error) active.job.termination = { treeError: redact(error.code || 'tree_termination_failed', 100), fallbackRequested: true };
      try { this.killChild(child); } catch {}
    };
    if (this.terminateTree) {
      try { this.terminateTree(child, (error) => { if (error) fallback(error); }); }
      catch (error) { fallback(error); }
    } else if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: this.terminationTimeoutMs }, (error) => { if (error) fallback(error); });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { fallback(error); }
    }
  }

  stop(active, state, error) {
    if (active.terminal || active.stopping) return;
    active.stopping = { state, error };
    clearTimeout(active.timer);
    if (!active.child) this.finish(active, state, error);
    else {
      // This secondary guard survives clearing the turn timeout. Report inability to
      // terminate instead of hanging a cancel call or claiming a living host stopped.
      active.terminationTimer = setTimeout(() => {
        if (active.terminal) return;
        const child = active.child;
        try { if (child.exitCode === null && child.signalCode === null) this.killChild(child); } catch {}
        active.terminationFinalTimer = setTimeout(() => {
          if (active.terminal) return;
          active.stopping = { state: 'failed', error: { code: 'termination_unconfirmed', message: 'Could not confirm host termination. This bridge still owns the child and conversation lock; do not resume until its process closes.' } };
          active.job.state = 'failed'; active.job.error = active.stopping.error; active.job.terminationPending = true; active.job.updatedAt = new Date().toISOString();
          try { this.store.write(active.job.project, 'jobs', active.job); } catch {}
          // Keep the live child and lock owned. Its handles keep the process alive;
          // an eventual close finalizes the failed job and releases the lock.
          active.resolve(summary(active.job));
        }, this.terminationTimeoutMs);
      }, this.terminationTimeoutMs);
      this.kill(active);
    }
  }

  finish(active, state, error) {
    if (active.terminal) return;
    active.terminal = true;
    clearTimeout(active.timer);
    clearTimeout(active.terminationTimer);
    clearTimeout(active.terminationFinalTimer);
    const { job } = active;
    job.state = state; job.finishedAt = new Date().toISOString(); job.updatedAt = job.finishedAt;
    delete job.terminationPending;
    if (error) job.error = error;
    try { this.store.write(job.project, 'jobs', job); }
    catch { job.state = 'failed'; job.error = { code: 'persistence_error', message: 'Could not persist terminal bridge state; inspect the owned store before resuming.' }; }
    try { active.unlock(); } catch { job.state = 'failed'; job.error = { code: 'unlock_error', message: 'Could not release the conversation lock.' }; }
    this.active.delete(job.id); active.resolve(summary(job));
  }

  status(request) {
    const project = this.context(request);
    const conversation = this.store.read(project, 'conversations', identifier(request.conversationId, 'conversationId'));
    const jobId = identifier(request.jobId || conversation.activeJobId, 'jobId');
    const job = this.store.read(project, 'jobs', jobId);
    if (job.conversationId !== conversation.id || job.claudeSessionId !== conversation.claudeSessionId) throw new Error('Bridge job does not belong to this conversation.');
    return summary(job);
  }

  result(request) {
    const status = this.status(request);
    const job = this.store.read(status.project, 'jobs', status.id);
    return { ...summary(job), terminal: TERMINAL.has(job.state), result: job.result || null };
  }

  cancel(request) {
    const status = this.status(request);
    if (TERMINAL.has(status.state)) return status;
    const active = this.active.get(status.id);
    if (!active) throw new Error('This live job belongs to another bridge process. Cancel it through the owning MCP connection; no PID from disk will be killed.');
    this.stop(active, 'cancelled', { code: 'cancelled', message: 'Cancelled by the caller; no task completion is claimed.' });
    return { ...summary(active.job), cancellationRequested: true };
  }

  async wait(jobId) {
    const active = this.active.get(identifier(jobId, 'jobId'));
    if (!active) return null;
    return active.completion;
  }

  async close() {
    this.closed = true;
    const jobs = [...this.active.values()];
    for (const active of jobs) this.stop(active, 'interrupted', { code: 'owner_shutdown', message: 'The bridge owner shut down; no automatic retry occurred.' });
    await Promise.all(jobs.map((active) => active.completion));
  }
}

module.exports = { HostBridge, DEFAULT_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_PROMPT_BYTES, childEnvironment, requestOptions, redact };
