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
const grafanaProvisioning = path.join(repoDir, 'plugins', 'observability', 'observability', 'sinks', 'grafana', 'provisioning');
const grafanaDashboards = path.join(repoDir, 'plugins', 'observability', 'observability', 'sinks', 'grafana', 'dashboards');

const FIXTURE = Object.freeze({
  project: 'acme-webshop',
  projects: [
    {
      slug: 'acme-webshop',
      name: 'Acme Webshop',
      stories: [
        { key: 'checkout', title: 'Checkout confidence', color: 'violet' },
        { key: 'discovery', title: 'Storefront discovery', color: 'teal' },
      ],
      tickets: [
        { key: 'facet-url-state', title: 'Keep facet filters in the URL', description: 'Facet selections disappear after navigation. Preserve them in the URL and restore them when a shopper goes back.', status: 'todo', priority: 'high', category: 'product', story: 'discovery', assignee: 'Maya Chen', labels: ['search', 'ux'], age: '12m ago' },
        { key: 'sort-focus', title: 'Restore mobile sort focus', description: 'Keyboard focus falls back to the page after choosing a sort. Return it to the trigger without reopening the menu.', status: 'todo', priority: 'normal', category: 'product', story: 'discovery', assignee: 'Diego Park', labels: ['accessibility'], age: '28m ago' },
        { key: 'search-synonyms', title: 'Tune zero-result search synonyms', description: 'Common fabric and fit terms still return an empty grid. Add the reviewed synonym pairs and measure the fallback rate.', status: 'todo', priority: 'high', category: 'analytics', story: 'discovery', assignee: 'Priya Shah', labels: ['search', 'data'], age: '46m ago' },
        { key: 'checkout-events', title: 'Map checkout recovery events', description: 'The recovery path emits two names for the same completed order. Consolidate the schema before the funnel dashboard ships.', status: 'todo', priority: 'high', category: 'analytics', story: 'checkout', assignee: 'Jonah Reed', labels: ['analytics', 'checkout'], age: '1h ago' },
        { key: 'express-wallet', title: 'Add express checkout option', description: 'Returning shoppers need a one-tap wallet choice above the address form. Keep taxes and promotions visible before confirmation.', status: 'todo', priority: 'high', category: 'product', story: 'checkout', assignee: 'Noor Hassan', labels: ['checkout', 'payments'], age: '2h ago' },
        { key: 'returns-copy', title: 'Clarify final-sale returns copy', description: 'The product page and cart use different final-sale language. Use the approved policy text in both places.', status: 'todo', priority: 'low', category: 'content', assignee: null, labels: ['content', 'policy'], age: '3h ago' },
        { key: 'cart-summary', title: 'Build cart summary', description: 'The new summary keeps discounts, shipping, tax, and the final total in one stable grid. Mobile can wrap promotion labels, but totals must stay aligned.', status: 'doing', priority: 'urgent', category: 'product', story: 'checkout', assignee: null, labels: ['checkout', 'cart'], age: '18m ago' },
        { key: 'inventory-badge', title: 'Harden low-stock badge refresh', description: 'The badge can show stale inventory after a variant change. Cancel the old request and render only the latest response.', status: 'doing', priority: 'high', category: 'reliability', story: 'discovery', assignee: 'Eli Brooks', labels: ['inventory', 'api'], age: '37m ago' },
        { key: 'purchase-funnel', title: 'Wire the purchase funnel dashboard', description: 'Analysts need one view from product impression through paid order. Join the settled event names and call out late-arriving payments.', status: 'doing', priority: 'normal', category: 'analytics', story: 'checkout', assignee: 'Priya Shah', labels: ['analytics'], age: '1h ago' },
        { key: 'payment-retry', title: 'Retry payment confirmation safely', description: 'A network retry can duplicate the confirmation request. Reuse the idempotency key and surface the original result.', status: 'doing', priority: 'urgent', category: 'reliability', story: 'checkout', assignee: 'Diego Park', labels: ['payments', 'reliability'], age: '2h ago' },
        { key: 'search-refinements', title: 'Ship search refinements', description: 'The refined search keeps selected facets while results stream in. Product and analytics signed off on the release slice.', status: 'done', priority: 'high', category: 'product', story: 'discovery', assignee: 'Maya Chen', labels: ['search', 'shipped'], age: '4h ago' },
        { key: 'mobile-cards', title: 'Polish mobile product cards', description: 'Long product names now hold a consistent two-line height. Sale badges and swatches no longer shift the add button.', status: 'done', priority: 'normal', category: 'product', story: 'discovery', assignee: 'Jonah Reed', labels: ['mobile', 'ux'], age: 'yesterday' },
        { key: 'receipt-tax-copy', title: 'Explain estimated tax on receipts', description: 'Pending receipts implied that estimated tax was final. The revised copy distinguishes authorization from settlement.', status: 'done', priority: 'low', category: 'content', story: 'checkout', assignee: 'Noor Hassan', labels: ['content', 'tax'], age: 'yesterday' },
        { key: 'winter-promotion', title: 'Retire the winter promotion', description: 'The seasonal landing page and coupon have expired. Remove the campaign entry points while keeping the report available.', status: 'done', priority: 'low', category: 'content', story: 'discovery', assignee: 'Eli Brooks', labels: ['campaign', 'cleanup'], age: '3d ago', archived: true },
        { key: 'legacy-coupon', title: 'Remove the legacy coupon banner', description: 'The old banner still appears on bookmarked sale URLs. Redirect those visits to the current offers page.', status: 'done', priority: 'normal', category: 'product', story: 'checkout', assignee: 'Maya Chen', labels: ['checkout', 'cleanup'], age: '5d ago', archived: true },
      ],
    },
    {
      slug: 'acme-fulfillment',
      name: 'Acme Fulfillment',
      stories: [{ key: 'same-day', title: 'Same-day fulfillment', color: 'amber' }],
      tickets: [
        { key: 'stock-reservation', title: 'Protect stock reservations', description: 'Two pickers can reserve the last unit during a short race. Make the reservation atomic and return a clear conflict state.', status: 'todo', priority: 'urgent', category: 'reliability', story: 'same-day', assignee: 'Maya Chen', labels: ['inventory', 'backend'], age: '9m ago' },
        { key: 'carrier-cutoff', title: 'Show the local carrier cutoff', description: 'The checkout promise uses warehouse time instead of the shopper-facing cutoff. Return the correct local message for each region.', status: 'todo', priority: 'high', category: 'product', story: 'same-day', assignee: 'Diego Park', labels: ['shipping', 'checkout'], age: '31m ago' },
        { key: 'pick-list', title: 'Condense the mobile pick list', description: 'Pickers lose the bin location when item names wrap. Keep location and quantity pinned beside each line.', status: 'doing', priority: 'normal', category: 'product', story: 'same-day', assignee: 'Priya Shah', labels: ['warehouse', 'mobile'], age: '58m ago' },
        { key: 'refund-webhook', title: 'Reconcile refund webhooks', description: 'Partial refunds can arrive before the shipment update. Buffer the pair and publish one consistent order state.', status: 'doing', priority: 'high', category: 'analytics', assignee: 'Jonah Reed', labels: ['returns', 'webhooks'], age: '2h ago' },
        { key: 'tracking-email', title: 'Launch shipment tracking email', description: 'The new email groups split shipments and names the next expected scan. Support approved the copy and fallback state.', status: 'done', priority: 'normal', category: 'content', story: 'same-day', assignee: 'Noor Hassan', labels: ['email', 'shipping'], age: 'yesterday' },
        { key: 'carrier-table', title: 'Archive the holiday carrier table', description: 'Holiday exceptions are no longer active. Preserve the decisions in the runbook and remove the table from daily views.', status: 'done', priority: 'low', category: 'content', story: 'same-day', assignee: 'Eli Brooks', labels: ['operations', 'cleanup'], age: '7d ago', archived: true },
      ],
    },
    {
      slug: 'acme-support-desk',
      name: 'Acme Support Desk',
      stories: [],
      tickets: [
        { key: 'vip-tags', title: 'Tag high-value conversations', description: 'Support needs a quiet signal for shoppers with recent high-value orders. Add the tag without exposing order totals in the queue.', status: 'todo', priority: 'low', category: 'analytics', assignee: 'Eli Brooks', labels: ['support', 'crm'], age: '16m ago' },
        { key: 'order-sidebar', title: 'Add order context to the sidebar', description: 'Agents switch tabs to check fulfillment and refund state. Show the latest safe order summary beside the conversation.', status: 'doing', priority: 'high', category: 'product', assignee: 'Maya Chen', labels: ['support', 'orders'], age: '49m ago' },
        { key: 'macro-audit', title: 'Audit delayed-order macros', description: 'Several saved replies still quote the old delivery window. Replace them with the current regional guidance.', status: 'done', priority: 'normal', category: 'content', assignee: 'Diego Park', labels: ['support', 'content'], age: '2d ago' },
      ],
    },
  ],
  categories: [
    { id: 'product', name: 'Product', model: 'sonnet', effort: 'medium' },
    { id: 'analytics', name: 'Analytics', model: 'codex-gpt-5-6-terra', effort: 'high' },
    { id: 'content', name: 'Content', model: 'fable', effort: 'low' },
    { id: 'reliability', name: 'Reliability', model: 'opus', effort: 'xhigh' },
  ],
  comments: {
    'cart-summary': [
      ['Maya Chen', 'The totals line up on desktop, but the tax row wraps on the 360 px checkout.'],
      ['Diego Park', 'The promotion label is keeping its full width. I can wrap that label without changing the tablet grid.'],
      ['Maya Chen', 'Keep the tablet layout as-is. Two lines on mobile are fine if the total stays aligned.'],
      ['Noor Hassan', 'Updated the mobile spec with that constraint. The wallet row uses the same grid now.'],
    ],
    'checkout-events': [
      ['Priya Shah', 'order_complete still fires before the retry settles. The dashboard would count that order twice.'],
      ['Jonah Reed', 'I can move it after settlement and keep recovery_started for the earlier checkpoint.'],
      ['Priya Shah', 'That matches the funnel definition. I added both names to the analytics contract.'],
    ],
    'stock-reservation': [
      ['Eli Brooks', 'The race reproduces when two pick waves open within the same second.'],
      ['Maya Chen', 'Can we lock at the SKU and warehouse pair instead of the whole order?'],
      ['Eli Brooks', 'Yes. That keeps unrelated bins moving and gives us a clean conflict response.'],
    ],
    'order-sidebar': [
      ['Noor Hassan', 'Please hide gift messages and payment details from the sidebar response.'],
      ['Maya Chen', 'Agreed. The first pass only returns shipment, refund, and contact-safe item names.'],
    ],
  },
  links: [
    ['cart-summary', 'blocks', 'express-wallet'],
    ['checkout-events', 'related', 'purchase-funnel'],
    ['stock-reservation', 'blocks', 'pick-list'],
  ],
  reminder: { ticket: 'cart-summary', fireAt: '2030-04-18T09:00:00Z', display: 'Scheduled for Apr 18, 2030, 9:00 AM' },
  dialogUpdated: 'Updated Mar 12, 2026, 10:42 AM',
  dialogStory: 'US-1 · Checkout confidence',
  commentTimes: ['Mar 12, 2026, 9:18 AM', 'Mar 12, 2026, 9:34 AM', 'Mar 12, 2026, 10:03 AM', 'Mar 12, 2026, 10:27 AM'],
  notificationTimes: ['8m', '14m', '21m', '34m', '46m', '1h', '2h'],
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
    ['Checkout confidence', '8 tickets', '$8.72'],
    ['Storefront discovery', '7 tickets', '$5.24'],
    ['Same-day fulfillment', '5 tickets', '$3.18'],
  ],
  sessions: ['demo-alpha-7f3a', 'demo-beta-4c21', 'demo-gamma-9b18'],
});

