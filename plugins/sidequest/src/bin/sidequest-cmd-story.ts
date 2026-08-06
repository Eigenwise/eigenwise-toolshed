const path = require('path');
const os = require('os');
const fs = require('node:fs/promises');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const store = require('../lib/store');
const agentsync = require('../lib/agentsync');
const work = require('../lib/work');
const commitScope = require('../lib/commit-scope');
const worktrees = require('../lib/worktrees');
const tempCleanup = require('../lib/temp-cleanup');
const execNames = require('../lib/exec-names');
const { claimRefusalMessage } = require('../lib/refusal-guidance');
const { assertSidequestInstall, assertDispatchTransport } = require('../lib/dispatch-preflight');

const { fail, resolveProject, workerId, bodyFromOpts } = require('./sidequest-cmd-shared');
const { PRIORITY_MARK } = require('./sidequest-cmd-tickets');
function storyTicketCount(slug: any, storyId: any) {
  return store.listTickets(slug).filter((t: any) => !t.archived && t.storyId === storyId).length;
}

async function cmdStory(opts: any, positional: any) {
  const action = (positional[0] || '').toLowerCase();
  const idOrRef = positional[1];
  const { slug, meta } = await resolveProject(opts);

  switch (action) {
    case 'add':
    case 'new':
    case 'create': {
      const title = opts.title;
      if (!title) fail('story add: --title/-t is required, e.g. sidequest story add -t "Auth revamp" [--color teal]');
      const story = store.createStory(slug, {
        title,
        description: opts.desc != null ? opts.desc : opts.description,
        color: opts.color,
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, story }, null, 2) + '\n');
        return;
      }
      console.log(`✓ ${story.ref}  "${story.title}"  [${story.color}]  — ${meta.name}`);
      return;
    }

    case 'list':
    case 'ls': {
      const stories = store.listStories(slug);
      if (opts.json) {
        const withCounts = stories.map((s: any) => Object.assign({}, s, { ticketCount: storyTicketCount(slug, s.id) }));
        process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, stories: withCounts }, null, 2) + '\n');
        return;
      }
      if (!stories.length) {
        console.log(`No user stories in ${meta.name}.`);
        return;
      }
      console.log(`${meta.name} — ${stories.length} user story/stories`);
      for (const s of stories) {
        const n = storyTicketCount(slug, s.id);
        console.log(`  ${s.ref}  [${s.color}]  ${s.title}  (${n} ticket${n === 1 ? '' : 's'})`);
      }
      return;
    }

    case 'show':
    case 'view': {
      if (!idOrRef) fail('story show: pass a story ref, e.g. sidequest story show US-1');
      const story = store.getStory(slug, idOrRef);
      if (!story) fail(`story show: no story "${idOrRef}" in ${meta.name}`);
      const tickets = store.listTickets(slug).filter((t: any) => !t.archived && t.storyId === story.id);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, story: store.storyReadPayload(story, { full: opts.full }), tickets }, null, 2) + '\n');
        return;
      }
      console.log(`${story.ref}  [${story.color}]  "${story.title}"  — ${meta.name}`);
      if (story.description) console.log(`  ${story.description}`);
      if (!tickets.length) {
        console.log('  (no tickets yet)');
        return;
      }
      console.log(`  ${tickets.length} ticket(s):`);
      for (const t of tickets) {
        const pr = PRIORITY_MARK[t.priority] ? ` ${PRIORITY_MARK[t.priority]}` : '';
        console.log(`    ${t.ref}${pr}  [${t.status}]  ${t.title}`);
      }
      return;
    }

    case 'contract': {
      if (!idOrRef) fail('story contract: pass a story ref, e.g. sidequest story contract US-1 [--body-file path]');
      const body = await bodyFromOpts(opts, 'story contract');
      const story = body === undefined
        ? store.getStory(slug, idOrRef)
        : store.updateStory(slug, idOrRef, { executionContract: body });
      if (!story) fail(`story contract: no story "${idOrRef}" in ${meta.name}`);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, story }, null, 2) + '\n');
        return;
      }
      if (body === undefined) {
        console.log(`${story.ref} execution contract revision ${story.contractRevision || 0}`);
        console.log(story.executionContract || '(no execution contract set)');
        return;
      }
      console.log(`✓ ${story.ref} execution contract revision ${story.contractRevision || 0} — ${meta.name}`);
      return;
    }

    case 'log': {
      if (!idOrRef) fail('story log: pass a story ref, e.g. sidequest story log US-1 [--body-file path]');
      const entry = await bodyFromOpts(opts, 'story log');
      if (opts.rotate && entry !== undefined) fail('story log: pass an entry or --rotate, not both');
      const by = workerId(opts);
      let story;
      let advisory = null;
      if (opts.rotate) {
        if (by !== 'orchestrator') fail('story log: --rotate requires --by orchestrator');
        story = store.rotateStoryLog(slug, idOrRef);
      } else if (entry === undefined) {
        story = store.getStory(slug, idOrRef);
      } else {
        story = store.appendStoryLogEntry(slug, idOrRef, { entry, ref: opts.ref, by });
        advisory = store.storyLogEntryAdvisory(entry);
      }
      if (!story) fail(`story log: no story "${idOrRef}" in ${meta.name}`);
      const log = store.storyDecisionLog(story, { full: opts.full });
      const payload = {
        ok: true,
        project: slug,
        projectName: meta.name,
        story: {
          ref: story.ref,
          logBytes: log.bytes,
          logCapacity: log.capacity,
          logRevision: log.revision,
          entries: log.entries,
          totalEntries: log.totalEntries,
          omittedEntries: log.omittedEntries,
          archivedEntries: log.archivedEntries,
        },
        ...(advisory ? { advisory } : {}),
      };
      if (opts.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        return;
      }
      console.log(`${story.ref} decision log revision ${log.revision} (${log.entries.length} entries)`);
      for (const item of log.entries) {
        console.log(`- #${item.seq} ${item.kind} (${item.ref || 'orchestrator'}, ${item.by}): ${item.text}`);
      }
      if (log.omittedEntries) console.log(`  ${log.omittedEntries} history entries omitted; pass --full for the complete history.`);
      if (advisory) console.log(`  ${advisory}`);
      return;
    }

    case 'update':
    case 'edit':
    case 'set': {
      if (!idOrRef) fail('story update: pass a story ref, e.g. sidequest story update US-1 -t "New title"');
      const patch: any = {};
      if (opts.title != null) patch.title = opts.title;
      if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
      if (opts.color != null) patch.color = opts.color;
      const story = store.updateStory(slug, idOrRef, patch);
      if (!story) fail(`story update: no story "${idOrRef}" in ${meta.name}`);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, project: slug, story }, null, 2) + '\n');
        return;
      }
      console.log(`✓ ${story.ref} updated  [${story.color}]  "${story.title}"  — ${meta.name}`);
      return;
    }

    case 'rm':
    case 'remove':
    case 'delete': {
      if (!idOrRef) fail('story rm: pass a story ref, e.g. sidequest story rm US-1');
      const existing = store.getStory(slug, idOrRef);
      const ok = store.deleteStory(slug, idOrRef);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok, project: slug, story: existing || null }, null, 2) + '\n');
        if (!ok) process.exitCode = 1;
        return;
      }
      if (!ok) fail(`story rm: no story "${idOrRef}" in ${meta.name}`);
      console.log(`✓ removed ${existing ? existing.ref : idOrRef} from ${meta.name} (member tickets detached)`);
      return;
    }

    default:
      fail(`story: unknown action "${positional[0] || ''}". Use add | list | show | contract | log | update | rm. Run "sidequest help".`);
  }
}

/* ------------------------------------------------------------------ *
 *  Server lifecycle
 * ------------------------------------------------------------------ */

// The installed plugin version. Compared against a running server's health
// payload so an old, still-alive server (e.g. left up from before a plugin
// update) gets recognized as stale-code and recycled instead of quietly
// going on serving a routing ladder that predates the on-disk source — see
// SQ-92. Missing/unreadable just disables the check (never a hard failure).

module.exports = { cmdStory };
