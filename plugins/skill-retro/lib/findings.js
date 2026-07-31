'use strict';

const ROUTES = {
  gitignore: 'gitignore + memory',
  script: 'bundled script only',
  skill: 'skill (with bundled script)',
  rule: 'live rule',
  memory: 'memory entry',
  map: 'codebase map',
  ticket: 'ticket',
  settings: 'settings (permissions)',
  drop: 'drop',
};

const BASE_SCORE = {
  'hazard-private-data': 1000,
  'hazard-untracked': 900,
  'rewritten-script': 60,
  'repeated-command': 40,
  'fail-then-fix': 35,
  'ephemeral-artifact': 30,
  'rediscovery-tax': 45,
  'user-correction': 50,
  'permission-denial': 20,
};

function audience(finding) {
  const actors = finding.actors ?? [];
  const total = actors.reduce((sum, actor) => sum + (actor.count ?? 1), 0) || 1;
  const subagent = actors.filter((actor) => String(actor.label).startsWith('subagent:'));
  const subagentShare = subagent.reduce((sum, actor) => sum + (actor.count ?? 1), 0) / total;
  if (actors.some((actor) => actor.label === 'user')) return { primary: 'user', distinctSubagents: subagent.length, subagentShare };
  if (subagentShare >= 0.5) return { primary: 'subagents', distinctSubagents: subagent.length, subagentShare };
  return { primary: 'main-loop', distinctSubagents: subagent.length, subagentShare };
}

/**
 * Proposes where a finding's fix belongs. The proposal is a starting point the reviewing model is
 * expected to overrule: the routing call is the judgment the whole pass exists to make, and it depends
 * on context a detector cannot see.
 *
 * Who repeated the work decides as much as what was repeated. A skill only helps someone who thinks to
 * invoke it, so work that subagents keep redoing routes to things that reach them without being asked:
 * a script they can call, a rule scoped to the files they edit, a map entry loaded at their start.
 */
function routeFor(finding) {
  const who = audience(finding);
  const many = (finding.actors ?? []).length > 1;

  switch (finding.kind) {
    case 'hazard-private-data':
      return {
        route: 'gitignore',
        why: 'Ignore the paths now, then record why they exist so the hole does not reopen. Not a skill: nothing about this needs invoking.',
      };
    case 'hazard-untracked':
      return { route: 'gitignore', why: 'A gitignore entry costs one line and removes the whole class.' };

    case 'rewritten-script':
      return {
        route: 'script',
        why: finding.proven
          ? 'The working version is already in the transcript and its output was recorded, so salvage and test it rather than writing a new one.'
          : 'Salvage the last written version. Nothing in the window proves it ran clean, so test it before shipping it.',
        alternatives: ['skill, if choosing when to run it needs judgment'],
      };

    case 'repeated-command': {
      const parameterized = (finding.arguments ?? []).length > 0;
      if (who.primary === 'subagents' && many) {
        return {
          route: 'script',
          why: `${who.distinctSubagents} different executors ran this, so it belongs somewhere they can call without knowing it exists. A skill would not reach them.`,
        };
      }
      return {
        route: parameterized ? 'script' : 'skill',
        why: parameterized
          ? 'The parts that varied become CLI arguments; the command itself carries no judgment worth a skill.'
          : 'The shape never varied, so wrap it only if the surrounding decision is worth writing down.',
        alternatives: parameterized ? ['skill, if picking the arguments needs judgment'] : ['drop, if it is fast enough by hand'],
      };
    }

    case 'fail-then-fix':
      return {
        route: 'script',
        why: 'The correction goes in the script so it cannot be forgotten; the reason it was needed goes in the skill body, where it survives someone wondering why the flag is there.',
      };

    case 'ephemeral-artifact':
      return {
        route: 'script',
        why: 'It gets rebuilt every session because it lives nowhere durable. Give it a home and a CLI.',
      };

    case 'rediscovery-tax':
      return {
        route: 'map',
        why: who.primary === 'subagents'
          ? 'Executors start cold every time, and the map is injected at their session start, so it is the only fix that reaches them before they start reading.'
          : 'Re-deriving the same layout is what a map entry exists to stop.',
        alternatives: ['ticket, if the answer is not written down anywhere yet'],
      };

    case 'user-correction':
      return {
        route: finding.occurrences > 1 ? 'rule' : 'memory',
        why: finding.occurrences > 1
          ? 'Repeated correction, so it needs to arrive unbidden on every prompt that matches, which is what a live rule does. Never a skill: the whole problem is that nobody thinks to invoke one.'
          : 'Said once. Record it with its reason and let a rule follow if it recurs.',
        alternatives: ['drop, if it was situational rather than a standing preference'],
      };

    case 'permission-denial':
      return {
        route: 'settings',
        why: 'Repeated denials are a permissions allowlist gap, not a behavior to correct. This route sits outside the usual six on purpose.',
      };

    default:
      return { route: 'ticket', why: 'No obvious owner; file it and decide with more context.' };
  }
}

function score(finding) {
  const base = BASE_SCORE[finding.kind] ?? 10;
  const occurrences = Math.max(1, finding.occurrences ?? 1);
  const breadth = (finding.sessions ?? 1) + (finding.actors ?? []).length;
  const complexity = finding.complexity ? Math.min(3, 1 + finding.complexity / 30) : 1;
  return Math.round(base * Math.log2(occurrences + 1) * Math.sqrt(breadth) * complexity);
}

/**
 * Ranks findings and drops the ones that would only create busywork. A retro that pads its output
 * teaches the reader to skim it, which costs more than the padding saves.
 */
function rank(findings, options = {}) {
  const floor = options.floor ?? 25;
  const scored = findings.map((finding, index) => {
    const routing = routeFor(finding);
    const value = score(finding);
    return {
      id: `F${String(index + 1).padStart(2, '0')}`,
      ...finding,
      audience: audience(finding),
      route: routing.route,
      routeLabel: ROUTES[routing.route],
      routeWhy: routing.why,
      routeAlternatives: routing.alternatives ?? [],
      score: value,
      severity: finding.severity ?? (value >= 200 ? 'high' : value >= 80 ? 'medium' : 'low'),
    };
  });

  // Hazards sort above everything by rule, not by score. A single exposed credential has to outrank a
  // chore that ran forty times, and no scoring formula should be trusted to keep producing that order.
  const isHazard = (finding) => String(finding.kind).startsWith('hazard');
  scored.sort((a, b) => (isHazard(b) ? 1 : 0) - (isHazard(a) ? 1 : 0) || b.score - a.score);
  const kept = scored.filter((finding) => finding.score >= floor || isHazard(finding));
  const dropped = scored.filter((finding) => !kept.includes(finding));

  kept.forEach((finding, index) => {
    finding.id = `F${String(index + 1).padStart(2, '0')}`;
  });

  return { findings: kept, dropped: dropped.map((finding) => ({ kind: finding.kind, title: finding.title, score: finding.score })) };
}

module.exports = { audience, rank, ROUTES, routeFor, score };
