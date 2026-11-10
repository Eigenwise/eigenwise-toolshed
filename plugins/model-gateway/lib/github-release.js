'use strict';

const { spawnSync } = require('node:child_process');

// Unauthenticated GitHub API calls share a 60-per-hour budget per IP address, which a
// machine running several agents spends quickly. An authenticated call gets 5,000.
// The token goes only on the API request; release assets download without it.
const ENV_TOKEN_SOURCES = ['GH_TOKEN', 'GITHUB_TOKEN'];

function tokenFromEnv(env) {
  for (const source of ENV_TOKEN_SOURCES) {
    const token = (env[source] || '').trim();
    if (token) return { token, source };
  }
  return null;
}

function tokenFromGh(run) {
  const result = run('gh', ['auth', 'token', '--hostname', 'github.com'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const token = result.error || result.status !== 0 ? '' : String(result.stdout || '').trim();
  return token ? { token, source: 'gh auth token' } : null;
}

function githubToken({ env = process.env, run = spawnSync } = {}) {
  return tokenFromEnv(env) || tokenFromGh(run);
}

function apiHeaders(auth) {
  const headers = { accept: 'application/vnd.github+json' };
  if (auth) headers.authorization = `Bearer ${auth.token}`;
  return headers;
}

function refusalMessage(status, auth) {
  const base = `GitHub API returned ${status}`;
  if (auth) return `${base} using the token from ${auth.source}; check that it is valid for github.com`;
  if (status === 403 || status === 429) {
    return `${base}: unauthenticated requests are rate limited. Set GH_TOKEN or run \`gh auth login\`, then retry`;
  }
  return base;
}

async function fetchLatestRelease(repo, { fetchUrl, log = () => {}, env, run } = {}) {
  const auth = githubToken({ env, run });
  log(`fetching latest release of ${repo}${auth ? ` (authenticated via ${auth.source})` : ''}...`);
  const response = await fetchUrl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: apiHeaders(auth) });
  if (response.status !== 200) throw new Error(refusalMessage(response.status, auth));
  return JSON.parse(response.body.toString());
}

module.exports = { githubToken, fetchLatestRelease };
