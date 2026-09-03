'use strict';

const { reviewCandidateFromSubmission, sameReviewCandidate, reviewRelationFor, reviewRelationRef } = require('../kernel/review-binding');

function createTickets(dependencies: any) {
  const {
    EXECUTOR_ANCHORS_MAX, EXECUTOR_VERIFY_MAX, acquireLock, assetPath, assetsDir, boardConfig,
    claimReclaimable, coerceComplexity, coercePriority, commitScope, copyAsset, createComment,
    database, deleteCachedRow, dispatchState, dispatchVerifyCommandError, effectiveScope, execFileSync, executorText, fs,
    getCategory, getStory, getTicket, listTickets, makeWorkedBy, newTicketId, nextSeq, normalizeRoute, path, pendingSubmission, putTicket,
    queryTickets, queueEventNotification, readMeta, readyTickets, releaseLock,
    requestedReadonlyOverride, requireStatus, requireVerifyOracle, normalizeVerifyOracleKind, saveAssetData, stripLinksTo,
    ticketLockPath, ticketStoryId, touchClaimActivity, transaction, upperRef, withTicketLock,
  } = dependencies;
  const coerceStoryId = ticketStoryId;

function submissionReviewRelation(slug?: any, sourceTicket?: any) {
  return reviewRelationFor(sourceTicket, listTickets(slug), (idOrRef: string) => getTicket(slug, idOrRef));
}

function terminallySubmitted(ticket?: any) {
  const state = dispatchState(ticket);
  return Boolean(
    (state?.terminalAt && state.outcome === 'submitted')
    || ticket?.lifecycleAttempt?.state === 'submitted',
  );
}

// Test-only crash seam sitting exactly between the review write and the source
// mirror write, so a suite can prove the pair rolls back together instead of
// leaving the half-bound state this contract exists to make impossible.
function injectedReviewBindingFault(stage: string) {
  if (String(process.env.SIDEQUEST_TEST_REVIEW_BINDING_FAULT || '').trim() !== stage) return;
  throw new Error(`injected review binding fault after the ${stage} write`);
}

function categoryReadOnly(ticket?: any) {
  return ticket?.category?.readonly === true;
}

function readOnlyOverrideActive(ticket?: any) {
  return typeof ticket?.readonlyOverride === 'boolean';
}

function dispatchReadOnly(ticket?: any) {
  return typeof ticket?.readonlyOverride === 'boolean' ? ticket.readonlyOverride : categoryReadOnly(ticket);
}

function normalizedTicketRoute(route?: any) {
  if (route == null) return null;
  const normalized = normalizeRoute(route);
  if (!normalized) throw new Error('Ticket route override requires a valid model and effort.');
  return normalized;
}

function authoringVerifyError(ticket?: any, projectPath?: any) {
  const error = dispatchVerifyCommandError(ticket, projectPath);
  return error && /(?:requires .*package\.json|requires a `[^`]+` script)/.test(error) ? error : null;
}

function storyLogRevision(slug?: any, storyId?: any) {
  const story = storyId ? getStory(slug, storyId) : null;
  return Number(story?.logRevision) || 0;
}

function normalizedReviewTarget(slug: any, reviewTicket: any, requested: any) {
  if (!requested || typeof requested !== 'object') {
    throw new Error('reviewTarget requires ref plus the exact submitted candidate');
  }
  const targetRef = String(requested.ref || '').trim().toUpperCase();
  if (!targetRef) throw new Error('reviewTarget.ref is required');
  const sourceTicket = getTicket(slug, targetRef);
  if (!sourceTicket) throw new Error(`reviewTarget.ref ${targetRef} does not exist`);
  if (sourceTicket.id === reviewTicket?.id) throw new Error(`${reviewTicket.ref} cannot review its own submission`);
  if (sourceTicket.claim?.by) {
    throw new Error(`reviewTarget ${sourceTicket.ref} is still live-claimed by ${sourceTicket.claim.by}; it must submit and release before review binds`);
  }
  if (!pendingSubmission(sourceTicket) || !terminallySubmitted(sourceTicket)) {
    throw new Error(`reviewTarget ${sourceTicket.ref} has no claim-free terminal submission to review`);
  }
  const candidate = reviewCandidateFromSubmission(sourceTicket.submission);
  if (!candidate) throw new Error(`reviewTarget ${sourceTicket.ref} has no immutable candidate identity`);
  const requestedCommit = String(requested.commit || '').trim().toLowerCase();
  const requestedRevision = requested.sourceRevision && typeof requested.sourceRevision === 'object'
    ? { source: String(requested.sourceRevision.source || '').trim(), value: String(requested.sourceRevision.value || '').trim() }
    : null;
  const hasCommit = Boolean(requestedCommit);
  const hasRevision = Boolean(requestedRevision?.source && requestedRevision.value);
  if (hasCommit === hasRevision) throw new Error('reviewTarget requires exactly one of commit or sourceRevision');
  if (!sameReviewCandidate(candidate, hasCommit ? { source: 'git', value: requestedCommit } : requestedRevision)) {
    throw new Error(`reviewTarget ${sourceTicket.ref} candidate does not match its submitted ${candidate.source}:${candidate.value}`);
  }
  const relation = submissionReviewRelation(slug, sourceTicket);
  if (relation && (relation.conflict || !reviewTicket?.id || relation.reviewTicket?.id !== reviewTicket.id)) {
    throw new Error(`reviewTarget ${sourceTicket.ref} candidate is already bound to ${reviewRelationRef(relation)}`);
  }
  return {
    sourceTicket,
    target: {
      ticketId: sourceTicket.id,
      ref: sourceTicket.ref,
      candidate,
      submittedAt: sourceTicket.submission.at,
      submittedBy: sourceTicket.submission.by,
      ...(sourceTicket.submission.gitRef ? { gitRef: sourceTicket.submission.gitRef } : {}),
    },
  };
}

// The one authoritative review-binding transition. The review's reviewTarget and
// the source submission's review mirror are two halves of a single fact, so both
// rows commit inside one storage transaction: a fault between them rolls the
// review write back with the mirror and leaves neither side bound.
function bindReviewTarget(slug: any, reviewTicket: any, requested: any, persistReview: any) {
  const category = String(reviewTicket?.category?.id || reviewTicket?.category || '').trim().toLowerCase();
  if (requested === undefined) {
    persistReview(reviewTicket);
    return reviewTicket;
  }
  if (category !== 'review-audit') throw new Error('reviewTarget is only valid for category review-audit');
  const bound = normalizedReviewTarget(slug, reviewTicket, requested);
  const previousTarget = reviewTicket.reviewTarget || null;
  // Immutable means the whole identity, not just the candidate value: two
  // tickets can submit the same commit, so retargeting across them must refuse.
  if (previousTarget
    && (previousTarget.ticketId !== bound.target.ticketId || !sameReviewCandidate(previousTarget.candidate, bound.target.candidate))) {
    throw new Error(`${reviewTicket.ref} reviewTarget is immutable; retarget needs a fresh review ticket`);
  }
  const now = new Date().toISOString();
  try {
    transaction(() => {
      reviewTicket.reviewTarget = bound.target;
      persistReview(reviewTicket);
      injectedReviewBindingFault('review');
      const sourceTicket = getTicket(slug, bound.sourceTicket.id);
      if (!sourceTicket?.submission) throw new Error(`reviewTarget ${bound.target.ref} lost its submission mid-binding`);
      const mirror = sourceTicket.submission.review;
      sourceTicket.submission.review = {
        ticketId: reviewTicket.id,
        ref: reviewTicket.ref,
        candidate: bound.target.candidate,
        createdAt: mirror?.createdAt || now,
        outcome: mirror?.outcome || 'planned',
      };
      sourceTicket.updatedAt = now;
      putTicket(slug, sourceTicket);
    });
  } catch (error: any) {
    if (previousTarget) reviewTicket.reviewTarget = previousTarget;
    else delete reviewTicket.reviewTarget;
    throw error;
  }
  return reviewTicket;
}

// Deliberately not withTicketLock: that helper runs its callback inside
// transaction(), which would make the transition's own boundary a reentrant
// no-op and hand the atomicity guarantee to the caller. The binding owns its
// boundary, so the source lock here is mutual exclusion only.
function withSourceTicketLock(slug: any, sourceId: any, fn: any) {
  const lock = ticketLockPath(slug, sourceId);
  const locked = acquireLock(lock); // best-effort, matching the per-ticket update lock
  try {
    return fn();
  } finally {
    if (locked) releaseLock(lock, locked);
  }
}

function persistWithReviewBinding(slug: any, ticket: any, requested: any) {
  const persistReview = (review: any) => putTicket(slug, review);
  const targetRef = requested === undefined ? '' : String(requested?.ref || '').trim().toUpperCase();
  const sourceTicket = targetRef ? getTicket(slug, targetRef) : null;
  if (!sourceTicket) return bindReviewTarget(slug, ticket, requested, persistReview);
  const bound = withSourceTicketLock(slug, sourceTicket.id, () => bindReviewTarget(slug, ticket, requested, persistReview));
  queueEventNotification(slug, getTicket(slug, sourceTicket.id), 'status', ticket.lastEventSource || 'cli');
  return bound;
}

function createTicket(slug?: any, fields?: any, reviewTarget?: any) {
  fields = fields || {};
  if (Object.hasOwn(fields, 'reviewTarget')) {
    throw new Error('generic ticket fields cannot set reviewTarget; pass the review target transition separately');
  }
  const status = fields.status === undefined ? 'todo' : requireStatus(fields.status);
  const id = newTicketId();
  const seq = nextSeq(slug);
  const ref = `SQ-${seq}`;
  const now = new Date().toISOString();

  const assets: any[] = [];
  const imgs = Array.isArray(fields.images) ? fields.images : [];
  for (const src of imgs) {
    try {
      assets.push(copyAsset(slug, id, src));
    } catch (e: any) {
      // Record which image could not be attached; the CLI surfaces this.
      if (fields.onAssetError) fields.onAssetError(src, e);
    }
  }
  for (const d of asDataImages(fields.imagesData)) {
    try {
      assets.push(saveAssetData(slug, id, d.name, d.buffer));
    } catch (_: any) {
      /* skip a bad upload */
    }
  }

  requireVerifyOracle(fields.executorVerifyKind, fields.executorVerify, fields.executorAttestationArtifact);
  const executorVerify = executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command');
  const executorVerifyKind = normalizeVerifyOracleKind(fields.executorVerifyKind, executorVerify);
  const storyId = coerceStoryId(slug, fields.storyId);
  const ticket = {
    id,
    ref,
    title: String(fields.title || 'Untitled').trim().slice(0, 300) || 'Untitled',
    description: String(fields.description || '').trim(),
    status,
    priority: coercePriority(fields.priority, 'normal'),
    labels: boundedLabels(fields.labels),
    highStakes: !!fields.highStakes,
    storyId, // the user story this ticket belongs to (null = none)
    storyLogSeenSeq: storyLogRevision(slug, storyId),
    category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
    route: normalizedTicketRoute(fields.route),
    complexity: coerceComplexity(fields.complexity), // 1..10 score the routing is derived from (entry points require it)
    complexityWhy: String(fields.complexityWhy || '').trim().slice(0, 1000), // the mandatory motivation for the score
    files: boundedFiles(fields.files, {
      category: fields.category,
      readonlyOverride: requestedReadonlyOverride(fields),
      slug,
      ticketRef: ref,
      operation: 'add',
    }),          // declared file scope, for parallel-wave planning
    contracts: boundedContracts(fields.contracts), // declared contract edges, for parallel-wave planning
    contractWaiver: !!fields.contractWaiver,
    readonlyOverride: requestedReadonlyOverride(fields),
    workingTreeDelivery: fields.workingTreeDelivery === true,
    externalDeliverable: fields.externalDeliverable === true,
    executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors'),
    executorVerifyKind,
    executorAttestationArtifact: executorText(fields.executorAttestationArtifact, EXECUTOR_VERIFY_MAX, 'executor attestation artifact'),
    executorVerify,
    assets,
    comments: [],              // [{ id, by, body, kind: 'comment', at }]
    links: [],                 // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,               // { by, at } when an agent has claimed it to work on
    checkpoint: null,
    dispatchNonce: null,
    dispatchExecutor: null,
    directClaim: null,
    assignee: normalizeAssignee(fields.assignee), // who it's assigned to (usually the human "you"); distinct from an agent claim
    archived: false,           // hidden from the board (kept, restorable) once true
    archivedAt: null,
    source: String(fields.source || 'manual'),
    // Who/what last touched this ticket, and how. The dashboard uses these to
    // decide whether a change was made by the user (source "dashboard") or by
    // Claude/the CLI in the background, and whether it was a status change.
    lastEventType: 'created',
    lastEventSource: String(fields.source || 'manual'),
    createdAt: now,
    updatedAt: now,
    referenceUpdatedAt: now,
    order: Date.now(),
  };
  const verifyError = authoringVerifyError(ticket, readMeta(slug)?.path);
  if (verifyError) throw new Error(`${verifyError} Keep acceptance criteria in a comment, not the verify field.`);
  persistWithReviewBinding(slug, ticket, reviewTarget);
  queueEventNotification(slug, ticket, 'created', ticket.lastEventSource);
  return ticket;
}

// Decode an optional [{ name, base64 }] list (dashboard image paste/drop) into
// [{ name, buffer }]. Data-URL prefixes are stripped. Bad entries are dropped.
function asDataImages(list?: any) {
  if (!Array.isArray(list)) return [];
  const out: any[] = [];
  for (const d of list) {
    if (!d || typeof d.base64 !== 'string') continue;
    const b64 = d.base64.replace(/^data:[^;]+;base64,/, '');
    try {
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length) out.push({ name: d.name, buffer });
    } catch (_: any) {
      /* skip */
    }
  }
  return out;
}

function normalizeLabels(labels?: any) {
  if (!labels) return [];
  const arr = Array.isArray(labels) ? labels : String(labels).split(',');
  const seen = new Set();
  const out: any[] = [];
  for (const l of arr) {
    const v = String(l).trim().slice(0, 40);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

// A ticket's declared file scope drives wave planning and gates repository commits
// submitted through the Sidequest executor path. Normalizing never drops entries:
// a truncated scope silently un-approves paths the caller declared, and the commit
// gate then refuses them as out of scope (SQ-900). List bounds belong on the write
// path, where the caller can be told to re-scope.
function normalizeFiles(files?: any) {
  if (!files) return [];
  const arr = Array.isArray(files) ? files : String(files).split(',');
  const seen = new Set();
  const out: any[] = [];
  for (const f of arr) {
    const v = String(f).trim().replace(/\\/g, '/').replace(/\/+$/, '').slice(0, 200);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

function isVerificationEvidencePath(file: any, evidenceDirectory: any, ticketRef?: any) {
  const directory = String(evidenceDirectory || '').trim();
  const requestedPath = String(file || '').trim();
  if (!requestedPath) return false;
  if (directory) {
    const relative = path.relative(path.resolve(directory), path.resolve(requestedPath));
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return true;
  }
  const normalizedPath = requestedPath.replace(/\\/g, '/').toLowerCase();
  const normalizedRef = String(ticketRef || '').trim().toLowerCase();
  return Boolean(
    normalizedRef
    && normalizedPath.includes(normalizedRef)
    && normalizedPath.split('/').some((segment: string) => ['artifacts', 'evidence', 'verification'].includes(segment)),
  );
}

function verificationEvidenceGuidance(evidenceDirectory: any, evidencePaths: any[]) {
  if (!evidencePaths.length) return '';
  const subject = evidencePaths.length === 1 ? 'The refused path is' : 'The refused paths are';
  return ` ${subject} board-owned verification evidence: ${evidencePaths.join(', ')}. Verification evidence belongs in ${evidenceDirectory}; do not request or commit it inside the repository.`;
}

function declaredScopeGuidance(ticket: any, refusedPaths: any[]) {
  if (!refusedPaths.length || !normalizeFiles(ticket.files).length) return '';
  const subject = refusedPaths.length === 1 ? 'The refused path is' : 'The refused paths are';
  return ` ${subject} outside this ticket's declared files: ${refusedPaths.join(', ')}. The orchestrator has to declare them (\`sidequest update ${ticket.ref} --file <path>\`) and redispatch.`;
}

const DECLARED_FILES_MAX = 100;
const CONTRACT_NAMES_MAX = 40;
const LABELS_MAX = 24;

function boundedList(values?: any, max?: any, label?: any, guidance?: any) {
  if (values.length > max) {
    throw new Error(`${label} accepts at most ${max} entries; this write declared ${values.length} (${values.length - max} over). ${guidance}`);
  }
  return values;
}

function externalOutputAllowed(context?: any) {
  if (typeof context?.readonlyOverride === 'boolean') return context.readonlyOverride;
  return getCategory(context?.category, { project: context?.slug })?.readonly === true;
}

function boundedFiles(files?: any, context?: any) {
  const declaredFiles = boundedList(
    normalizeFiles(files),
    DECLARED_FILES_MAX,
    'declared file scope',
    'Re-scope with directory entries: a declared directory covers every path under it (e.g. plugins/sidequest/test instead of each test file).',
  );
  const outside = commitScope.validateRelativeScopes(declaredFiles).outside;
  if (outside.length && !externalOutputAllowed(context)) {
    throw new Error(`declared file scope contains paths outside the repo worktree: ${outside.join(', ')}. For genuine non-repo output, classify as non-repo/artifact work; otherwise declare in-repo paths.`);
  }
  const foreignReleaseFragments = commitScope.foreignReleaseFragmentScopePaths(declaredFiles, context?.ticketRef);
  if (foreignReleaseFragments.length) {
    throw new Error(commitScope.foreignReleaseFragmentRefusalMessage(context?.operation || 'declared file scope', context?.ticketRef, foreignReleaseFragments));
  }
  return declaredFiles;
}

function boundedLabels(labels?: any) {
  return boundedList(normalizeLabels(labels), LABELS_MAX, 'labels', 'Labels route and filter work; drop the ones that do neither.');
}

function scopeExpansionFiles(ticket?: any, additions?: any) {
  return normalizeFiles([...(Array.isArray(ticket?.files) ? ticket.files : []), ...normalizeFiles(additions)]);
}

function scopeResolution(slug?: any, ticket?: any, request?: any, state?: any, now?: any, granted?: any, refused?: any) {
  const resolution = {
    state,
    by: request?.by || null,
    requestAt: request?.at || null,
    requested: normalizeFiles(request?.requested || request?.files),
    granted: normalizeFiles(granted),
    refused: normalizeFiles(refused),
    effectiveScope: [] as string[],
    at: now || new Date().toISOString(),
  };
  ticket.scopeResolution = resolution;
  resolution.effectiveScope = effectiveScope(slug, ticket);
}

function syncLiveDispatchScope(slug?: any, ticket?: any) {
  const dispatch = dispatchState(ticket);
  if (!dispatch || dispatch.terminalAt) return;
  const scope = effectiveScope(slug, ticket);
  // The implicit release fragment is granted by the dispatch, not declared on the
  // ticket, so a refresh that only re-read ticket.files would revoke it.
  const refreshed = dispatch.artifactMode ? scope : commitScope.ticketCommitScope(scope, ticket?.files, ticket?.ref);
  // A shared-tree dispatch's binding preserves the submit gate after a caller
  // sheds ticket scope; isolated worktrees may instead shed their private scope.
  dispatch.declaredFiles = dispatch.sharedTree === false
    ? refreshed
    : normalizeFiles([...(Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : []), ...refreshed]);
}

function scopeExpansionCommand(ticket?: any, additions?: any) {
  const ref = String(ticket?.ref || '').trim();
  if (!ref) return null;
  return `sidequest update ${ref} --files ${JSON.stringify(scopeExpansionFiles(ticket, additions).join(','))}`;
}

const TEST_DIRECTORY_NAMES = ['test', 'tests', 'spec', 'specs', '__tests__'];

function repoRelative(file?: any) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// The test directories a ticket may widen into without asking: the ones sitting
// beside a file it already declares, anywhere from that file's own folder up to
// the repo root. A ticket that owns plugins/x/src/y.ts reaches plugins/x/test,
// and one that owns src/synth.cpp reaches the repo's tests/ — but neither
// reaches the other's.
function reachableTestRoots(ticket?: any, slug?: any) {
  const repo = readMeta(slug)?.path;
  if (!repo) return [];
  const roots = new Map<string, string>();
  for (const declared of normalizeFiles(ticket?.files)) {
    const segments = repoRelative(declared).split('/').filter(Boolean);
    segments.pop();
    for (let depth = segments.length; depth >= 0; depth--) {
      const parent = segments.slice(0, depth);
      for (const name of TEST_DIRECTORY_NAMES) {
        const candidate = [...parent, name].join('/');
        if (roots.has(candidate.toLowerCase())) continue;
        try {
          if (fs.statSync(path.join(repo, ...parent, name)).isDirectory()) roots.set(candidate.toLowerCase(), candidate);
        } catch (_) { /* not a test root here */ }
      }
    }
  }
  return [...roots.values()];
}

function enclosingTestRoot(file?: any, roots?: any) {
  const target = repoRelative(file).toLowerCase();
  return (roots || []).find((root: string) => {
    const prefix = root.toLowerCase();
    return target === prefix || target.startsWith(`${prefix}/`);
  }) || null;
}

// Asking a ticket to name every test file it will touch before the work starts
// is a prediction, and it kept being wrong: the executor stops mid-run, the
// orchestrator wakes to rule on `tests/`, and the round trip buys nothing a
// commit-time check does not already catch. Widening into a test directory the
// ticket already reaches is audited, not gated.
function autoApprovedTestScope(ticket?: any, requested?: any, additions?: any, slug?: any) {
  if (!boardConfig(slug)?.autoApproveTestScope) return null;
  const roots = reachableTestRoots(ticket, slug);
  if (!roots.length) return null;
  const requestedRoots = normalizeFiles(requested).map((file?: any) => enclosingTestRoot(file, roots));
  if (!requestedRoots.length || requestedRoots.some((root?: any) => !root)) return null;
  return normalizeFiles(normalizeFiles(additions).map((file?: any) => enclosingTestRoot(file, roots)).filter(Boolean));
}

const SOURCE_FILE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.cs', '.go', '.js', '.jsx', '.py', '.rs', '.ts', '.tsx']);

function isSourceFile(file?: any) {
  return SOURCE_FILE_EXTENSIONS.has(path.extname(repoRelative(file)).toLowerCase());
}

function buildRegistrationCandidates(source?: any) {
  const extension = path.extname(repoRelative(source)).toLowerCase();
  if (extension === '.cs') return ['*.csproj', '*.vcxproj'];
  if (extension === '.go') return ['go.mod'];
  if (extension === '.py') return ['pyproject.toml', 'setup.py', '__init__.py'];
  if (extension === '.rs') return ['Cargo.toml', 'mod.rs'];
  if (extension === '.ts' || extension === '.tsx' || extension === '.js' || extension === '.jsx') return ['package.json', 'index.ts', 'index.js'];
  return ['CMakeLists.txt'];
}

function registrationFileAt(repo?: any, parent?: any, candidate?: any) {
  if (candidate === '*.csproj' || candidate === '*.vcxproj') {
    try {
      const suffix = candidate.slice(1).toLowerCase();
      return fs.readdirSync(path.join(repo, ...parent)).find((name: string) => name.toLowerCase().endsWith(suffix)) || null;
    } catch (_) {
      return null;
    }
  }
  try {
    return fs.statSync(path.join(repo, ...parent, candidate)).isFile() ? candidate : null;
  } catch (_) {
    return null;
  }
}

function governingBuildRegistrationFile(source?: any, slug?: any) {
  const repo = readMeta(slug)?.path;
  if (!repo || !isSourceFile(source)) return null;
  const segments = repoRelative(source).split('/').filter(Boolean);
  segments.pop();
  for (let depth = segments.length; depth >= 0; depth--) {
    const parent = segments.slice(0, depth);
    for (const candidate of buildRegistrationCandidates(source)) {
      const name = registrationFileAt(repo, parent, candidate);
      if (name) return [...parent, name].join('/');
    }
  }
  return null;
}

function autoApprovedBuildRegistrationScope(ticket?: any, additions?: any, slug?: any) {
  const requested = normalizeFiles(additions);
  if (!requested.length) return null;
  const registrations = new Map<string, string>();
  for (const source of normalizeFiles(ticket?.files)) {
    const registration = governingBuildRegistrationFile(source, slug);
    if (registration) registrations.set(registration.toLowerCase(), registration);
  }
  if (!registrations.size || requested.some((file?: any) => !registrations.has(repoRelative(file).toLowerCase()))) return null;
  return requested.map((file?: any) => registrations.get(repoRelative(file).toLowerCase()));
}

function globExpression(pattern?: any) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`, process.platform === 'win32' ? 'i' : '');
}

function autoApprovedScopePaths(ticket?: any, additions?: any, slug?: any) {
  const patterns = boardConfig(slug)?.autoApproveScope || [];
  if (!patterns.length) return [];
  const expressions = patterns.map((pattern: string) => globExpression(pattern));
  return normalizeFiles(additions).filter((file?: any) => expressions.some((expression: RegExp) => expression.test(repoRelative(file))));
}

const PACKAGE_SURFACE_CONTAINERS = new Set(['apps', 'crates', 'packages', 'plugins', 'services']);
const PACKAGE_SURFACE_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'CMakeLists.txt'];
const PACKAGE_MANIFESTS = new Set([...PACKAGE_SURFACE_MARKERS.map((name: string) => name.toLowerCase()), 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const CONTROL_PATH_SEGMENTS = new Set(['.claude', '.claude-plugin', '.circleci', '.github', '.gitlab', '.buildkite', '.changeset']);
const ROOT_RELEASE_DIRECTORIES = new Set(['release', 'releases']);
const CONTINUOUS_INTEGRATION_FILENAMES = new Set(['appveyor.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'jenkinsfile']);
const CREDENTIAL_FILENAMES = new Set(['.npmrc', '.pypirc', 'credentials.json', 'credentials.toml', 'credentials.yaml', 'credentials.yml', 'id_ed25519', 'id_rsa', 'secrets.json', 'secrets.toml', 'secrets.yaml', 'secrets.yml']);

function containsScopePattern(file?: any) {
  return /[*?\[\]{}!]/.test(repoRelative(file));
}

function protectedAutoApprovalPath(file?: any) {
  const normalized = repoRelative(file).toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) || '';
  const firstSegment = segments[0] || '';
  if (!segments.length || segments.some((segment: string) => CONTROL_PATH_SEGMENTS.has(segment))) return true;
  if (ROOT_RELEASE_DIRECTORIES.has(firstSegment)) return true;
  if (PACKAGE_MANIFESTS.has(basename) || CONTINUOUS_INTEGRATION_FILENAMES.has(basename) || CREDENTIAL_FILENAMES.has(basename)) return true;
  if (basename === '.env' || basename.startsWith('.env.') || /\.(key|p12|pem|pfx)$/.test(basename)) return true;
  return firstSegment === 'scripts' && /^(cut|publish|release)([.-]|$)/.test(basename);
}

function workspacePackageRoot(file?: any) {
  const segments = repoRelative(file).split('/').filter(Boolean);
  const firstSegment = segments[0] || '';
  return segments.length > 1 && PACKAGE_SURFACE_CONTAINERS.has(firstSegment.toLowerCase())
    ? segments.slice(0, 2).join('/')
    : null;
}

function directoryHasPackageMarker(repository?: any, segments?: any) {
  const directory = path.join(repository, ...segments);
  for (const marker of PACKAGE_SURFACE_MARKERS) {
    try {
      if (fs.statSync(path.join(directory, marker)).isFile()) return true;
    } catch (_) {}
  }
  try {
    return fs.readdirSync(directory).some((name: string) => /\.(csproj|vcxproj)$/i.test(name));
  } catch (_) {
    return false;
  }
}

function packageSurfaceRoot(file?: any, slug?: any) {
  const workspaceRoot = workspacePackageRoot(file);
  if (workspaceRoot) return workspaceRoot;
  const repository = readMeta(slug)?.path;
  if (!repository) return null;
  const segments = repoRelative(file).split('/').filter(Boolean);
  try {
    if (!fs.statSync(path.join(repository, ...segments)).isDirectory()) segments.pop();
  } catch (_) {
    segments.pop();
  }
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const parent = segments.slice(0, depth);
    if (directoryHasPackageMarker(repository, parent)) return parent.join('/') || '.';
  }
  return null;
}

function packageRelativeSegments(file?: any, packageRoot?: any) {
  const segments = repoRelative(file).split('/').filter(Boolean);
  if (packageRoot === '.') return segments;
  const rootSegments = repoRelative(packageRoot).split('/').filter(Boolean);
  return segments.slice(rootSegments.length);
}

function packageSurfaceName(file?: any, packageRoot?: any) {
  return packageRelativeSegments(file, packageRoot)[0]?.toLowerCase() || null;
}

function declaredPackageSurfaces(ticket?: any, slug?: any) {
  const surfaces = new Map<string, Set<string>>();
  for (const file of normalizeFiles(ticket?.files)) {
    if (containsScopePattern(file) || protectedAutoApprovalPath(file)) continue;
    const root = packageSurfaceRoot(file, slug);
    const surface = root == null ? null : packageSurfaceName(file, root);
    if (!root || !surface) continue;
    const rootKey = root.toLowerCase();
    const rootSurfaces = surfaces.get(rootKey) || new Set<string>();
    rootSurfaces.add(surface);
    surfaces.set(rootKey, rootSurfaces);
  }
  return surfaces;
}

function autoApprovedPackageScope(ticket?: any, additions?: any, slug?: any) {
  if (dispatchReadOnly(ticket) || dispatchState(ticket)?.readonly === true) return [];
  const testScopeDisabled = boardConfig(slug)?.autoApproveTestScope === false;
  const testRoots = testScopeDisabled ? reachableTestRoots(ticket, slug) : [];
  const declaredSurfaces = declaredPackageSurfaces(ticket, slug);
  if (!declaredSurfaces.size) return [];
  return normalizeFiles(additions).filter((file?: any) => {
    if (containsScopePattern(file) || protectedAutoApprovalPath(file) || enclosingTestRoot(file, testRoots)) return false;
    const root = packageSurfaceRoot(file, slug);
    const surface = root == null ? null : packageSurfaceName(file, root);
    return root != null && surface != null && declaredSurfaces.get(root.toLowerCase())?.has(surface) === true;
  });
}

function requestScope(slug?: any, idOrRef?: any, by?: any, files?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    const held = t.claim;
    if (!held || !held.by) return { ok: false, reason: 'not_claimed', ticket: t };
    if (held.by !== by && !opts.force) return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    const requested = normalizeFiles(files);
    if (!requested.length) return { ok: false, reason: 'files_required', ticket: t };
    const evidenceDirectory = String(t.dispatch?.evidenceDirectory || '').trim();
    const requestedEvidencePaths = requested.filter((file?: any) => isVerificationEvidencePath(file, evidenceDirectory, t.ref));
    const validation = commitScope.validateRelativeScopes(requested);
    if (!validation.ok) {
      const refusalMessage = `Scope expansion refused: ${validation.outside.join(', ')}.`;
      return {
        ok: false,
        reason: 'invalid_scope',
        ticket: t,
        paths: validation.outside,
        ...(requestedEvidencePaths.length ? {
          message: `${refusalMessage}${verificationEvidenceGuidance(evidenceDirectory, requestedEvidencePaths)}`,
        } : {}),
      };
    }
    const foreignReleaseFragments = commitScope.foreignReleaseFragmentScopePaths(requested, t.ref);
    const isForeignReleaseFragmentScope = (file?: any) => foreignReleaseFragments.some((fragment: string) => (
      commitScope.isInScope(file, [fragment]) && commitScope.isInScope(fragment, [file])
    ));
    // Match the commit gate (submissions.ts), which admits the ticket's own release
    // fragment implicitly; asking for it back must read as covered, not as an addition.
    const scope = commitScope.ticketCommitScope(effectiveScope(slug, t), t.files, t.ref);
    const additions = requested.filter((file?: any) => !isForeignReleaseFragmentScope(file) && !commitScope.isInScope(file, scope));
    const covered = requested.filter((file?: any) => !isForeignReleaseFragmentScope(file) && commitScope.isInScope(file, scope));
    const now = new Date().toISOString();
    touchClaimActivity(t, by, now);
    const request = { by, files: additions, requested, covered, at: now };
    if (!additions.length && !foreignReleaseFragments.length) {
      scopeResolution(slug, t, request, 'granted', now, [], []);
      t.updatedAt = now;
      putTicket(slug, t);
      return { ok: true, ticket: t, covered, approved: [], autoApproved: false, state: 'granted', resolution: t.scopeResolution };
    }
    const testDirectories = autoApprovedTestScope(t, requested, additions, slug) || [];
    const testScopeApproved = testDirectories.length > 0;
    const buildRegistrations = testScopeApproved ? [] : autoApprovedBuildRegistrationScope(t, additions, slug) || [];
    const buildRegistrationApproved = buildRegistrations.length > 0;
    const configuredScope = testScopeApproved || buildRegistrationApproved ? [] : autoApprovedScopePaths(t, additions, slug);
    const derivedScope = testScopeApproved ? testDirectories : buildRegistrationApproved ? buildRegistrations : configuredScope;
    const remainingAfterDerivedScope = additions.filter((file?: any) => !commitScope.isInScope(file, derivedScope));
    const packageScope = autoApprovedPackageScope(t, remainingAfterDerivedScope, slug);
    const approved = normalizeFiles([...derivedScope, ...packageScope]);
    if (approved.length) {
      t.files = boundedFiles(scopeExpansionFiles(t, approved));
      syncLiveDispatchScope(slug, t);
    }
    const refused = normalizeFiles([
      ...foreignReleaseFragments,
      ...additions.filter((file?: any) => !commitScope.isInScope(file, approved)),
    ]);
    const state = refused.length ? 'refused' : 'granted';
    scopeResolution(slug, t, request, state, now, approved, refused);
    if (!Array.isArray(t.comments)) t.comments = [];
    const policy = testScopeApproved && !packageScope.length
      ? 'test scope under board policy'
      : buildRegistrationApproved && !packageScope.length
        ? 'build-registration scope derived from the in-scope source layout'
        : configuredScope.length && !packageScope.length
          ? 'scope under board policy'
          : 'matching package surface derived from the ticket’s declared files';
    // A ticket that declares nothing gives the package-scope derivation no root to
    // work from, so anything the board's own policy does not already cover refuses.
    // Telling this executor to hand back names the symptom; the fix belongs to
    // whoever filed the ticket, so say which one it is (SQ-1846).
    const undeclared = !normalizeFiles(t.files).length
      ? ` This ticket declares no files, so nothing outside board policy can be in scope. The orchestrator has to declare them (\`sidequest update ${t.ref} --file <path>\`) and redispatch.`
      : '';
    const refusedEvidencePaths = refused.filter((file?: any) => isVerificationEvidencePath(file, evidenceDirectory, t.ref));
    const refusedOutsideDeclaredFiles = refused.filter((file?: any) => (
      !isForeignReleaseFragmentScope(file) && !isVerificationEvidencePath(file, evidenceDirectory, t.ref)
    ));
    const foreignReleaseFragmentMessage = foreignReleaseFragments.length
      ? commitScope.foreignReleaseFragmentRefusalMessage('scopeRequest', t.ref, foreignReleaseFragments)
      : '';
    const scopeExpansionRefusalMessage = additions.length
      ? `Scope expansion refused: ${refused.join(', ')}.`
      : '';
    const refusalMessage = [foreignReleaseFragmentMessage, scopeExpansionRefusalMessage].filter(Boolean).join(' ');
    const body = refused.length
      ? `${refusalMessage}${approved.length ? ` Auto-approved ${policy}: ${approved.join(', ')}.` : ''}${undeclared}${declaredScopeGuidance(t, refusedOutsideDeclaredFiles)}${verificationEvidenceGuidance(evidenceDirectory, refusedEvidencePaths)} Commit in-scope work, then release with kind \"handback\" and name the refused paths.`
      : `Auto-approved ${policy}: ${approved.join(', ')}.`;
    const comment = createComment({ by: refused.length ? 'board' : 'board', body, kind: 'comment', source: refused.length ? (opts.source || 'cli') : 'policy' }, now);
    t.comments.push(comment);
    t.lastEventType = refused.length ? 'scope_refused' : 'scope_auto_approved';
    t.lastEventSource = comment.source;
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    return {
      ok: true,
      ticket: t,
      covered,
      approved,
      autoApproved: !refused.length,
      refused,
      state,
      resolution: t.scopeResolution,
      comment,
      ...(refusalMessage ? { message: refusalMessage } : {}),
    };
  });
}

