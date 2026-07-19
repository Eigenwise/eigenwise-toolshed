'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUBSCRIPTION_LABELS = Object.freeze({
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
});

function parseAuthStatus(stdout) {
  try {
    const status = JSON.parse(stdout);
    const subscriptionType = typeof status.subscriptionType === 'string'
      ? status.subscriptionType.toLowerCase()
      : null;
    return {
      apiKeyActive: typeof status.apiKeySource === 'string' && status.apiKeySource.length > 0,
      subscriptionType: Object.hasOwn(SUBSCRIPTION_LABELS, subscriptionType) ? subscriptionType : null,
    };
  } catch {
    return null;
  }
}

function authStatus(command, environment, run = spawnSync) {
  try {
    const result = run(command, ['auth', 'status', '--json'], {
      encoding: 'utf8',
      env: environment,
      timeout: 2000,
      windowsHide: true,
    });
    return result.status === 0 ? parseAuthStatus(result.stdout) : null;
  } catch {
    return null;
  }
}

function withoutApiKey(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key !== 'ANTHROPIC_API_KEY'));
}

function detectBillingPath(options = {}) {
  const environment = options.environment || process.env;
  const command = options.command || 'claude';
  const current = options.currentStatus || authStatus(command, environment, options.spawnSync);
  if (!current?.apiKeyActive) return null;
  const configured = options.configuredStatus
    || authStatus(command, withoutApiKey(environment), options.spawnSync);
  return configured?.subscriptionType || null;
}

function warningStateFile(input, directory) {
  if (typeof input?.session_id !== 'string' || input.session_id.length === 0) return null;
  const digest = crypto.createHash('sha256').update(input.session_id).digest('hex');
  return path.join(directory, digest);
}

function markWarning(input, options = {}) {
  const directory = options.warningStateDirectory
    || path.join(os.tmpdir(), 'eigenwise-toolshed', 'billing-path-warnings');
  const stateFile = warningStateFile(input, directory);
  if (!stateFile) return true;
  try {
    const fileSystem = options.fileSystem || fs;
    fileSystem.mkdirSync(path.dirname(stateFile), { recursive: true });
    fileSystem.writeFileSync(stateFile, '', { flag: 'wx' });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

function buildWarning(input, options = {}) {
  const subscriptionType = detectBillingPath(options);
  if (!subscriptionType || !markWarning(input, options)) return '';
  const subscription = SUBSCRIPTION_LABELS[subscriptionType];
  const additionalContext = `PAY-PER-TOKEN BILLING ACTIVE: an API key is overriding the configured ${subscription} subscription. Remove the API key override before starting Claude Code to use the subscription seat.`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
}

function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const output = buildWarning(input);
    if (output) process.stdout.write(output);
  } catch {
    return;
  }
}

if (require.main === module) main();

module.exports = {
  authStatus,
  buildWarning,
  detectBillingPath,
  markWarning,
  parseAuthStatus,
  withoutApiKey,
  warningStateFile,
};
