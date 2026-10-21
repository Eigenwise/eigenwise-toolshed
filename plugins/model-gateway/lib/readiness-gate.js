'use strict';

const fs = require('node:fs');
const { effectiveBaseUrl } = require('./settings-wiring.js');
const { ourBaseUrls } = require('./pins.js');
const { resolveStableCommandPath } = require('./runtime.js');

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
  if (!ourBaseUrls().includes(effectiveBaseUrl().value)) return;
  try { await recover(); }
  catch (error) {
    const message = recoveryGuidance(error.message);
    console.error(message);
    process.exitCode = payload.hook_event_name === 'UserPromptSubmit' ? 2 : 1;
  }
}

module.exports = { readHookPayload, readinessGate, recoveryGuidance };
