#!/usr/bin/env node
'use strict';
/**
 * sidequest - command-line interface
 *
 * The single entry point used by humans, the capture hook, and the ticket-filer
 * subagent. Node stdlib only; cross-platform.
 *
 *   sidequest add -t "title" [-d desc] [-p priority] [-l label]... [-i image]... [-s status]
 *   sidequest list [--status todo] [--json]
 *   sidequest update <id|SQ-n> [-t] [-d] [-p] [-s] [-l ...] [-i ...]
 *   sidequest rm <id|SQ-n>
 *   sidequest projects
 *   sidequest dashboard [--port N] [--no-open]      # ensure server + open browser
 *   sidequest serve [--port N]                       # run the server in foreground
 *   sidequest stop                                   # stop the running server
 *
 * The project defaults to $CLAUDE_PROJECT_DIR (or the current directory). Pass
 * --project <path-or-slug> to target another board.
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const store = require('../lib/store');

/* ------------------------------------------------------------------ *
 *  Arg parsing
 * ------------------------------------------------------------------ */

// Flags that may be repeated collect into arrays; everything else is a scalar.
const ARRAY_FLAGS = new Set(['image', 'label']);
const ALIASES = {
  t: 'title',
  d: 'desc',
  p: 'priority',
  l: 'label',
  i: 'image',
  s: 'status',
};

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') || a.startsWith('-')) {
      const isLong = a.startsWith('--');
      let key = a.replace(/^-+/, '');
      let val = null;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (!isLong && ALIASES[key]) key = ALIASES[key];
      if (key === 'no-open') {
        opts.open = false;
        continue;
      }
      // Boolean-ish flags don't consume a value.
      const BOOL = new Set(['json', 'open', 'help']);
      if (val === null) {
        if (BOOL.has(key)) {
          opts[key] = true;
          continue;
        }
        val = argv[i + 1];
        i++;
      }
      if (ARRAY_FLAGS.has(key)) {
        (opts[key] = opts[key] || []).push(val);
      } else {
        opts[key] = val;
      }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

/* ------------------------------------------------------------------ *
 *  Project resolution
 * ------------------------------------------------------------------ */

function resolveProject(opts) {
  const arg = opts.project;
  if (arg) {
    // An exact slug of an existing board wins; otherwise treat it as a path.
    if (store.readMeta(arg)) return { slug: arg, meta: store.readMeta(arg) };
    return store.ensureProject(arg, opts.name);
  }
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return store.ensureProject(dir, opts.name);
}

/* ------------------------------------------------------------------ *
 *  Commands
 * ------------------------------------------------------------------ */

const PRIORITY_MARK = { urgent: '!!', high: '!', normal: '', low: '·' };

function cmdAdd(opts) {
  if (!opts.title) fail('add: --title is required (e.g. sidequest add -t "Contact form does not send")');
  const { slug, meta } = resolveProject(opts);
  const warnings = [];
  const ticket = store.createTicket(slug, {
    title: opts.title,
    description: opts.desc || opts.description || '',
    priority: opts.priority,
    status: opts.status,
    labels: opts.label,
    images: opts.image || [],
    source: opts.source || 'cli',
    onAssetError: (src) => warnings.push(`could not attach image: ${src}`),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, ticket, warnings }, null, 2) + '\n');
    return;
  }
  const pr = PRIORITY_MARK[ticket.priority] ? ` ${PRIORITY_MARK[ticket.priority]}` : '';
  const imgs = ticket.assets.length ? ` (${ticket.assets.length} image${ticket.assets.length > 1 ? 's' : ''})` : '';
  console.log(`✓ ${ticket.ref}${pr}  "${ticket.title}"  [${ticket.status}/${ticket.priority}]${imgs}  — ${meta.name}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  const info = store.readServerInfo();
  if (info && info.url) console.log(`  board: ${info.url}`);
}

function cmdList(opts) {
  const { slug, meta } = resolveProject(opts);
  let tickets = store.listTickets(slug);
  if (opts.status) tickets = tickets.filter((t) => t.status === String(opts.status).toLowerCase());
  if (opts.json) {
    process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, tickets }, null, 2) + '\n');
    return;
  }
  if (!tickets.length) {
    console.log(`No tickets in ${meta.name}.`);
    return;
  }
  console.log(`${meta.name} — ${tickets.length} ticket(s)`);
  const cols = { todo: 'TO DO', doing: 'DOING', done: 'DONE' };
  for (const status of store.VALID_STATUS) {
    const group = tickets.filter((t) => t.status === status);
    if (!group.length) continue;
    console.log(`\n  ${cols[status]} (${group.length})`);
    for (const t of group) {
      const pr = PRIORITY_MARK[t.priority] ? ` ${PRIORITY_MARK[t.priority]}` : '';
      const labels = t.labels.length ? `  #${t.labels.join(' #')}` : '';
      const imgs = t.assets.length ? `  \u{1F5BC}${t.assets.length}` : '';
      console.log(`    ${t.ref}${pr}  ${t.title}${labels}${imgs}`);
    }
  }
}

function cmdUpdate(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('update: pass a ticket id or ref, e.g. sidequest update SQ-4 --status done');
  const { slug, meta } = resolveProject(opts);
  const patch = {};
  if (opts.title != null) patch.title = opts.title;
  if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
  if (opts.status != null) patch.status = opts.status;
  if (opts.priority != null) patch.priority = opts.priority;
  if (opts.label != null) patch.labels = opts.label;
  if (opts.image != null) patch.images = opts.image;
  patch.source = opts.source || 'cli'; // a CLI/subagent change (Claude), not the dashboard
  const updated = store.updateTicket(slug, idOrRef, patch);
  if (!updated) fail(`update: no ticket "${idOrRef}" in ${meta.name}`);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, ticket: updated }, null, 2) + '\n');
    return;
  }
  console.log(`✓ ${updated.ref} updated  [${updated.status}/${updated.priority}]  "${updated.title}"`);
}