function migrateLegacyScopeRequest(slug?: any, idOrRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    const request = ticket?.scopeRequest;
    if (!ticket || !request) return { ok: true, migrated: false, ticket };
    const now = new Date().toISOString();
    const requested = normalizeFiles(request.requested || request.files);
    scopeResolution(slug, ticket, request, 'refused', now, [], requested);
    ticket.scopeRequest = null;
    if (ticket.dispatch) delete ticket.dispatch.scopeRequest;
    if (!Array.isArray(ticket.comments)) ticket.comments = [];
    const comment = createComment({
      by: 'board',
      body: `Cleared legacy pending scope request from ${request.by || 'unknown requester'}: ${requested.join(', ') || '(no paths recorded)'}. Scope requests now rule immediately; commit in-scope work and release with kind \"handback\" if these paths are still needed.`,
      kind: 'comment',
      source: 'migration',
    }, now);
    ticket.comments.push(comment);
    ticket.lastEventType = 'scope_request_migrated';
    ticket.lastEventSource = 'migration';
    ticket.updatedAt = now;
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, 'comment', comment.source, { commentBody: comment.body });
    return { ok: true, migrated: true, ticket, comment };
  });
}

// Do two declared scopes collide? A path conflicts with an equal path or with
// one that is a directory-prefix of it (case-insensitive, "/"-normalized).
// Empty scopes never conflict mechanically — "no declaration" means "no
// information", and the skill tells the orchestrator how to treat that.
function overlappingScopePaths(filesA?: any, filesB?: any) {
  const a = normalizeFiles(filesA);
  const b = normalizeFiles(filesB);
  const overlaps = new Map();
  for (const x of a) {
    for (const y of b) {
      const left = x.toLowerCase();
      const right = y.toLowerCase();
      const overlap = left === right ? x : (left.startsWith(right + '/') ? x : (right.startsWith(left + '/') ? y : null));
      if (overlap) overlaps.set(overlap.toLowerCase(), overlap);
    }
  }
  return Array.from(overlaps.values()).sort((left?: any, right?: any) => left.localeCompare(right));
}

