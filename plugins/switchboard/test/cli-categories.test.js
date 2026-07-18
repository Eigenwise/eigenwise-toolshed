'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'switchboard.js');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cli-'));
  return {
    directory,
    env: Object.assign({}, process.env, {
      SWITCHBOARD_CONFIG_USER_FILE: path.join(directory, 'user.json'),
      SWITCHBOARD_CONFIG_PROJECT_FILE: path.join(directory, 'project.json'),
    }),
  };
}

function run(env, ...args) {
  return execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
}

test('category CLI adds, edits, detaches, relinks, and explains resolution', () => {
  const { directory, env } = fixture();
  try {
    run(env, 'category', 'add', 'alpha', '--name', 'Alpha', '--description', 'alpha work', '--contract', 'do alpha', '--model', 'sonnet', '--effort', 'high', '--json');
    const listed = JSON.parse(run(env, 'category', 'list', '--json'));
    assert.equal(listed.categories.find((category) => category.id === 'alpha').name, 'Alpha');

    run(env, 'category', 'edit', 'alpha', '--project', directory, '--name', 'Local alpha', '--json');
    const detached = JSON.parse(run(env, 'category', 'show', 'alpha', '--project', directory, '--json'));
    assert.equal(detached.category.name, 'Local alpha');
    assert.equal(detached.state, 'detached');

    run(env, 'category', 'relink', 'alpha', '--project', directory, '--json');
    const relinked = JSON.parse(run(env, 'category', 'show', 'alpha', '--project', directory, '--json'));
    assert.equal(relinked.category.name, 'Alpha');

    const resolved = JSON.parse(run(env, 'resolve', 'alpha', '--project', directory, '--json'));
    assert.equal(resolved.status, 'routed');
    assert.equal(resolved.route.source, 'primary');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy numeric commands continue to print their deprecation notice', () => {
  const { directory, env } = fixture();
  try {
    const output = execFileSync(process.execPath, [cli, 'route', '5'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(output, /C5/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
