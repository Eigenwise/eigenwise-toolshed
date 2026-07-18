#!/usr/bin/env node
'use strict';
/**
 * switchboard - command-line interface
 *
 * The whole config surface for the ladder engine (lib/ladder.js). There's no
 * dashboard here — this CLI is where routing, bias, and per-model/effort
 * toggles live. Node stdlib only.
 *
 *   switchboard models [--json]
 *   switchboard bias [<int>] [--json]
 *   switchboard route <complexity> [--json]
 *   switchboard enable <target...>
 *   switchboard disable <target...>
 *   switchboard routing on|off
 *   switchboard help
 *
 * Prefs live under SWITCHBOARD_HOME (default ~/.claude/switchboard) — see
 * lib/ladder.js for the file layout and the routing math.
 */

const ladder = require('../lib/ladder');
const migration = require('../lib/migrate');
const categories = require('../lib/mcp');
const server = require('../lib/server');

function fail(msg) {
  console.error(`switchboard: ${msg}`);
  process.exit(1);
}

function legacyNotice() {
  console.warn('switchboard: numeric ladder commands are deprecated and only affect legacy prefs. Run "switchboard migrate --dry-run" to preview category-cap migration.');
}

/* ------------------------------------------------------------------ *
 *  Shared presentation — mirrors sidequest's cmdModels/printLadder/cmdBias
 *  (plugins/sidequest/bin/sidequest.js:771-856), minus every "toggle in the
 *  dashboard settings" callout: here the CLI itself is the settings screen.
 * ------------------------------------------------------------------ */

function biasLabel(n) {
  if (n === 0) return 'neutral';
  return n < 0 ? 'frugal' : 'generous';
}

function printLadder(rungs) {
  console.log('Complexity ladder (score → derived routing):');
  for (const rung of rungs) {
    const label = `C${rung.complexity}`.padEnd(3);
    console.log(`  ${label}  ${rung.model}${rung.effort ? '·' + rung.effort : ''}`);
  }
}

function cmdModels(json) {
  if (!json) legacyNotice();
  const prefs = ladder.getModelPrefs();
  const routing = prefs.routing !== false;
  const rungs = ladder.routingLadder(prefs);
  // Effort is a per-model matrix (prefs.efforts[model] = {low..max}); haiku has
  // no row at all (no effort axis) — build the enabled list from whichever
  // tiers actually got a row, rather than hardcoding "not haiku" here.
  const enabledEfforts = {};
  for (const m of Object.keys(prefs.efforts)) {
    enabledEfforts[m] = ladder.VALID_EFFORTS.filter((e) => prefs.efforts[m][e]);
  }
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          legacy: true,
          routing,
          bias: prefs.routingBias,
          enabled: ladder.VALID_MODELS.filter((m) => prefs[m]),
          enabledEfforts,
          ladder: rungs,
          prefs,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }
  console.log(`Routing: ${routing ? 'on' : 'off'}`);
  console.log(`Bias: ${prefs.routingBias}  (${biasLabel(prefs.routingBias)} — see "switchboard bias")`);
  console.log('Model tiers:');
  for (const m of ladder.VALID_MODELS) console.log(`  ${prefs[m] ? '✓' : '✗'} ${m}${prefs[m] ? '' : '  (disabled)'}`);
  console.log('Effort levels (per model):');
  for (const m of ladder.VALID_MODELS) {
    if (!prefs.efforts[m]) {
      console.log(`  · ${m.padEnd(10)}(no effort axis — haiku ignores effort)`);
      continue;
    }
    console.log(`  ✓ ${m.padEnd(10)}${enabledEfforts[m].join(', ')}`);
  }
  printLadder(rungs);
}

// Mirrors ladder.ROUTING_BIAS_MIN/MAX — pulled straight from the engine so the
// CLI's range check can never drift out of sync with it.
const BIAS_MIN = ladder.ROUTING_BIAS_MIN;
const BIAS_MAX = ladder.ROUTING_BIAS_MAX;

