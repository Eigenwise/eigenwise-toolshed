'use strict';

// These identities are a closed protocol, not a prefix-stripping rule. Bare Gemini
// IDs and future native models gain no routing meaning from this table.
const MODELS = Object.freeze({
  'claude-antigravity-gemini-4-argon-low': 'antigravity/gemini-4-argon-low',
  'claude-antigravity-gemini-4-argon-medium': 'antigravity/gemini-4-argon-medium',
  'claude-antigravity-gemini-4-argon-high': 'antigravity/gemini-4-argon-high',
});
const PICKERS = Object.freeze(Object.fromEntries(Object.entries(MODELS).map(([picker, model]) => [model, picker])));
const NATIVE_IDS = Object.freeze(Object.values(MODELS));
const WINDOW_POLICIES = Object.freeze(Object.fromEntries(Object.entries(MODELS).map(([pickerAlias, backendId]) => [backendId, Object.freeze({
  backend: 'antigravity', backendId, pickerAlias, backendWindow: null, advertisedWindow: 200000,
  measurement: 'unmeasured conservative client advertisement; native backend window unverified', sentry: 'none',
  sessionPolicy: 'fixed-model',
})])));
const FRESH_SESSION = 'Use an exact direct Antigravity model in a fresh session; keep the model, tier and profile fixed.';
const LEGACY_REFUSAL = `Antigravity cannot be selected through claude-codex-auto markers or cached/inherited routes. ${FRESH_SESSION} A marker in earlier user history still counts; remove it by starting a fresh session.`;

function isReservedModel(value) {
  return typeof value === 'string' && /^(?:claude-(?:codex-)?)?antigravity/i.test(value.trimStart());
}

function resolveModel(value) {
  if (Object.hasOwn(MODELS, value)) return MODELS[value];
  return Object.hasOwn(PICKERS, value) ? value : null;
}

function pickerId(value) {
  return PICKERS[resolveModel(value)] || null;
}

function hasMillionBeta(value) {
  return String(value || '').split(',').some((token) => /^context-1m(?:-|$)/i.test(token.trim()));
}

function validateContext(model, headers) {
  if (/\[1m\]/i.test(model) || hasMillionBeta(headers['anthropic-beta'])) {
    throw new Error(`Antigravity does not support [1m] or context-1m beta. ${FRESH_SESSION}`);
  }
}

