'use strict';

const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const { COMPAT_BASE_URL, COMPAT_HOST, COMPAT_PORT, HOSTS_BLOCK_END, HOSTS_BLOCK_LINE, HOSTS_BLOCK_START, WIN } = require('./runtime.js');

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1']);

function hostsFilePath() {
  if (process.env.CODEX_GATEWAY_HOSTS_FILE) return process.env.CODEX_GATEWAY_HOSTS_FILE;
  return WIN
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts';
}

// Cross-platform hosts syntax is identical on Windows/macOS/Linux: one entry
// per line, "<ip> <hostname> [alias...]", '#' starts a trailing comment,
// fields are whitespace-separated. Only an EXACT loopback mapping for
// api.anthropic.com counts — anything mapping to a non-loopback address is
// ignored (it isn't a route back to this shim, so switching would break
// Claude Code, not enable compatibility mode).
function parseHostsCompatEntry(text) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const [ip, ...names] = line.split(/\s+/);
    if (!LOOPBACK_IPS.has(ip)) continue;
    if (names.some((n) => n.toLowerCase().replace(/\.$/, '') === COMPAT_HOST)) {
      return { ip, line: rawLine.trim() };
    }
  }
  return null;
}

function parseHostsCompatBlock(text) {
  const start = text.indexOf(HOSTS_BLOCK_START);
  const end = text.indexOf(HOSTS_BLOCK_END);
  if (start < 0 && end < 0) return { state: 'absent', block: null };
  if (start < 0 || end < 0 || end < start) return { state: 'partial', block: null };
  const endIndex = end + HOSTS_BLOCK_END.length;
  const block = text.slice(start, endIndex);
  const before = text.slice(0, start);
  const after = text.slice(endIndex);
  if (parseHostsCompatEntry(block)) return { state: 'valid', block, before, after };
  return { state: 'invalid', block, before, after };
}

function managedHostsBlock(eol = '\n') {
  return [HOSTS_BLOCK_START, HOSTS_BLOCK_LINE, HOSTS_BLOCK_END].join(eol) + eol;
}

function adoptUnmarkedHostsEntry(text, eol) {
  let start = 0;
  while (start < text.length) {
    const newline = /\r?\n/.exec(text.slice(start));
    const end = newline ? start + newline.index : text.length;
    const rawLine = text.slice(start, end);
    if (parseHostsCompatEntry(rawLine)) {
      const after = text.slice(newline ? end + newline[0].length : end);
      return text.slice(0, start) + HOSTS_BLOCK_START + eol + rawLine + eol + HOSTS_BLOCK_END + eol + after;
    }
    if (!newline) break;
    start = end + newline[0].length;
  }
  return null;
}

function addManagedHostsBlock(text) {
  const parsed = parseHostsCompatBlock(text);
  if (parsed.state === 'valid') return { text, changed: false };
  if (parsed.state !== 'absent') throw new Error(`plugin-marked hosts block is ${parsed.state}; run remote-control doctor and repair it manually`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const adopted = adoptUnmarkedHostsEntry(text, eol);
  if (adopted) return { text: adopted, changed: true };
  const separator = text && !text.endsWith('\n') ? eol : '';
  return { text: text + separator + managedHostsBlock(eol), changed: true };
}

function removeManagedHostsBlock(text) {
  const parsed = parseHostsCompatBlock(text);
  if (parsed.state === 'absent') return { text, changed: false };
  if (parsed.state !== 'valid') throw new Error(`plugin-marked hosts block is ${parsed.state}; run remote-control doctor and repair it manually`);
  const after = parsed.after.replace(/^\r?\n/, '');
  const next = (parsed.before + after).replace(/(?:\r?\n){3,}/g, (match) => match.includes('\r\n') ? '\r\n\r\n' : '\n\n');
  return { text: next, changed: true };
}

function findConflictingHostsMappings(text) {
  const conflicts = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.includes(HOSTS_BLOCK_START) || rawLine.includes(HOSTS_BLOCK_END)) continue;
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const [ip, ...names] = line.split(/\s+/);
    if (names.some((name) => name.toLowerCase().replace(/\.$/, '') === COMPAT_HOST) && !LOOPBACK_IPS.has(ip)) {
      conflicts.push(rawLine.trim());
    }
  }
  return conflicts;
}

function readHostsFile() {
  const file = hostsFilePath();
  try { return { file, text: fs.readFileSync(file, 'utf8') }; }
  catch (error) { return { file, text: null, error }; }
}

function hostsWriteStatus(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return 'available';
  } catch { return 'missing (run from an elevated terminal)'; }
}

async function lookupCompatHost() {
  try { return await dns.promises.lookup(COMPAT_HOST); }
  catch { return null; }
}

function elevatedHostsInstructions(action) {
  if (WIN) {
    return `Open Notepad as Administrator, then ${action} the plugin-marked block in ${hostsFilePath()}.`;
  }
  return `Use sudo to ${action} the plugin-marked block in ${hostsFilePath()}.`;
}