function scopesOverlap(filesA?: any, filesB?: any) {
  return overlappingScopePaths(filesA, filesB).length > 0;
}

const CONTRACT_EDGE_KINDS = ['produces', 'changes', 'consumes'];

function normalizeContractNames(values?: any) {
  if (!values) return [];
  const entries = Array.isArray(values) ? values : String(values).split(',');
  const seen = new Set();
  const normalized: any[] = [];
  for (const value of entries) {
    const name = String(value).trim().slice(0, 200);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      normalized.push(name);
    }
  }
  return normalized;
}

function normalizeContracts(contracts?: any) {
  const source = contracts && typeof contracts === 'object' ? contracts : {};
  return Object.fromEntries(CONTRACT_EDGE_KINDS.map((kind) => [kind, normalizeContractNames(source[kind])]));
}

function boundedContracts(contracts?: any) {
  const normalized = normalizeContracts(contracts);
  for (const kind of CONTRACT_EDGE_KINDS) {
    boundedList(normalized[kind], CONTRACT_NAMES_MAX, `contract ${kind}`, 'Name the shared interfaces the wave planner sequences on, not every symbol they touch.');
  }
  return normalized;
}

function contractNamesByLowerCase(values?: any) {
  return new Map(normalizeContractNames(values).map((value?: any) => [value.toLowerCase(), value]));
}