function fixtureText(value) {
  return JSON.stringify(value);
}

function assertSyntheticFixture() {
  const text = fixtureText(FIXTURE);
  // Only genuinely identifying environment values: paths and the username.
  // Matching every env value false-positives on generic words ("high", "true")
  // that legitimately appear in the fixture.
  const forbidden = [
    process.cwd(), os.userInfo().username, os.homedir(), os.tmpdir(),
    ...Object.values(process.env).filter((value) => typeof value === 'string' && /[\\/]/.test(value)),
  ].filter((value) => typeof value === 'string' && value.length > 3);
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

async function seedSidequest(tempHome, tempRoot) {
  const refs = new Map();
  const projectClis = new Map();
  for (const project of FIXTURE.projects) {
    const fakeProject = path.join(tempRoot, project.slug);
    await mkdir(fakeProject, { recursive: true });
    const env = { ...process.env, SIDEQUEST_HOME: tempHome, CLAUDE_PROJECT_DIR: fakeProject };
    const cli = (args) => command(process.execPath, [sidequestCli, ...args, '--project', fakeProject], { cwd: fakeProject, env });
    projectClis.set(project.slug, cli);
    cli(['board-config', '--name', project.name]);
    for (const category of FIXTURE.categories) {
      cli(['category', 'add', category.id, '--name', category.name, '--route-model', category.model, '--route-effort', category.effort]);
    }
    const stories = new Map();
    for (const story of project.stories) {
      const ref = cli(['story', 'add', '-t', story.title, '--color', story.color]).match(/US-\d+/)?.[0];
      assert.ok(ref, `Could not create the synthetic story ${story.title}`);
      stories.set(story.key, ref);
    }
    for (const ticket of project.tickets) {
      const args = ['add', '-t', ticket.title, '--category', ticket.category, '-p', ticket.priority, '-s', ticket.status, '-d', ticket.description];
      if (ticket.story) args.push('--story', stories.get(ticket.story));
      for (const label of ticket.labels) args.push('-l', label);
      const ref = ticketRef(cli(args));
      refs.set(ticket.key, { ref, slug: project.slug });
      if (ticket.assignee) cli(['assign', ref, '--to', ticket.assignee]);
    }
  }
  for (const [ticketKey, messages] of Object.entries(FIXTURE.comments)) {
    const ticket = refs.get(ticketKey);
    const cli = projectClis.get(ticket.slug);
    for (const [author, body] of messages) cli(['comment', ticket.ref, '-m', body, '--by', author]);
  }
  for (const [sourceKey, verb, targetKey] of FIXTURE.links) {
    const source = refs.get(sourceKey);
    const target = refs.get(targetKey);
    assert.equal(source.slug, target.slug, `Synthetic links must stay on one board: ${sourceKey}`);
    projectClis.get(source.slug)(['link', source.ref, verb, target.ref]);
  }
  const reminder = refs.get(FIXTURE.reminder.ticket);
  projectClis.get(reminder.slug)(['remind', reminder.ref, '--at', FIXTURE.reminder.fireAt]);
  for (const project of FIXTURE.projects) {
    const cli = projectClis.get(project.slug);
    for (const ticket of project.tickets.filter((candidate) => candidate.archived)) cli(['archive', refs.get(ticket.key).ref]);
  }
  return path.join(tempRoot, FIXTURE.project);
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
  </style></head><body><header><span class="mark">◢</span><strong>Grafana</strong><span class="crumb">Dashboards / Observability / Claude Code Usage</span></header><main><h1>Claude Code Usage</h1><p>Acme Webshop synthetic observability data</p><div class="tabs"><span class="active">${htmlEscape(title)}</span><span>Tool activity</span><span>MCP</span><span>Sessions & agents</span><span>Sidequest costs</span></div><div class="cards"><div class="card"><div class="label">Input tokens</div><div class="value orange">3.90M</div></div><div class="card"><div class="label">Output tokens</div><div class="value green">642K</div></div><div class="card"><div class="label">Synthetic cost</div><div class="value blue">$8.72</div></div></div><section class="panel"><h2>${htmlEscape(title)}</h2><p>${htmlEscape(caption)}</p>${table(rows, headers)}</section><div class="note">Demo only. Fixed synthetic records, captured by docs/screenshots/capture.mjs.</div></main></body></html>`;
}

async function captureGrafana(browser, grafanaPort) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${grafanaPort}/d/claude-code-usage`, { waitUntil: 'domcontentloaded' });
  await page.goto('about:blank');
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

async function maskGeneratedBoardText(page) {
  const masks = {
    projectSlugs: FIXTURE.projects.map((project) => project.slug),
    primaryProject: FIXTURE.project,
    ages: Object.fromEntries(FIXTURE.projects.flatMap((project) => project.tickets.map((ticket) => [ticket.title, ticket.age]))),
    dialogUpdated: FIXTURE.dialogUpdated,
    dialogStory: FIXTURE.dialogStory,
    commentTimes: FIXTURE.commentTimes,
    notificationTimes: FIXTURE.notificationTimes,
    reminder: FIXTURE.reminder.display,
  };
  await page.evaluate((fixed) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const pathLike = /^[A-Za-z]:[\\/]|^\/(home|Users|tmp)\//;
    const generatedWorkspace = /toolshed-docs-screenshots-[^ /]+/g;
    const generatedTimestamp = /\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/g;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent.trim();
      if (pathLike.test(text)) {
        const slug = fixed.projectSlugs.find((candidate) => text.includes(candidate)) ?? fixed.primaryProject;
        node.textContent = `~/projects/${slug}`;
        continue;
      }
      node.textContent = node.textContent
        .replace(generatedWorkspace, 'demo-workspace')
        .replace(generatedTimestamp, 'Mar 12, 2026, 10:42 AM');
    }
    for (const card of document.querySelectorAll('[data-tour="ticket-card"]')) {
      const title = card.querySelector('.card-main > strong')?.textContent?.trim();
      const time = card.querySelector('time');
      if (title && time && fixed.ages[title]) time.textContent = fixed.ages[title];
    }
    for (const row of document.querySelectorAll('section.archive article')) {
      const title = row.querySelector('.ticket strong')?.textContent?.trim();
      const time = row.querySelector('time');
      if (title && time && fixed.ages[title]) time.textContent = fixed.ages[title];
    }
    const dialogUpdated = document.querySelector('.dialog-header small');
    if (dialogUpdated?.textContent?.trim().startsWith('Updated')) dialogUpdated.textContent = fixed.dialogUpdated;
    const story = document.querySelector('[role="combobox"][aria-label="Story"] span:first-child');
    if (story?.textContent?.trim() === 'Select an option') story.textContent = fixed.dialogStory;
    document.querySelectorAll('section.comments article time').forEach((time, index) => {
      time.textContent = fixed.commentTimes[index % fixed.commentTimes.length];
    });
    document.querySelectorAll('.notification-list .notification time').forEach((time, index) => {
      time.textContent = fixed.notificationTimes[index % fixed.notificationTimes.length];
    });
    const reminder = document.querySelector('section.reminder .active span');
    if (reminder) reminder.textContent = fixed.reminder;
  }, masks);
}

