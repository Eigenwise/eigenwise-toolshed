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

function fail(msg) {
  console.error(`switchboard: ${msg}`);
  process.exit(1);
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
  const valueArgs = rawArgs.filter((a) => a !== '--json');

  if (valueArgs.length === 0) {
    const prefs = ladder.getModelPrefs();
    const rungs = ladder.routingLadder(prefs);
    if (json) {
      process.stdout.write(JSON.stringify({ bias: prefs.routingBias, ladder: rungs }, null, 2) + '\n');
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
    process.stdout.write(JSON.stringify({ bias: prefs.routingBias, ladder: rungs }, null, 2) + '\n');
    return;
  }
  console.log(`✓ Bias set to ${prefs.routingBias}  (${biasLabel(prefs.routingBias)})`);
  printLadder(rungs);
}

// `switchboard route <complexity> [--json]` — derive the (model, effort) one
// score maps to under the current prefs. Doesn't touch disk.
function cmdRoute(rawArgs) {
  const json = rawArgs.includes('--json');
  const valueArgs = rawArgs.filter((a) => a !== '--json');
  if (valueArgs.length !== 1) fail('route: pass a single complexity score 1-10, e.g. switchboard route 6');
  const c = ladder.coerceComplexity(valueArgs[0]);
  if (!c) fail(`route: "${valueArgs[0]}" is not a valid complexity — pass an integer 1-10`);
  const routing = ladder.deriveRouting(c);
  if (json) {
    process.stdout.write(JSON.stringify({ complexity: c, model: routing.model, effort: routing.effort }, null, 2) + '\n');
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
  const sub = args[0];
  if (sub !== 'on' && sub !== 'off') fail('routing: pass "on" or "off", e.g. switchboard routing off');
  const prefs = ladder.setModelPrefs({ routing: sub === 'on' });
  console.log(`Routing: ${prefs.routing ? 'on' : 'off'}`);
}

function help() {
  console.log(`switchboard — complexity-scored model/effort routing

Usage:
  switchboard models [--json]              routing state, tiers, per-model efforts, and the ladder
  switchboard bias [<int>] [--json]        read (no arg) or set (-5..5) the routing bias dial
  switchboard route <complexity> [--json]  derive one score's routing, e.g. switchboard route 6
  switchboard enable <target...>           turn on a tier or model.effort pair, e.g. switchboard enable opus.medium
  switchboard disable <target...>          turn off a tier or model.effort pair, e.g. switchboard disable fable
  switchboard routing on|off               master switch — off means switchboard scores nothing
  switchboard help                         this message

Prefs live under SWITCHBOARD_HOME (default ~/.claude/switchboard/prefs.json).`);
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
    case 'routing':
      cmdRouting(rest);
      break;
    default:
      help();
      process.exit(1);
  }
}

main();
