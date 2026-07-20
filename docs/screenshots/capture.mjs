/*
 * Documentation screenshots use only the fixed FIXTURE below. The privacy gate
 * rejects any fixture text that matches cwd, the OS user, or environment values;
 * temporary paths, ports, and container names are lifecycle-only and never rendered.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, '..');
const repoDir = path.resolve(docsDir, '..');
const outputDir = path.join(docsDir, 'src', 'assets', 'screenshots');
const sidequestCli = path.join(repoDir, 'plugins', 'sidequest', 'bin', 'sidequest.js');
const grafanaProvisioning = path.join(repoDir, 'plugins', 'workbench', 'observability', 'sinks', 'grafana', 'provisioning');
const grafanaDashboards = path.join(repoDir, 'plugins', 'workbench', 'observability', 'sinks', 'grafana', 'dashboards');

const FIXTURE = Object.freeze({
  project: 'acme-webshop',
  story: 'Spring storefront refresh',
  tickets: [
    ['Design category filters', 'todo', 'high', 'product'],
    ['Map checkout event names', 'todo', 'normal', 'analytics'],
    ['Review mobile product cards', 'todo', 'normal', 'product'],
    ['Add returns-policy copy', 'todo', 'low', 'content'],
    ['Build cart summary', 'doing', 'urgent', 'product'],
    ['Check inventory sync', 'doing', 'high', 'analytics'],
    ['Wire purchase funnel', 'doing', 'normal', 'analytics'],
    ['Ship search refinements', 'done', 'high', 'product'],
    ['Archive winter promotion', 'done', 'low', 'content'],
  ],
  models: [
    ['fable', '68,400', 'Orchestrator'],
    ['sonnet', '41,200', 'Research'],
    ['gpt-5.6-terra', '97,600', 'Implementation'],
  ],
  mcp: [
    ['sidequest', '2,840', '38 calls'],
    ['github', '1,920', '24 calls'],
    ['playwright', '1,360', '17 calls'],
  ],
  burn: [
    ['fable', '1.82M', '$4.16'],
    ['gpt-5.6-terra', '1.24M', '$2.84'],
    ['sonnet', '836K', '$1.72'],
  ],
  board: [
    ['Spring storefront refresh', '9 tickets', '$8.72'],
    ['Returns flow cleanup', '6 tickets', '$3.18'],
    ['Mobile discovery', '4 tickets', '$2.06'],
  ],
  sessions: ['demo-alpha-7f3a', 'demo-beta-4c21', 'demo-gamma-9b18'],
});

function fixtureText(value) {
  return JSON.stringify(value);
}

function assertSyntheticFixture() {
  const text = fixtureText(FIXTURE);
  const forbidden = [process.cwd(), os.userInfo().username, ...Object.values(process.env)]
    .filter((value) => typeof value === 'string' && value.length > 3);
  assert.match(text, /acme-webshop/);
  for (const value of forbidden) assert.equal(text.includes(value), false, `Synthetic fixture contains environment text: ${value}`);
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandName} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function ticketRef(output) {
  const match = output.match(/SQ-\d+/);
  assert.ok(match, `Could not read ticket ref from: ${output}`);
  return match[0];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 302) return;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || 'unknown error'}`);
}

async function seedSidequest(tempHome, fakeProject) {
  const env = { ...process.env, SIDEQUEST_HOME: tempHome, CLAUDE_PROJECT_DIR: fakeProject };
  const cli = (args) => command(process.execPath, [sidequestCli, ...args, '--project', fakeProject], { cwd: fakeProject, env });
  for (const [id, name] of [['product', 'Product'], ['analytics', 'Analytics'], ['content', 'Content']]) {
    cli(['category', 'add', id, '--name', name, '--route-model', 'fable', '--route-effort', 'low']);
  }
  const story = cli(['story', 'add', '-t', FIXTURE.story, '--color', 'teal']).match(/US-\d+/)?.[0];
  assert.ok(story, 'Could not create the synthetic story');
  const refs = [];
  for (const [title, status, priority, category] of FIXTURE.tickets) {
    refs.push(ticketRef(cli(['add', '-t', title, '--category', category, '--story', story, '-p', priority, '-s', status, '-d', 'Synthetic documentation ticket for the Acme Webshop demo board.'])));
  }
  cli(['comment', refs[4], '-m', 'Checkout summary is ready for a friendly design review.', '--by', 'Maya Chen']);
  cli(['comment', refs[0], '-m', 'The filter states are documented in the storefront brief.', '--by', 'Diego Park']);
}

function startSidequest(tempHome, fakeProject, port) {
  const env = { ...process.env, SIDEQUEST_HOME: tempHome, CLAUDE_PROJECT_DIR: fakeProject };
  const child = spawn(process.execPath, [sidequestCli, 'serve', '--port', String(port), '--project', fakeProject], {
    cwd: fakeProject,
    env,
    stdio: 'pipe',
    windowsHide: true,
  });
  child.stderr.on('data', () => {});
  return child;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

function table(rows, headers) {
  return `<table><thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlEscape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function grafanaMock(title, caption, headers, rows) {
  return `<!doctype html><html><head><style>
    * { box-sizing: border-box; } body { margin: 0; background: #111827; color: #edf2f7; font: 15px Inter, ui-sans-serif, system-ui, sans-serif; }
    header { height: 56px; padding: 0 28px; display: flex; align-items: center; gap: 18px; background: #171f2f; border-bottom: 1px solid #2b3a52; color: #dbeafe; }
    .mark { color: #f59e0b; font-size: 22px; } .crumb { color: #91a4c3; } main { padding: 30px 42px; } h1 { font-size: 26px; margin: 0 0 8px; } p { color: #9fb0ca; margin: 0 0 24px; }
    .tabs { display: flex; gap: 20px; border-bottom: 1px solid #2b3a52; margin-bottom: 24px; } .tabs span { padding: 0 0 12px; color: #9fb0ca; } .tabs .active { color: #f8fafc; border-bottom: 2px solid #f59e0b; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 18px; } .card, .panel { background: #1b2638; border: 1px solid #31435d; border-radius: 5px; }
    .card { padding: 18px; min-height: 112px; } .label { color: #a8bad1; font-size: 13px; } .value { font-size: 30px; font-weight: 650; padding-top: 12px; } .orange { color: #f59e0b; } .green { color: #4ade80; } .blue { color: #60a5fa; }
    .panel { padding: 20px; } h2 { font-size: 17px; margin: 0 0 6px; } .panel p { font-size: 13px; } table { border-collapse: collapse; width: 100%; margin-top: 16px; } th { color: #9fb0ca; font-weight: 500; text-align: left; border-bottom: 1px solid #41536c; padding: 11px 12px; } td { border-bottom: 1px solid #2c3b52; padding: 13px 12px; } tr:last-child td { border: 0; }
    .tag { padding: 3px 8px; border-radius: 999px; background: #243a56; color: #b9d4ff; font-size: 12px; } .note { padding-top: 20px; color: #71839f; font-size: 12px; }
  </style></head><body><header><span class="mark">◢</span><strong>Grafana</strong><span class="crumb">Dashboards / Workbench / Claude Code Usage</span></header><main><h1>Claude Code Usage</h1><p>Acme Webshop synthetic observability data</p><div class="tabs"><span class="active">${htmlEscape(title)}</span><span>Tool activity</span><span>MCP</span><span>Sessions & agents</span><span>Sidequest costs</span></div><div class="cards"><div class="card"><div class="label">Input tokens</div><div class="value orange">3.90M</div></div><div class="card"><div class="label">Output tokens</div><div class="value green">642K</div></div><div class="card"><div class="label">Synthetic cost</div><div class="value blue">$8.72</div></div></div><section class="panel"><h2>${htmlEscape(title)}</h2><p>${htmlEscape(caption)}</p>${table(rows, headers)}</section><div class="note">Demo only. Fixed synthetic records, captured by docs/screenshots/capture.mjs.</div></main></body></html>`;
}

async function captureGrafana(browser, grafanaPort) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${grafanaPort}/d/claude-code-usage`, { waitUntil: 'domcontentloaded' });
  const captures = [
    ['observability-tokens-models.png', 'Tokens & models', 'Fixed token totals by model for the Acme Webshop demo.', ['Model', 'Context tokens', 'Role'], FIXTURE.models],
    ['observability-mcp.png', 'MCP', 'Tool-definition footprint and activity from the fixed demo dataset.', ['MCP server', 'Definition tokens', 'Activity'], FIXTURE.mcp],
    ['observability-who-is-burning.png', 'Who is burning tokens', 'Synthetic model totals and demo-only cost figures.', ['Model', 'Tokens', 'Synthetic cost'], FIXTURE.burn],
    ['observability-board-costs.png', 'Sidequest board costs', 'Example rollup for the Acme Webshop demo board.', ['Story', 'Tickets', 'Synthetic cost'], FIXTURE.board],
  ];
  for (const [file, title, caption, headers, rows] of captures) {
    await page.setContent(grafanaMock(title, caption, headers, rows), { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(outputDir, file), fullPage: true });
  }
  await page.close();
}

async function captureSidequest(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(outputDir, 'sidequest-kanban.png'), fullPage: true });
  const card = page.getByText('Build cart summary', { exact: true });
  await card.click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outputDir, 'sidequest-ticket-detail.png'), fullPage: true });
  await page.close();
}

async function main() {
  assertSyntheticFixture();
  await mkdir(outputDir, { recursive: true });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'toolshed-docs-screenshots-'));
  const tempHome = path.join(tempRoot, 'sidequest-home');
  const fakeProject = path.join(tempRoot, FIXTURE.project);
  const sidequestPort = await freePort();
  const grafanaPort = await freePort();
  const otlpPort = await freePort();
  const container = `toolshed-docs-${process.pid}`;
  const volume = `${container}-data`;
  let server;
  let browser;
  try {
    await mkdir(fakeProject, { recursive: true });
    await seedSidequest(tempHome, fakeProject);
    server = startSidequest(tempHome, fakeProject, sidequestPort);
    await waitFor(`http://127.0.0.1:${sidequestPort}`, 'Synthetic Sidequest server');
    command('docker', ['run', '--detach', '--name', container, '--publish', `127.0.0.1:${grafanaPort}:3000`, '--publish', `127.0.0.1:${otlpPort}:4318`, '--volume', `${volume}:/data`, '--volume', `${grafanaProvisioning}:/otel-lgtm/grafana/conf/provisioning/dashboards:ro`, '--volume', `${grafanaDashboards}:/otel-lgtm/grafana/conf/provisioning/workbench-dashboards:ro`, '--env', 'GF_AUTH_ANONYMOUS_ENABLED=true', '--env', 'GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer', 'grafana/otel-lgtm:0.11.0']);
    await waitFor(`http://127.0.0.1:${grafanaPort}/api/health`, 'Isolated Grafana');
    browser = await chromium.launch();
    await captureSidequest(browser, sidequestPort);
    await captureGrafana(browser, grafanaPort);
    console.log(`Generated 6 synthetic screenshots in ${outputDir}`);
  } finally {
    await browser?.close();
    server?.kill();
    try { command('docker', ['rm', '--force', container], { stdio: 'ignore' }); } catch {}
    try { command('docker', ['volume', 'rm', volume], { stdio: 'ignore' }); } catch {}
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
