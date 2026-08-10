'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const { readAvailable, readInstalled, searchAvailable, unusedInstalled } = require('../lib/catalog.js');

let environment;

beforeEach(() => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-catalog-test-'));
  const pluginsDir = path.join(claudeDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  environment = { CLAUDE_CONFIG_DIR: claudeDir, pluginsDir };

  fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'live-rules@eigenwise-toolshed': [{ scope: 'user' }],
      'context7@claude-plugins-official': [{ scope: 'user' }],
    },
  }));

  fs.writeFileSync(path.join(pluginsDir, 'plugin-catalog-cache.json'), JSON.stringify({
    catalog: {
      plugins: {
        'context7@claude-plugins-official': {
          plugin: 'context7',
          unique_installs: 9000,
          components: { skills: [], commands: [], agents: [], hooks: [], mcpServers: [{}], lspServers: [] },
          marketplace_entry: { name: 'context7', description: 'Up-to-date documentation lookup via MCP', category: 'development' },
        },
        'playwright@claude-plugins-official': {
          plugin: 'playwright',
          unique_installs: 5000,
          components: { skills: [{}], commands: [], agents: [], hooks: [], mcpServers: [{}], lspServers: [] },
          marketplace_entry: { name: 'playwright', description: 'Browser automation and testing with Playwright', category: 'development' },
        },
      },
    },
  }));

  const marketplaceDir = path.join(pluginsDir, 'marketplaces', 'local-market', '.claude-plugin');
  fs.mkdirSync(marketplaceDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({
    'local-market': { installLocation: path.dirname(marketplaceDir) },
  }));
  fs.writeFileSync(path.join(marketplaceDir, 'marketplace.json'), JSON.stringify({
    name: 'local-market',
    plugins: [{ name: 'grafana-helper', description: 'Dashboards for Grafana', keywords: ['grafana', 'observability'] }],
  }));
});

test('readInstalled splits id into name and marketplace', () => {
  const installed = readInstalled(environment);
  const liveRules = installed.find((plugin) => plugin.name === 'live-rules');
  assert.equal(liveRules.marketplace, 'eigenwise-toolshed');
  assert.deepEqual(liveRules.scopes, ['user']);
});

test('readAvailable merges catalog cache with marketplace manifests', () => {
  const available = readAvailable(environment);
  const ids = available.map((plugin) => plugin.id).sort();
  assert.deepEqual(ids, [
    'context7@claude-plugins-official',
    'grafana-helper@local-market',
    'playwright@claude-plugins-official',
  ]);
  const playwright = available.find((plugin) => plugin.name === 'playwright');
  assert.equal(playwright.installs, 5000);
  assert.equal(playwright.components.mcpServers, 1);
});

test('searchAvailable matches terms, excludes installed, ranks name hits first', () => {
  const browserResults = searchAvailable('browser automation', environment);
  assert.equal(browserResults[0].name, 'playwright');

  const documentationResults = searchAvailable('documentation', environment);
  assert.equal(documentationResults.find((plugin) => plugin.name === 'context7'), undefined, 'installed plugins never recommended');

  const grafanaResults = searchAvailable('grafana', environment);
  assert.equal(grafanaResults[0].name, 'grafana-helper');
});

test('unusedInstalled flags installs with no attribution events', () => {
  const unused = unusedInstalled({ 'live-rules': 12 }, environment);
  assert.deepEqual(unused, ['context7@claude-plugins-official']);
});
