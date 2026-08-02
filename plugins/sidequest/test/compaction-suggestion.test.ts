import './_temp-cleanup.js';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-compaction-test-'));
process.env.SIDEQUEST_HOME = HOME;

const store = require('../lib/store.js');
const boardPath = path.join(HOME, 'board');
fs.mkdirSync(boardPath, { recursive: true });
const { slug } = store.ensureProject(boardPath);
const hooks = path.join(__dirname, '..', 'hooks');
const stopHook = path.join(hooks, 'compaction-suggestion.js');
const postCompactHook = path.join(hooks, 'post-compact.js');

function hook(script: string, payload: unknown, env: Record<string, string> = {}): any {
  const output = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
  return output ? JSON.parse(output) : null;
}

function closeTicket(title: string): any {
  const ticket = store.createTicket(slug, { title, source: 'test' });
  assert.equal(store.completeTicket(slug, ticket.ref, 'test-worker').ok, true);
  return ticket;
}

function stop(sessionId: string, transcriptPath: string, env: Record<string, string> = {}): any {
  return hook(stopHook, {
    session_id: sessionId,
    cwd: boardPath,
    transcript_path: transcriptPath,
    last_assistant_message: 'Finished the last task.',
  }, env);
}