// `switchboard bias [<int>]` — read or set the routingBias dial, then print
// the ladder it shapes (same presentation as `models`). Takes rawArgs
// straight from argv (see main()) because a negative value like "-5" would
// otherwise be swallowed by a generic --flag parser.
function cmdBias(rawArgs) {
  const json = rawArgs.includes('--json');
  if (!json) legacyNotice();
  const valueArgs = rawArgs.filter((a) => a !== '--json');

  if (valueArgs.length === 0) {
    const prefs = ladder.getModelPrefs();
    const rungs = ladder.routingLadder(prefs);
    if (json) {
      process.stdout.write(JSON.stringify({ legacy: true, bias: prefs.routingBias, ladder: rungs }, null, 2) + '\n');
      return;
    }
    console.log(`Bias: ${prefs.routingBias}  (${biasLabel(prefs.routingBias)})`);
    printLadder(rungs);
    return;
  }

  if (valueArgs.length > 1) fail(`bias: pass a single integer ${BIAS_MIN}..${BIAS_MAX}, e.g. switchboard bias 3 (got: ${valueArgs.join(' ')})`);
  const raw = valueArgs[0];
  if (!/^-?\d+$/.test(raw)) fail(`bias: "${raw}" is not an integer — pass a whole number ${BIAS_MIN}..${BIAS_MAX}, e.g. switchboard bias -2`);
  const n = parseInt(raw, 10);
  if (n < BIAS_MIN || n > BIAS_MAX) fail(`bias: ${n} is out of range — must be an integer ${BIAS_MIN}..${BIAS_MAX} (negative = frugal, positive = generous, 0 = neutral)`);

  const prefs = ladder.setModelPrefs({ routingBias: n });
  const rungs = ladder.routingLadder(prefs);
  if (json) {
    process.stdout.write(JSON.stringify({ legacy: true, bias: prefs.routingBias, ladder: rungs }, null, 2) + '\n');
    return;
  }
  console.log(`✓ Bias set to ${prefs.routingBias}  (${biasLabel(prefs.routingBias)})`);
  printLadder(rungs);
}

// `switchboard route <complexity> [--json]` — derive the (model, effort) one
// score maps to under the current prefs. Doesn't touch disk.
function cmdRoute(rawArgs) {
  const json = rawArgs.includes('--json');
  if (!json) legacyNotice();
  const valueArgs = rawArgs.filter((a) => a !== '--json');
  if (valueArgs.length !== 1) fail('route: pass a single complexity score 1-10, e.g. switchboard route 6');
  const c = ladder.coerceComplexity(valueArgs[0]);
  if (!c) fail(`route: "${valueArgs[0]}" is not a valid complexity — pass an integer 1-10`);
  const routing = ladder.deriveRouting(c);
  if (json) {
    process.stdout.write(JSON.stringify({ legacy: true, complexity: c, model: routing.model, effort: routing.effort }, null, 2) + '\n');
    return;
  }
  console.log(`C${c} → ${routing.model}${routing.effort ? '·' + routing.effort : ''}`);
}

// `switchboard enable/disable <target...>` — a target is a bare tier
// ("haiku") or a model.effort pair ("opus.medium"). All targets in one call
// land in a single setModelPrefs patch, so the engine's guards (last tier
// stays on, each row keeps >= 1 effort) evaluate the whole request together,
// not target-by-target. After applying, report what actually got saved per
// target — a guard can override a request (e.g. disabling every tier at
// once), and that's worth surfacing rather than silently swallowing.
function cmdSetTargets(targets, enabled) {
  legacyNotice();
  const verb = enabled ? 'enable' : 'disable';
  if (!targets.length) fail(`${verb}: pass at least one target — a tier (e.g. haiku) or a model.effort pair (e.g. opus.medium)`);

  const parsed = targets.map((target) => {
    const parts = target.split('.');
    if (parts.length > 2) fail(`${verb}: "${target}" is not a valid target — expected a tier (e.g. haiku) or model.effort (e.g. opus.medium)`);
    const [model, effort = null] = parts;
    if (!ladder.VALID_MODELS.includes(model)) {
      fail(`${verb}: "${model}" is not a tier — valid tiers: ${ladder.VALID_MODELS.join(', ')}`);
    }
    if (effort !== null) {
      if (model === 'haiku') fail(`${verb}: haiku has no effort axis — pass "haiku" alone, not "${target}"`);
      if (!ladder.VALID_EFFORTS.includes(effort)) fail(`${verb}: "${effort}" is not a valid effort — valid efforts: ${ladder.VALID_EFFORTS.join(', ')}`);
    }
    return { target, model, effort };
  });

  const patch = { efforts: {} };
  for (const { model, effort } of parsed) {
    if (effort === null) {
      patch[model] = enabled;
    } else {
      patch.efforts[model] = patch.efforts[model] || {};
      patch.efforts[model][effort] = enabled;
    }
  }

  const prefs = ladder.setModelPrefs(patch);

  for (const { target, model, effort } of parsed) {
    const actual = effort === null ? prefs[model] : prefs.efforts[model][effort];
    const mark = actual ? '✓' : '✗';
    const note = actual === enabled ? '' : "  (guard kept this on — can't disable the last tier/effort)";
    console.log(`  ${mark} ${target}${note}`);
  }
  printLadder(ladder.routingLadder(prefs));
}

