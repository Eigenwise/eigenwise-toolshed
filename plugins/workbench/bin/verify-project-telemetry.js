#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const { defaultConfigPath, defaultDataDir, readObservabilityConfig } = require('../observability/sinks/index.js');
const { projectName } = require('./project-telemetry.js');

function getJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ statusCode: response.statusCode, body: null });
        }
      });
    });
    request.once('timeout', () => { request.destroy(); resolve(null); });
    request.once('error', () => resolve(null));
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project' && argv[index + 1]) {
      options.projectDir = argv[++index];
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  return options;
}

async function verifyProjectTelemetry(projectDir, options = {}) {
  const configFile = options.configFile || defaultConfigPath(options.dataDir || defaultDataDir(options.environment));
  const config = readObservabilityConfig(configFile).observability;
  const project = projectName(projectDir);
  const observer = await getJson(`http://127.0.0.1:${config.ports?.observer || 14319}/health`);
  const observerHealthy = observer?.statusCode === 200 && observer.body?.ok === true;
  if (!config.dashboard) return { found: false, project, observerHealthy, reason: 'dashboard_not_configured' };

  const dashboardUrl = `http://127.0.0.1:${config.ports?.dashboard || 3000}`;
  const dataSources = await getJson(`${dashboardUrl}/api/datasources`);
  if (dataSources?.statusCode !== 200) return { found: false, project, observerHealthy, reason: 'dashboard_unreachable' };

  const dataSource = Array.isArray(dataSources.body) && dataSources.body.find((candidate) => candidate.type === 'prometheus');
  const query = `claude_code_token_usage_tokens_total{project_id=${JSON.stringify(project)}}`;
  const dashboard = await getJson(`${dashboardUrl}/api/datasources/proxy/uid/${encodeURIComponent(dataSource?.uid || 'prometheus')}/api/v1/query?query=${encodeURIComponent(query)}`);
  if (dashboard?.statusCode !== 200) return { found: false, project, observerHealthy, reason: 'dashboard_unreachable' };

  const found = Array.isArray(dashboard.body?.data?.result) && dashboard.body.data.result.length > 0;
  return { found, project, observerHealthy, reason: found ? undefined : 'metric_not_found' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await verifyProjectTelemetry(path.resolve(options.projectDir || process.cwd()), options);
  process.stdout.write(`${result.found ? 'found' : 'not-found'} project=${result.project} observer=${result.observerHealthy ? 'healthy' : 'unavailable'}${result.reason ? ` reason=${result.reason}` : ''}\n`);
}

module.exports = { parseArgs, verifyProjectTelemetry };

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
