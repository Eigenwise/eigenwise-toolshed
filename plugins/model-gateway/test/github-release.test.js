'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { githubToken, fetchLatestRelease } = require('../lib/github-release.js');
const { fetchUrl } = require('../lib/process-supervision.js');

const API = 'https://api.github.com/repos/raine/claude-code-proxy/releases/latest';
const noGh = () => ({ status: 1, stdout: '' });

test('githubToken prefers GH_TOKEN, then GITHUB_TOKEN, then gh auth token', () => {
  const gh = () => ({ status: 0, stdout: 'gho_from_gh\n' });
  assert.deepEqual(githubToken({ env: { GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }, run: gh }), { token: 'a', source: 'GH_TOKEN' });
  assert.deepEqual(githubToken({ env: { GITHUB_TOKEN: 'b' }, run: gh }), { token: 'b', source: 'GITHUB_TOKEN' });
  assert.deepEqual(githubToken({ env: {}, run: gh }), { token: 'gho_from_gh', source: 'gh auth token' });
});

test('githubToken asks gh for the github.com host without a shell and with a timeout', () => {
  let call;
  githubToken({ env: {}, run: (command, args, options) => { call = { command, args, options }; return { status: 0, stdout: 't' }; } });
  assert.equal(call.command, 'gh');
  assert.deepEqual(call.args, ['auth', 'token', '--hostname', 'github.com']);
  assert.equal(call.options.timeout, 5000);
  assert.notEqual(call.options.shell, true);
});

test('githubToken returns null when gh is missing, logged out, or prints nothing', () => {
  assert.equal(githubToken({ env: {}, run: () => ({ error: new Error('ENOENT') }) }), null);
  assert.equal(githubToken({ env: {}, run: noGh }), null);
  assert.equal(githubToken({ env: {}, run: () => ({ status: 0, stdout: '  \n' }) }), null);
  assert.equal(githubToken({ env: { GH_TOKEN: '  ' }, run: noGh }), null);
});

test('fetchLatestRelease sends the token only as a bearer header on the API call', async () => {
  let seen;
  const release = await fetchLatestRelease('raine/claude-code-proxy', {
    fetchUrl: async (url, options) => { seen = { url, options }; return { status: 200, body: Buffer.from('{"tag_name":"v1"}') }; },
    env: { GH_TOKEN: 'secret' }, run: noGh,
  });
  assert.equal(release.tag_name, 'v1');
  assert.equal(seen.url, API);
  assert.equal(seen.options.headers.authorization, 'Bearer secret');
  assert.equal(seen.options.headers.accept, 'application/vnd.github+json');
});

test('fetchLatestRelease stays unauthenticated when no token is available', async () => {
  let headers;
  await fetchLatestRelease('raine/claude-code-proxy', {
    fetchUrl: async (url, options) => { headers = options.headers; return { status: 200, body: Buffer.from('{}') }; },
    env: {}, run: noGh,
  });
  assert.equal('authorization' in headers, false);
});

test('fetchLatestRelease names the rate limit and the fix when an unauthenticated call is refused', async () => {
  for (const status of [403, 429]) {
    await assert.rejects(
      fetchLatestRelease('raine/claude-code-proxy', { fetchUrl: async () => ({ status, body: Buffer.alloc(0) }), env: {}, run: noGh }),
      (error) => error.message.includes(`GitHub API returned ${status}`) && error.message.includes('GH_TOKEN') && error.message.includes('gh auth login'),
    );
  }
});

test('fetchLatestRelease reports any other failure status without rate-limit advice', async () => {
  await assert.rejects(
    fetchLatestRelease('raine/claude-code-proxy', { fetchUrl: async () => ({ status: 500, body: Buffer.alloc(0) }), env: {}, run: noGh }),
    { message: 'GitHub API returned 500' },
  );
});

test('fetchLatestRelease reports which token source was refused, never the token', async () => {
  await assert.rejects(
    fetchLatestRelease('raine/claude-code-proxy', { fetchUrl: async () => ({ status: 401, body: Buffer.alloc(0) }), env: { GITHUB_TOKEN: 'ghp_secret' }, run: noGh }),
    (error) => error.message.includes('GitHub API returned 401') && error.message.includes('GITHUB_TOKEN') && !error.message.includes('ghp_secret'),
  );
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('fetchUrl keeps authorization on a same-host redirect and drops it on a cross-host one', async (t) => {
  const received = [];
  const target = await listen((request, response) => { received.push(request.headers.authorization); response.end('ok'); });
  const origin = await listen((request, response) => {
    if (request.url === '/same') { received.push(request.headers.authorization); response.writeHead(302, { location: '/done' }); return response.end(); }
    if (request.url === '/done') { received.push(request.headers.authorization); return response.end('ok'); }
    response.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/asset` });
    response.end();
  });
  t.after(() => { origin.close(); target.close(); });
  const base = `http://127.0.0.1:${origin.address().port}`;

  await fetchUrl(`${base}/same`, { headers: { authorization: 'Bearer secret' } });
  assert.deepEqual(received, ['Bearer secret', 'Bearer secret']);

  received.length = 0;
  const result = await fetchUrl(`${base}/cross`, { headers: { Authorization: 'Bearer secret' } });
  assert.equal(result.status, 200);
  assert.deepEqual(received, [undefined]);
});