// `switchboard routing on|off` — the master switch. Off means switchboard
// scores nothing; the caller is on its own for model/effort choices.
function cmdRouting(args) {
  if (args[0] === 'resolve') {
    const requestIndex = args.indexOf('--request');
    if (requestIndex === -1 || !args[requestIndex + 1]) fail('routing resolve: pass --request <json>.');
    try {
      const request = JSON.parse(args[requestIndex + 1]);
      printResult(categories.resolve(request), true);
      return;
    } catch (error) {
      fail(`routing resolve: ${error.message}`);
    }
  }
  legacyNotice();
  const sub = args[0];
  if (sub !== 'on' && sub !== 'off') fail('routing: pass "on" or "off", e.g. switchboard routing off');
  const prefs = ladder.setModelPrefs({ routing: sub === 'on' });
  console.log(`Routing: ${prefs.routing ? 'on' : 'off'}`);
}

function cmdMigrate(args) {
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  const apply = args.length === 1 && args[0] === '--apply';
  if (!dryRun && !apply) fail('migrate: pass exactly --dry-run or --apply');
  let result;
  try {
    result = apply ? migration.applyMigration() : migration.previewMigration();
  } catch (error) {
    fail(error.message);
  }
  process.stdout.write(JSON.stringify(Object.assign({ applied: apply }, result), null, 2) + '\n');
}

