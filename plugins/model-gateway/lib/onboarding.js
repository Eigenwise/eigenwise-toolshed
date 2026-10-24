'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeFileAtomically } = require('./atomic-file.js');
const { STATE, PROXY_BIN } = require('./runtime.js');
const antigravity = require('./antigravity-contract.js');
const { fetchCapabilities, readObservation, openResponse, readBoundedBody } = require('./antigravity-discovery.js');
const { configRequiresCompatibility } = require('./antigravity-config-intent.js');

const ONBOARDING_PATH = path.join(STATE, 'onboarding.json');
const PROVIDERS = ['codex', 'antigravity'];
const AUTH_OPTIONS = Object.freeze({ login: '--manual', status: '--json' });
const STATUS_OPTIONS = Object.freeze({ encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true });

function invalidPreference() { return new Error('Invalid or future onboarding.json; preserved without changes. Repair the guidance preference explicitly before setup/ensure.'); }
function validPreference(record) {
  return record?.schemaVersion === 1 && PROVIDERS.includes(record.provider) && Object.keys(record).length === 2;
}

function readOnboarding(file = ONBOARDING_PATH) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 'codex'; throw invalidPreference(); }
  let record;
  try { record = JSON.parse(text); } catch { throw invalidPreference(); }
  if (!validPreference(record)) throw invalidPreference();
  return record.provider;
}

