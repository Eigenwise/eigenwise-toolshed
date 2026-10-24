'use strict';

const fs = require('node:fs');
const { recoveryPolicy, pluginDisabledNotice } = require('./recovery-policy.js');
const { resolveStableCommandPath, PLUGIN_VERSION } = require('./runtime.js');
const { intentionallyStopped } = require('./lifecycle-lock.js');
const { readPidRecord, gatewayInstallRootFromCommand, installBelongsToThisPlugin } = require('./process-supervision.js');
const { fetchShimHealth, servingCurrentVersion, servingShimVersion } = require('./shim-state.js');

function ownedSupervisorRecord(record) {
  return Boolean(record && installBelongsToThisPlugin(gatewayInstallRootFromCommand(record.command || '')));
}

async function recoverUnlessHealthy(recover) {
  if (await healthyRecordedShim()) return;
  await recover();
}

async function healthyRecordedShim() {
  if (intentionallyStopped()) return false;
  const record = readPidRecord('guardian');
  if (!ownedSupervisorRecord(record)) return false;
  const health = await fetchShimHealth({ timeout: 750 });
  if (health?.supervisorPid !== record.pid) return false;
  return currentHealthyShim(health);
}

function currentHealthyShim(health) {
  const installedVersion = PLUGIN_VERSION;
  if (servingShimVersion(health) !== installedVersion) return false;
  return servingCurrentVersion({ state: health?.ok ? 'running-ours' : 'stopped', health }, installedVersion);
}

function recoveryGuidance(reason) {
  const command = `node "${resolveStableCommandPath()}"`;
  return `Model Gateway isn't ready: ${reason}. Run ${command} start (resumes an intentional stop), ${command} recover, or ${command} doctor. To remove project wiring, run ${command} env --remove. Then resubmit your prompt. Hooks disabled by the host and failures inside an active turn aren't covered by the prompt gate.`;
}

function readHookPayload() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (typeof payload.cwd === 'string') process.chdir(payload.cwd);
  return payload;
}

async function readinessGate({ recover = () => require('./commands.js').recoverGateway() } = {}) {
  const payload = readHookPayload();
  const policy = recoveryPolicy();
  if (policy === 'unwired') return;
  if (policy === 'disabled') return console.error(pluginDisabledNotice());
  try { await recoverUnlessHealthy(recover); }
  catch (error) {
    const message = recoveryGuidance(error.message);
    console.error(message);
    process.exitCode = payload.hook_event_name === 'UserPromptSubmit' ? 2 : 1;
  }
}

module.exports = { readHookPayload, readinessGate, recoveryGuidance };
