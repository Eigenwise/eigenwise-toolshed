import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const [home, projectRoot, root] = process.argv.slice(2);
process.env.SIDEQUEST_HOME = home;
process.env.CLAUDE_PROJECT_DIR = projectRoot;
const store = require(join(root, 'plugins', 'sidequest', 'lib', 'store.js'));
const db = require(join(root, 'plugins', 'sidequest', 'lib', 'db.js'));
const database = db.openDb(home);
const first = store.ensureProject(join(projectRoot, 'alpha'), 'Alpha board');
const second = store.ensureProject(join(projectRoot, 'beta'), 'Beta board');
const archived = store.ensureProject(join(projectRoot, 'retired'), 'Retired board');
store.setProjectNotify(second.slug, false);
store.setProjectRouting(first.slug, 'enabled');
for (let index = 1; index <= 18; index += 1) {
  store.setCategory({ id: `fixture-category-${index}`, name: `Fixture category ${index}`, description: 'Synthetic settings overflow fixture.', route: { model: 'sonnet', effort: 'high' }, fallback: null, contract: '', enabled: true });
}
const story = store.createStory(first.slug, { title: 'Parity rollout', description: 'Seeded story', color: '#8c6cff' });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const todo = store.createTicket(first.slug, {
  title: 'Ship the dashboard parity suite',
  description: `# Acceptance\n\n${'Seeded **markdown** details with [a link](https://example.com).\n\n'.repeat(80)}`,
  priority: 'urgent', labels: ['acceptance', 'synthetic'], files: ['dashboard/e2e/dashboard.spec.ts'],
  category: 'general', storyId: story.id, assignee: 'you',
  imagesData: [{ name: 'fixture.png', base64: `data:image/png;base64,${png}` }], source: 'cli'
});
const doing = store.createTicket(first.slug, { title: 'Investigate stale agent claim', description: 'A blocked implementation.', status: 'doing', priority: 'high', category: 'general', assignee: 'agent', source: 'cli' });
const done = store.createTicket(first.slug, { title: 'Completed seeded work', status: 'done', priority: 'low', category: 'general', source: 'cli' });
const betaTicket = store.createTicket(second.slug, { title: 'Beta board ticket', priority: 'normal', category: 'general', source: 'cli' });
const archivedTicket = store.createTicket(first.slug, { title: 'Archived ticket', status: 'done', category: 'general', source: 'cli' });
store.archiveTicket(first.slug, archivedTicket.id, { source: 'cli' });
store.archiveProject(archived.slug);
store.addComment(first.slug, todo.id, { by: 'fixture', body: 'A regular seeded comment.', source: 'background' });
store.addComment(first.slug, doing.id, { by: 'fixture', body: 'This is a blocked comment.', source: 'background' });
store.linkTickets(first.slug, todo.ref, 'blocks', doing.ref);
store.setReminder(first.slug, todo.id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
store.claimTicket(first.slug, todo.id, 'fixture-agent', { direct: true, reason: 'Synthetic claimed fixture ticket', source: 'fixture', status: false });
const current = store.getTicket(first.slug, todo.id);
current.claim = { by: 'fixture-agent', at: new Date().toISOString() };
const blocked = store.getTicket(first.slug, doing.id);
blocked.blocked = true;
current.comments.push({ id: 'legacy-question', by: 'legacy-agent', body: 'Legacy question should render as a plain comment.', kind: 'question', source: 'background', at: new Date().toISOString() });
db.putRow(database, 'tickets', { id: blocked.id, project: first.slug, ref: blocked.ref, status: blocked.status, archived: blocked.archived ? 1 : 0, ord: blocked.order, claim_by: null, data: blocked });
db.putRow(database, 'tickets', { id: current.id, project: first.slug, ref: current.ref, status: current.status, archived: current.archived ? 1 : 0, ord: current.order, claim_by: current.claim?.by ?? null, data: current });
db.putRow(database, 'globals', { key: 'notify-prefs', data: { comment: true, created: true, status: true } });
database.close();