function contractCollisionReasons(left?: any, right?: any) {
  if (!left || !right || left.contractWaiver || right.contractWaiver) return [];
  const leftContracts = normalizeContracts(left.contracts);
  const rightContracts = normalizeContracts(right.contracts);
  const reasons: any[] = [];
  const matchingNames = (a?: any, b?: any) => {
    const matches: any[] = [];
    for (const [key, name] of contractNamesByLowerCase(a)) {
      if (contractNamesByLowerCase(b).has(key)) matches.push(name);
    }
    return matches.sort((a?: any, b?: any) => a.localeCompare(b));
  };
  for (const contract of matchingNames(leftContracts.produces, rightContracts.consumes)) {
    reasons.push({ contract, type: 'produces-consumes', message: `${left.ref} produces ${contract}, which ${right.ref} consumes.` });
  }
  for (const contract of matchingNames(rightContracts.produces, leftContracts.consumes)) {
    reasons.push({ contract, type: 'produces-consumes', message: `${right.ref} produces ${contract}, which ${left.ref} consumes.` });
  }
  for (const contract of matchingNames(leftContracts.changes, rightContracts.changes)) {
    reasons.push({ contract, type: 'changes-changes', message: `${left.ref} and ${right.ref} both change ${contract}.` });
  }
  return reasons;
}

