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
// The nested suite reaches the registry two different ways, and the preload has to
// redirect both, so the pattern covers both rather than whichever one is cheapest.
// `complexity 4+ add warns` registers through a CLI subprocess (cliJson), which
// inherits SIDEQUEST_HOME from the environment; the other three call
// store.ensureProject in-process, where the preload has to have rewritten the home
// before the module loaded. A pattern naming only the subprocess case leaves the
// in-process surface untested (SQ-2800 review).
const REGISTRY_WRITING_PLANNING_TESTS = [
  'complexity 4\\+ add warns',
  'rejects unrunnable npm verifies',
  'warning presentation deduplicates',
  'SQ-2200: verify preflight',
].join('|');

function runPlanningWarningsSuite(sidequestHome: string, preloads: string[] = [], testNamePattern?: string) {
  return spawnSync(process.execPath, [
    '--import', 'tsx',
    ...preloads.flatMap((preload) => ['--import', preload]),
    '--test',
    ...(testNamePattern ? ['--test-name-pattern', testNamePattern] : []),
    planningWarningsTest,
  ], {
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
    // Run the four tests in the nested suite that register a project, not all 42 and
    // not just one. The invariant here is that the preload redirects every project
    // write, so the evidence has to include every test that can write: the other
    // three call store.ensureProject too. Narrowing to one of four writers would
    // leave a test that bypasses the preload undetected (SQ-2800 review).
    const isolatedRun = runPlanningWarningsSuite(liveHome, [testHomePreload], REGISTRY_WRITING_PLANNING_TESTS);
    assert.strictEqual(isolatedRun.status, 0, isolatedRun.stderr || isolatedRun.stdout);
    assert.match(isolatedRun.stdout + isolatedRun.stderr, /complexity 4\+ add warns for empty executor context and file scope/);
    assert.match(isolatedRun.stdout + isolatedRun.stderr, /rejects unrunnable npm verifies when tickets are added or updated/);
    assert.match(isolatedRun.stdout + isolatedRun.stderr, /warning presentation deduplicates by ticket and session/);
    assert.match(isolatedRun.stdout + isolatedRun.stderr, /SQ-2200: verify preflight looks up each npm script/);
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
