'use strict';

// One reading of the shim that status, doctor and ensure all share, so they cannot contradict each other (#275).
const { PUBLIC_SHIM_PORT, SHIM_PORT } = require('./runtime.js');
const { fetchUrl, readPidRecord, recordedGatewayPid, resolvePortOwner } = require('./process-supervision.js');

async function fetchShimHealth() {
  try {
    const response = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/healthz`, { timeout: 2000 });
    return JSON.parse(response.body.toString());
  } catch { return null; }
}

function servingShimVersion(health) {
  return health?.supervisorVersion || health?.version || null;
}

function startingOrStopped(owner, { recordedSupervisorPid, supervisorRecord }) {
  const pid = owner.state === 'same-install' ? owner.pid : recordedSupervisorPid();
  if (!pid) return { state: 'stopped' };
  const record = supervisorRecord();
  return { state: 'starting', pid, since: record?.pid === pid ? record.startedAt : null };
}

// running-ours: our control endpoint answers. running-foreign: a listener this install cannot claim, either
// another install root or an owner it could not identify. starting: our supervisor exists but the endpoint does
// not answer yet. stopped: nothing is there.
async function probeShimState({
  resolveOwner = resolvePortOwner,
  fetchHealth = fetchShimHealth,
  recordedSupervisorPid = () => recordedGatewayPid('guardian'),
  supervisorRecord = () => readPidRecord('guardian'),
} = {}) {
  const [owner, health] = await Promise.all([
    Promise.resolve().then(() => resolveOwner(PUBLIC_SHIM_PORT)).catch(() => ({ state: 'unknown', pid: null, reason: 'unidentified' })),
    fetchHealth(),
  ]);
  if (owner.state === 'foreign-install') return { state: 'running-foreign', pid: owner.pid, image: owner.installRoot, owner, health };
  if (health?.ok) return { state: 'running-ours', pid: owner.pid, version: servingShimVersion(health), owner, health };
  if (owner.state === 'unknown') return { state: 'running-foreign', pid: owner.pid, image: null, owner, health };
  return { ...startingOrStopped(owner, { recordedSupervisorPid, supervisorRecord }), owner, health };
}

const SHIM_STATE_DETAILS = {
  'running-ours': (shim) => ` (serving ${shim.version || 'version unavailable'})`,
  'running-foreign': (shim) => ` (PID ${shim.pid || 'unknown'}, ${shim.image || `owner unidentified: ${shim.owner.reason}`})`,
  starting: (shim) => ` (PID ${shim.pid}${shim.since ? ` since ${shim.since}` : ''})`,
  stopped: () => '',
};

function describeShimState(shim) {
  return `shim (model router) on :${SHIM_PORT}: ${shim.state}${SHIM_STATE_DETAILS[shim.state](shim)}`;
}

module.exports = { describeShimState, fetchShimHealth, probeShimState, servingShimVersion };
