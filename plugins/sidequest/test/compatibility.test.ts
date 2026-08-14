import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'sidequest.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const mcp = require('../lib/mcp.js') as { toolDescriptors(): unknown[]; MCP_TOOLS_LIST_MAX_BYTES: number; MCP_TOOLS_LIST_HEADROOM_BYTES: number };
const MCP_DESCRIPTOR_GOLDEN = path.join(FIXTURES, 'mcp-tool-descriptors.json');

type RunResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], env: Record<string, string>, input?: string): RunResult {
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    input,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function isolatedEnv(root: string, home: string, project: string): Record<string, string> {
  return {
    CLAUDE_PLUGIN_ROOT: root,
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_CODE_SESSION_ID: 'sidequest-golden-session',
    SIDEQUEST_HOME: home,
    SIDEQUEST_DISCOVERY_DIRS: fs.mkdtempSync(path.join(os.tmpdir(), 'sq-golden-catalog-')),
  };
}

function assertCliGolden(name: string, fixture: Record<string, unknown>, env: Record<string, string>): void {
  const args = fixture.args as string[];
  const result = run(CLI, args, env);
  assert.equal(result.status, fixture.status, name);
  assert.equal(result.stderr, fixture.stderr, `${name} stderr`);
  const expectedSubstrings = fixture.stdoutContains as string[] | undefined;
  if (expectedSubstrings === undefined) {
    assert.equal(result.stdout, '', `${name} stdout should stay empty`);
    return;
  }
  for (const expected of expectedSubstrings) {
    assert.ok(result.stdout.includes(expected), `${name} stdout includes ${JSON.stringify(expected)}`);
  }
}

function configuredCommands(config: unknown): string[] {
  const commands: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
      return;
    }
    if (typeof value === 'string' && value.startsWith('node ') && value.includes('${CLAUDE_PLUGIN_ROOT}')) commands.push(value);
  };
  visit(config);
  return commands;
}

function configuredPath(command: string): string {
  const match = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}[\\/]([^"']+)/);
  assert.ok(match, `unsupported configured command: ${command}`);
  return match[1]!.replace(/[\\/]/g, path.sep);
}

function copyMarketplaceFiles(destination: string): void {
  fs.cpSync(ROOT, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(ROOT, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      if (parts.includes('src') || parts.includes('node_modules') || parts.includes('test') || parts.includes('scripts')) return false;
      if (parts[0] === 'dashboard' && (parts[1] === 'app' || parts[1] === 'e2e' || parts[1] === 'test' || parts[1] === 'test-results')) return false;
      if (relative === path.join('dashboard', 'index.html')) return false;
      return true;
    },
  });
}

