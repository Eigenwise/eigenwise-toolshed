'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { stateRoot } = require('./paths.js');

const SCHEMA_VERSION = 1;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked_permissions']);
const STATES = new Set(['queued', 'running', ...TERMINAL]);

function identifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid bridge ${label}; use the UUID returned by this bridge.`);
  return value;
}

function canonicalProject(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('project must be an absolute existing directory.');
  const project = fs.realpathSync.native(value);
  if (!fs.statSync(project).isDirectory()) throw new Error('project must be a directory.');
  return project;
}

function projectKey(project) {
  const identity = process.platform === 'win32' ? project.toLowerCase() : project;
  return createHash('sha256').update(identity).digest('hex');
}

// Reject links at every owned-store component, including the root's existing ancestors.
// Project symlinks are resolved once, but the bridge's own data must stay in its owned tree.
function plainPath(candidate, directory = false) {
  const absolute = path.resolve(candidate);
  const parent = path.dirname(absolute);
  if (parent !== absolute) plainPath(parent, true);
  try {
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error(`Bridge store refuses a link or unexpected file type: ${absolute}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return absolute;
}

function directory(candidate) {
  plainPath(candidate, true);
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  plainPath(candidate, true);
  return candidate;
}

function readJson(file) {
  plainPath(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Bridge record exceeds its size limit or is not a regular file.');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

function writeJson(file, value) {
  directory(path.dirname(file));
  plainPath(file);
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try { plainPath(file); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

class BridgeStore {
  constructor(options = {}) {
    this.root = directory(path.resolve(options.home || process.env.QUARTERMASTER_BRIDGE_HOME || path.join(stateRoot(), 'host-bridge')));
  }

  projectDirectory(project) { return path.join(this.root, projectKey(project)); }
  recordPath(project, kind, id) {
    identifier(id, kind === 'jobs' ? 'jobId' : 'conversationId');
    return path.join(this.projectDirectory(project), kind, `${id}.json`);
  }
  validate(record, project, id, kind) {
    if (!record || record.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported bridge record schemaVersion.');
    if (record.id !== id || record.project !== project) throw new Error('Bridge record project or identity mismatch.');
    if (kind === 'jobs') {
      identifier(record.conversationId, 'conversationId');
      if (!STATES.has(record.state)) throw new Error('Invalid bridge job state.');
    } else {
      identifier(record.claudeSessionId, 'Claude session identity');
      if (record.activeJobId) identifier(record.activeJobId, 'active jobId');
    }
    return record;
  }
  read(project, kind, id) {
    try { return this.validate(readJson(this.recordPath(project, kind, id)), project, id, kind); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Bridge conversation/job is unknown for this project. Use its original canonical project and bridge-owned ID.');
      throw error;
    }
  }
  write(project, kind, record) {
    this.validate(record, project, record.id, kind);
    writeJson(this.recordPath(project, kind, record.id), record);
  }
  newConversation(project, profile, persist = true) {
    const now = new Date().toISOString();
    const record = { schemaVersion: SCHEMA_VERSION, id: randomUUID(), claudeSessionId: randomUUID(), project, profile, createdAt: now, updatedAt: now, activeJobId: null };
    if (persist) this.write(project, 'conversations', record);
    return record;
  }
  readRequest(project, requestId) {
    const file = this.recordPath(project, 'requests', identifier(requestId, 'requestId'));
    let record;
    try { record = readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (record.schemaVersion !== SCHEMA_VERSION || record.id !== requestId || record.project !== project || !/^[0-9a-f]{64}$/.test(record.payloadHash)) throw new Error('Unsupported or mismatched bridge request record.');
    this.validate(record.conversation, project, record.conversation.id, 'conversations');
    this.validate(record.job, project, record.job.id, 'jobs');
    if (record.job.conversationId !== record.conversation.id || record.job.claudeSessionId !== record.conversation.claudeSessionId) throw new Error('Bridge request conversation binding mismatch.');
    return record;
  }
  reserveRequest(project, record) {
    const file = this.recordPath(project, 'requests', record.id);
    directory(path.dirname(file));
    plainPath(file);
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Linking an already-complete record is exclusive and atomic across processes. A direct
    // write with wx would let another process observe a half-written reservation.
    try { fs.linkSync(temporary, file); return { created: true, record }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; return { created: false, record: this.readRequest(project, record.id) }; }
    finally { fs.unlinkSync(temporary); }
  }
  lock(project, conversationId, jobId, ownerId) {
    const file = path.join(this.projectDirectory(project), 'locks', `${identifier(conversationId)}.json`);
    directory(path.dirname(file));
    plainPath(file);
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(fd, JSON.stringify({ ownerId, ownerPid: process.pid, jobId }));
      fs.closeSync(fd);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('This bridge conversation already has an active turn. Wait for its result before following up.');
      throw error;
    }
    return () => {
      try { const lock = readJson(file); if (lock.ownerId === ownerId && lock.jobId === jobId) fs.unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  recover(project, activeJobs = new Set()) {
    const root = this.projectDirectory(project);
    plainPath(root, true);
    const requests = path.join(root, 'requests');
    plainPath(requests, true);
    if (fs.existsSync(requests)) {
      const entries = fs.readdirSync(requests);
      if (entries.length > 10000) throw new Error('Bridge request count exceeds its safety limit.');
      for (const entry of entries) {
        const id = entry.endsWith('.json') ? entry.slice(0, -5) : '';
        if (!ID.test(id)) continue;
        const record = this.readRequest(project, id);
        if (processAlive(record.job.ownerPid)) continue;
        const file = this.recordPath(project, 'jobs', record.job.id);
        plainPath(file);
        if (fs.existsSync(file)) continue;
        const conversationFile = this.recordPath(project, 'conversations', record.conversation.id);
        plainPath(conversationFile);
        if (!fs.existsSync(conversationFile)) this.write(project, 'conversations', record.conversation);
        const job = { ...record.job, state: 'interrupted', finishedAt: new Date().toISOString(), error: { code: 'owner_stopped', message: 'The bridge stopped after reserving this request. It was not automatically retried.' } };
        job.updatedAt = job.finishedAt;
        this.write(project, 'jobs', job);
      }
    }
    const jobs = path.join(root, 'jobs');
    plainPath(jobs, true);
    if (!fs.existsSync(jobs)) return;
    const entries = fs.readdirSync(jobs);
    if (entries.length > 10000) throw new Error('Bridge project job count exceeds its safety limit. Archive terminal records before continuing.');
    for (const entry of entries) {
      const id = entry.endsWith('.json') ? entry.slice(0, -5) : '';
      if (!ID.test(id)) continue;
      const job = this.read(project, 'jobs', id);
      if (activeJobs.has(id) || processAlive(job.ownerPid)) continue;
      if (!TERMINAL.has(job.state) || job.terminationPending) {
        const terminationUnconfirmed = job.terminationPending === true;
        job.state = 'interrupted';
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        job.error = terminationUnconfirmed
          ? { code: 'owner_stopped_termination_unconfirmed', message: 'The bridge owner stopped without confirming host termination. This conversation cannot be resumed; no stored PID was killed and no automatic retry occurred.' }
          : { code: 'owner_stopped', message: 'The bridge owner stopped before a terminal host result. No automatic retry occurred.' };
        if (terminationUnconfirmed) {
          delete job.terminationPending;
          job.terminationUnconfirmed = true;
          job.resumeBlocked = true;
        }
        this.write(project, 'jobs', job);
      }
      // A crash can happen after a terminal job is persisted but before unlock. Release
      // only the exact dead ownership record, including for a terminal job. Never kill
      // a PID read from disk, and do not remove an unrelated or live owner's lock.
      const lock = path.join(root, 'locks', `${job.conversationId}.json`);
      try {
        const data = readJson(lock);
        if (data.jobId === id && data.ownerId === job.ownerId && data.ownerPid === job.ownerPid && !processAlive(data.ownerPid)) fs.unlinkSync(lock);
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

module.exports = { BridgeStore, SCHEMA_VERSION, TERMINAL, identifier, canonicalProject, projectKey, plainPath, processAlive };