function ticketsConflict(left?: any, right?: any) {
  return scopesOverlap(left.files, right.files) || contractCollisionReasons(left, right).length > 0;
}

function orderReadyTicketsByContractDependencies(tickets?: any) {
  const ordered = Array.isArray(tickets) ? tickets : [];
  const edges = new Map(ordered.map((ticket?: any) => [ticket.id, new Set()]));
  for (const producer of ordered) {
    if (producer.contractWaiver) continue;
    const produced = contractNamesByLowerCase(normalizeContracts(producer.contracts).produces);
    for (const consumer of ordered) {
      if (producer.id === consumer.id || consumer.contractWaiver) continue;
      const consumed = contractNamesByLowerCase(normalizeContracts(consumer.contracts).consumes);
      const dependencies = edges.get(producer.id);
      if (dependencies && [...produced.keys()].some((name?: any) => consumed.has(name))) dependencies.add(consumer.id);
    }
  }
  const pending = new Set(ordered.map((ticket?: any) => ticket.id));
  const result: any[] = [];
  while (pending.size) {
    const next = ordered.find((ticket?: any) => {
      if (!pending.has(ticket.id)) return false;
      for (const [from, targets] of edges) {
        if (pending.has(from) && targets.has(ticket.id)) return false;
      }
      return true;
    }) || ordered.find((ticket?: any) => pending.has(ticket.id));
    result.push(next);
    pending.delete(next.id);
  }
  return result;
}

