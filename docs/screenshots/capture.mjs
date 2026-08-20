/*
 * Documentation screenshots use only the fixed FIXTURE below. The privacy gate
 * rejects any fixture text that matches cwd, the OS user, or environment values;
 * temporary paths, ports, and container names are lifecycle-only and never rendered.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
const SYNTHETIC_NOW = Date.parse('2026-08-20T12:00:00.000Z');
const SYNTHETIC_INTERVAL = 10 * 60 * 1_000;
const SYNTHETIC_START = SYNTHETIC_NOW - (23 * 60 * 60 * 1_000);
const SYNTHETIC_BUCKETS = Math.floor((SYNTHETIC_NOW - SYNTHETIC_START) / SYNTHETIC_INTERVAL) + 1;
const { generatedDashboards } = createRequire(import.meta.url)(
  path.join(repoDir, 'plugins', 'observability', 'observability', 'sinks', 'grafana', 'dashboard-generator.js'),
);

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
        { key: 'spring-lookbook', title: 'Archive the spring lookbook', description: 'The spring editorial collection has left the main navigation. Keep its campaign results available while retiring the storefront route.', status: 'done', priority: 'low', category: 'content', story: 'discovery', assignee: 'Noor Hassan', labels: ['campaign', 'content'], age: '9d ago', archived: true },
      ],
    },
    {
      slug: 'acme-fulfillment',
      name: 'Acme Fulfillment',
      stories: [{ key: 'same-day', title: 'Same-day fulfillment', color: 'amber' }],
      tickets: [
        { key: 'stock-reservation', title: 'Protect stock reservations', description: 'Two pickers can reserve the last unit during a short race. Make the reservation atomic and return a clear conflict state.', status: 'todo', priority: 'urgent', category: 'reliability', story: 'same-day', assignee: 'Maya Chen', labels: ['inventory', 'backend'], age: '9m ago' },
        { key: 'carrier-cutoff', title: 'Show the local carrier cutoff', description: 'The checkout promise uses warehouse time instead of the shopper-facing cutoff. Return the correct local message for each region.', status: 'todo', priority: 'high', category: 'product', story: 'same-day', assignee: 'Diego Park', labels: ['shipping', 'checkout'], age: '31m ago' },
        { key: 'mobile-address', title: 'Show mobile address exceptions', description: 'Small screens hide the apartment warning below the sticky action bar. Keep the exception beside the address and preserve the corrected value.', status: 'todo', priority: 'normal', category: 'product', story: 'same-day', assignee: 'Noor Hassan', labels: ['mobile', 'shipping'], age: '44m ago' },
        { key: 'pick-list', title: 'Condense the mobile pick list', description: 'Pickers lose the bin location when item names wrap. Keep location and quantity pinned beside each line.', status: 'doing', priority: 'normal', category: 'product', story: 'same-day', assignee: 'Priya Shah', labels: ['warehouse', 'mobile'], age: '58m ago' },
        { key: 'refund-webhook', title: 'Reconcile refund webhooks', description: 'Partial refunds can arrive before the shipment update. Buffer the pair and publish one consistent order state.', status: 'done', priority: 'high', category: 'analytics', assignee: 'Jonah Reed', labels: ['returns', 'webhooks'], age: '2h ago' },
        { key: 'mobile-packing', title: 'Summarize mobile packing exceptions', description: 'Supervisors need a compact list of skipped scans while walking the floor. Group exceptions by wave and keep the affected bin visible.', status: 'doing', priority: 'normal', category: 'analytics', story: 'same-day', assignee: 'Eli Brooks', labels: ['mobile', 'warehouse'], age: '2h ago' },
        { key: 'scan-timeout', title: 'Recover stalled dock scans', description: 'A scanner that wakes from sleep can leave the loading task pending forever. Expire the old attempt and let the operator retry the same carton.', status: 'doing', priority: 'urgent', category: 'reliability', story: 'same-day', assignee: 'Diego Park', labels: ['warehouse', 'reliability'], age: '3h ago' },
        { key: 'tracking-email', title: 'Launch shipment tracking email', description: 'The new email groups split shipments and names the next expected scan. Support approved the copy and fallback state.', status: 'done', priority: 'normal', category: 'content', story: 'same-day', assignee: 'Noor Hassan', labels: ['email', 'shipping'], age: 'yesterday' },
        { key: 'mobile-dock', title: 'Finish the mobile dock dashboard', description: 'Dock leads can now see late trailers and open doors without pinching the desktop table. The final pass keeps status colors readable outdoors.', status: 'done', priority: 'normal', category: 'analytics', story: 'same-day', assignee: 'Priya Shah', labels: ['mobile', 'analytics'], age: '2d ago' },
        { key: 'carrier-table', title: 'Archive the holiday carrier table', description: 'Holiday exceptions are no longer active. Preserve the decisions in the runbook and remove the table from daily views.', status: 'done', priority: 'low', category: 'content', story: 'same-day', assignee: 'Eli Brooks', labels: ['operations', 'cleanup'], age: '7d ago', archived: true },
        { key: 'overnight-promise', title: 'Retire the overnight promise test', description: 'The regional promise experiment has ended. Save its result and remove the stale assignment rule from fulfillment planning.', status: 'done', priority: 'normal', category: 'analytics', story: 'same-day', assignee: 'Jonah Reed', labels: ['shipping', 'experiment'], age: '11d ago', archived: true },
        { key: 'gift-wrap-station', title: 'Close the gift-wrap station pilot', description: 'The pilot finished with a smaller permanent station plan. Archive the temporary queue and keep the staffing notes with the decision.', status: 'done', priority: 'low', category: 'content', assignee: 'Maya Chen', labels: ['warehouse', 'pilot'], age: '14d ago', archived: true },
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
        { key: 'refund-macro', title: 'Archive the refund delay macro', description: 'The payments migration removed the delay this reply described. Keep the response history and retire it from the agent picker.', status: 'done', priority: 'low', category: 'content', assignee: 'Noor Hassan', labels: ['support', 'cleanup'], age: '8d ago', archived: true },
        { key: 'legacy-inbox', title: 'Retire the legacy priority inbox', description: 'The unified queue now owns every escalation path. Archive the old inbox rules after preserving the weekly volume comparison.', status: 'done', priority: 'normal', category: 'analytics', assignee: 'Priya Shah', labels: ['support', 'analytics'], age: '12d ago', archived: true },
        { key: 'courier-script', title: 'Close the courier callback script', description: 'Carriers now send structured delay updates directly. Remove the manual callback script while retaining its escalation contacts.', status: 'done', priority: 'low', category: 'product', assignee: 'Jonah Reed', labels: ['support', 'shipping'], age: '16d ago', archived: true },
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
  sessions: ['demo-alpha-7f3a', 'demo-beta-4c21', 'demo-gamma-9b18'],
});

function fixtureText(value) {
  return JSON.stringify(value);
}

function assertSyntheticFixture() {
  const text = fixtureText(FIXTURE);
  const tickets = FIXTURE.projects.flatMap((project) => project.tickets);
  // Only genuinely identifying environment values: paths and the username.
  // Matching every env value false-positives on generic words ("high", "true")
  // that legitimately appear in the fixture.
  const forbidden = [
    process.cwd(), os.userInfo().username, os.homedir(), os.tmpdir(),
    ...Object.values(process.env).filter((value) => typeof value === 'string' && /[\\/]/.test(value)),
  ].filter((value) => typeof value === 'string' && value.length > 3);
  assert.match(text, /acme-webshop/);
  assert.equal(FIXTURE.projects.length, 3);
  assert.equal(tickets.filter((ticket) => !ticket.archived).length, 25);
  assert.equal(tickets.filter((ticket) => ticket.archived).length, 9);
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

function otlpValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: String(value) };
}

function otlpAttributes(attributes) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function syntheticLog(serviceName, eventName, attributes, timestamp) {
  return {
    serviceName,
    record: {
      timeUnixNano: String(BigInt(timestamp) * 1_000_000n),
      body: { stringValue: eventName },
      attributes: otlpAttributes(attributes),
    },
  };
}

function groupedLogs(records) {
  const byService = new Map();
  for (const { serviceName, record } of records) {
    const serviceRecords = byService.get(serviceName) || [];
    serviceRecords.push(record);
    byService.set(serviceName, serviceRecords);
  }
  return {
    resourceLogs: [...byService].map(([serviceName, logRecords]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeLogs: [{ scope: { name: 'toolshed-docs-fixture' }, logRecords }],
    })),
  };
}

async function postOtlp(otlpPort, signal, payload) {
  const response = await fetch(`http://127.0.0.1:${otlpPort}/v1/${signal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.ok, true, `Synthetic OTLP ${signal} export failed: ${response.status} ${response.statusText}`);
}

async function seedGrafana(otlpPort) {
  const projects = [
    { name: 'acme-webshop', factor: 1 },
    { name: 'acme-fulfillment', factor: 0.58 },
    { name: 'acme-support-desk', factor: 0.34 },
  ];
  const models = [
    { name: 'claude-sonnet-5', role: 'orchestrator', input: 80_000, output: 9_000, cacheRead: 24_000, context: 115_000 },
    { name: 'claude-opus-5', role: 'orchestrator', input: 45_000, output: 6_000, cacheRead: 15_000, context: 90_000 },
    { name: 'gpt-5.6-terra', role: 'executor', input: 100_000, output: 10_000, cacheRead: 30_000, context: 130_000 },
  ];
  const timestamps = Array.from({ length: SYNTHETIC_BUCKETS }, (_, index) => SYNTHETIC_START + (index * SYNTHETIC_INTERVAL));
  const workloadAt = (timestamp, index) => {
    const hour = new Date(timestamp).getUTCHours();
    const workingHours = hour >= 7 && hour < 19;
    const wave = 0.78 + ((Math.sin(index * 0.83) + 1) * 0.36);
    const peak = index % 37 === 11 ? 1.7 : index % 53 === 29 ? 1.4 : 1;
    return (workingHours ? 1.45 : 0.24) * wave * peak;
  };
  const records = [];
  for (const [index, timestamp] of timestamps.entries()) {
    let eventOffset = 0;
    const eventTimestamp = () => timestamp + (eventOffset++ * 1_000);
    const workload = workloadAt(timestamp, index);
    for (const project of projects) {
      for (const model of models) {
        const scale = workload * project.factor;
        records.push(syntheticLog('workbench-observer', 'gateway.token.usage', {
          'workbench.attribute.project_name': project.name,
          'workbench.attribute.model': model.name,
          'workbench.attribute.agent_role': model.role,
          'workbench.attribute.session_id': `synthetic-session-${index + 1}`,
          'workbench.measurement.input_tokens.value': Math.round(model.input * scale),
          'workbench.measurement.output_tokens.value': Math.round(model.output * scale),
          'workbench.measurement.cache_read_tokens.value': Math.round(model.cacheRead * scale),
          'workbench.measurement.context_tokens.value': Math.round(model.context * scale),
        }, eventTimestamp()));
      }
    }
    const primaryAttributes = { 'workbench.attribute.project_name': FIXTURE.project };
    const toolCalls = Math.max(2, Math.round(workload * 4));
    for (let call = 0; call < toolCalls; call += 1) {
      const failed = call === 0 && index % 17 === 3;
      records.push(syntheticLog('workbench-observer', 'hook.post_tool_use', {
        ...primaryAttributes,
        'workbench.attribute.status': failed ? 'error' : 'success',
        'workbench.attribute.tool_name': ['Read', 'Search', 'Terminal', 'Browser'][call % 4],
      }, eventTimestamp()));
    }
    if (index % 13 === 4) {
      records.push(syntheticLog('workbench-observer', 'claude_code.hook_execution_complete', {
        ...primaryAttributes,
        'workbench.attribute.status': 'failed',
        'workbench.attribute.hook_name': 'post_tool_use',
      }, eventTimestamp()));
    }
    if (index % 12 === 7) {
      records.push(syntheticLog('codex-gateway', 'gateway request throttled briefly', {}, eventTimestamp()));
    } else {
      records.push(syntheticLog('codex-gateway', 'gateway request completed', {}, eventTimestamp()));
    }
    const rechargeTools = [
      ['all', Math.max(1, Math.round(workload * 3)), 0, 0],
      ['Read', 0, 18_000, 44_000],
      ['Search', 0, 11_000, 27_000],
      ['Terminal', 0, 8_000, 20_000],
      ['Browser', 0, 6_000, 15_000],
    ];
    for (const [toolName, assistantTurns, resultBytes, weightedResultBytes] of rechargeTools) {
      const scale = workload * (toolName === 'all' ? 1 : 0.75);
      records.push(syntheticLog('workbench-observer', 'workbench.recharge_rollup', {
        ...primaryAttributes,
        'workbench.attribute.tool_name': toolName,
        'workbench.measurement.assistant_turns.value': assistantTurns,
        'workbench.measurement.tool_result_bytes.value': Math.round(resultBytes * scale),
        'workbench.measurement.recharge_weighted_tool_result_bytes.value': Math.round(weightedResultBytes * scale),
      }, eventTimestamp()));
    }
  }
  const healthTimestamp = SYNTHETIC_NOW + (30 * 1_000);
  let healthOffset = 0;
  const healthEventTimestamp = () => healthTimestamp + (healthOffset++ * 1_000);
  const healthAttributes = { 'workbench.attribute.project_name': FIXTURE.project };
  for (const model of models) {
    records.push(syntheticLog('workbench-observer', 'gateway.token.usage', {
      ...healthAttributes,
      'workbench.attribute.model': model.name,
      'workbench.attribute.agent_role': model.role,
      'workbench.attribute.session_id': 'synthetic-session-current',
      'workbench.measurement.input_tokens.value': Math.round(model.input * 1.2),
      'workbench.measurement.output_tokens.value': Math.round(model.output * 1.2),
      'workbench.measurement.cache_read_tokens.value': Math.round(model.cacheRead * 1.2),
      'workbench.measurement.context_tokens.value': Math.round(model.context * 1.2),
    }, healthEventTimestamp()));
  }
  for (let call = 0; call < 5; call += 1) {
    records.push(syntheticLog('workbench-observer', 'hook.post_tool_use', {
      ...healthAttributes,
      'workbench.attribute.status': call === 0 ? 'error' : 'success',
      'workbench.attribute.tool_name': ['Read', 'Search', 'Terminal', 'Browser', 'Read'][call],
    }, healthEventTimestamp()));
  }
  records.push(syntheticLog('codex-gateway', 'gateway request completed', {}, healthEventTimestamp()));
  const healthRecharge = [
    ['all', 4, 0, 0],
    ['Read', 0, 20_000, 50_000],
    ['Search', 0, 12_000, 30_000],
    ['Terminal', 0, 9_000, 22_000],
    ['Browser', 0, 7_000, 17_000],
  ];
  for (const [toolName, assistantTurns, resultBytes, weightedResultBytes] of healthRecharge) {
    records.push(syntheticLog('workbench-observer', 'workbench.recharge_rollup', {
      ...healthAttributes,
      'workbench.attribute.tool_name': toolName,
      'workbench.measurement.assistant_turns.value': assistantTurns,
      'workbench.measurement.tool_result_bytes.value': resultBytes,
      'workbench.measurement.recharge_weighted_tool_result_bytes.value': weightedResultBytes,
    }, healthEventTimestamp()));
  }
  for (const timestamp of timestamps) {
    const bucketStart = BigInt(timestamp) * 1_000_000n;
    const bucketEnd = BigInt(timestamp + SYNTHETIC_INTERVAL) * 1_000_000n;
    const bucketRecords = records.filter(({ record }) => {
      const recordTimestamp = BigInt(record.timeUnixNano);
      return recordTimestamp >= bucketStart && recordTimestamp < bucketEnd;
    });
    await postOtlp(otlpPort, 'logs', groupedLogs(bucketRecords));
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const healthRecords = records.filter(({ record }) => BigInt(record.timeUnixNano) >= BigInt(healthTimestamp) * 1_000_000n);
  await postOtlp(otlpPort, 'logs', groupedLogs(healthRecords));
  const metricDataPoints = Array.from({ length: 10 }, (_, index) => ({
    asInt: String((index + 1) * 25_000),
    startTimeUnixNano: String(BigInt(SYNTHETIC_NOW - (5 * 60 * 1_000)) * 1_000_000n),
    timeUnixNano: String(BigInt(SYNTHETIC_NOW - ((4 - (index * 0.4)) * 60 * 1_000)) * 1_000_000n),
    attributes: otlpAttributes({ model: 'claude-sonnet-5', type: 'input', project_id: FIXTURE.project }),
  }));
  await postOtlp(otlpPort, 'metrics', {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          { key: 'project.id', value: { stringValue: FIXTURE.project } },
        ],
      },
      scopeMetrics: [{
        scope: { name: 'toolshed-docs-fixture' },
        metrics: [{
          name: 'claude_code.token.usage',
          unit: 'tokens',
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: metricDataPoints,
          },
        }],
      }],
    }],
  });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

async function writeGrafanaDashboards(tempRoot) {
  const dashboardDirectory = path.join(tempRoot, 'workbench-dashboards');
  await mkdir(dashboardDirectory, { recursive: true });
  const projects = [
    { project_id: 'a'.repeat(64), project_name: 'acme-webshop' },
    { project_id: 'b'.repeat(64), project_name: 'acme-fulfillment' },
    { project_id: 'c'.repeat(64), project_name: 'acme-support-desk' },
  ];
  const statSeriesNames = new Map([
    ['Claude metric samples, 5m', 'Claude metric samples'],
    ['Observer records, 5m', 'Observer records'],
    ['Gateway records, 5m', 'Gateway records'],
  ]);
  for (const { fileName, dashboard } of generatedDashboards(projects)) {
    for (const panel of dashboard.panels) {
      const seriesName = statSeriesNames.get(panel.title);
      if (!seriesName) continue;
      panel.fieldConfig.defaults.displayName = seriesName;
      for (const target of panel.targets || []) target.legendFormat = seriesName;
    }
    await writeFile(path.join(dashboardDirectory, fileName), `${JSON.stringify(dashboard, null, 2)}\n`);
  }
  return dashboardDirectory;
}

async function dashboardRowBounds(page, title) {
  const titleButton = page.getByTestId(`data-testid dashboard-row-title-${title}`);
  await titleButton.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const rowHeaders = await page.locator('[data-testid^="data-testid dashboard-row-title-"]').evaluateAll((elements) => elements.map((element) => {
    const row = element.closest('.react-grid-item');
    const bounds = row?.getBoundingClientRect();
    return bounds ? { top: bounds.top, bottom: bounds.bottom } : null;
  }).filter(Boolean));
  const currentHeader = await titleButton.locator('xpath=ancestor::*[contains(@class, "react-grid-item")][1]').boundingBox();
  assert.ok(currentHeader, `Could not measure Grafana row header ${title}`);
  const nextTop = rowHeaders.find(({ top }) => top > currentHeader.y + 1)?.top ?? null;
  const items = await page.locator('.react-grid-item').evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, text: element.innerText };
  }));
  const rowItems = items.filter(({ y }) => y >= currentHeader.y - 1 && (nextTop === null || y < nextTop - 1));
  assert.ok(rowItems.length > 0, `Could not find panels in Grafana row ${title}`);
  return {
    bounds: {
      x: Math.min(...rowItems.map(({ x }) => x)),
      y: Math.min(...rowItems.map(({ y }) => y)),
      width: Math.max(...rowItems.map(({ right }) => right)) - Math.min(...rowItems.map(({ x }) => x)),
      height: Math.max(...rowItems.map(({ bottom }) => bottom)) - Math.min(...rowItems.map(({ y }) => y)),
    },
    text: rowItems.map(({ text }) => text).join('\n'),
  };
}

async function captureGrafana(browser, grafanaPort) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  const from = encodeURIComponent(new Date(SYNTHETIC_NOW - (23 * 60 * 60 * 1_000)).toISOString());
  const to = encodeURIComponent(new Date(SYNTHETIC_NOW + 60_000).toISOString());
  await page.goto(`http://127.0.0.1:${grafanaPort}/d/claude-code-usage?from=${from}&to=${to}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  await page.evaluate(() => document.fonts.ready);
  const captures = [
    ['observability-at-a-glance.png', 'At a glance'],
    ['observability-where-the-spend-goes.png', 'Where the spend goes'],
    ['observability-failures-and-source-activity.png', 'Failures and source activity'],
    ['observability-context-recharge.png', 'Context recharge'],
  ];
  for (const [file, title] of captures) {
    const { bounds, text } = await dashboardRowBounds(page, title);
    assert.doesNotMatch(text, /No data|No samples in|Query failed/i, `Grafana row ${title} did not render data: ${text}`);
    await page.screenshot({ path: path.join(outputDir, file), clip: bounds });
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'light', reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem('sq_theme', 'light'));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  const skipTour = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skipTour.isVisible()) await skipTour.click();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const capture = async (filename, content) => {
    await maskGeneratedBoardText(page);
    await content.waitFor();
    const contentBounds = await content.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(contentBounds, `Could not measure screenshot content for ${filename}`);
    assert.ok(viewport, `Could not read screenshot viewport for ${filename}`);
    const contentHeight = Math.min(viewport.height, Math.ceil(contentBounds.y + contentBounds.height + 24));
    await page.screenshot({
      path: path.join(outputDir, filename),
      clip: { x: 0, y: 0, width: viewport.width, height: contentHeight },
    });
  };

  const board = page.locator('.board');
  await capture('sidequest-kanban.png', board);

  await page.getByRole('textbox', { name: 'Search tickets' }).fill('mobile');
  const priorityFilter = page.locator('[aria-label="Priority filter"]');
  const normalPriority = priorityFilter.getByRole('button', { name: 'normal', exact: true });
  await normalPriority.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Priority filter"] button.active')?.textContent?.trim() === 'normal');
  assert.equal(await board.locator('[data-tour="ticket-card"]').count(), 6, 'Synthetic mobile and normal filters did not produce six cards');
  await capture('sidequest-filtered-board.png', board);
  await page.getByRole('textbox', { name: 'Search tickets' }).fill('');
  await priorityFilter.getByRole('button', { name: 'all', exact: true }).click();

  await page.getByRole('button', { name: 'Notifications' }).click();
  const notificationInbox = page.locator('section.inbox');
  await notificationInbox.evaluate((element) => { element.style.height = `${Math.ceil(element.getBoundingClientRect().height)}px`; });
  await capture('sidequest-notifications.png', notificationInbox);
  await page.getByRole('button', { name: 'Notifications' }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await settingsDialog.waitFor();
  await capture('sidequest-settings.png', settingsDialog);
  await page.getByRole('button', { name: 'Close settings' }).click();

  const secondProject = page.locator('aside[aria-label="Boards"] nav button').filter({ hasText: 'Acme Fulfillment' });
  await secondProject.click();
  await page.getByRole('heading', { name: 'Acme Fulfillment', exact: true }).waitFor();
  await page.waitForTimeout(200);
  assert.equal(await board.locator('[data-tour="ticket-card"]').count(), 9, 'Synthetic Fulfillment board did not render nine active tickets');
  await capture('sidequest-second-project.png', board);

  await page.locator('aside[aria-label="Boards"] nav > button').first().click();
  await page.locator('.archive-button').click();
  const archive = page.locator('section.archive');
  await page.getByText('Archived tickets', { exact: true }).waitFor();
  await page.getByText('Archive the holiday carrier table', { exact: true }).waitFor();
  assert.equal(await archive.locator('article').count(), 9, 'Synthetic archive did not render nine tickets');
  await capture('sidequest-archive.png', archive);
  await page.getByRole('button', { name: 'Back to board' }).click();

  const primaryProject = page.locator('aside[aria-label="Boards"] nav button').filter({ hasText: 'Acme Webshop' });
  await primaryProject.click();
  await page.waitForTimeout(3_000);
  await page.getByText('Build cart summary', { exact: true }).click();
  const category = page.getByRole('combobox', { name: 'Category' });
  assert.match((await category.textContent()) ?? '', /Product/, 'Synthetic ticket detail did not load its board category');
  await capture('sidequest-ticket-detail.png', page.getByRole('dialog'));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.close();
}

async function main() {
  assertSyntheticFixture();
  await mkdir(outputDir, { recursive: true });
  for (const file of [
    'observability-tokens-models.png',
    'observability-mcp.png',
    'observability-who-is-burning.png',
    'observability-board-costs.png',
  ]) await rm(path.join(outputDir, file), { force: true });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'toolshed-docs-screenshots-'));
  const tempHome = path.join(tempRoot, 'sidequest-home');
  const fakeProject = path.join(tempRoot, FIXTURE.project);
  const dashboardDirectory = await writeGrafanaDashboards(tempRoot);
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
    command('docker', ['cp', `${grafanaProvisioning}/.`, `${container}:/otel-lgtm/grafana/conf/provisioning/dashboards`]);
    command('docker', ['cp', dashboardDirectory, `${container}:/otel-lgtm/grafana/conf/provisioning`]);
    command('docker', ['start', container]);
    await waitFor(`http://127.0.0.1:${grafanaPort}/api/health`, 'Isolated Grafana');
    await waitFor(`http://127.0.0.1:${grafanaPort}/api/dashboards/uid/claude-code-usage`, 'Synthetic Grafana dashboard');
    await seedGrafana(otlpPort);
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
