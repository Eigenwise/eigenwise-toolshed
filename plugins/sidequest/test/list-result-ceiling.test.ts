import './_sidequest-install-fixture.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-list-ceiling-board-'));
process.env.CLAUDE_PROJECT_DIR = projectPath;
process.env.CLAUDE_CODE_SESSION_ID = `list-ceiling-${process.pid}`;
execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: projectPath, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: projectPath, windowsHide: true });

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');

const MCP_RESULT_CEILING_BYTES = 70 * 1024;

let requestId = 0;
async function listResult(args: Record<string, unknown>) {
  const response = await mcp.handleRequest({
    jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
    params: { name: 'list', arguments: args },
  });
  return response.result;
}

// GH-829: rows whose brief projection spans many lines were costed at top-level indent but emitted
// nested inside the page object, so a default page overshot the ceiling and the read threw.
test('every default list page fits the MCP ceiling and the cursor walks the whole board', async () => {
  const project = store.ensureProject(projectPath).slug;
  const ticketCount = 120;
  const externalReferences = Array.from({ length: 100 }, (_, index) => `ABC-${1000 + index}`);
  for (let index = 0; index < ticketCount; index += 1) {
    store.createTicket(project, {
      title: `Busy board row ${index} with a long title that carries real words ${'w'.repeat(120)}`,
      refs: externalReferences,
    });
  }

  const seen: string[] = [];
  let cursor: string | null | undefined;
  let pages = 0;
  do {
    const result = await listResult(cursor ? { project, cursor } : { project });
    const text = result.content[0].text;
    assert.ok(!result.isError, text);
    const bytes = Buffer.byteLength(text, 'utf8');
    assert.ok(bytes <= MCP_RESULT_CEILING_BYTES, `page ${pages} is ${bytes} bytes`);
    const page = JSON.parse(text);
    assert.equal(page.ticketsTotal, undefined, `page ${pages} was cut after projection instead of being paged`);
    for (const row of page.tickets) seen.push(row.ref);
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages <= ticketCount, 'paging terminates');
  } while (cursor);

  assert.equal(seen.length, ticketCount);
  assert.equal(new Set(seen).size, ticketCount);
  assert.ok(pages >= 2, `the board took ${pages} page(s)`);
});