function contractMetadata(ticket?: any) {
  const contracts = normalizeContracts(ticket && ticket.contracts);
  return {
    produces: contracts.produces,
    changes: contracts.changes,
    consumes: contracts.consumes,
    waiver: !!(ticket && ticket.contractWaiver),
  };
}

// Partition the ready set into waves an orchestrator can fan out one wave at a
// time: within a wave no two tickets' declared scopes or named contracts
// conflict. Greedy first-fit in priority order, so wave 1 is "start these now",
// wave 2 "after wave 1", etc. Tickets with no declarations never mechanically
// conflict.
function readyWaves(slug?: any, opts?: any) {
  const ready = orderReadyTicketsByContractDependencies(readyTickets(slug, opts));
  const waves: any[] = [];
  for (const t of ready) {
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((w?: any) => ticketsConflict(w, t))) {
        wave.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([t]);
  }
  return waves;
}

function readyWaveDependencies(slug?: any, opts?: any) {
  const waves = readyWaves(slug, opts);
  const dependencies: any[] = [];
  for (let waveIndex = 1; waveIndex < waves.length; waveIndex++) {
    for (const ticket of waves[waveIndex]) {
      for (let priorWave = 0; priorWave < waveIndex; priorWave++) {
        for (const earlier of waves[priorWave]) {
          for (const reason of contractCollisionReasons(earlier, ticket)) {
            dependencies.push({ before: earlier.ref, after: ticket.ref, contract: reason.contract, type: reason.type, reason: reason.message });
          }
        }
      }
    }
  }
  return dependencies;
}

// An assignee is a free-form name (the human "you", or an agent). Empty/blank
// clears it back to null (unassigned).
function normalizeAssignee(v?: any) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  return s || null;
}

function updateDoneRefusal(ticket?: any) {
  if (ticket.claim && ticket.claim.by && !claimReclaimable(ticket)) {
    return `${ticket.ref} is claimed. Use done/completeTicket for eligible non-repo or artifact work; scoped repository work must commit and submit.`;
  }
  if (pendingSubmission(ticket)) {
    return `${ticket.ref} has a pending submission. Complete it through the integration lifecycle; update --status done cannot consume submitted work.`;
  }
  const state = dispatchState(ticket);
  if (ticket.dispatchNonce || (state && !state.terminalAt)) {
    return `${ticket.ref} has an active dispatch. Its executor must use done/completeTicket or commit and submit; update --status done cannot bypass that lifecycle.`;
  }
  if (state) {
    return `${ticket.ref} has routed dispatch history. Executors cannot close released repository work unless their verified no-op release recorded clean scope. Otherwise commit and submit verified scoped changes, or release to todo with findings; the orchestrator can re-dispatch it or use the control-plane grooming closure with evidence.`;
  }
  return null;
}

// update --status <anything but done> on a ticket with a pending submission
// used to apply silently, leaving the submission in place: the ticket looked
// reopened but the next claim still refused it as already-submitted (SQ-1010).
// Reopening past a pending submission needs the explicit reject, not a status
// patch that quietly strands it.
function updateReopenRefusal(ticket?: any, nextStatus?: any) {
  if (!pendingSubmission(ticket)) return null;
  const commit = String(ticket.submission.commit || '').slice(0, 12);
  return `${ticket.ref} has a pending submission (commit ${commit}) parked READY_FOR_INTEGRATION. update cannot move it to "${nextStatus}" and leave the submission in place. For a review rejection, record it with MCP \`rework\` (review and reason required), then dispatch the same ticket for repair; the old candidate stays recorded until replacement submission. Use \`sidequest submit ${ticket.ref} --clear --status ${nextStatus}\` only for an integration bounce that intentionally drops the candidate, or integrate it through the publish flow.`;
}

function sameFiles(left?: any, right?: any) {
  const normalizedLeft = normalizeFiles(left);
  const normalizedRight = normalizeFiles(right);
  const rightFiles = new Set(normalizedRight.map((file: any) => file.toLowerCase()));
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((file: any) => rightFiles.has(file.toLowerCase()));
}

type UpdateTicketOptions = {
  allowLiveClaimCloseoutUpdate?: boolean;
};