function writeOnboarding(provider, file = ONBOARDING_PATH) {
  if (!PROVIDERS.includes(provider)) throw new Error('setup --provider expects codex or antigravity');
  readOnboarding(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(file, JSON.stringify({ schemaVersion: 1, provider }) + '\n', { mode: 0o600 });
}

function selectSetupProvider(state, args, index) {
  if (args[index] !== '--provider' || state.explicit) throw new Error('setup arguments: use [--provider codex|antigravity] [--preserve-wiring] once each');
  if (!PROVIDERS.includes(args[index + 1])) throw new Error('setup --provider expects codex or antigravity');
  state.provider = args[index + 1]; state.explicit = true;
  return index + 1;
}

function setupArgument(state, args, index) {
  if (args[index] === '--preserve-wiring' && !state.preserveWiring) { state.preserveWiring = true; return index; }
  return selectSetupProvider(state, args, index);
}

function validateSetupArguments(args) {
  const state = { provider: 'codex', explicit: false, preserveWiring: false };
  for (let index = 0; index < args.length; index++) index = setupArgument(state, args, index);
  return state;
}

function prepareSetup(args, { file = ONBOARDING_PATH } = {}) {
  const provider = readOnboarding(file);
  const state = validateSetupArguments(args);
  return { ...state, provider: state.explicit ? state.provider : provider };
}

function reportStartupFailure(context, result, { notice, record, command }) {
  if (context.quiet && result.waitCutShort) {
    if (result.started?.includes('shim')) record('ensure-hook-wait-cut-short', { component: 'SessionStart', pid: process.pid, outcome: 'supervisor-started' });
    const label = context.provider === 'antigravity' ? 'Antigravity' : 'Codex';
    notice(`model-gateway is still starting; retry the ${label} model in a few seconds`, { toStderr: true });
    context.finish(0); return;
  }
  notice(`model-gateway could not start: ${result.reason}. Run \`node "${command()}" doctor\` to see which part is down.`, { toStderr: true });
  context.finish(1);
}

function parseCliReport(result) {
  if (result.status !== 0) return antigravity.unconfirmed('unsupported');
  try { return antigravity.inspectCliStatus(JSON.parse(result.stdout)); }
  catch { return antigravity.unconfirmed('malformed'); }
}

function probeCliStatus(binary = PROXY_BIN, { run = spawnSync } = {}) {
  try { return parseCliReport(run(binary, ['antigravity', 'auth', 'status', '--json'], STATUS_OPTIONS)); }
  catch { return antigravity.unconfirmed('unsupported'); }
}

function assertCandidateCompatibility(staged, { run = spawnSync } = {}) {
  const snapshot = probeCliStatus(staged, { run });
  if (!antigravity.compatibleProvider(snapshot.provider)) {
    throw new Error('Antigravity staged proxy is incompatible with the frozen native capability contract. Installed binary and services were left unchanged.');
  }
}

async function installCompatibleCandidate({ required, staged, install, restart, run = spawnSync }) {
  if (required) assertCandidateCompatibility(staged, { run });
  install();
  return restart();
}

function authArgumentCount(action, option) {
  return option !== undefined && option === AUTH_OPTIONS[action] ? 3 : 2;
}

function parseAuthArguments(args) {
  const [provider, action, option] = args;
  if (provider !== 'antigravity' || !['login', 'status', 'logout'].includes(action)) throw new Error('Use auth antigravity login [--manual]|status [--json]|logout; device flow is unsupported.');
  if (args.length !== authArgumentCount(action, option)) throw new Error('Use auth antigravity login [--manual]|status [--json]|logout; device flow and implicit enablement are unsupported.');
  return { action, json: option === '--json', manual: option === '--manual' };
}

function reportAuthStatus(snapshot, json, print) {
  if (!snapshot.authoritative) throw new Error('Antigravity auth status could not report a compatible native status.');
  if (json) print(JSON.stringify({ schema_version: 1, provider: 'antigravity', ...snapshot.provider }));
  else print(antigravity.readiness(snapshot).message);
  return 0;
}

function runAuth(args, { binary = PROXY_BIN, run = spawnSync, print = console.log } = {}) {
  const { action, json, manual } = parseAuthArguments(args);
  if (action === 'status') return reportAuthStatus(probeCliStatus(binary, { run }), json, print);
  const nativeArgs = ['antigravity', 'auth', action];
  if (manual) nativeArgs.push('--manual');
  const result = run(binary, nativeArgs, { stdio: 'inherit', windowsHide: true });
  if (result.status === 0) print(`Antigravity ${action} completed without changing provider enablement or onboarding. ${antigravity.FRESH_SESSION}`);
  return result.status ?? 1;
}

function selectedReadiness(provider, codex, snapshot) {
  if (provider === 'codex') return { ...codex, onboardingProvider: provider };
  const agy = antigravity.readiness(snapshot, { shimReady: codex.checks.shimRunning && codex.checks.servingVersionMatches });
  return { ...codex, ...agy, onboardingProvider: provider, codexReadiness: codex, antigravity: snapshot };
}

async function gatewayReadiness({ provider = readOnboarding(), getCodexReadiness, port, snapshot = null }) {
  const codex = await getCodexReadiness();
  if (provider === 'codex') return selectedReadiness(provider, codex, null);
  return selectedReadiness(provider, codex, snapshot || await fetchCapabilities({ port }));
}

async function servingListsAntigravity(port) {
  try {
    const response = await openResponse(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2500), agent: false });
    const body = JSON.parse(await readBoundedBody(response, 256 * 1024));
    return response.statusCode === 200 && Array.isArray(body.data) && body.data.some((row) => antigravity.isReservedModel(row?.id));
  } catch { return false; }
}

async function knownServingSupport({ port }) {
  const previous = readObservation(path.join(STATE, 'antigravity-discovery.json'));
  if (previous?.provider?.enabled === true) return previous;
  if (!previous && !await servingListsAntigravity(port)) return antigravity.unconfirmed('unsupported');
  return fetchCapabilities({ port });
}

async function compatibilityRequired({ provider, port, environment = process.env, cwd = process.cwd(), probe = probeCliStatus, serving = knownServingSupport }) {
  const configIntent = configRequiresCompatibility({ environment, cwd });
  if (provider === 'antigravity' || configIntent) return true;
  const installed = probe();
  if (installed.provider?.enabled === true) return true;
  const snapshot = await serving({ port });
  return snapshot.provider?.enabled === true;
}

module.exports = { ONBOARDING_PATH, readOnboarding, writeOnboarding, validateSetupArguments, prepareSetup, reportStartupFailure, probeCliStatus, assertCandidateCompatibility,
  installCompatibleCandidate, runAuth, selectedReadiness, gatewayReadiness, compatibilityRequired };
