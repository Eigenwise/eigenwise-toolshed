import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import './_temp-cleanup.js';

import {
  isPlanningDepthWarningsFixturePath,
  planningDepthWarningsFixtureParent,
} from './_fixture-provenance.js';

const pluginRoot = path.resolve(__dirname, '..');
const planningWarningsTest = path.join(pluginRoot, 'test', 'planning-depth-warnings.test.ts');
const testHomePreload = pathToFileURL(path.join(pluginRoot, 'test', '_sidequest-test-home.ts')).href;
const fixtureBoardPath = path.join(planningDepthWarningsFixtureParent, 'board');

function runPlanningWarningsSuite(sidequestHome: string, preloads: string[] = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', ...preloads.flatMap((preload) => ['--import', preload]), '--test', planningWarningsTest], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, SIDEQUEST_HOME: sidequestHome },
  });
}

function registerProject(sidequestHome: string, projectPath: string, projectName: string) {
  const result = spawnSync(process.execPath, ['-e', "require('./lib/store').ensureProject(process.env.SQ1976_PROJECT_PATH, process.env.SQ1976_PROJECT_NAME)"], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SIDEQUEST_HOME: sidequestHome,
      SQ1976_PROJECT_PATH: projectPath,
      SQ1976_PROJECT_NAME: projectName,
    },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

function fixtureRegistrations(sidequestHome: string) {
  const database = new DatabaseSync(path.join(sidequestHome, 'sidequest.db'));
  const registrations = database.prepare("SELECT json_extract(data, '$.path') AS path FROM projects ORDER BY path").all() as Array<{ path: string }>;
  database.close();
  return registrations
    .filter(({ path: projectPath }) => isPlanningDepthWarningsFixturePath(projectPath))
    .map(({ path: projectPath }) => ({ path: projectPath }));
}

function registryBytes(directory: string) {
  const files = new Map<string, string>();
  function collect(currentDirectory: string, relativeDirectory = '') {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) collect(fullPath, relativePath);
      else if (entry.isFile()) files.set(relativePath, fs.readFileSync(fullPath).toString('base64'));
    }
  }
  collect(directory);
  return files;
}

test('test runner creates a Sidequest home before store imports', () => {
  assert.match(path.basename(String(process.env.SIDEQUEST_HOME)), /^sq-test-home-/);
});

test('a test process without test-home preload registers a planning fixture, while the isolated suite preserves a live-registry sentinel', () => {
  const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1976-legacy-home-'));
  const liveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1976-live-home-'));
  const sentinelProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1976-sentinel-project-'));

  try {
    registerProject(legacyHome, fixtureBoardPath, 'board');
    assert.deepStrictEqual(fixtureRegistrations(legacyHome), [{ path: fixtureBoardPath }]);

    registerProject(liveHome, sentinelProject, 'sentinel');
    const before = registryBytes(liveHome);
    const isolatedRun = runPlanningWarningsSuite(liveHome, [testHomePreload]);
    assert.strictEqual(isolatedRun.status, 0, isolatedRun.stderr || isolatedRun.stdout);
    assert.match(isolatedRun.stdout + isolatedRun.stderr, /complexity 4\+ add warns for empty executor context and file scope/);
    assert.deepStrictEqual(registryBytes(liveHome), before);
  } finally {
    for (const directory of [legacyHome, liveHome, sentinelProject]) {
      try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        // _temp-cleanup retries Windows file locks after the test process exits.
      }
    }
  }
});