function activeClaimCloseoutUpdateRefusal(ticket?: any, patch?: any, options: UpdateTicketOptions = {}) {
  if (!ticket.claim?.by || claimReclaimable(ticket)) return null;
  const changedFields = [
    ...(patch.files !== undefined && !sameFiles(ticket.files, patch.files) ? ['files'] : []),
    ...(patch.status !== undefined && String(patch.status).trim().toLowerCase() !== ticket.status ? ['status'] : []),
    ...((patch.readonly !== undefined || patch.readonlyOverride !== undefined) && requestedReadonlyOverride(patch) !== ticket.readonlyOverride ? ['readonly'] : []),
    ...(patch.workingTreeDelivery !== undefined && (patch.workingTreeDelivery === true) !== (ticket.workingTreeDelivery === true) ? ['workingTreeDelivery'] : []),
    ...(patch.externalDeliverable !== undefined && (patch.externalDeliverable === true) !== (ticket.externalDeliverable === true) ? ['externalDeliverable'] : []),
    ...(patch.executorVerify !== undefined && patch.executorVerify !== ticket.executorVerify ? ['verify'] : []),
    ...(patch.executorVerifyKind !== undefined && patch.executorVerifyKind !== ticket.executorVerifyKind ? ['verifyKind'] : []),
    ...(patch.executorAttestationArtifact !== undefined && patch.executorAttestationArtifact !== ticket.executorAttestationArtifact ? ['attestationArtifact'] : []),
  ];
  if (!changedFields.length) return null;
  const caller = String(patch.by || '').trim();
  if (options.allowLiveClaimCloseoutUpdate === true && caller !== ticket.claim.by) return null;
  const scopeChange = changedFields.includes('files');
  const closeoutChanges = changedFields.some((field) => field !== 'files');
  const scopeGuidance = scopeChange ? ' Executors use `scopeRequest` for files.' : '';
  const closeoutGuidance = closeoutChanges ? ' Ask the orchestrator to set other closeout fields from the main thread.' : '';
  return `${ticket.ref}: refusing active-claim update for ${changedFields.join(', ')}. Release the claim before changing these fields through the CLI, or use MCP \`update\` from the orchestrator's main thread without the claim holder's \`by\`.${scopeGuidance}${closeoutGuidance}`;
}

function activeClaimScopeRefusal(slug?: any, ticket?: any, files?: any, patch?: any) {
  if (!ticket.claim?.by || claimReclaimable(ticket)) return null;
  const current = normalizeFiles(ticket.files);
  const next = boundedFiles(files, {
    category: ticket.category,
    readonlyOverride: ticket.readonlyOverride,
    slug,
    ticketRef: ticket.ref,
    operation: 'update',
  });
  if (sameFiles(current, next)) return null;
  const caller = String(patch?.by || '').trim();
  if (caller && caller !== ticket.claim.by) return null;
  const claimedSession = String(dispatchState(ticket)?.sessionId || '').trim();
  const callerSession = String(patch?.sessionId || '').trim();
  if (callerSession && claimedSession && callerSession !== claimedSession) return null;
  const currentFiles = new Set(current.map((file: any) => file.toLowerCase()));
  const nextFiles = new Set(next.map((file: any) => file.toLowerCase()));
  // Shedding is the claim holder's own call, but only once they say who they
  // are: an unidentified caller still has to name itself, the same as any other
  // scope change under a live claim.
  if (caller && next.every((file: any) => currentFiles.has(file.toLowerCase()))) return null;
  const refused = [
    ...next.filter((file: any) => !currentFiles.has(file.toLowerCase())),
    ...current.filter((file: any) => !nextFiles.has(file.toLowerCase())),
  ];
  const refusal = `${ticket.ref}: refusing active-claim scope change for ${refused.join(', ')}.`;
  if (!caller) {
    return `${refusal} Re-run \`sidequest update ${ticket.ref} --files <paths> --by <your-id>\` using your own control-plane identity (MCP \`update\` with \`by:"<your-id>"\`).`;
  }
  return `${refusal} Use \`sidequest scope-request ${ticket.ref} --file <path> --by ${ticket.claim.by}\` to request approval.`;
}

// Apply a partial update. Only known fields are written; unknown keys ignored.
// Locked (like every other mutator) so a concurrent comment/claim/link append
// can never be silently overwritten by an update whose read predates it.
function updateTicket(slug?: any, idOrRef?: any, patch?: any, reviewTarget?: any, options: UpdateTicketOptions = {}) {
  const found = getTicket(slug, idOrRef);
  if (!found) return null;
  patch = patch || {};
  if (Object.hasOwn(patch, 'reviewTarget')) {
    throw new Error('generic ticket patch cannot set, change, or clear reviewTarget; pass the review target transition separately');
  }
  const apply = (t?: any) => {
    const closeoutUpdateRefusal = activeClaimCloseoutUpdateRefusal(t, patch, options);
    if (closeoutUpdateRefusal) throw new Error(closeoutUpdateRefusal);
    const nextStatus = patch.status == null ? null : requireStatus(patch.status);
    const doneRefusal = nextStatus === 'done' ? updateDoneRefusal(t) : null;
    if (doneRefusal) throw new Error(doneRefusal);
    const reopenRefusal = nextStatus != null && nextStatus !== 'done' ? updateReopenRefusal(t, nextStatus) : null;
    if (reopenRefusal) throw new Error(reopenRefusal);
    if (t.reviewTarget && patch.category !== undefined
      && String(patch.category == null ? '' : patch.category).trim().toLowerCase() !== 'review-audit') {
      throw new Error(`${t.ref} reviewTarget is immutable and cannot be cleared by changing category; file a fresh ticket`);
    }
    const prevStatus = t.status;
    if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
    if (patch.description != null) t.description = String(patch.description).trim();
    if (patch.status != null) t.status = nextStatus;
    if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
    if (patch.labels != null) t.labels = boundedLabels(patch.labels);
    if (patch.highStakes !== undefined) t.highStakes = !!patch.highStakes;
    if (patch.storyId !== undefined) {
      const storyId = coerceStoryId(slug, patch.storyId);
      if (storyId !== t.storyId) {
        t.storyId = storyId;
        t.storyLogSeenSeq = storyLogRevision(slug, storyId);
      }
    }
    if (patch.category !== undefined) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
    if (patch.route !== undefined) t.route = normalizedTicketRoute(patch.route);
    // Complexity can move to another valid score, never clear; a fresh motivation
    // rides along whenever one is provided (the CLI demands one on change).
    if (patch.complexity !== undefined) { const c = coerceComplexity(patch.complexity); if (c) t.complexity = c; }
    if (patch.complexityWhy !== undefined && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1000);
    if (patch.files !== undefined) {
      const scopeRefusal = options.allowLiveClaimCloseoutUpdate === true
        ? null
        : activeClaimScopeRefusal(slug, t, patch.files, patch);
      if (scopeRefusal) throw new Error(scopeRefusal);
      t.files = boundedFiles(patch.files, {
        category: patch.category === undefined ? t.category : patch.category,
        readonlyOverride: patch.readonly === undefined && patch.readonlyOverride === undefined
          ? t.readonlyOverride
          : requestedReadonlyOverride(patch),
        slug,
        ticketRef: t.ref,
        operation: 'update',
      });
      syncLiveDispatchScope(slug, t);
    }
    if (patch.contracts !== undefined) t.contracts = boundedContracts(patch.contracts);
    if (patch.contractWaiver !== undefined) t.contractWaiver = !!patch.contractWaiver;
    if (patch.readonly !== undefined || patch.readonlyOverride !== undefined) t.readonlyOverride = requestedReadonlyOverride(patch);
    if (patch.workingTreeDelivery !== undefined) t.workingTreeDelivery = patch.workingTreeDelivery === true;
    if (patch.externalDeliverable !== undefined) t.externalDeliverable = patch.externalDeliverable === true;
    if (patch.category !== undefined || patch.readonly !== undefined || patch.readonlyOverride !== undefined) {
      t.files = boundedFiles(t.files, {
        category: t.category,
        readonlyOverride: t.readonlyOverride,
        slug,
        ticketRef: t.ref,
        operation: 'update',
      });
    }
    if (patch.executorAnchors !== undefined) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors');
    const nextVerifyKind = patch.executorVerifyKind === undefined ? t.executorVerifyKind : patch.executorVerifyKind;
    const nextAttestationArtifact = patch.executorAttestationArtifact === undefined ? t.executorAttestationArtifact : patch.executorAttestationArtifact;
    const nextVerify = patch.executorVerify === undefined ? t.executorVerify : patch.executorVerify;
    if (patch.executorVerify !== undefined || patch.executorVerifyKind !== undefined || patch.executorAttestationArtifact !== undefined) {
      requireVerifyOracle(nextVerifyKind, nextVerify, nextAttestationArtifact);
      const executorVerify = executorText(nextVerify, EXECUTOR_VERIFY_MAX, 'executor verify command');
      const executorVerifyKind = normalizeVerifyOracleKind(nextVerifyKind, executorVerify);
      const executorAttestationArtifact = executorText(nextAttestationArtifact, EXECUTOR_VERIFY_MAX, 'executor attestation artifact');
      const verifyTicket = Object.assign({}, t, { executorVerifyKind, executorAttestationArtifact, executorVerify });
      const verifyError = authoringVerifyError(verifyTicket, readMeta(slug)?.path);
      if (verifyError) throw new Error(`${verifyError} Keep acceptance criteria in a comment, not the verify field.`);
      if (t.claim || dispatchState(t)) {
        const verifyError = dispatchVerifyCommandError(verifyTicket, readMeta(slug)?.path);
        if (verifyError) throw new Error(verifyError);
      }
      t.executorVerifyKind = executorVerifyKind;
      t.executorAttestationArtifact = executorAttestationArtifact;
      t.executorVerify = executorVerify;
    }
    // A provenance stamp may ride along a patch (e.g. the dashboard completing a
    // ticket). Permissive like the routing fields above: a valid stamp is set, a
    // bad one is ignored rather than thrown (the data layer never crashes a write).
    if (patch.workedBy !== undefined) {
      try { const w = makeWorkedBy(patch.workedBy); if (w) t.workedBy = w; } catch (_: any) { /* ignore an invalid stamp on a patch */ }
    }
    if (patch.assignee !== undefined) t.assignee = normalizeAssignee(patch.assignee);
    if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
    // Attach any newly supplied images (by path from the CLI, or base64 from the
    // dashboard). Also allow removing an attached asset by filename.
    const imgs = Array.isArray(patch.images) ? patch.images : [];
    for (const src of imgs) {
      try {
        t.assets.push(copyAsset(slug, t.id, src));
      } catch (e: any) {
        if (patch.onAssetError) patch.onAssetError(src, e);
      }
    }
    for (const d of asDataImages(patch.imagesData)) {
      try {
        t.assets.push(saveAssetData(slug, t.id, d.name, d.buffer));
      } catch (_: any) {
        /* skip */
      }
    }
    if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
      const drop = new Set(patch.removeAssets.map((f?: any) => path.basename(String(f))));
      t.assets = t.assets.filter((a?: any) => {
        if (!drop.has(a)) return true;
        try {
          fs.unlinkSync(assetPath(slug, t.id, a));
        } catch (_: any) {
          /* ignore */
        }
        return false;
      });
    }
    // Record the event: a status move vs. a plain edit, and who made it. Source
    // defaults to "cli" (the CLI / a subagent), so only the dashboard tags itself.
    t.lastEventType = t.status !== prevStatus ? 'status' : 'edit';
    t.lastEventSource = patch.source ? String(patch.source) : 'cli';
    const now = new Date().toISOString();
    if (t.status !== prevStatus) t.statusTransition = { from: prevStatus, to: t.status, at: now };
    t.updatedAt = now;
    t.referenceUpdatedAt = now;
    bindReviewTarget(slug, t, reviewTarget, (review: any) => putTicket(slug, review));
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return t;
  };
  const applyUnderTicketLock = () => {
    const lock = ticketLockPath(slug, found.id);
    const locked = acquireLock(lock); // best-effort: still applies the update if contention outlasts the retries
    try {
      const t = getTicket(slug, found.id); // fresh read, under the lock when we have it
      if (!t) return null;
      return apply(t);
    } finally {
      if (locked) releaseLock(lock, locked);
    }
  };
  const targetRef = reviewTarget === undefined ? '' : String(reviewTarget?.ref || '').trim().toUpperCase();
  const sourceTicket = targetRef ? getTicket(slug, targetRef) : null;
  if (!sourceTicket) return applyUnderTicketLock();
  // The source lock is taken first and always in that order, so a review binding
  // and a concurrent source mutation can never deadlock against each other.
  const updated = withSourceTicketLock(slug, sourceTicket.id, applyUnderTicketLock);
  queueEventNotification(slug, getTicket(slug, sourceTicket.id), 'status', patch.source ? String(patch.source) : 'cli');
  return updated;
}

