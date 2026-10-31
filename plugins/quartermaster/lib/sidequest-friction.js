'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { claudeDir } = require('./paths.js');

const FRICTION_TITLES = {
  verificationAmendments: 'Pinned verifiers amended after dispatch',
  failedVerifications: 'Failed verification runs',
  timedOutVerifications: 'Timed-out verification runs',
  checkpointReleases: 'Executor checkpoint or budget releases',
  rejectedSubmissions: 'Rejected submissions',
};

function withinWindow(timestamp, cutoffMs, now) {
  const milliseconds = Date.parse(timestamp);
  return milliseconds >= cutoffMs && milliseconds <= now;
}

function uniqueRecords(records, identity) {
  return [...new Map(records.toReversed().map((record) => [identity(record), record])).values()];
}

function attemptIdentity(attempt) {
  return JSON.stringify([attempt.preparedAt, attempt.sessionId, attempt.executor]);
}

function capturedVerifications(ticket) {
  const captures = (ticket.verificationCaptures ?? []).filter((capture) => !capture.control);
  return uniqueRecords(captures, (capture) => capture.id ?? JSON.stringify(capture));
}

function checkpointReleases(ticket) {
  const attempts = uniqueRecords(ticket.dispatch?.attempts ?? [], attemptIdentity);
  return attempts.filter((attempt) => /checkpoint|budget/i.test(attempt.release?.reason ?? ''));
}

function ticketFriction(ticket, cutoffMs, now) {
  const recent = (records, timestamp) => records.filter((record) => withinWindow(record[timestamp], cutoffMs, now));
  const captures = recent(capturedVerifications(ticket), 'completedAt');
  return {
    verificationAmendments: recent(ticket.verificationAmendments ?? [], 'at').length,
    failedVerifications: captures.filter((capture) => ['failed_suite', 'failed_check'].includes(capture.status)).length,
    timedOutVerifications: captures.filter((capture) => capture.status === 'timeout').length,
    checkpointReleases: recent(checkpointReleases(ticket), 'terminalAt').length,
    rejectedSubmissions: recent(ticket.rejectedSubmissions ?? [], 'rejectedAt').length,
  };
}

function projectFriction(database, project, cutoffMs, now) {
  const totals = Object.fromEntries(Object.keys(FRICTION_TITLES).map((kind) => [kind, 0]));
  const tickets = [];
  for (const row of database.prepare('SELECT ref, data FROM tickets WHERE project = ?').iterate(project.slug)) {
    const counts = ticketFriction(JSON.parse(row.data), cutoffMs, now);
    for (const kind of Object.keys(totals)) totals[kind] += counts[kind];
    if (Object.values(counts).some(Boolean)) tickets.push({ ref: row.ref, ...counts });
  }
  return { project: project.slug, totals, tickets: tickets.slice(0, 10), ticketsWithFriction: tickets.length };
}

function selectedProjects(database, options) {
  const projects = database.prepare('SELECT slug, data FROM projects').all();
  if (options.allProjects) return projects;
  const requested = path.resolve(options.projectPath ?? process.cwd());
  return projects.filter((project) => path.relative(JSON.parse(project.data).path, requested) === '');
}

function frictionCandidates(projects) {
  return projects.flatMap((project) => Object.entries(project.totals)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({
      fingerprint: `sidequest:${kind}`,
      title: FRICTION_TITLES[kind],
      project: project.project,
      count,
      source: 'sidequest',
    })));
}

function readBoardFriction(databasePath, options, cutoffMs, now = options.now ?? Date.now()) {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const projects = selectedProjects(database, options).map((project) => projectFriction(database, project, cutoffMs, now));
    return {
      projects: projects.slice(0, 20),
      projectsScanned: projects.length,
      candidates: frictionCandidates(projects).slice(0, 100),
      limits: 'Retained Sidequest records only, not a complete event log. No durations inferred. Up to 20 projects, 10 ticket samples per project and 100 candidates shown. Control captures excluded; captures deduplicated by id and dispatch attempts by preparedAt/sessionId/executor.',
    };
  } finally {
    database.close();
  }
}

function sidequestFriction(options, cutoffMs) {
  const env = options.env ?? process.env;
  const databasePath = path.join(env.SIDEQUEST_HOME || path.join(claudeDir(env), 'sidequest'), 'sidequest.db');
  if (!fs.existsSync(databasePath)) return { projects: [], candidates: [] };
  try {
    return readBoardFriction(databasePath, options, cutoffMs);
  } catch (error) {
    return { projects: [], candidates: [], unavailable: error.message };
  }
}

module.exports = { sidequestFriction };
