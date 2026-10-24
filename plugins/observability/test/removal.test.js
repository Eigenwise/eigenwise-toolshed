const assert = require('node:assert/strict');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pluginRoot = path.resolve(__dirname, '..');

test('retired telemetry services and sink files are absent', () => {
  for (const removedPath of ['bin/observer.js', 'lib/observability', 'observability/sinks', 'hooks/observability.js']) {
    assert.equal(existsSync(path.join(pluginRoot, removedPath)), false, `${removedPath} must stay removed`);
  }
  const retiredFiles = readdirSync(pluginRoot, { recursive: true })
    .filter((file) => file !== 'CHANGELOG.md')
    .filter((file) => /grafana|otelcol/i.test(file));
  assert.deepEqual(retiredFiles, []);
});