let remoteControlDependencies = {};

function configureRemoteControl(dependencies) { remoteControlDependencies = dependencies; }

function servingCompatibilityStatus(result) {
  if (result?.status === 'unavailable') return `unavailable (${result.code || 'unknown'})`;
  return ['bound', 'bindable', 'unknown'].includes(result?.status) ? result.status : 'unknown';
}

async function remoteControlCommand() {
  const {
    args, flag, log, die, doctor, fetchShimHealth, requestServingCompatibility = async () => ({ status: 'unknown' }),
    startAll, syncCompatMode, compatibilityPortConflict = () => null, unsafeRemoteControlProcessEnv = () => null,
  } = remoteControlDependencies;
  const action = args[0];
  if (!['enable', 'disable', 'doctor'].includes(action)) {
    die('usage: remote-control <enable|disable|doctor>');
  }
  if (action === 'enable') {
    const unsafeProcessEnv = unsafeRemoteControlProcessEnv();
    if (unsafeProcessEnv) {
      die(`cannot enable RC-compatibility while effective process env ANTHROPIC_BASE_URL is ${unsafeProcessEnv.value}: the hosts mapping would redirect HTTPS traffic to an unsupported TLS endpoint. A user-controlled Claude Code CLI launch can correct or unset ANTHROPIC_BASE_URL, then restart. If a host replaces it, use the supported Claude Code CLI on this wired project; Desktop routing is unsupported under forced overrides on Windows and macOS. Settings, parent, and User-scope edits cannot be promised to win.`);
    }
  }
  const { file, text, error } = readHostsFile();
  const parsed = text == null ? { state: 'unreadable', block: null } : parseHostsCompatBlock(text);
  const conflicts = text == null ? [] : findConflictingHostsMappings(text);
  const detected = text == null ? null : parseHostsCompatEntry(text);

  if (action === 'doctor') {
    const blockState = parsed.state === 'absent' && detected
      ? 'absent (unmarked loopback mapping present, enable will adopt it)'
      : parsed.state;
    const serving = await requestServingCompatibility({ action: 'probe' });
    log(`hosts file: ${file}`);
    log(`plugin block: ${blockState}`);
    log(`loopback mapping: ${detected ? detected.line : 'not present'}`);
    log(`conflicting mappings: ${conflicts.length ? conflicts.join(' | ') : 'none'}`);
    log(`elevated write: ${hostsWriteStatus(file)}`);
    log(`serving compatibility: ${servingCompatibilityStatus(serving)}`);
    log(serving.status === 'unavailable'
      ? (compatibilityPortConflict() || `port ${COMPAT_PORT}: unavailable (${serving.code || 'unknown'})`)
      : `port ${COMPAT_PORT}: ${servingCompatibilityStatus(serving)} by serving supervisor`);
    const dnsResult = await lookupCompatHost();
    log(`DNS lookup: ${dnsResult ? `${dnsResult.address} (IPv${dnsResult.family})` : 'failed'}`);
    await doctor();
    return;
  }

  if (text == null) {
    die(`cannot read hosts file ${file}: ${error && (error.code || error.message)}`);
  }
  if (conflicts.length) {
    die(`conflicting non-loopback mapping for ${COMPAT_HOST}: ${conflicts.join(' | ')}. Remove it manually before enabling compatibility mode.`);
  }

  const operation = action === 'enable' ? addManagedHostsBlock : removeManagedHostsBlock;
  let transformed;
  try { transformed = operation(text); } catch (operationError) { die(operationError.message); }
  if (!transformed.changed) {
    log(`remote-control compatibility is already ${action === 'enable' ? 'enabled' : 'disabled'} in ${file}`);
    return;
  }
  log(`${action === 'enable' ? 'Enable' : 'Disable'} Remote Control compatibility by ${action === 'enable' ? 'adding' : 'removing'} only this block:`);
  log(action === 'enable' ? managedHostsBlock(text.includes('\r\n') ? '\r\n' : '\n').trim() : parsed.block);
  if (!flag('--confirm')) {
    if (hostsWriteStatus(file) !== 'available') {
      log(`This needs elevation. ${elevatedHostsInstructions(action === 'enable' ? 'add' : 'remove')}`);
    }
    log('Do you want to make this hosts-file change now? Re-run with --confirm only after the user answers yes.');
    return;
  }

  let serving = null;
  if (action === 'enable') {
    serving = await requestServingCompatibility({ action: 'probe' });
    if (!['bound', 'bindable'].includes(serving.status)) {
      const diagnostic = serving.status === 'unavailable' ? compatibilityPortConflict() : null;
      die(`cannot enable RC-compatibility because the serving supervisor is ${servingCompatibilityStatus(serving)}${diagnostic ? `: ${diagnostic}` : ''}; start the normal-user gateway supervisor, then run remote-control doctor.`);
    }
  }
  let current;
  try { current = fs.readFileSync(file, 'utf8'); } catch (readError) { die(`could not re-read ${file}: ${readError.code || readError.message}`); }
  if (current !== text) {
    die(`hosts file changed after confirmation; left it untouched. Run remote-control doctor and confirm again.`);
  }

  const backup = `${file}.model-gateway-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  try {
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, transformed.text);
  } catch (writeError) {
    die(`could not write ${file}: ${writeError.code || writeError.message}. Backup ${backup} may exist. ${elevatedHostsInstructions('edit')}`);
  }
  log(`updated hosts file: ${file}`);
  log(`backup: ${backup}`);
  try {
    if (action === 'enable') {
      const activated = await requestServingCompatibility({ action: 'reconcile', expectedSupervisorPid: serving.supervisorPid });
      if (activated.status !== 'bound') throw new Error(`serving supervisor activation was ${servingCompatibilityStatus(activated)}`);
      if (!(await remoteControlVerify({ expectedSupervisorPid: serving.supervisorPid, requireCompatibility: true }))) {
        throw new Error('serving supervisor did not report RC-compatibility ready');
      }
      const synchronized = await syncCompatMode({ requiredMode: 'compat' });
      if (synchronized?.mode !== 'compat') {
        throw new Error(`wiring synchronization achieved ${synchronized?.mode || 'unknown'} mode instead of compat`);
      }
      return;
    }
    const started = await startAll();
    if (!started.ok) throw new Error(`gateway reconciliation failed: ${started.reason}`);
    const reconciled = await requestServingCompatibility({ action: 'reconcile' });
    if (reconciled.status !== 'bound') throw new Error(`serving supervisor reconciliation was ${servingCompatibilityStatus(reconciled)}`);
    if (!(await remoteControlVerify({ requireCompatibility: false }))) {
      throw new Error('serving supervisor did not report default mode ready');
    }
    await syncCompatMode();
  } catch (activationError) {
    if (action === 'enable') {
      let restored = false;
      try {
        if (fs.readFileSync(file, 'utf8') === transformed.text) {
          fs.writeFileSync(file, text);
          restored = true;
          log(`restored hosts file from this command's original bytes: ${file}`);
        } else {
          log(`hosts file changed again after this command wrote it; preserved the observed bytes. Manual recovery: compare backup ${backup}.`);
        }
      } catch (rollbackError) {
        log(`could not inspect or restore ${file}: ${rollbackError.code || rollbackError.message}. Manual recovery: compare backup ${backup}.`);
      }
      const recovered = await requestServingCompatibility({ action: 'reconcile', expectedSupervisorPid: serving.supervisorPid });
      if (recovered.status !== 'bound') {
        log(`serving supervisor recovery was ${servingCompatibilityStatus(recovered)}. Manual recovery: compare backup ${backup}.`);
      } else if (!restored) {
        log(`serving supervisor reconciled the observed hosts file. Manual recovery: compare backup ${backup}.`);
      }
    }
    die(`hosts file changed, but gateway reconciliation failed: ${activationError.message}. Backup ${backup}.`);
  }
}

