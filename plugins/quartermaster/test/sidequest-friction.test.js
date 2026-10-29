'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { mine } = require('../lib/mine.js');
const { sidequestFriction } = require('../lib/sidequest-friction.js');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const RECENT = '2026-10-28T12:00:00Z';
const OLD = '2026-09-01T12:00:00Z';

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-sidequest-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    projectPath: path.join(directory, 'project'),
    env: { CLAUDE_CONFIG_DIR: directory, SIDEQUEST_HOME: path.join(directory, 'board') },
    now: NOW,
    days: 7,
  };
}

function seed(options, tickets) {
  fs.mkdirSync(options.env.SIDEQUEST_HOME);
  const database = new DatabaseSync(path.join(options.env.SIDEQUEST_HOME, 'sidequest.db'));
  database.exec('CREATE TABLE projects (slug TEXT, data TEXT); CREATE TABLE tickets (project TEXT, ref TEXT, data TEXT)');
  const insertProject = database.prepare('INSERT INTO projects VALUES (?, ?)');
  insertProject.run('local', JSON.stringify({ path: options.projectPath }));
  insertProject.run('other', JSON.stringify({ path: path.join(options.projectPath, 'other') }));
  const insertTicket = database.prepare('INSERT INTO tickets VALUES (?, ?, ?)');
  for (const ticket of tickets) insertTicket.run(ticket.project, ticket.ref, JSON.stringify(ticket));
  database.close();
}

function lifecycleTickets() {
  const attempt = { preparedAt: RECENT, sessionId: 'session', executor: 'executor', terminalAt: RECENT, release: { reason: 'Continuation checkpoint: context budget' } };
  const failed = { id: 'failed', status: 'failed_suite', completedAt: RECENT };
  return [
    {
      project: 'local', ref: 'SQ-1',
      verificationAmendments: [{ at: RECENT }, { at: OLD }],
      verificationCaptures: [{ status: 'passed', completedAt: RECENT }, { id: 'future', status: 'failed_check', completedAt: '2026-11-01T00:00:00Z' }, failed, { ...failed }, { id: 'timeout', status: 'timeout', completedAt: RECENT }, { id: 'control', status: 'failed_check', control: true, completedAt: RECENT }, { id: 'old', status: 'failed_suite', completedAt: OLD }],
      dispatch: { attempts: [{ preparedAt: OLD }, attempt, { ...attempt, terminalAt: '2026-11-01T00:00:00Z' }] },
      rejectedSubmissions: [{ rejectedAt: RECENT }, { rejectedAt: OLD }],
    },
    { project: 'local', ref: 'SQ-2' },
  ];
}

test('mine exposes lifecycle friction once per retained capture and attempt without changing the board', async (context) => {
  const options = fixture(context);
  seed(options, lifecycleTickets());
  const databasePath = path.join(options.env.SIDEQUEST_HOME, 'sidequest.db');
  const before = fs.readFileSync(databasePath);
  const report = await mine(options);
  assert.deepEqual(report.sidequest.projects[0].totals, {
    verificationAmendments: 1, failedVerifications: 1, timedOutVerifications: 1, checkpointReleases: 1, rejectedSubmissions: 1,
  });
  assert.equal(report.sidequest.projects[0].ticketsWithFriction, 1);
  assert.equal(report.sidequest.projects[0].tickets[0].ref, 'SQ-1');
  assert.equal(report.sidequest.projects[0].tickets[0].verificationAmendments, 1);
  assert.equal(report.sidequest.candidates.length, 5);
  assert.ok(report.sidequest.candidates.every((candidate) => candidate.count === 1));
  assert.deepEqual(fs.readFileSync(databasePath), before);
});

test('mine skips an absent Sidequest database without creating state or returning an error', async (context) => {
  const options = fixture(context);
  const report = await mine(options);
  assert.deepEqual(report.sidequest, { projects: [], candidates: [] });
  assert.equal(fs.existsSync(options.env.SIDEQUEST_HOME), false);
});

test('mine scopes board records to the project unless all projects were requested', async (context) => {
  const options = fixture(context);
  seed(options, [{ project: 'other', ref: 'SQ-3', verificationAmendments: [{ at: RECENT }] }]);
  assert.deepEqual((await mine(options)).sidequest.candidates, []);
  const global = await mine({ ...options, allProjects: true });
  assert.equal(global.sidequest.projectsScanned, 2);
  assert.equal(global.sidequest.candidates[0].project, 'other');
  assert.equal(global.sidequest.candidates[0].count, 1);
});

test('mine reports unreadable board data as unavailable without losing transcript mining', async (context) => {
  const options = fixture(context);
  fs.mkdirSync(options.env.SIDEQUEST_HOME);
  fs.writeFileSync(path.join(options.env.SIDEQUEST_HOME, 'sidequest.db'), 'not a database');
  const report = await mine(options);
  assert.match(report.sidequest.unavailable, /database/i);
  assert.deepEqual(report.sidequest.candidates, []);
  assert.equal(report.window.sessionsScanned, 0);
});


test('board mining uses default home and clock when no environment overrides are passed', (context) => {
  const options = fixture(context);
  options.env.SIDEQUEST_HOME = path.join(options.env.CLAUDE_CONFIG_DIR, 'sidequest');
  seed(options, [{ project: 'local', ref: 'SQ-4', verificationCaptures: [{ status: 'failed_check', completedAt: new Date().toISOString() }] }]);
  const environment = { ...process.env };
  context.after(() => { process.env = environment; });
  process.env.CLAUDE_CONFIG_DIR = options.env.CLAUDE_CONFIG_DIR;
  delete process.env.SIDEQUEST_HOME;
  assert.deepEqual(sidequestFriction({}, 0).candidates, []);
  const report = sidequestFriction({ projectPath: options.projectPath }, 0);
  assert.equal(report.projects[0].totals.failedVerifications, 1);
});
