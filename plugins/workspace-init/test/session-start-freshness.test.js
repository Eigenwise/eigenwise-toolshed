'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MIGRATION_NOTICE,
  hasUserWorkbench,
  migrationNotice,
} = require('../hooks/session-start-freshness.js');

test('shows the Workbench migration notice until Workbench is installed at user scope', () => {
  const registry = {
    plugins: {
      'workbench@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/project' }],
    },
  };

  assert.equal(hasUserWorkbench(registry), false);
  assert.equal(migrationNotice(registry), MIGRATION_NOTICE);
});

test('stays silent after Workbench is installed at user scope', () => {
  const registry = {
    plugins: {
      'workbench@eigenwise-toolshed': [{ scope: 'user' }],
    },
  };

  assert.equal(hasUserWorkbench(registry), true);
  assert.equal(migrationNotice(registry), '');
});