function validateRequest({ method, pathname, model, headers }) {
  validateContext(model, headers);
  const target = resolveModel(model);
  if (!target) throw new Error(`Unknown Antigravity selector. ${FRESH_SESSION}`);
  if (method !== 'POST') throw new Error('Antigravity supports POST only.');
  if (!['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) {
    throw new Error('Antigravity supports only /v1/messages and /v1/messages/count_tokens, not OpenAI-compatible APIs.');
  }
  return target;
}

function userText(message) {
  if (message?.role !== 'user') return [];
  if (typeof message.content === 'string') return [message.content];
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((block) => block?.type === 'text').map((block) => block.text);
}

function reservedMarker(text) {
  if (typeof text !== 'string') return false;
  // Widen the target ONLY inside the historical route-marker authority position.
  // Brackets in [1m], slashes and invalid trailing fields must not select a cache fallback.
  return [...text.matchAll(/\[sidequest-route\s+model=([^\s\]]+)/gi)].some((match) => isReservedModel(match[1]));
}

function hasReservedRouteMarker(messages) {
  return Array.isArray(messages) && messages.flatMap(userText).some(reservedMarker);
}

function localConfigurationReady(status) {
  return status.configuration === 'valid' && ['ready', 'refresh_required'].includes(status.auth) && status.project === 'configured';
}

function validStatus(status) {
  if (!status || typeof status !== 'object') return false;
  const checks = [
    ['valid', 'invalid'].includes(status.configuration),
    ['missing', 'invalid', 'unreadable', 'ready', 'refresh_required', 'login_required'].includes(status.auth),
    ['missing', 'configured'].includes(status.project),
    typeof status.configuration_ready === 'boolean', status.live_verified === false,
    status.configuration_ready === localConfigurationReady(status),
  ];
  return checks.every(Boolean);
}

function validApis(apis) {
  return Array.isArray(apis) && ['messages', 'count_tokens'].every((api) => apis.includes(api));
}

function compatibleProvider(provider) {
  if (!provider || typeof provider !== 'object') return false;
  return [provider.supported === true, typeof provider.enabled === 'boolean', provider.mode === 'native',
    provider.experimental === true, validApis(provider.supported_apis), provider.session_policy === 'fixed-model',
    provider.context_window === 200000, provider.backend_window_verified === false, validStatus(provider.status)].every(Boolean);
}

function unconfirmed(state) {
  return { state, authoritative: false, observedAt: null, models: [], provider: null };
}

function listedNativeModels(data) {
  if (!Array.isArray(data)) return [];
  return [...new Set(data.map((row) => row?.id).filter((id) => NATIVE_IDS.includes(id)))];
}

function publicProvider(provider) {
  const status = provider.status;
  return { supported: provider.supported, enabled: provider.enabled, mode: provider.mode, experimental: provider.experimental,
    supported_apis: ['messages', 'count_tokens'], session_policy: provider.session_policy, context_window: provider.context_window,
    backend_window_verified: provider.backend_window_verified,
    status: { configuration: status.configuration, auth: status.auth, project: status.project,
      configuration_ready: status.configuration_ready, live_verified: false } };
}

function confirmedProvider(provider, data, observedAt) {
  if (provider?.supported === false) return { state: 'unsupported', authoritative: true, observedAt, models: [], provider: { supported: false } };
  if (!compatibleProvider(provider)) return unconfirmed('malformed');
  return { state: provider.enabled ? 'confirmed' : 'disabled', authoritative: true, observedAt,
    models: provider.enabled ? listedNativeModels(data) : [], provider: publicProvider(provider) };
}

function servingObservation(snapshot) {
  // The native inspector reports enabled:false on invalid configuration. That
  // reports unready configuration, not evidence of an intentional model removal.
  if (snapshot.provider?.status?.configuration !== 'invalid') return snapshot;
  return { ...snapshot, state: 'configuration-invalid', authoritative: false, observedAt: null, models: [] };
}

function inspectCapabilities(body, observedAt = Date.now()) {
  if (!body?.capabilities) return unconfirmed('unsupported');
  if (body.capabilities.schema_version !== 1) return unconfirmed('unknown-version');
  if (!Array.isArray(body.data)) return unconfirmed('malformed');
  return servingObservation(confirmedProvider(body.capabilities.providers?.antigravity, body.data, observedAt));
}

function inspectCliStatus(body, observedAt = Date.now()) {
  if (body?.schema_version !== 1) return unconfirmed('unknown-version');
  if (body.provider !== 'antigravity') return unconfirmed('malformed');
  return confirmedProvider(body, [], observedAt);
}

const STATE_MESSAGES = Object.freeze({
  unsupported: 'Native Antigravity support is unsupported or unconfirmed; a models.json entry or binary version is not proof.',
  'unknown-version': 'Antigravity capability schema is unknown; compatible native support is unconfirmed.',
  malformed: 'Antigravity capability metadata is malformed; native support is unconfirmed.',
  'transport-error': 'Antigravity serving capability metadata is unavailable; readiness is unconfirmed.',
  disabled: 'Antigravity inference is explicitly disabled. Enable it in the native proxy configuration; gateway onboarding does not enable it.',
  'configuration-invalid': 'Antigravity local configuration is invalid. Inspect native auth status and configuration.',
  'auth-missing': 'Antigravity sign-in is required. Run auth antigravity login, then setup --provider antigravity.',
  'auth-invalid': 'Antigravity credentials are invalid. Run auth antigravity login in the intended profile.',
  'auth-unreadable': 'Antigravity credentials are unreadable. Inspect the intended native profile locally.',
  'auth-login_required': 'Antigravity requires login. Run auth antigravity login in the intended profile.',
  'project-missing': 'Antigravity needs a configured stored project. Complete native provider configuration.',
  'shim-down': 'Antigravity shim is unavailable; run ensure, then retry.',
  ready: 'Antigravity local readiness does not verify Google access. Use a fresh session for model, tier or profile changes.',
});

function configurationState(status) {
  if (status.configuration !== 'valid') return 'configuration-invalid';
  if (!['ready', 'refresh_required'].includes(status.auth)) return `auth-${status.auth}`;
  return status.project === 'configured' ? 'ready' : 'project-missing';
}

function readinessState(snapshot, shimReady) {
  if (snapshot?.provider?.status?.configuration === 'invalid') return 'configuration-invalid';
  if (snapshot?.state !== 'confirmed') return snapshot?.state || 'unsupported';
  if (!shimReady) return 'shim-down';
  return configurationState(snapshot.provider.status);
}

function readiness(snapshot, { shimReady = true } = {}) {
  const state = readinessState(snapshot, shimReady);
  return { ready: state === 'ready', state, message: STATE_MESSAGES[state] || STATE_MESSAGES.unsupported };
}

function displayName(model) {
  return model.replace(/^antigravity\//, '').replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ') + ' (Antigravity; experimental fixed session)';
}

module.exports = { MODELS, PICKERS, NATIVE_IDS, WINDOW_POLICIES, FRESH_SESSION, LEGACY_REFUSAL, isReservedModel, resolveModel,
  pickerId, validateRequest, hasReservedRouteMarker, inspectCapabilities, inspectCliStatus, compatibleProvider,
  listedNativeModels, readiness, unconfirmed, displayName };
