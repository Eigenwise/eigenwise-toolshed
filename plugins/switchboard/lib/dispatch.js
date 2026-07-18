'use strict';

const { VALID_EFFORTS } = require('./categories.js');

const GATEWAY_SPAWN_MODEL = 'claude-codex-auto';
const MARKER_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

function markerModel(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!MARKER_MODEL_RE.test(model)) throw new Error('Dispatch model is not marker-safe.');
  return model;
}

function markerEffort(value) {
  const effort = typeof value === 'string' ? value.trim() : '';
  if (!VALID_EFFORTS.includes(effort)) throw new Error('Dispatch effort is not marker-safe.');
  return effort;
}

function nativeDispatch(spawnModel) {
  if (typeof spawnModel !== 'string' || !spawnModel.trim()) throw new Error('Native dispatch requires a spawn model.');
  return { kind: 'native', spawnModel: spawnModel.trim() };
}

function gatewayDispatch(dispatchModel, effort) {
  const model = markerModel(dispatchModel);
  const safeEffort = markerEffort(effort);
  return {
    kind: 'gateway-marker',
    spawnModel: GATEWAY_SPAWN_MODEL,
    dispatchModel: model,
    marker: `[switchboard-route model=${model} effort=${safeEffort}]`,
  };
}

module.exports = {
  GATEWAY_SPAWN_MODEL,
  gatewayDispatch,
  nativeDispatch,
};