test('MCP descriptors preserve tool and caller-discipline contracts', () => {
  const descriptors = mcp.toolDescriptors() as Array<{
    name: string;
    description: string;
    inputSchema: { properties?: Record<string, { description?: string; type?: string | string[]; maximum?: number }>; required?: string[] };
  }>;
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const categoryEdit = byName.get('category_edit');
  assert.deepEqual(Object.keys(categoryEdit?.inputSchema.properties ?? {}), ['id', 'project', 'profile', 'name', 'description', 'contract', 'artifactRoots', 'routeModel', 'routeEffort', 'fallbackModel', 'fallbackEffort', 'enabled', 'readonly']);
  assert.deepEqual(categoryEdit?.inputSchema.properties?.fallbackModel, { type: ['string', 'null'], description: 'null clears fallback.' });
  assert.equal(byName.size, descriptors.length);
  assert.equal(byName.has('ask'), false);
  assert.equal(byName.has('await'), false);
  assert.equal(byName.has('native_agent'), false);
  assert.deepEqual(byName.get('context_page')?.inputSchema.required, ['handle', 'cursor', 'expectedRevision']);
  assert.equal(byName.get('context_page')?.inputSchema.properties?.limit?.maximum, 16384);
  assert.match(byName.get('list')?.description ?? '', /changes\/pulse/);
  assert.equal(byName.get('changes')?.description, 'Poll ticket changes.');
  assert.match(byName.get('claim')?.description ?? '', /Claim before work/);
  assert.deepEqual(
    Object.keys(byName.get('claim')?.inputSchema.properties ?? {}).filter((name) => ['by', 'effort', 'executor', 'token', 'tokenFile'].includes(name)).sort(),
    ['by', 'effort', 'executor', 'token', 'tokenFile'],
  );
  const submit = byName.get('submit');
  assert.deepEqual(
    Object.keys(submit?.inputSchema.properties ?? {}).filter((name) => ['commit', 'verify', 'worktree'].includes(name)).sort(),
    ['commit', 'verify', 'worktree'],
  );
  assert.equal(submit?.inputSchema.properties?.force?.type, 'boolean');
  assert.match(submit?.description ?? '', /clear needs owner; force only lets owner replace candidate/);
  const rework = byName.get('rework');
  assert.equal(rework?.inputSchema.properties?.force, undefined);
  assert.match(rework?.description ?? '', /candidate owner only/);
  assert.match(byName.get('comments')?.inputSchema.properties?.full?.description as string, /Whole bodies/);
  assert.match(byName.get('release')?.inputSchema.properties?.command?.description as string, /Required for blocker\/contradiction/);
  assert.match(byName.get('release')?.inputSchema.properties?.outputTail?.description as string, /Required blocker\/contradiction/);
  assert.equal(byName.get('release')?.inputSchema.properties?.candidate?.type, 'string');
  assert.equal(byName.get('release')?.inputSchema.properties?.deliverable?.type, 'string');
  assert.match(byName.get('release')?.description ?? '', /oracle handoff/);
  assert.match(byName.get('dispatch')?.inputSchema.properties?.sharedTree?.description ?? '', /Omit to share zero-scope read-only work/);
  assert.match(byName.get('dispatch')?.inputSchema.properties?.recoveryEvidence?.description ?? '', /Recovery evidence/);

  const payload = JSON.stringify(descriptors);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  const headroom = mcp.MCP_TOOLS_LIST_MAX_BYTES - payloadBytes;
  assert.equal(`${JSON.stringify(descriptors, null, 2)}\n`, fs.readFileSync(MCP_DESCRIPTOR_GOLDEN, 'utf8'));
  assert.ok(payloadBytes <= mcp.MCP_TOOLS_LIST_MAX_BYTES, `tools/list payload is ${payloadBytes} bytes, over the ${mcp.MCP_TOOLS_LIST_MAX_BYTES}-byte budget`);
  assert.ok(headroom >= mcp.MCP_TOOLS_LIST_HEADROOM_BYTES, `tools/list headroom is ${headroom} bytes, below ${mcp.MCP_TOOLS_LIST_HEADROOM_BYTES}`);
});

test('CLI representative bytes, statuses, and removed commands match goldens', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cli-goldens.json'), 'utf8')) as Record<string, Record<string, unknown>>;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-golden-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-golden-project-'));
  const env = isolatedEnv(ROOT, home, project);
  for (const [name, expected] of Object.entries(fixture)) assertCliGolden(name, expected, env);
});

test('CLI verdict records an awaiting oracle result', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-verdict-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-verdict-project-'));
  const env = isolatedEnv(ROOT, home, project);
  const discovery = env.SIDEQUEST_DISCOVERY_DIRS!;
  fs.mkdirSync(path.join(discovery, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(discovery, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' }],
  }));
  const seed = `
    const store = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
    const { slug } = store.ensureProject(${JSON.stringify(project)});
    const ticket = store.createTicket(slug, { title: 'CLI verdict fixture', complexity: 2, complexityWhy: 'exercise the CLI oracle verdict command' });
    const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId: 'cli-verdict' });
    store.claimTicket(slug, ticket.ref, 'cli-verdict-worker', { token: prepared.token, executor: prepared.ticket.dispatchExecutor });
    store.releaseTicket(slug, ticket.ref, 'cli-verdict-worker', { releaseKind: 'oracle', oracle: 'Rank the candidates.', candidate: 'abc1234' });
    process.stdout.write(ticket.ref);
  `;
  const seeded = spawnSync(process.execPath, ['-e', seed], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(seeded.status, 0, seeded.stderr);
  const ref = seeded.stdout;
  const result = run(CLI, ['verdict', ref, '--text', 'Candidate B wins.', '--outcome', 'accepted', '--why', 'The transient is less sharp.', '--constraint', 'Keep the transient below the reference.', '--json'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'accepted');
  const repeated = run(CLI, ['verdict', ref, '--text', 'Candidate B wins.', '--outcome', 'accepted'], env);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /not awaiting an oracle verdict/i);
});