function printResult(value, json) {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    return;
  }
  if (Array.isArray(value.categories)) {
    for (const category of value.categories) {
      console.log(`${category.enabled ? '✓' : '✗'} ${category.id.padEnd(24)} ${category.name} (${value.states[category.id] || 'unknown'})`);
    }
    for (const warning of value.warnings || []) console.warn(`warning: ${warning}`);
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function parseOptions(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) {
      options[key] = inline;
    } else if (args[index + 1] && !args[index + 1].startsWith('--')) {
      options[key] = args[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { options, positional };
}

function routeFromOptions(options, prefix = '') {
  const modelKey = prefix ? `${prefix}Model` : 'model';
  const effortKey = prefix ? `${prefix}Effort` : 'effort';
  if (options[modelKey] === undefined && options[effortKey] === undefined) return undefined;
  return { model: options[modelKey], effort: options[effortKey] };
}

function categoryPayload(id, options, existing) {
  const route = routeFromOptions(options) || (existing && existing.route);
  const fallback = options.noFallback ? null : (routeFromOptions(options, 'fallback') || (existing ? existing.fallback : null));
  return {
    id,
    name: options.name === undefined ? existing && existing.name : options.name,
    description: options.description === undefined ? existing && existing.description : options.description,
    contract: options.contract === undefined ? existing && existing.contract : options.contract,
    route,
    fallback,
    enabled: options.enabled === undefined ? (existing ? existing.enabled : true) : options.enabled !== 'false',
  };
}

function cmdCategory(args) {
  const sub = args[0];
  const { options, positional } = parseOptions(args.slice(1));
  const project = options.project !== undefined;
  const projectPath = project ? (options.project === true ? process.cwd() : options.project) : undefined;
  const json = options.json === true;
  try {
    if (sub === 'list') return printResult(categories.listCategories({ projectPath, global: options.global === true, includeDisabled: options.disabled !== false }), json);
    if (sub === 'show') return printResult(categories.showCategory({ id: positional[0], projectPath, global: options.global === true }), json);
    if (sub === 'add') return printResult(categories.addCategory({ category: categoryPayload(positional[0], options), projectPath, project }), json);
    if (sub === 'edit') {
      const existing = categories.showCategory({ id: positional[0], projectPath, global: !project }).category;
      return printResult(categories.editCategory({ id: positional[0], patch: categoryPayload(existing.id, options, existing), projectPath, project }), json);
    }
    if (sub === 'disable') return printResult(categories.disableCategory({ id: positional[0], projectPath, project }), json);
    if (sub === 'remove') return printResult(categories.removeCategory({ id: positional[0], projectPath, project }), json);
    if (sub === 'detach') {
      if (!project) fail('category detach: pass --project <path> to create a project-local copy.');
      return printResult(categories.detachCategory({ id: positional[0], projectPath }), json);
    }
    if (sub === 'relink' || sub === 'reset') {
      if (!project) fail(`category ${sub}: pass --project <path> to remove a project-local override.`);
      return printResult(categories.relinkCategory({ id: positional[0], projectPath }), json);
    }
    fail('category: use list, show, add, edit, disable, remove, detach, relink, or reset.');
  } catch (error) {
    fail(`category ${sub}: ${error.message}`);
  }
}

function cmdFallback(args) {
  const { options } = parseOptions(args);
  const project = options.project !== undefined;
  const projectPath = project ? (options.project === true ? process.cwd() : options.project) : undefined;
  try {
    const route = routeFromOptions(options);
    printResult(route === undefined ? categories.getFallback({ projectPath }) : categories.setFallback({ route: options.clear ? null : route, projectPath, project }), options.json === true);
  } catch (error) {
    fail(`fallback: ${error.message}`);
  }
}

function cmdResolve(args) {
  const { options, positional } = parseOptions(args);
  try {
    printResult(categories.resolve({ categoryId: positional[0], projectPath: options.project === true ? process.cwd() : options.project, consumer: options.consumer }), options.json === true);
  } catch (error) {
    fail(`resolve: ${error.message}`);
  }
}

function cmdConfigSurface(name, args) {
  const { options } = parseOptions(args);
  try {
    const projectPath = options.project === true ? process.cwd() : options.project;
    const value = name === 'available'
      ? categories.availableModels({ projectPath })
      : name === 'contract'
        ? categories.contract()
        : categories.doctor({ projectPath });
    printResult(value, options.json === true);
  } catch (error) {
    fail(`${name}: ${error.message}`);
  }
}

function cmdOpen(args) {
  const { options } = parseOptions(args);
  server.start(options.port).then(({ url }) => {
    console.log(`Switchboard settings: ${url}`);
  }).catch((error) => fail(`open: ${error.message}`));
}

function help() {
  console.log(`switchboard — complexity-scored model/effort routing

Usage:
  switchboard open [--port <port>]                             open local routing settings
  switchboard category list|show|add|edit|disable|remove [args]  category policy management
  switchboard category detach|relink|reset <id> --project <path>  project overlays
  switchboard fallback [--model <model> --effort <effort>]         global fallback
  switchboard available [--project <path>] [--json]               models and effort caps
  switchboard resolve <category> [--project <path>] [--json]      explain every route attempt
  switchboard contract [--json]                                   routing contract breadcrumb
  switchboard doctor [--project <path>] [--json]                  config and catalog checks
  switchboard migrate --dry-run|--apply                           preview or apply legacy migration

Deprecated numeric-ladder compatibility commands:
  switchboard models [--json]
  switchboard bias [<int>] [--json]
  switchboard route <complexity> [--json]
  switchboard enable|disable <target...>
  switchboard routing on|off
  switchboard routing resolve --request <json>                    contract-compatible resolver

Legacy prefs live under SWITCHBOARD_HOME (default ~/.claude/switchboard/prefs.json).
Category config lives at ~/.claude/toolshed/switchboard.json and .claude/switchboard.json.
For test/CI, SWITCHBOARD_CONFIG_USER_FILE, SWITCHBOARD_CONFIG_PROJECT_FILE, and
SWITCHBOARD_CONFIG_OVERRIDES provide explicit temporary layers.`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    help();
    return;
  }

  const rest = argv.slice(1);
  switch (cmd) {
    case 'open':
      cmdOpen(rest);
      break;
    case 'category':
      cmdCategory(rest);
      break;
    case 'fallback':
      cmdFallback(rest);
      break;
    case 'available':
      cmdConfigSurface('available', rest);
      break;
    case 'resolve':
      cmdResolve(rest);
      break;
    case 'contract':
      cmdConfigSurface('contract', rest);
      break;
    case 'doctor':
      cmdConfigSurface('doctor', rest);
      break;
    case 'models':
      cmdModels(rest.includes('--json'));
      break;
    case 'bias':
      cmdBias(rest);
      break;
    case 'route':
      cmdRoute(rest);
      break;
    case 'enable':
      cmdSetTargets(rest, true);
      break;
    case 'disable':
      cmdSetTargets(rest, false);
      break;
    case 'migrate':
      cmdMigrate(rest);
      break;
    case 'routing':
      cmdRouting(rest);
      break;
    default:
      help();
      process.exit(1);
  }
}

main();