async function remoteControlVerify({ expectedSupervisorPid = null, requireCompatibility }) {
  const { log, fetchShimHealth } = remoteControlDependencies;
  const entry = detectHostsCompat();
  const health = await fetchShimHealth();
  const dnsResult = await lookupCompatHost();
  const modelCount = health ? health.models : 0;
  const identityMatches = expectedSupervisorPid == null || health?.supervisorPid === expectedSupervisorPid;
  const compatible = requireCompatibility
    ? entry && health?.compat?.hostsDetected === true && health.compat.port80Bound === true
    : !entry && health?.compat?.hostsDetected === false && health.compat.port80Bound === false;
  const ready = health?.ok === true && identityMatches && compatible;
  log(`DNS/hosts mapping: ${dnsResult ? `${dnsResult.address} (IPv${dnsResult.family})` : 'FAILED'}`);
  log(`hosts entry: ${entry ? entry.line : 'MISSING'}`);
  log(`port ${COMPAT_PORT}: ${health?.compat?.port80Bound ? 'bound' : 'unavailable'}`);
  log(`shim health: ${health?.ok ? 'healthy' : 'DOWN'}`);
  log(`Codex discovery: ${modelCount ? `${modelCount} models` : 'unavailable'}`);
  log(`Remote Control eligibility: ${ready ? `ready after Claude Code restarts with ${COMPAT_BASE_URL}` : 'not ready'}`);
  return ready;
}

// Read-only: model-gateway never writes to the hosts file. Returns
// { ip, line } when the user has added the exact managed entry, else null.
function detectHostsCompat() {
  let text;
  try { text = fs.readFileSync(hostsFilePath(), 'utf8'); } catch { return null; }
  return parseHostsCompatEntry(text);
}


module.exports = { addManagedHostsBlock, configureRemoteControl, detectHostsCompat, findConflictingHostsMappings, hostsFilePath, managedHostsBlock, parseHostsCompatBlock, parseHostsCompatEntry, removeManagedHostsBlock, remoteControlCommand };