test('schema v7 rows reopen and preserve legacy question comments as plain comments', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-schema-golden-home-'));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-schema-golden-project-'));
  const env = isolatedEnv(ROOT, home, projectPath);
  const seedScript = `
    const store = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
    const db = require(${JSON.stringify(path.join(ROOT, 'lib', 'db.js'))});
    const project = store.ensureProject(${JSON.stringify(projectPath)}).slug;
    const ticket = store.createTicket(project, { title: 'legacy comment', complexity: 1, complexityWhy: 'golden schema reopen fixture' });
    const database = db.openDb(${JSON.stringify(home)});
    const raw = database.prepare('SELECT data FROM tickets WHERE id = ?').get(ticket.id);
    const data = JSON.parse(raw.data);
    data.comments = [{ id: 'legacy-question', at: '2026-01-01T00:00:00.000Z', by: 'legacy', body: 'old question row', kind: 'question' }];
    database.prepare('UPDATE tickets SET data = ? WHERE id = ?').run(JSON.stringify(data), ticket.id);
    database.close();
    process.stdout.write(JSON.stringify({ project, id: ticket.id, ref: ticket.ref }));
  `;
  const seeded = spawnSync(process.execPath, ['-e', seedScript], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(seeded.status, 0, seeded.stderr);
  const identity = JSON.parse(seeded.stdout) as { project: string; id: string; ref: string };
  const reopenScript = `
    const db = require(${JSON.stringify(path.join(ROOT, 'lib', 'db.js'))});
    const database = db.openDb(${JSON.stringify(home)});
    const schema = db.getRow(database, 'meta', 'schema_version');
    const row = db.getRow(database, 'tickets', ${JSON.stringify(identity.id)});
    database.close();
    process.stdout.write(JSON.stringify({ schema, comments: row.comments }));
  `;
  const reopened = spawnSync(process.execPath, ['-e', reopenScript], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.deepEqual(JSON.parse(reopened.stdout), {
    schema: 7,
    comments: [{ id: 'legacy-question', at: '2026-01-01T00:00:00.000Z', by: 'legacy', body: 'old question row', kind: 'question' }],
  });
});

test('configured MCP and hook entrypoints exist and spawn from the committed tree', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-entrypoint-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-entrypoint-project-'));
  const env = isolatedEnv(ROOT, home, project);
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
  const mcpEntry = mcpConfig.mcpServers.board;
  assert.ok(mcpEntry, 'board MCP server is configured');
  const mcpRelative = mcpEntry.args.find((arg) => arg.includes('${CLAUDE_PLUGIN_ROOT}'))!.replace('${CLAUDE_PLUGIN_ROOT}/', '');
  assert.equal(mcpEntry.command, 'node');
  assert.equal(fs.existsSync(path.join(ROOT, mcpRelative)), true);
  const mcpResult = run(path.join(ROOT, mcpRelative), [], env, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
  assert.equal(mcpResult.status, 0, mcpResult.stderr);
  const mcpFrames = mcpResult.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { id: number; result: { tools?: Array<{ name: string }> } });
  assert.equal(mcpFrames[0]?.id, 1);
  assert.equal(mcpFrames[1]?.id, 2);
  assert.equal(mcpFrames[1]?.result.tools?.some((tool) => tool.name === 'ask' || tool.name === 'await'), false);

  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const commands = configuredCommands(hooks);
  assert.ok(commands.length > 0);
  for (const command of commands) {
    const relative = configuredPath(command);
    const entry = path.join(ROOT, relative);
    assert.equal(fs.existsSync(entry), true, relative);
    const result = run(entry, [], env, '{}\n');
    assert.equal(result.status, 0, `${relative}: ${result.stderr}`);
  }
});

test('marketplace-shaped copy runs without source or node_modules and keeps a schema-v7 board', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-installed-copy-'));
  copyMarketplaceFiles(copy);
  assert.equal(fs.existsSync(path.join(copy, 'src')), false);
  assert.equal(fs.existsSync(path.join(copy, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(copy, 'dashboard', 'index.html')), false);
  assert.equal(fs.existsSync(path.join(copy, 'dashboard', 'dist', 'index.html')), true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-installed-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-installed-project-'));
  const env = isolatedEnv(copy, home, project);
  const help = run(path.join(copy, 'bin', 'sidequest.js'), ['--help'], env);
  assert.equal(help.status, 0, help.stderr);
  const mcp = run(path.join(copy, 'bin', 'sidequest-mcp.js'), [], env, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(mcp.stdout.includes('"ask"'), false);
  const add = run(path.join(copy, 'bin', 'sidequest.js'), ['add', '-t', 'installed smoke', '--unclassified'], env);
  assert.equal(add.status, 0, add.stderr);
  const schema = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(path.join(home, 'sidequest.db'))});process.stdout.write(String(JSON.parse(d.prepare(\"SELECT value FROM meta WHERE key='schema_version'\").get().value)));d.close();`], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(schema.status, 0, schema.stderr);
  assert.equal(schema.stdout, '7');
});
