import { createRequire } from 'node:module';
import { fragmentFingerprint, parseFragment } from './fragments.mjs';
import { readRepoChangelog, releasedFragmentFingerprints } from './changelog.mjs';
import { commitSource } from './treesource.mjs';

const require = createRequire(import.meta.url);

export function publicationFragments(git, previous, commit) {
  const released = releasedFragmentFingerprints(readRepoChangelog(commitSource(git, commit)));
  const deletions = git.capture(['log', '--format=%H', '--diff-filter=D', `${previous}..${commit}`, '--', '.release/unreleased/']).split('\n').filter(Boolean);
  return [...new Set(deletions)].flatMap((revision) => deletedFragments(git, revision))
    .filter((fragment) => released.has(fragmentFingerprint(fragment)));
}

function deletedFragments(git, revision) {
  const files = git.capture(['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=D', '-r', revision, '--', '.release/unreleased/']);
  return files.split('\n').filter((file) => file.endsWith('.md'))
    .map((file) => parseFragment(file, git.showFile(`${revision}^`, file)));
}

export function emitPublishedExternalRefUpdates(repoRoot, tag, loadFragments, log = console.warn) {
  try {
    const fragments = loadFragments();
    if (!fragments.some((fragment) => fragment.refs?.length)) return;
    const store = require('../../../plugins/sidequest/lib/store.js');
    const project = store.findProject(repoRoot);
    if (!project.ok) return;
    const mode = store.boardConfig(project.slug).githubSync;
    const { emitExternalRefUpdates } = require('../../../plugins/sidequest/lib/store/external-ref-updates.js');
    for (const fragment of fragments) {
      emitExternalRefUpdates({ ref: fragment.ref, externalRefs: fragment.refs }, {
        kind: 'released', tag, mode, cwd: repoRoot,
        onFailure: (body) => store.addComment(project.slug, fragment.ref, { by: 'github-sync', body }),
      });
    }
  } catch (error) {
    log(`GitHub sync failed after ${tag} publication: ${error.message}`);
  }
}

export function emitConfirmedReleaseExternalRefs(release, repoRoot, tag, loadFragments, log, emit = emitPublishedExternalRefUpdates) {
  if (release.status === 'published') emit(repoRoot, tag, loadFragments, log);
}
