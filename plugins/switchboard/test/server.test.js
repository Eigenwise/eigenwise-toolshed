'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const server = require('../lib/server.js');

function request(url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

test('Switchboard settings host binds to loopback and serves the reusable panel contract', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-server-'));
  const previousUser = process.env.SWITCHBOARD_CONFIG_USER_FILE;
  const previousProject = process.env.SWITCHBOARD_CONFIG_PROJECT_FILE;
  process.env.SWITCHBOARD_CONFIG_USER_FILE = path.join(directory, 'user.json');
  process.env.SWITCHBOARD_CONFIG_PROJECT_FILE = path.join(directory, 'project.json');
  const started = await server.start(0);
  try {
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:/);
    const home = await request(`${started.url}/`);
    assert.equal(home.status, 200);
    assert.match(home.body, /switchboard-root/);
    const panel = await request(`${started.url}/panel.js`);
    assert.equal(panel.status, 200);
    assert.match(panel.body, /createPanel/);

    const settings = await request(`${started.url}/api/settings`);
    const payload = JSON.parse(settings.body);
    assert.equal(settings.status, 200);
    assert.ok(payload.effective.categories.some((category) => category.id === 'general'));
    assert.ok(payload.contract);

    const resolution = await request(`${started.url}/api/resolve?category=general`);
    assert.equal(resolution.status, 200);
    assert.equal(JSON.parse(resolution.body).category.id, 'general');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (previousUser === undefined) delete process.env.SWITCHBOARD_CONFIG_USER_FILE;
    else process.env.SWITCHBOARD_CONFIG_USER_FILE = previousUser;
    if (previousProject === undefined) delete process.env.SWITCHBOARD_CONFIG_PROJECT_FILE;
    else process.env.SWITCHBOARD_CONFIG_PROJECT_FILE = previousProject;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
