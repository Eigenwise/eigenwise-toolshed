'use strict';
/**
 * Tests for repo-anchored boards + the `merge` command (SQ-94 / SQ-95).
 *
 * Older versions keyed a board on process.cwd(), so a `cd` into a subfolder of
 * a repo minted a brand-new duplicate board on that subfolder path (the
 * docai_refactored-inside-contractify case). Two fixes:
 *   - store.nearestRepoRoot() walks up to the enclosing .git so any subfolder
 *     resolves to the one repo board.
 *   - store.mergeProject() folds an existing duplicate board back into its
 *     parent, renumbering refs and remapping links so nothing collides.
 *
 * Run: node --test plugins/sidequest/test/repo-anchor-and-merge.test.js
 * (the directory form of `node --test` is broken on this Node v22/Windows setup)
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-anchor-merge-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

/* ------------------------------------------------------------------ *
 *  nearestRepoRoot
 * ------------------------------------------------------------------ */

// A throwaway directory tree, cleaned per-call, for the filesystem-walk tests.
function mkTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-repo-walk-'));
}

test('nearestRepoRoot: a nested subfolder resolves to the repo root (.git dir)', () => {
  const root = mkTree();
  fs.mkdirSync(path.join(root, '.git'));
  const deep = path.join(root, 'bin', 'docai_refactored');
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(store.nearestRepoRoot(deep), path.resolve(root));
  assert.strictEqual(store.nearestRepoRoot(root), path.resolve(root));
});

test('nearestRepoRoot: a .git *file* (worktree/submodule) counts as a repo root', () => {
  const root = mkTree();
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere/else\n');
  const deep = path.join(root, 'nested');
  fs.mkdirSync(deep);
  assert.strictEqual(store.nearestRepoRoot(deep), path.resolve(root));
});

test('nearestRepoRoot: an inner repo wins over an outer one', () => {
  const outer = mkTree();
  fs.mkdirSync(path.join(outer, '.git'));
  const inner = path.join(outer, 'vendor', 'plugin');
  fs.mkdirSync(inner, { recursive: true });
  fs.mkdirSync(path.join(inner, '.git'));
  const deep = path.join(inner, 'src');
  fs.mkdirSync(deep);
  assert.strictEqual(store.nearestRepoRoot(deep), path.resolve(inner));
});

test('nearestRepoRoot: a folder with no repo above it is returned unchanged', () => {
  const plain = mkTree(); // a fresh tmp dir with no .git anywhere in the subtree
  assert.strictEqual(store.nearestRepoRoot(plain), path.resolve(plain));
});

/* ------------------------------------------------------------------ *
 *  mergeProject
 * ------------------------------------------------------------------ */

// A one-pixel PNG so createTicket has a real image to attach and copy.
function writeTempImage() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-img-')), 'shot.png');
  fs.writeFileSync(f, Buffer.from('89504e470d0a1a0a', 'hex'));
  return f;
}

function assetFilesFor(slug, ticketId) {
  const dir = path.join(SIDEQUEST_HOME, 'projects', slug, 'assets', ticketId);
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

test('mergeProject: folds a board into another, renumbering refs above the destination', () => {
  const dest = store.ensureProject(path.join(os.tmpdir(), 'sq-fx', 'contractify'), 'contractify');
  const src = store.ensureProject(path.join(os.tmpdir(), 'sq-fx', 'contractify', 'bin', 'docai'), 'docai_refactored');

  // Give dest an existing ticket + story so its counters are non-zero: the
  // merged refs must land strictly above these.
  const destTicket = store.createTicket(dest.slug, { title: 'existing dest ticket', complexity: 1 });
  assert.strictEqual(destTicket.ref, 'SQ-1');

  // Build a source board with two linked tickets, a story, and an attached image.
  const story = store.createStory(src.slug, { title: 'docai cleanup' });
  assert.strictEqual(story.ref, 'US-1');
  const img = writeTempImage();
  const a = store.createTicket(src.slug, { title: 'src ticket A', storyId: story.ref, images: [img], complexity: 2 });
  const b = store.createTicket(src.slug, { title: 'src ticket B', complexity: 3 });
  store.linkTickets(src.slug, a.ref, 'blocks', b.ref); // A blocks B (inverse auto-set)
  assert.strictEqual(a.assets.length, 1, 'ticket A should have an attached image to move');

  const res = store.mergeProject(src.slug, dest.slug);
  assert.strictEqual(res.tickets, 2);
  assert.strictEqual(res.stories, 1);

  // Source board is gone.
  assert.ok(!fs.existsSync(path.join(SIDEQUEST_HOME, 'projects', src.slug)), 'source project dir should be deleted');

  // Dest holds the original + both merged tickets, with fresh refs above SQ-1.
  const destTickets = store.listTickets(dest.slug);
  assert.strictEqual(destTickets.length, 3);
  const movedA = destTickets.find((t) => t.id === a.id);
  const movedB = destTickets.find((t) => t.id === b.id);
  assert.ok(movedA && movedB, 'both source tickets should now live in dest');
  assert.strictEqual(movedA.ref, 'SQ-2');
  assert.strictEqual(movedB.ref, 'SQ-3');

  // The A→B link followed the renumber (its ref points at B's NEW ref).
  const linkToB = movedA.links.find((l) => l.type === 'blocks');
  assert.ok(linkToB, 'the blocks link should survive the merge');
  assert.strictEqual(linkToB.ref, movedB.ref, 'link ref must be remapped to B\'s new ref');

  // Story moved with a fresh US ref above dest\'s counter, and A still belongs to it.
  const destStories = store.listStories(dest.slug);
  const movedStory = destStories.find((s) => s.id === story.id);
  assert.ok(movedStory, 'the story should now live in dest');
  assert.strictEqual(movedStory.ref, 'US-1', 'dest had no stories, so it re-mints from US-1');
  assert.strictEqual(movedA.storyId, story.id, 'storyId (a stable id) must survive the move');

  // The attached image copied across, keyed by the (unchanged) ticket id.
  assert.strictEqual(assetFilesFor(dest.slug, a.id).length, 1, 'the attached image should be copied into dest');
});

test('mergeProject: --dry-run computes the mapping without touching disk', () => {
  const dest = store.ensureProject(path.join(os.tmpdir(), 'sq-fx2', 'parent'), 'parent-board');
  const src = store.ensureProject(path.join(os.tmpdir(), 'sq-fx2', 'parent', 'child'), 'child-board');
  store.createTicket(src.slug, { title: 'lonely ticket', complexity: 1 });

  const res = store.mergeProject(src.slug, dest.slug, { dryRun: true });
  assert.strictEqual(res.tickets, 1);
  assert.strictEqual(res.mapping.length, 1);
  assert.strictEqual(res.mapping[0].from, 'SQ-1');

  // Nothing moved: source still exists with its ticket, dest still empty.
  assert.ok(fs.existsSync(path.join(SIDEQUEST_HOME, 'projects', src.slug)), 'dry-run must not delete the source');
  assert.strictEqual(store.listTickets(src.slug).length, 1);
  assert.strictEqual(store.listTickets(dest.slug).length, 0);
});

test('mergeProject: refuses to merge a board into itself', () => {
  const p = store.ensureProject(path.join(os.tmpdir(), 'sq-fx3', 'solo'), 'solo');
  assert.throws(() => store.mergeProject(p.slug, p.slug), /same board/i);
});