function cmdRm(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('rm: pass a ticket id or ref, e.g. sidequest rm SQ-4');
  const { slug, meta } = resolveProject(opts);
  const ok = store.deleteTicket(slug, idOrRef);
  if (!ok) fail(`rm: no ticket "${idOrRef}" in ${meta.name}`);
  console.log(`✓ removed ${idOrRef} from ${meta.name}`);
}

function cmdProjects(opts) {
  const projects = store.listProjects();
  if (opts.json) {
    process.stdout.write(JSON.stringify({ projects }, null, 2) + '\n');
    return;
  }
  if (!projects.length) {
    console.log('No sidequest boards yet. Create a ticket to start one.');
    return;
  }
  console.log(`${projects.length} board(s):`);
  for (const p of projects) {
    console.log(`  ${p.name}  —  ${p.open} open (${p.counts.todo} todo, ${p.counts.doing} doing, ${p.counts.done} done)`);
    console.log(`    ${p.path}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Server lifecycle
 * ------------------------------------------------------------------ */

function checkHealth(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs || 800 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const info = JSON.parse(raw);
          resolve(info && info.name === 'sidequest' ? info : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Return the URL of a running dashboard, starting a detached one if needed.
async function ensureServer(requestedPort) {
  const existing = store.readServerInfo();
  if (existing && existing.port) {
    const health = await checkHealth(existing.port);
    if (health) return existing.url || `http://127.0.0.1:${existing.port}`;
  }
  // Spawn the server detached so it outlives this short-lived CLI process.
  const args = [path.join(__dirname, 'sidequest.js'), 'serve'];
  if (requestedPort) args.push('--port', String(requestedPort));
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  // Wait for it to record itself and answer health.
  for (let i = 0; i < 60; i++) {
    await delay(150);
    const info = store.readServerInfo();
    if (info && info.port) {
      const health = await checkHealth(info.port);
      if (health) return info.url || `http://127.0.0.1:${info.port}`;
    }
  }
  throw new Error('the dashboard server did not start in time');
}

function openBrowser(targetUrl) {
  try {
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', targetUrl];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [targetUrl];
    } else {
      cmd = 'xdg-open';
      args = [targetUrl];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (_) {
    /* opening the browser is best-effort */
  }
}

async function cmdDashboard(opts) {
  // Register the current project so it shows up even before its first ticket.
  try {
    resolveProject(opts);
  } catch (_) {
    /* fine if we cannot */
  }
  const targetUrl = await ensureServer(opts.port);
  if (opts.open !== false) openBrowser(targetUrl);
  console.log(`sidequest dashboard: ${targetUrl}`);
  if (opts.open === false) console.log('(browser auto-open skipped; open the URL above)');
}

async function cmdServe(opts) {
  const server = require('../lib/server');
  const { url } = await server.start(opts.port);
  console.log(`sidequest dashboard running at ${url}`);
  // Do not exit: the HTTP server keeps the process alive.
}

function cmdStop() {
  const info = store.readServerInfo();
  if (!info || !info.pid) {
    console.log('No running sidequest server recorded.');
    return;
  }
  try {
    process.kill(info.pid);
    console.log(`Stopped sidequest server (pid ${info.pid}).`);
  } catch (e) {
    console.log(`Could not stop pid ${info.pid}: ${e.message}`);
  }
  store.clearServerInfo();
}

/* ------------------------------------------------------------------ *
 *  Help + dispatch
 * ------------------------------------------------------------------ */

function help() {
  console.log(
    `sidequest — a Trello-light quest log for Claude Code

Usage:
  sidequest add -t "title" [-d desc] [-p low|normal|high|urgent] [-l label]... [-i image]... [-s todo|doing|done]
  sidequest list [--status todo|doing|done] [--json]
  sidequest update <id|SQ-n> [-t title] [-d desc] [-p priority] [-s status] [-l label]... [-i image]...
  sidequest rm <id|SQ-n>
  sidequest projects [--json]
  sidequest dashboard [--port N] [--no-open]     open the live board in the browser
  sidequest serve [--port N]                     run the board server in the foreground
  sidequest stop                                 stop the running board server

Project selection:
  Defaults to $CLAUDE_PROJECT_DIR or the current directory.
  --project <path-or-slug>   target another board  ·  --name <name>   set its display name

Tickets and their images are stored centrally (default ~/.claude/sidequest), so
one dashboard shows every project's board at once.`
  );
}

function fail(msg) {
  console.error(`sidequest: ${msg}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { opts, positional } = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || opts.help) {
    help();
    return;
  }

  switch (cmd) {
    case 'add':
    case 'new':
    case 'ticket':
      cmdAdd(opts);
      break;
    case 'list':
    case 'ls':
      cmdList(opts);
      break;
    case 'update':
    case 'edit':
    case 'set':
      cmdUpdate(opts, positional);
      break;
    case 'rm':
    case 'remove':
    case 'delete':
      cmdRm(opts, positional);
      break;
    case 'projects':
    case 'boards':
      cmdProjects(opts);
      break;
    case 'dashboard':
    case 'open':
    case 'board':
      await cmdDashboard(opts);
      break;
    case 'serve':
      await cmdServe(opts);
      break;
    case 'stop':
      cmdStop();
      break;
    default:
      fail(`unknown command "${cmd}". Run "sidequest help".`);
  }
}

main().catch((err) => {
  console.error(`sidequest: ${(err && err.message) || err}`);
  process.exit(1);
});