// Locked so a delete can never yank the ticket/lock file out from under a
// concurrent addComment/claimTicket that still believes it holds the lock.
function deleteTicket(slug?: any, idOrRef?: any, options: { allowLiveClaimDeletion?: boolean } = {}) {
  const found = getTicket(slug, idOrRef);
  if (!found) return false;
  // Deleting a live-claimed ticket sheds the claim and all closeout state, so it
  // is the same escape as flipping closeout flags: the store refuses it unless an
  // explicit grant is passed. Only the hook-authenticated main-thread MCP remove
  // supplies that grant; CLI --force and the unauthenticated dashboard DELETE do
  // not, and so must release the claim first.
  if (found.claim && found.claim.by && !claimReclaimable(found) && options.allowLiveClaimDeletion !== true) {
    throw new Error(`${found.ref}: refusing to delete a live-claimed ticket (held by "${found.claim.by}"). Release the claim first, or remove it with the orchestrator's main-thread MCP.`);
  }
  const deletedRef = found.ref;
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock);
  let ok = false;
  try {
    ok = deleteCachedRow(database(), 'tickets', found.id);
    if (ok) {
      try {
        fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
      } catch (_: any) {
        /* best effort */
      }
    }
  } finally {
    if (locked) releaseLock(lock, locked); // also removes the lock file itself
  }
  if (!ok) return false;
  // Drop any links other tickets had pointing at the one we just removed, so no
  // dangling "blocked-by SQ-deleted" leaves a ticket falsely blocked forever.
  try {
    for (const other of listTickets(slug)) {
      if (Array.isArray(other.links) && other.links.some((l?: any) => upperRef(l.ref) === upperRef(deletedRef))) {
        stripLinksTo(slug, other.id, deletedRef);
      }
    }
  } catch (_: any) {
    /* best effort */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Archiving: put finished work out of the way without deleting it
 *
 *  An archived ticket is kept (and fully restorable) but hidden from the board,
 *  the counts, and `next`. This is how "clear out the Done column" works without
 *  losing the record.
 * ------------------------------------------------------------------ */

function setArchived(slug?: any, idOrRef?: any, archived?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    t.archived = !!archived;
    t.archivedAt = archived ? new Date().toISOString() : null;
    t.lastEventType = archived ? 'archived' : 'restored';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}

function archiveTicket(slug?: any, idOrRef?: any, opts?: any) {
  return setArchived(slug, idOrRef, true, opts);
}
function unarchiveTicket(slug?: any, idOrRef?: any, opts?: any) {
  return setArchived(slug, idOrRef, false, opts);
}

// Archive every done, not-yet-archived ticket in a project. Returns the refs.
function archiveAllDone(slug?: any, opts?: any) {
  const refs: any[] = [];
  for (const ticket of queryTickets(String(slug || ''), { status: 'done', archived: false })) {
    const result = setArchived(slug, ticket.id, true, opts);
    if (result.ok) refs.push(result.ticket.ref);
  }
  return { ok: true, archived: refs };
}

function listArchived(slug?: any) {
  return queryTickets(String(slug || ''), { archived: true });
}
function listActive(slug?: any) {
  return queryTickets(String(slug || ''), { archived: false });
}

  return { DECLARED_FILES_MAX, CONTRACT_NAMES_MAX, LABELS_MAX, categoryReadOnly, readOnlyOverrideActive, dispatchReadOnly, submissionReviewRelation, createTicket, normalizeLabels, normalizeFiles, scopeExpansionFiles, scopeExpansionCommand, requestScope, migrateLegacyScopeRequest, overlappingScopePaths, scopesOverlap, normalizeContracts, contractCollisionReasons, contractMetadata, readyWaves, readyWaveDependencies, normalizeAssignee, updateTicket, deleteTicket, archiveTicket, unarchiveTicket, archiveAllDone, listArchived, listActive };
}

module.exports = { createTickets };
