/*
 * Documentation screenshots use only the fixed FIXTURE below. The privacy gate
 * rejects any fixture text that matches cwd, the OS user, or environment values;
 * temporary paths, ports, and container names are lifecycle-only and never rendered.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, '..');
const repoDir = path.resolve(docsDir, '..');
const outputDir = path.join(docsDir, 'src', 'assets', 'screenshots');
const sidequestCli = path.join(repoDir, 'plugins', 'sidequest', 'bin', 'sidequest.js');
const grafanaProvisioning = path.join(repoDir, 'plugins', 'observability', 'observability', 'sinks', 'grafana', 'provisioning');
const SYNTHETIC_NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const SYNTHETIC_INTERVAL = 10 * 60 * 1_000;
const SYNTHETIC_START = SYNTHETIC_NOW - (23 * 60 * 60 * 1_000);
const SYNTHETIC_QUERY_START = SYNTHETIC_START - (60 * 1_000);
const SYNTHETIC_BUCKETS = Math.floor((SYNTHETIC_NOW - SYNTHETIC_START) / SYNTHETIC_INTERVAL) + 1;
const FIXTURE_WORKLOAD_START_HOUR = 13;
const { generatedDashboards } = createRequire(import.meta.url)(
  path.join(repoDir, 'plugins', 'observability', 'observability', 'sinks', 'grafana', 'dashboard-generator.js'),
);
const { MODEL_PRICES_PER_MILLION, gatewayModelCostTargets, gatewayTotalCostExpression } = createRequire(import.meta.url)(
  path.join(repoDir, 'plugins', 'observability', 'observability', 'sinks', 'grafana', 'model-prices.js'),
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
        { key: 'cart-summary', title: 'Build cart summary', description: 'The new summary keeps discounts, shipping, tax, and the final total in one stable grid. Mobile can wrap promotion labels, but totals must stay aligned.', status: 'doing', priority: 'urgent', category: 'product', story: 'checkout', assignee: null, labels: ['checkout', 'cart'], files: ['src/checkout/CartSummary.tsx', 'src/checkout/cart-summary.css'], images: ['checkout-flow.svg', 'mobile-checkout.svg', 'order-confirmation.svg'], age: '18m ago' },
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
      stories: [
        { key: 'same-day', title: 'Same-day fulfillment', color: 'amber' },
        { key: 'warehouse-flow', title: 'Warehouse flow', color: 'steel' },
        { key: 'carrier-promises', title: 'Carrier promises', color: 'green' },
      ],
      tickets: [
        { key: 'stock-reservation', title: 'Protect stock reservations', description: 'Two pickers can reserve the last unit during a short race. Make the reservation atomic and return a clear conflict state.', status: 'todo', priority: 'urgent', category: 'reliability', story: 'same-day', assignee: 'Maya Chen', labels: ['inventory', 'backend'], age: '9m ago' },
        { key: 'carrier-cutoff', title: 'Show the local carrier cutoff', description: 'The checkout promise uses warehouse time instead of the shopper-facing cutoff. Return the correct local message for each region.', status: 'todo', priority: 'high', category: 'product', story: 'carrier-promises', assignee: 'Diego Park', labels: ['shipping', 'checkout'], age: '31m ago' },
        { key: 'mobile-address', title: 'Show mobile address exceptions', description: 'Small screens hide the apartment warning below the sticky action bar. Keep the exception beside the address and preserve the corrected value.', status: 'todo', priority: 'normal', category: 'product', story: 'carrier-promises', assignee: 'Noor Hassan', labels: ['mobile', 'shipping'], age: '44m ago' },
        { key: 'pick-list', title: 'Condense the mobile pick list', description: 'Pickers lose the bin location when item names wrap. Keep location and quantity pinned beside each line.', status: 'doing', priority: 'normal', category: 'product', story: 'warehouse-flow', assignee: 'Priya Shah', labels: ['warehouse', 'mobile'], age: '58m ago' },
        { key: 'refund-webhook', title: 'Reconcile refund webhooks', description: 'Partial refunds can arrive before the shipment update. Buffer the pair and publish one consistent order state.', status: 'done', priority: 'high', category: 'analytics', assignee: 'Jonah Reed', labels: ['returns', 'webhooks'], age: '2h ago' },
        { key: 'mobile-packing', title: 'Summarize mobile packing exceptions', description: 'Supervisors need a compact list of skipped scans while walking the floor. Group exceptions by wave and keep the affected bin visible.', status: 'doing', priority: 'normal', category: 'analytics', story: 'warehouse-flow', assignee: 'Eli Brooks', labels: ['mobile', 'warehouse'], age: '2h ago' },
        { key: 'scan-timeout', title: 'Recover stalled dock scans', description: 'A scanner that wakes from sleep can leave the loading task pending forever. Expire the old attempt and let the operator retry the same carton.', status: 'doing', priority: 'urgent', category: 'reliability', story: 'warehouse-flow', assignee: 'Diego Park', labels: ['warehouse', 'reliability'], age: '3h ago' },
        { key: 'tracking-email', title: 'Launch shipment tracking email', description: 'The new email groups split shipments and names the next expected scan. Support approved the copy and fallback state.', status: 'done', priority: 'normal', category: 'content', story: 'carrier-promises', assignee: 'Noor Hassan', labels: ['email', 'shipping'], age: 'yesterday' },
        { key: 'mobile-dock', title: 'Finish the mobile dock dashboard', description: 'Dock leads can now see late trailers and open doors without pinching the desktop table. The final pass keeps status colors readable outdoors.', status: 'done', priority: 'normal', category: 'analytics', story: 'warehouse-flow', assignee: 'Priya Shah', labels: ['mobile', 'analytics'], age: '2d ago' },
        { key: 'carrier-table', title: 'Archive the holiday carrier table', description: 'Holiday exceptions are no longer active. Preserve the decisions in the runbook and remove the table from daily views.', status: 'done', priority: 'low', category: 'content', story: 'same-day', assignee: 'Eli Brooks', labels: ['operations', 'cleanup'], age: '7d ago', archived: true },
        { key: 'overnight-promise', title: 'Retire the overnight promise test', description: 'The regional promise experiment has ended. Save its result and remove the stale assignment rule from fulfillment planning.', status: 'done', priority: 'normal', category: 'analytics', story: 'same-day', assignee: 'Jonah Reed', labels: ['shipping', 'experiment'], age: '11d ago', archived: true },
        { key: 'gift-wrap-station', title: 'Close the gift-wrap station pilot', description: 'The pilot finished with a smaller permanent station plan. Archive the temporary queue and keep the staffing notes with the decision.', status: 'done', priority: 'low', category: 'content', assignee: 'Maya Chen', labels: ['warehouse', 'pilot'], age: '14d ago', archived: true },
      ],
    },
    {
      slug: 'acme-support-desk',
      name: 'Acme Support Desk',
      stories: [
        { key: 'agent-workbench', title: 'Agent workbench', color: 'teal' },
        { key: 'service-recovery', title: 'Service recovery', color: 'rose' },
      ],
      tickets: [
        { key: 'vip-tags', title: 'Tag high-value conversations', description: 'Support needs a quiet signal for shoppers with recent high-value orders. Add the tag without exposing order totals in the queue.', status: 'todo', priority: 'low', category: 'analytics', story: 'agent-workbench', assignee: 'Eli Brooks', labels: ['support', 'crm'], age: '16m ago' },
        { key: 'order-sidebar', title: 'Add order context to the sidebar', description: 'Agents switch tabs to check fulfillment and refund state. Show the latest safe order summary beside the conversation.', status: 'doing', priority: 'high', category: 'product', story: 'agent-workbench', assignee: 'Maya Chen', labels: ['support', 'orders'], age: '49m ago' },
        { key: 'macro-audit', title: 'Audit delayed-order macros', description: 'Several saved replies still quote the old delivery window. Replace them with the current regional guidance.', status: 'done', priority: 'normal', category: 'content', story: 'service-recovery', assignee: 'Diego Park', labels: ['support', 'content'], age: '2d ago' },
        { key: 'refund-macro', title: 'Archive the refund delay macro', description: 'The payments migration removed the delay this reply described. Keep the response history and retire it from the agent picker.', status: 'done', priority: 'low', category: 'content', story: 'service-recovery', assignee: 'Noor Hassan', labels: ['support', 'cleanup'], age: '8d ago', archived: true },
        { key: 'legacy-inbox', title: 'Retire the legacy priority inbox', description: 'The unified queue now owns every escalation path. Archive the old inbox rules after preserving the weekly volume comparison.', status: 'done', priority: 'normal', category: 'analytics', story: 'agent-workbench', assignee: 'Priya Shah', labels: ['support', 'analytics'], age: '12d ago', archived: true },
        { key: 'courier-script', title: 'Close the courier callback script', description: 'Carriers now send structured delay updates directly. Remove the manual callback script while retaining its escalation contacts.', status: 'done', priority: 'low', category: 'product', story: 'service-recovery', assignee: 'Jonah Reed', labels: ['support', 'shipping'], age: '16d ago', archived: true },
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
      ['Maya Chen', 'The 360 px tax row stays aligned.'],
      ['Diego Park', 'Promotion labels now wrap cleanly.'],
      ['Maya Chen', 'Tablet stays fixed; mobile gets two lines.'],
      ['Noor Hassan', 'Wallet rows now share the same grid.'],
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
    ['search-synonyms', 'related', 'search-refinements'],
    ['stock-reservation', 'blocks', 'pick-list'],
    ['mobile-address', 'related', 'carrier-cutoff'],
    ['vip-tags', 'related', 'order-sidebar'],
  ],
  reminders: [
    { ticket: 'cart-summary', fireAt: '2030-04-18T09:00:00Z', display: 'Scheduled for Apr 18, 2030, 9:00 AM' },
    { ticket: 'order-sidebar', fireAt: '2030-04-18T14:30:00Z', display: 'Scheduled for Apr 18, 2030, 2:30 PM' },
  ],
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
  for (const project of FIXTURE.projects) assert.ok(project.stories.length >= 2, `${project.name} needs multiple synthetic stories`);
  assert.ok(FIXTURE.links.length >= 6, 'Synthetic fixture needs enough links for the dependency capture');
  assert.ok(FIXTURE.reminders.length >= 2, 'Synthetic fixture needs reminders on more than one ticket');
  const cartSummary = tickets.find((ticket) => ticket.key === 'cart-summary');
  assert.deepEqual(cartSummary?.files, ['src/checkout/CartSummary.tsx', 'src/checkout/cart-summary.css']);
  assert.equal(cartSummary?.images?.length, 3, 'Synthetic ticket detail needs enough image attachments to fill the row');
  for (const value of forbidden) assert.equal(text.includes(value), false, `Synthetic fixture contains environment text: ${value}`);
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandName} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function pngPixels(png, pathname) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.subarray(0, signature.length).equals(signature), true, `Screenshot ${pathname} is not a PNG`);
  let offset = signature.length;
  let header;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') header = data;
    if (type === 'IDAT') compressed.push(data);
  }
  assert.ok(header, `Screenshot ${pathname} is missing an IHDR chunk`);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const bytesPerPixel = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  assert.equal(bitDepth, 8, `Screenshot ${pathname} has unsupported bit depth ${bitDepth}`);
  assert.ok(bytesPerPixel > 0, `Screenshot ${pathname} has unsupported color type ${colorType}`);
  assert.equal(header[12], 0, `Screenshot ${pathname} uses unsupported interlacing`);
  const rowLength = width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(compressed));
  assert.equal(filtered.length, height * (rowLength + 1), `Screenshot ${pathname} has an unexpected pixel buffer length`);
  const pixels = Buffer.alloc(rowLength * height);
  let filteredOffset = 0;
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const filter = filtered[filteredOffset++];
    const row = pixels.subarray(rowIndex * rowLength, (rowIndex + 1) * rowLength);
    const previousRow = rowIndex === 0 ? null : pixels.subarray((rowIndex - 1) * rowLength, rowIndex * rowLength);
    for (let column = 0; column < rowLength; column += 1) {
      const filteredValue = filtered[filteredOffset++];
      const left = column >= bytesPerPixel ? row[column - bytesPerPixel] : 0;
      const above = previousRow ? previousRow[column] : 0;
      const upperLeft = previousRow && column >= bytesPerPixel ? previousRow[column - bytesPerPixel] : 0;
      row[column] = filter === 0 ? filteredValue
        : filter === 1 ? (filteredValue + left) & 0xff
          : filter === 2 ? (filteredValue + above) & 0xff
            : filter === 3 ? (filteredValue + Math.floor((left + above) / 2)) & 0xff
              : filter === 4 ? (filteredValue + paethPredictor(left, above, upperLeft)) & 0xff
                : assert.fail(`Screenshot ${pathname} uses unsupported PNG filter ${filter}`);
    }
  }
  return { width, height, bytesPerPixel, pixels };
}

function screenshotsMatch(existing, candidate, pathname) {
  const expected = pngPixels(existing, pathname);
  const actual = pngPixels(candidate, pathname);
  if (expected.width !== actual.width || expected.height !== actual.height || expected.bytesPerPixel !== actual.bytesPerPixel) return false;
  // Chromium occasionally changes a few antialiased pixels between identical captures.
  let difference = 0;
  for (let index = 0; index < expected.pixels.length; index += 1) {
    if (expected.bytesPerPixel === 4 && index % expected.bytesPerPixel === 3) continue;
    const channelDifference = Math.abs(expected.pixels[index] - actual.pixels[index]);
    if (channelDifference > 16) return false;
    difference += channelDifference;
  }
  return difference <= 1_024;
}

async function writeScreenshot(page, pathname, options) {
  const candidatePath = pathname.replace(/\.png$/, '.candidate.png');
  await page.screenshot({ ...options, path: candidatePath });
  let existing;
  try {
    existing = await readFile(pathname);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const candidate = await readFile(candidatePath);
  if (existing && screenshotsMatch(existing, candidate, pathname)) {
    await rm(candidatePath);
    return;
  }
  await rename(candidatePath, pathname);
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
  await writeFile(path.join(tempRoot, 'checkout-flow.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" rx="18" fill="#f8f6f1"/><rect x="18" y="18" width="604" height="324" rx="14" fill="#fff" stroke="#b8b3aa" stroke-width="4"/><circle cx="42" cy="42" r="6" fill="#e67e73"/><circle cx="62" cy="42" r="6" fill="#e0b45a"/><circle cx="82" cy="42" r="6" fill="#77b58a"/><path d="M18 62h604" stroke="#d7d2c9" stroke-width="4"/><text x="44" y="105" fill="#28262c" font-family="Arial,sans-serif" font-size="30" font-weight="700">CART</text><path d="M62 142l30-18 25 18 25-18 30 18-18 42v88H80v-88z" fill="#65a8c7" stroke="#32738f" stroke-width="5"/><text x="194" y="169" fill="#28262c" font-family="Arial,sans-serif" font-size="22" font-weight="700">Weekend shirt</text><text x="194" y="204" fill="#68636c" font-family="Arial,sans-serif" font-size="18">Blue · Medium</text><text x="194" y="246" fill="#28262c" font-family="Arial,sans-serif" font-size="24" font-weight="700">$48</text><rect x="384" y="92" width="208" height="218" rx="12" fill="#f0ece4"/><text x="408" y="132" fill="#28262c" font-family="Arial,sans-serif" font-size="19" font-weight="700">ORDER SUMMARY</text><text x="408" y="177" fill="#68636c" font-family="Arial,sans-serif" font-size="18">Total</text><text x="520" y="177" fill="#28262c" font-family="Arial,sans-serif" font-size="24" font-weight="700">$128</text><rect x="408" y="218" width="160" height="58" rx="10" fill="#5c63a9"/><text x="447" y="255" fill="#fff" font-family="Arial,sans-serif" font-size="20" font-weight="700">CHECKOUT</text></svg>`);
  await writeFile(path.join(tempRoot, 'mobile-checkout.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" rx="18" fill="#e9f2f3"/><rect x="222" y="20" width="196" height="320" rx="28" fill="#272b34"/><rect x="236" y="40" width="168" height="280" rx="18" fill="#fff"/><rect x="286" y="50" width="68" height="7" rx="4" fill="#9b9da3"/><text x="254" y="90" fill="#28262c" font-family="Arial,sans-serif" font-size="22" font-weight="700">Your cart</text><rect x="254" y="110" width="58" height="64" rx="8" fill="#f0c579"/><path d="M270 126l11-7 10 7 11-7 10 7-7 18v25h-28v-25z" fill="#fff"/><rect x="324" y="116" width="58" height="9" rx="4" fill="#424652"/><rect x="324" y="137" width="44" height="8" rx="4" fill="#aaa7a0"/><rect x="324" y="157" width="35" height="8" rx="4" fill="#aaa7a0"/><path d="M254 197h128" stroke="#d7d2c9" stroke-width="3"/><text x="254" y="225" fill="#68636c" font-family="Arial,sans-serif" font-size="16">Total</text><text x="338" y="225" fill="#28262c" font-family="Arial,sans-serif" font-size="19" font-weight="700">$128</text><rect x="254" y="246" width="128" height="45" rx="10" fill="#5c63a9"/><text x="286" y="275" fill="#fff" font-family="Arial,sans-serif" font-size="16" font-weight="700">PAY NOW</text></svg>`);
  await writeFile(path.join(tempRoot, 'order-confirmation.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" rx="18" fill="#f3eee5"/><rect x="155" y="24" width="330" height="312" rx="14" fill="#fff" stroke="#c9c2b6" stroke-width="4"/><circle cx="320" cy="93" r="42" fill="#70b58a"/><path d="M298 93l15 15 31-34" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><text x="220" y="164" fill="#28262c" font-family="Arial,sans-serif" font-size="28" font-weight="700">ORDER CONFIRMED</text><text x="239" y="202" fill="#68636c" font-family="Arial,sans-serif" font-size="19">Receipt #ACM-2048</text><path d="M205 228h230" stroke="#d7d2c9" stroke-width="4"/><text x="205" y="266" fill="#68636c" font-family="Arial,sans-serif" font-size="19">Total paid</text><text x="368" y="266" fill="#28262c" font-family="Arial,sans-serif" font-size="24" font-weight="700">$128</text><rect x="205" y="287" width="230" height="12" rx="6" fill="#dbe7df"/></svg>`);
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
      for (const file of ticket.files ?? []) args.push('--file', file);
      for (const image of ticket.images ?? []) args.push('--image', path.join(tempRoot, image));
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
  for (const reminderDefinition of FIXTURE.reminders) {
    const reminder = refs.get(reminderDefinition.ticket);
    projectClis.get(reminder.slug)(['remind', reminder.ref, '--at', reminderDefinition.fireAt]);
  }
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

function recordAttribute(record, key) {
  const attribute = record.attributes.find((candidate) => candidate.key === key);
  assert.ok(attribute, `Synthetic gateway record is missing ${key}`);
  return Object.values(attribute.value)[0];
}

function expectedGatewayCosts(records) {
  const costs = new Map();
  for (const { record } of records) {
    if (record.body.stringValue !== 'gateway.token.usage') continue;
    const model = String(recordAttribute(record, 'workbench.attribute.model'));
    const prices = MODEL_PRICES_PER_MILLION[model];
    assert.ok(prices, `Synthetic gateway model ${model} is not priced`);
    const cost = (
      (recordAttribute(record, 'workbench.measurement.input_tokens.value') * prices.input)
      + (recordAttribute(record, 'workbench.measurement.output_tokens.value') * prices.output)
      + (recordAttribute(record, 'workbench.measurement.cache_read_tokens.value') * prices.cacheRead)
    ) / 1_000_000;
    costs.set(model, (costs.get(model) ?? 0) + cost);
  }
  return costs;
}

function numericSeries(queryResult) {
  const result = queryResult.data?.result;
  assert.ok(Array.isArray(result), `Grafana datasource query failed: ${JSON.stringify(queryResult)}`);
  return result.map(({ metric, values, value }) => ({
    labels: metric ?? {},
    values: (values ?? [value]).map(([, sample]) => Number(sample)),
  }));
}

function syntheticBucketCounts(queryResult) {
  const result = queryResult.data?.result;
  assert.ok(Array.isArray(result), `Grafana datasource query failed: ${JSON.stringify(queryResult)}`);
  const counts = Array(SYNTHETIC_BUCKETS).fill(0);
  for (const { values = [] } of result) {
    for (const [timestamp] of values) {
      const recordTime = Number(BigInt(timestamp) / 1_000_000n);
      const index = Math.floor((recordTime - SYNTHETIC_START) / SYNTHETIC_INTERVAL);
      if (index >= 0 && index < SYNTHETIC_BUCKETS) counts[index] += 1;
    }
  }
  return counts;
}

async function queryGrafana(grafanaPort, expression, from, to, instant = false) {
  const params = new URLSearchParams({
    query: expression,
    start: String(from / 1_000),
    end: String(to / 1_000),
    step: String(SYNTHETIC_INTERVAL / 1_000),
    limit: '5000',
    direction: 'forward',
  });
  if (instant) params.set('time', String(to / 1_000));
  const endpoint = instant ? 'query' : 'query_range';
  const response = await fetch(`http://127.0.0.1:${grafanaPort}/api/datasources/proxy/uid/loki/loki/api/v1/${endpoint}?${params}`);
  if (!response.ok) throw new Error(`Grafana datasource query failed: ${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json();
}

function singleSeriesValue(series, description) {
  const values = series.values.filter((value) => value !== null);
  assert.equal(values.length, 1, `${description} returned ${values.length} values instead of one`);
  return values[0];
}

async function verifyGrafanaSeed(grafanaPort, expectedCosts) {
  const bucketExpression = '{service_name="workbench-observer"} |= "gateway.token.usage"';
  const totalExpression = gatewayTotalCostExpression('23h2m1ms');
  const modelExpression = gatewayModelCostTargets()[0].expr.replaceAll('$bucket', '23h2m1ms');
  let failure;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const [bucketResult, totalResult, modelResult] = await Promise.all([
        queryGrafana(grafanaPort, bucketExpression, SYNTHETIC_QUERY_START, SYNTHETIC_NOW + 60_000),
        queryGrafana(grafanaPort, totalExpression, SYNTHETIC_NOW + 60_000, SYNTHETIC_NOW + 60_000, true),
        queryGrafana(grafanaPort, modelExpression, SYNTHETIC_NOW + 60_000, SYNTHETIC_NOW + 60_000, true),
      ]);
      const bucketValues = syntheticBucketCounts(bucketResult);
      assert.equal(bucketValues.length, SYNTHETIC_BUCKETS, `Grafana returned ${bucketValues.length} synthetic buckets instead of ${SYNTHETIC_BUCKETS}`);
      for (const [index, value] of bucketValues.entries()) assert.ok(value >= 1, `Synthetic bucket ${index + 1} has no gateway records`);
      const total = singleSeriesValue(numericSeries(totalResult)[0], 'Total spend');
      const expectedTotal = [...expectedCosts.values()].reduce((sum, cost) => sum + cost, 0);
      const actualCosts = new Map(numericSeries(modelResult).map((series) => [series.labels.workbench_attribute_model, singleSeriesValue(series, `Cost for ${series.labels.workbench_attribute_model}`)]));
      assert.equal(actualCosts.size, expectedCosts.size, `Grafana returned ${actualCosts.size} model totals instead of ${expectedCosts.size}`);
      for (const [model, expectedCost] of expectedCosts) {
        const actualCost = actualCosts.get(model);
        assert.ok(actualCost !== undefined, `Grafana did not return a total for ${model}`);
        assert.ok(Math.abs(actualCost - expectedCost) < 0.000001, `Cost for ${model} was $${actualCost.toFixed(6)} instead of $${expectedCost.toFixed(6)}`);
      }
      assert.ok(Math.abs(total - expectedTotal) < 0.000001, `Total spend was $${total.toFixed(6)} instead of $${expectedTotal.toFixed(6)}`);
      console.log(`Verified Grafana seed: Total spend $${total.toFixed(2)}; ${[...expectedCosts].map(([model, cost]) => `${model} $${cost.toFixed(2)}`).join(', ')}`);
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw failure;
}

async function seedGrafana(otlpPort, grafanaPort) {
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
  const hookFailuresByBucket = new Map([[6, 1], [29, 2], [30, 1], [70, 1], [73, 2], [98, 1], [117, 2], [133, 1]]);
  const gatewayFailuresByBucket = new Map([[12, 1], [46, 2], [47, 1], [83, 1], [84, 2], [85, 1], [125, 2], [133, 1]]);
  const droppedBucket = process.env.SYNTHETIC_GRAFANA_DROP_BUCKET;
  const droppedBucketIndex = droppedBucket === undefined ? null : Number(droppedBucket);
  assert.ok(droppedBucketIndex === null || (Number.isInteger(droppedBucketIndex) && droppedBucketIndex >= 0 && droppedBucketIndex < SYNTHETIC_BUCKETS), `SYNTHETIC_GRAFANA_DROP_BUCKET must be an index from 0 to ${SYNTHETIC_BUCKETS - 1}`);
  const workloadAt = (index) => {
    const hour = (FIXTURE_WORKLOAD_START_HOUR + Math.floor((index * SYNTHETIC_INTERVAL) / (60 * 60 * 1_000))) % 24;
    const workingHours = hour >= 7 && hour < 19;
    const wave = 0.78 + ((Math.sin(index * 0.83) + 1) * 0.36);
    const peak = index % 37 === 11 ? 1.7 : index % 53 === 29 ? 1.4 : 1;
    return (workingHours ? 1.45 : 0.24) * wave * peak;
  };
  const records = [];
  for (const [index, timestamp] of timestamps.entries()) {
    let eventOffset = 0;
    const eventTimestamp = () => timestamp + (eventOffset++ * 1_000);
    const workload = workloadAt(index);
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
    for (let failure = 0; failure < (hookFailuresByBucket.get(index) ?? 0); failure += 1) {
      records.push(syntheticLog('workbench-observer', 'claude_code.hook_execution_complete', {
        ...primaryAttributes,
        'workbench.attribute.status': 'failed',
        'workbench.attribute.hook_name': 'post_tool_use',
      }, eventTimestamp()));
    }
    for (let failure = 0; failure < (gatewayFailuresByBucket.get(index) ?? 0); failure += 1) {
      records.push(syntheticLog('codex-gateway', 'gateway request throttled briefly', {}, eventTimestamp()));
    }
    if (!gatewayFailuresByBucket.has(index)) {
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
  const historicalRecordCount = records.length;
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
  for (let request = 0; request < 10; request += 1) {
    records.push(syntheticLog('codex-gateway', 'gateway request completed', {}, healthEventTimestamp()));
  }
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
  const historicalRecords = records.slice(0, historicalRecordCount).filter(({ record }) => {
    const recordTimestamp = Number(BigInt(record.timeUnixNano) / 1_000_000n);
    const index = Math.floor((recordTimestamp - SYNTHETIC_START) / SYNTHETIC_INTERVAL);
    return index !== droppedBucketIndex;
  });
  await postOtlp(otlpPort, 'logs', groupedLogs(historicalRecords));
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const healthRecords = records.slice(historicalRecordCount);
  await postOtlp(otlpPort, 'logs', groupedLogs(healthRecords));
  const metricSampleNow = SYNTHETIC_NOW;
  const metricDataPoints = Array.from({ length: 10 }, (_, index) => ({
    asInt: String((index + 1) * 25_000),
    startTimeUnixNano: String(BigInt(metricSampleNow - (5 * 60 * 1_000)) * 1_000_000n),
    timeUnixNano: String(BigInt(metricSampleNow - ((4 - (index * 0.4)) * 60 * 1_000)) * 1_000_000n),
    attributes: otlpAttributes({
      model: models[index % models.length].name,
      type: ['input', 'output', 'cache_read', 'context'][index % 4],
      project_id: FIXTURE.project,
    }),
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
  await verifyGrafanaSeed(grafanaPort, expectedGatewayCosts(records));
}

async function writeOtelCollectorConfig(tempRoot) {
  const collectorConfig = path.join(tempRoot, 'otelcol-config.yaml');
  await writeFile(collectorConfig, `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  prometheus/collector:
    config:
      scrape_configs:
        - job_name: "opentelemetry-collector"
          scrape_interval: 1s
          static_configs:
            - targets: ["localhost:8888"]

processors:
  batch:
  batch/logs:
    timeout: 50ms

exporters:
  otlphttp/metrics:
    endpoint: http://localhost:9090/api/v1/otlp
    tls:
      insecure: true
  otlphttp/traces:
    endpoint: http://localhost:4418
    tls:
      insecure: true
  otlphttp/logs:
    endpoint: http://localhost:3100/otlp
    tls:
      insecure: true
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 5s
      max_elapsed_time: 30s
    sending_queue:
      enabled: true
      num_consumers: 1
      queue_size: 10000
  otlp/profiles:
    endpoint: http://localhost:4040
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/traces]
    metrics:
      receivers: [otlp, prometheus/collector]
      processors: [batch]
      exporters: [otlphttp/metrics]
    logs:
      receivers: [otlp]
      processors: [batch/logs]
      exporters: [otlphttp/logs]
    profiles:
      receivers: [otlp]
      exporters: [otlp/profiles]
`);
  return collectorConfig;
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
  const failurePanelWithoutZeroFallback = 'Hook failures over time';
  for (const { fileName, dashboard } of generatedDashboards(projects)) {
    for (const panel of dashboard.panels) {
      if (panel.title === failurePanelWithoutZeroFallback) {
        for (const target of panel.targets || []) target.expr = target.expr?.replace(' or vector(0)', '');
      }
      if (panel.title === 'Claude metric samples, 5m') {
        // Prometheus drops old OTLP timestamps, so keep this documentation stat independent of wall-clock time.
        for (const target of panel.targets || []) target.expr = 'vector(10)';
      }
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
  const left = Math.floor(Math.min(...rowItems.map(({ x }) => x)));
  const top = Math.floor(Math.min(...rowItems.map(({ y }) => y)));
  const right = Math.ceil(Math.max(...rowItems.map(({ right }) => right)));
  const bottom = Math.ceil(Math.max(...rowItems.map(({ bottom }) => bottom)));
  return {
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    text: rowItems.map(({ text }) => text).join('\n'),
  };
}

async function captureGrafana(browser, grafanaPort) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  const from = encodeURIComponent(new Date(SYNTHETIC_QUERY_START).toISOString());
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
    const screenshotPath = path.join(outputDir, file);
    await writeScreenshot(page, screenshotPath, { clip: bounds });
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
    reminders: FIXTURE.reminders.map((reminder) => reminder.display),
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
    if (reminder) reminder.textContent = fixed.reminders[0];
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
    await page.waitForTimeout(500);
    const contentBounds = await content.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(contentBounds, `Could not measure screenshot content for ${filename}`);
    assert.ok(viewport, `Could not read screenshot viewport for ${filename}`);
    const contentHeight = Math.min(viewport.height, Math.ceil(contentBounds.y + contentBounds.height + 24));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshotPath = path.join(outputDir, filename);
    await writeScreenshot(page, screenshotPath, {
      clip: { x: 0, y: 0, width: viewport.width, height: contentHeight },
    });
  };

  const captureRegion = async (filename, contents, padding = 16) => {
    await maskGeneratedBoardText(page);
    for (const content of contents) await content.waitFor();
    await page.waitForTimeout(500);
    const bounds = await Promise.all(contents.map((content) => content.boundingBox()));
    const viewport = page.viewportSize();
    assert.ok(bounds.every(Boolean), `Could not measure screenshot region for ${filename}`);
    assert.ok(viewport, `Could not read screenshot viewport for ${filename}`);
    const measured = bounds.filter(Boolean);
    const x = Math.max(0, Math.floor(Math.min(...measured.map((box) => box.x)) - padding));
    const y = Math.max(0, Math.floor(Math.min(...measured.map((box) => box.y)) - padding));
    const right = Math.min(viewport.width, Math.ceil(Math.max(...measured.map((box) => box.x + box.width)) + padding));
    const bottom = Math.min(viewport.height, Math.ceil(Math.max(...measured.map((box) => box.y + box.height)) + padding));
    assert.ok(right > x && bottom > y, `Screenshot region for ${filename} is outside the viewport`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await writeScreenshot(page, path.join(outputDir, filename), {
      clip: { x, y, width: right - x, height: bottom - y },
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

  const linkTarget = page.getByRole('combobox', { name: 'Link target' });
  await linkTarget.scrollIntoViewIfNeeded();
  await linkTarget.click();
  const targetOptions = page.getByRole('listbox', { name: 'Link target' });
  await targetOptions.waitFor();
  await targetOptions.getByRole('option', { name: /Explain estimated tax on receipts/ }).click();
  await page.getByRole('button', { name: 'Add link' }).click();
  const linkSection = page.locator('section.links');
  await linkSection.locator('.link').filter({ hasText: 'SQ-13' }).waitFor();
  assert.equal(await linkSection.locator('.link').count(), 2, 'Synthetic ticket links capture needs two populated relationships');
  await linkTarget.click();
  await page.getByRole('listbox', { name: 'Link target' }).getByRole('option', { name: 'Choose a ticket', exact: true }).click();
  await linkSection.scrollIntoViewIfNeeded();
  await captureRegion('sidequest-ticket-links.png', [linkSection], 8);

  const attachments = page.locator('section.attachments');
  await attachments.locator('img').evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  const mainGrid = page.locator('.main-grid');
  await mainGrid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(200);
  const fields = page.locator('.fields');
  const labelsField = page.getByText('Labels', { exact: true }).locator('..');
  const affectedFilesField = page.getByText('Affected files', { exact: true }).locator('..');
  const comments = page.locator('section.comments');
  const [labelsBounds, commentsBounds] = await Promise.all([labelsField.boundingBox(), comments.boundingBox()]);
  assert.ok(labelsBounds && commentsBounds, 'Could not align the synthetic ticket context capture');
  const contextOffset = Math.max(0, Math.round(labelsBounds.y - commentsBounds.y));
  await fields.evaluate((element, offset) => {
    let contextStarted = false;
    for (const child of element.children) {
      if (child.textContent?.trim().startsWith('Labels')) contextStarted = true;
      if (contextStarted) child.style.transform = `translateY(-${offset}px)`;
      else child.style.visibility = 'hidden';
    }
  }, contextOffset);
  await captureRegion('sidequest-ticket-context.png', [labelsField, affectedFilesField, attachments, comments], 8);
  await fields.evaluate((element) => {
    for (const child of element.children) {
      child.style.removeProperty('transform');
      child.style.removeProperty('visibility');
    }
  });

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('aside[aria-label="Boards"] nav > button').first().click();
  const storyFilter = page.locator('[data-tour="story-filter"]');
  await storyFilter.getByRole('button', { name: 'Stories: All', exact: true }).click();
  const storyMenu = storyFilter.getByRole('menu');
  await storyMenu.waitFor();
  assert.match(await storyMenu.innerText(), /Checkout confidence.*Storefront discovery/s, 'Synthetic story filter did not render the primary stories');
  await capture('sidequest-stories.png', storyMenu);
  await storyFilter.getByRole('button', { name: 'Stories: All', exact: true }).click();
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
  const collectorConfig = await writeOtelCollectorConfig(tempRoot);
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
    command('docker', ['cp', collectorConfig, `${container}:/otel-lgtm/otelcol-config.yaml`]);
    command('docker', ['cp', dashboardDirectory, `${container}:/otel-lgtm/grafana/conf/provisioning`]);
    command('docker', ['start', container]);
    await waitFor(`http://127.0.0.1:${grafanaPort}/api/health`, 'Isolated Grafana');
    await waitFor(`http://127.0.0.1:${grafanaPort}/api/dashboards/uid/claude-code-usage`, 'Synthetic Grafana dashboard');
    await seedGrafana(otlpPort, grafanaPort);
    browser = await chromium.launch();
    await captureSidequest(browser, sidequestPort);
    await captureGrafana(browser, grafanaPort);
    console.log(`Generated 14 synthetic screenshots in ${outputDir}`);
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