async function captureSidequest(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'light', deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem('sq_theme', 'light'));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  const skipTour = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skipTour.isVisible()) await skipTour.click();

  const capture = async (filename, fullPage = true) => {
    await maskGeneratedBoardText(page);
    await page.screenshot({ path: path.join(outputDir, filename), fullPage });
  };

  await capture('sidequest-kanban.png');

  await page.getByRole('textbox', { name: 'Search tickets' }).fill('mobile');
  await page.getByRole('button', { name: 'normal', exact: true }).click();
  await capture('sidequest-filtered-board.png');
  await page.getByRole('textbox', { name: 'Search tickets' }).fill('');
  await page.getByRole('button', { name: 'all', exact: true }).click();

  await page.getByRole('button', { name: 'Notifications' }).click();
  await capture('sidequest-notifications.png', false);
  await page.getByRole('button', { name: 'Notifications' }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor();
  await capture('sidequest-settings.png', false);
  await page.getByRole('button', { name: 'Close settings' }).click();

  const secondProject = page.locator('aside[aria-label="Boards"] nav button').filter({ hasText: 'Acme Fulfillment' });
  await secondProject.click();
  await page.getByRole('heading', { name: 'Acme Fulfillment', exact: true }).waitFor();
  await page.waitForTimeout(200);
  await capture('sidequest-second-project.png');

  await page.locator('aside[aria-label="Boards"] nav > button').first().click();
  await page.locator('.archive-button').click();
  await page.getByText('Archived tickets', { exact: true }).waitFor();
  await page.getByText('Archive the holiday carrier table', { exact: true }).waitFor();
  await capture('sidequest-archive.png');
  await page.getByRole('button', { name: 'Back to board' }).click();

  const primaryProject = page.locator('aside[aria-label="Boards"] nav button').filter({ hasText: 'Acme Webshop' });
  await primaryProject.click();
  await page.waitForTimeout(3_000);
  await page.getByText('Build cart summary', { exact: true }).click();
  const category = page.getByRole('combobox', { name: 'Category' });
  assert.match((await category.textContent()) ?? '', /Product/, 'Synthetic ticket detail did not load its board category');
  await capture('sidequest-ticket-detail.png', false);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
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
    await seedSidequest(tempHome, tempRoot);
    server = startSidequest(tempHome, fakeProject, sidequestPort);
    await waitFor(`http://127.0.0.1:${sidequestPort}`, 'Synthetic Sidequest server');
    command('docker', ['create', '--name', container, '--publish', `127.0.0.1:${grafanaPort}:3000`, '--publish', `127.0.0.1:${otlpPort}:4318`, '--volume', `${volume}:/data`, '--env', 'GF_AUTH_ANONYMOUS_ENABLED=true', '--env', 'GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer', 'grafana/otel-lgtm:0.11.0']);
    command('docker', ['cp', path.join(grafanaProvisioning, '.'), `${container}:/otel-lgtm/grafana/conf/provisioning/dashboards`]);
    command('docker', ['cp', path.join(grafanaDashboards, '.'), `${container}:/otel-lgtm/grafana/conf/provisioning/workbench-dashboards`]);
    command('docker', ['start', container]);
    await waitFor(`http://127.0.0.1:${grafanaPort}/api/health`, 'Isolated Grafana');
    browser = await chromium.launch();
    await captureSidequest(browser, sidequestPort);
    await captureGrafana(browser, grafanaPort);
    console.log(`Generated 11 synthetic screenshots in ${outputDir}`);
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
