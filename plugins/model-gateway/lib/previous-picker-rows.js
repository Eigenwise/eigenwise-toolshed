'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { comparePinVersions, effectivePins, modelDisplayName, pinVersion } = require('./pins.js');

// Claude Code caches the rows Anthropic's bootstrap sends in its global config. Behind a custom
// base URL it lists them in /model, and a row there can name an older model than the current one
// for its family (SQ-4106: "Fable" running claude-fable-5-1). Claude Code skips a cached row when
// a gateway-discovered row has the same value, so advertising that value with an honest label is
// the supported way to stop the old model posing as the current one. The file is only read.
function claudeGlobalConfigPath(env = process.env) {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

function readServerPickerRows(file = claudeGlobalConfigPath()) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')).additionalModelOptionsCache;
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function currentPinValues() {
  return Object.fromEntries(Object.entries(effectivePins()).map(([alias, pin]) => [alias, pin.value]));
}

function previousServerRows(serverRows, currentPins) {
  return serverRows.flatMap((row) => {
    const value = row?.value;
    if (typeof value !== 'string' || !pinVersion(value)) return [];
    const current = currentPins[pinVersion(value)[0]];
    if (!current || comparePinVersions(value, current) !== -1) return [];
    return [{ id: value, display_name: `${modelDisplayName(value)} (previous)` }];
  });
}

function withPreviousServerRows(models, { serverRows = readServerPickerRows(), currentPins = currentPinValues() } = {}) {
  const previous = previousServerRows(serverRows, currentPins);
  const relabelled = new Set(previous.map((row) => row.id));
  return [...previous, ...models.filter((model) => !relabelled.has(model?.id))];
}

module.exports = { claudeGlobalConfigPath, previousServerRows, readServerPickerRows, withPreviousServerRows };
