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
const { collectGitSubmissionFacts } = require('../lib/mcp-lifecycle');
const { sourceRevisionAdapterFacts, sourceRevisionBaseline } = require('../lib/source-revision-capability');
const { assertSidequestInstall, assertDispatchTransport } = require('../lib/dispatch-preflight');

const { fail, resolveProject, workerId, sessionId, bodyFromOpts, addBodyComment } = require('./sidequest-cmd-shared');
function reportClaimFailure(action: any, idOrRef: any, res: any, meta: any) {
  process.exitCode = 1;
  console.log(`✗ ${res.message || claimRefusalMessage(res.reason, idOrRef, res.ticket || res.claim, meta.path)}`);
}

// `ready --model`/`next --model` used to coerce an unrecognized value straight
// to "no filter" (coerceModel returns null for garbage the same as it does for
// blank/any/none) — a silent footgun: a typo'd tier quietly returned the WHOLE
// board instead of erroring. classifyModelFilter (SQ-156/157) can tell the two
// apart; refuse the unrecognized case here instead of letting it fall through.
// Returns false (and has already reported the error) when the caller should
// bail without touching the store; true when opts.model is fine to pass on.
function validateModelFilter(action: any, opts: any) {
  if (opts.model == null) return true;
  const cls = store.classifyModelFilter(opts.model);
  if (cls !== 'unknown') return true;
  const message = `unknown model "${opts.model}" — known: ${store.getModelVocab().models.join(', ')}`;
  process.exitCode = 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'unknown_model', message }, null, 2) + '\n');
  } else {
    console.log(`✗ ${action}: ${message}`);
  }
  return false;
}

function claimPlanningWarnings(ticket: any, projectPath: any) {
  const warnings = store.ticketPlanningWarnings(ticket, projectPath);
  if (!warnings.length) return [];
  return warnings.map((warning: any) => `Dispatch context warning: ${warning.replace('Planning-depth warning: ', '')}`);
}

async function cmdClaim(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('claim: pass a ticket id or ref, e.g. sidequest claim SQ-3 --by me');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const res = store.claimTicket(slug, idOrRef, by, { force: !!opts.force, direct: !!opts.direct, reason: opts.reason, token: opts.token, tokenFile: opts['token-file'], executor: opts.executor, effort: opts.effort, source: opts.source || 'cli', sessionId: sessionId(opts), requireBoundAgent: true });
  const warnings = res.ok ? store.presentWarnings(res.ticket, claimPlanningWarnings(res.ticket, meta.path), sessionId(opts)) : [];
  if (opts.json) {
    const payload = Object.assign({ project: slug }, res, { warnings });
    if (!res.ok) payload.message = res.reason === 'executor_mismatch'
      ? claimRefusalMessage(res.reason, idOrRef, res.ticket || res.claim, meta.path)
      : res.message || claimRefusalMessage(res.reason, idOrRef, res.ticket || res.claim, meta.path);
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ claimed ${res.ticket.ref} as "${by}"  [${res.ticket.status}]  — ${meta.name}`);
    console.log(`  "${res.ticket.title}"`);
    for (const warning of warnings) console.log(`  ! ${warning}`);
  } else {
    reportClaimFailure('claim', idOrRef, res, meta);
  }
}

async function cmdCheckpoint(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('checkpoint: pass a ticket ref, e.g. sidequest checkpoint SQ-3 --by me --commit <hash> --verify "command: passed"');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  let res;
  try {
    res = store.checkpointTicket(slug, idOrRef, by, {
      commit: opts.commit,
      worktree: opts.worktree,
      verify: opts.verify,
      ttlMinutes: opts['ttl-minutes'],
      source: opts.source || 'cli',
    });
  } catch (e: any) {
    fail(`checkpoint: ${(e && e.message) || e}`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ ${res.ticket.ref} live review checkpoint ${res.checkpoint.id} [${res.checkpoint.state}] until ${res.checkpoint.expiresAt}: ${meta.name}`);
    console.log(`  claim remains held by "${by}"; dispatch remains active`);
  } else {
    reportClaimFailure('checkpoint', idOrRef, res, meta);
  }
}

function closeDispatchExecutor(ticket: any) {
  const executor = store.canonicalPreparedDispatchExecutor(ticket);
  if (executor) agentsync.cleanupNativeAgents({ name: executor });
}

async function cmdVerdict(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('verdict: pass a ticket ref, e.g. sidequest verdict SQ-3 --text "user words" --outcome accepted');
  const text = opts.text;
  const outcome = opts.outcome;
  if (text == null) fail('verdict: --text is required and must contain the user\'s words verbatim.');
  if (outcome == null) fail('verdict: --outcome is required: accepted, rejected, or inconclusive.');
  const { slug, meta } = await resolveProject(opts);
  let res;
  try {
    res = store.applyExperimentVerdict(slug, idOrRef, {
      text,
      outcome,
      why: opts.why,
      constraint: opts.constraint,
    });
  } catch (e: any) {
    fail(`verdict: ${(e && e.message) || e}`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ recorded ${res.outcome} verdict for ${idOrRef} round ${res.round} — ${meta.name}`);
  else fail(`verdict: ${res.message || `could not record a verdict for ${idOrRef}`}`);
}

async function cmdRelease(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('release: pass a ticket id or ref, e.g. sidequest release SQ-3');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  // The reason mandate is the MCP executor surface's contract (3.23.0); the CLI
  // stays the human/admin fallback where forced ceremony on dead-claim cleanup
  // would only get in the way. A given reason (or oracle ask) is still recorded.
  const reason = String(opts.reason || opts.oracle || '').trim();
  const evidence = store.technicalBlockerRelease({
    reason,
    oracle: opts.oracle,
    releaseKind: opts['release-kind'],
    command: opts.command,
    exitCode: opts['exit-code'],
    outputTail: opts['output-tail'],
  });
  if (!evidence.ok) fail(evidence.message);
  const ticket = store.getTicket(slug, idOrRef);
  const res = store.releaseTicket(slug, idOrRef, by, {
    force: !!opts.force,
    status: opts['release-kind'] === 'oracle' ? 'awaiting-oracle' : opts.status,
    oracle: opts.oracle,
    candidate: opts.candidate,
    deliverable: opts.deliverable,
    ...(reason ? { releaseComment: { by, body: store.releaseCommentBody(reason, evidence.evidence), kind: 'comment', source: opts.source || 'cli' } } : {}),
    releaseKind: evidence.releaseKind,
    releaseReason: reason,
    releaseEvidence: evidence.evidence,
    source: opts.source || 'cli',
    sessionId: sessionId(opts),
  });
  if (res.ok) closeDispatchExecutor(ticket);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ released ${res.ticket.ref}  [${res.ticket.status}]  — ${meta.name}`);
  else reportClaimFailure('release', idOrRef, res, meta);
}

async function cmdDone(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('done: pass a ticket id or ref, e.g. sidequest done SQ-3');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const body = await bodyFromOpts(opts, 'done');
  // Optional self-reported provenance: which tier/effort actually worked this
  // ticket. Invalid values throw from the store; surface them as a clean error.
  const ticket = store.getTicket(slug, idOrRef);
  let res;
  try {
    res = store.completeTicket(slug, idOrRef, by, {
      force: !!opts.force,
      source: opts.source || 'cli',
      model: opts.model,
      effort: opts.effort,
      body,
      sessionId: sessionId(opts),
    });
  } catch (e: any) {
    fail(`done: ${(e && e.message) || e}`);
  }
  if (res.ok && !res.idempotent) {
    closeDispatchExecutor(ticket);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ ${res.ticket.ref} done  — ${meta.name}`);
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
  }
  else reportClaimFailure('complete', idOrRef, res, meta);
}

// A branch left behind is the whole defect this reports on, so anything short of
// a clean advance prints as a refusal with the command that finishes the job.
// Silence is reserved for the cases where nothing was owed.
const QUIET_INTEGRATION_BRANCH_REASONS = ['remote_mode', 'already_integrated'];

function reportIntegrationBranch(outcome: any) {
  if (!outcome || QUIET_INTEGRATION_BRANCH_REASONS.includes(outcome.reason)) return;
  if (outcome.ignoredDirtyPaths?.length) {
    console.log(`  info: left unrelated dirty paths untouched: ${outcome.ignoredDirtyPaths.join(', ')}`);
  }
  console.log(outcome.advanced ? `  ${outcome.message}` : `  ! ${outcome.message}`);
  if (outcome.command) console.log(`    run: ${outcome.command}`);
}

async function cmdGroomClose(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('groom-close: pass a ticket id or ref, e.g. sidequest groom-close SQ-3 --reason "Already shipped in abc1234."');
  const reason = String(opts.reason || '').trim();
  if (!reason) fail('groom-close: pass --reason with the evidence for this administrative closure.');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const purpose = opts.integration ? 'integration' : opts['delivery-commit'] ? 'delivery' : 'grooming';
  const res = store.completeTicketAsControlPlane(slug, idOrRef, {
    by,
    reason,
    purpose,
    overrideLegacyScope: opts['override-legacy-scope'] === true,
    abandonSubmission: opts['abandon-submission'] === true,
    deliveryCommit: opts['delivery-commit'],
  });
  if (res.ok && !res.idempotent) closeDispatchExecutor(ticket);
  if (res.ok && opts.integration) {
    // Advance before sweeping: a local integration branch that just moved makes
    // this ticket's worktree reachable, which is what the sweep collects on.
    try {
      const integrationTarget = store.integrationTarget(slug);
      res.integrationBranch = await worktrees.advanceIntegrationBranch(meta.path, {
        integrationTarget,
        submissionCommit: res.ticket.submission ? res.ticket.submission.commit : null,
        submissionWorktree: res.ticket.submission ? res.ticket.submission.worktree : null,
        admittedScope: res.ticket.submission ? res.ticket.submission.admittedScope : null,
        changedPaths: res.ticket.submission ? res.ticket.submission.changedPaths : null,
      });
      res.worktreeSweep = await worktrees.sweep(meta.path, store.worktreeGcTickets(), {
        execute: true,
        currentPath: store.nearestRepoRoot(process.cwd()),
        integrationTarget,
        ticketRef: res.ticket.ref,
      });
    } catch (error: any) {
      res.worktreeSweep = { failures: [{ path: null, message: (error && error.message) || String(error) }] };
    }
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ ${res.ticket.ref} closed after ${purpose}  — ${meta.name}`);
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
    reportIntegrationBranch(res.integrationBranch);
  }
  else reportClaimFailure('groom-close', idOrRef, res, meta);
}

const OUT_OF_SCOPE_COMMENT_MAX = 16000;

function outOfScopeComment(paths: any[]) {
  const prefix = 'out-of-scope changes present: ';
  const complete = `${prefix}${paths.join(', ')} — widen scope + second commit, or discard`;
  if (complete.length <= OUT_OF_SCOPE_COMMENT_MAX) return complete;
  for (let shown = paths.length - 1; shown >= 0; shown -= 1) {
    const omitted = paths.length - shown;
    const suffix = `… +${omitted} more (run git status in the worktree for the full list)`;
    const body = `${prefix}${paths.slice(0, shown).join(', ')}${shown ? ' ' : ''}${suffix}`;
    if (body.length <= OUT_OF_SCOPE_COMMENT_MAX) return body;
  }
  return `${prefix}… +${paths.length} more (run git status in the worktree for the full list)`;
}

function scopeRemedy(ticket: any, paths: any[]) {
  return store.scopeExpansionCommand(ticket, paths);
}

async function cmdScopeRequest(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('scope-request: pass a ticket ref, e.g. sidequest scope-request SQ-3 --file path/to/new-file.');
  const files = opts.file != null ? opts.file : opts.files;
  if (files == null) fail('scope-request: pass one or more requested paths with --file or --files.');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const res = store.requestScope(slug, idOrRef, by, files, { source: opts.source || 'cli', force: !!opts.force });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    if (res.state === 'refused') {
      console.log(`✓ ${res.ticket.ref} scope expansion refused: ${res.refused.join(', ')} — ${meta.name}`);
      console.log('  commit in-scope work, then release with --release-kind handback and name the refused paths.');
    } else if (res.approved?.length) {
      console.log(`✓ ${res.ticket.ref} scope auto-approved: ${res.approved.join(', ')} — ${meta.name}`);
    } else {
      console.log(`✓ ${res.ticket.ref} already covers: ${res.covered.join(', ')} — ${meta.name}`);
    }
  } else {
    reportClaimFailure('scope-request', idOrRef, res, meta);
  }
}

async function cmdCommit(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('commit: pass a ticket ref, e.g. sidequest commit SQ-3 --by me --message "fix the thing".');
  if (!opts.message) fail('commit: pass --message for the scoped commit.');
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const by = workerId(opts);
  if (!ticket) fail(`commit: no ticket "${idOrRef}" in ${meta.name}.`);
  if (!ticket.claim || ticket.claim.by !== by) {
    const released = !ticket.claim && ticket.claimRelease ? ` ${store.autoReleasedClaimMessage(ticket.ref, ticket.claimRelease)}` : '';
    fail(`commit: ${ticket.ref} must be claimed by "${by}" before committing.${released}`);
  }
  if (ticket.dispatch && ticket.dispatch.sharedTree === false) {
    const location = commitScope.linkedWorktree(process.cwd());
    if (!location.ok || !location.linked) {
      fail(`commit: refused ${ticket.ref}; this dispatch requires a linked worktree. Do not commit in the shared tree. Report that the executor lost its worktree to the orchestrator and re-dispatch.`);
    }
  }
  const scope = commitScope.ticketCommitScope(store.executionScope(slug, ticket), ticket.files, ticket.ref);
  const foreignFragments = commitScope.foreignReleaseFragmentPaths(process.cwd(), ticket.ref);
  if (foreignFragments.length) {
    fail(`commit: refused ${ticket.ref}; only ${commitScope.ticketReleaseFragment(ticket.ref)} is implicitly writable. Other release fragments: ${foreignFragments.join(', ')}.`);
  }
  const result = commitScope.commitScoped(process.cwd(), opts.message, scope);
  if (!result.ok) {
    if (result.reason === 'missing_scope') fail(`commit: ${ticket.ref} has no declared file scope; use the explicit shared-tree escape hatch only for uncommitted-state work, not commits.`);
    if (result.reason === 'outside_scope') {
      fail(`commit: refused ${ticket.ref}; commit contains paths outside its declared scope: ${result.outside.join(', ')}. Expand scope with: ${scopeRemedy(ticket, result.outside)}`);
    }
    if (result.reason === 'no_existing_scope') fail(`commit: ${ticket.ref} has no declared paths that exist in this worktree. Missing: ${(result.missingScopes || []).join(', ')}.`);
    fail(`commit: git failed: ${result.message || result.reason}`);
  }
  store.touchClaim(slug, ticket.ref, by); // committing is proof of life; keep the backstop honest
  const warnings: string[] = [];
  // Mirrors the MCP commit path: an unrecorded commit reads as baseline drift and revokes the write lease
  // that authorized it, which makes submit's release-fragment requirement unsatisfiable (SQ-2182).
  const sanctioned = store.recordSanctionedCommit(slug, ticket.ref, { by, commit: result.commit });
  if (!sanctioned.ok && sanctioned.reason !== 'no_dispatch') warnings.push(store.unrecordedSanctionedCommitWarning(sanctioned.reason));
  if (result.unscopedPaths.length) {
    const comment = store.addComment(slug, ticket.ref, { by, body: outOfScopeComment(result.unscopedPaths), kind: 'comment', source: 'cli' });
    if (!comment.ok) warnings.push(`out-of-scope paths weren't recorded: ${comment.reason}`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      project: slug,
      ref: ticket.ref,
      commit: result.commit,
      paths: result.paths,
      missingScopes: result.missingScopes,
      unscopedPaths: result.unscopedPaths,
      ...(warnings.length ? { warnings } : {}),
    }, null, 2) + '\n');
    return;
  }
  warnings.push(
    result.missingScopes.length ? `missing declared paths: ${result.missingScopes.join(', ')}` : '',
    result.unscopedPaths.length ? `out-of-scope changes: ${result.unscopedPaths.join(', ')}` : '',
  );
  const visibleWarnings = warnings.filter(Boolean);
  console.log(`✓ ${ticket.ref} committed ${result.commit.slice(0, 12)} (${result.paths.join(', ')})${visibleWarnings.length ? `\n  ${visibleWarnings.join('\n  ')}` : ''}`);
}

// Executor terminal for repo-changing tickets: park verified, committed work as
// READY_FOR_INTEGRATION instead of publishing it. The orchestrator's publish
// transaction (references/publishing.md) integrates, versions, reverifies,
// pushes, and marks done. --clear is the orchestrator's reset for a bounced
// integration (drops the submission, optionally with -s todo).
function verifyEmbedsWorktreeRoot(verify: any, worktreeRoot: any) {
  if (typeof verify !== 'string' || !verify || !worktreeRoot) return false;
  const normalize = (value: any) => String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const root = normalize(path.resolve(worktreeRoot));
  const command = normalize(verify);
  const caseInsensitive = /^[a-z]:\//i.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableCommand = caseInsensitive ? command.toLowerCase() : command;
  let offset = comparableCommand.indexOf(comparableRoot);
  while (offset !== -1) {
    const next = comparableCommand.charAt(offset + comparableRoot.length);
    if (!next || next === '/' || !/[a-z0-9._-]/i.test(next)) return true;
    offset = comparableCommand.indexOf(comparableRoot, offset + comparableRoot.length);
  }
  return false;
}

async function cmdRework(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('rework: pass a ticket ref, e.g. sidequest rework SQ-3 --by reviewer --review SQ-4 --reason "what needs repair"');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const review = String(opts.review || '').trim();
  const reason = String(opts.reason || '').trim();
  const res = store.reworkSubmission(slug, idOrRef, {
    by,
    review,
    reason,
    source: opts.source || 'cli',
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ ${res.ticket.ref} rejected for rework; dispatch it for repair  [${res.ticket.status}]  — ${meta.name}`);
  else reportClaimFailure('rework submission', idOrRef, res, meta);
}

function sourceRevisionProjectCapabilities(opts: any, includeExecutionCapabilities: boolean) {
  if (!includeExecutionCapabilities) return undefined;
  return {
    process: !opts['no-process'],
    worktree: !opts['no-worktree'],
    review: !!opts.review,
  };
}

async function cmdSubmit(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('submit: pass a ticket id or ref, e.g. sidequest submit SQ-3 --by me --commit <hash>');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  if (opts.clear) {
    const res = store.clearSubmission(slug, idOrRef, {
      by,
      status: opts.status,
      source: opts.source || 'cli',
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
      if (!res.ok) process.exitCode = 1;
      return;
    }
    if (res.ok) console.log(`✓ cleared submission on ${res.ticket.ref}  [${res.ticket.status}]  — ${meta.name}`);
    else reportClaimFailure('clear submission', idOrRef, res, meta);
    return;
  }
  const body = await bodyFromOpts(opts, 'submit');
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) fail(`submit: no ticket "${idOrRef}" in ${meta.name}.`);
  const sourceRevisionValue = String(opts['source-revision-value'] || '').trim();
  if (sourceRevisionValue && opts.commit) {
    fail('submit: pass exactly one of --commit or --source-revision-value.');
  }
  const retryCandidate = ticket.submissionRetry?.candidate;
  const retryWithoutIdentity = retryCandidate && !sourceRevisionValue && !opts.commit;
  const requestedSourceRevision = sourceRevisionValue
    ? {
      source: String(opts['source-revision-source'] || '').trim(),
      value: sourceRevisionValue,
      observedAt: String(opts['source-revision-observed-at'] || '').trim(),
    }
    : null;
  const hydratedSourceRevision = retryCandidate
    ? (retryCandidate.source === 'git' ? null : retryCandidate)
    : requestedSourceRevision;
  if (hydratedSourceRevision || retryWithoutIdentity) {
    const projectCapabilities = hydratedSourceRevision
      ? sourceRevisionProjectCapabilities(opts, Boolean(sourceRevisionValue && !retryCandidate))
      : undefined;
    const adapterFacts = hydratedSourceRevision
      ? sourceRevisionAdapterFacts(slug, hydratedSourceRevision, sourceRevisionBaseline(ticket))
      : null;
    let res;
    try {
      res = store.submitTicket(slug, idOrRef, by, {
        ...(hydratedSourceRevision ? {
          sourceRevision: hydratedSourceRevision,
          changedSurfaces: retryCandidate ? ticket.submissionRetry?.changedSurfaces : opts['changed-surface'],
        } : {}),
        ...(projectCapabilities ? { projectCapabilities } : {}),
        ...(adapterFacts ? { admissionFacts: adapterFacts } : {}),
        verify: opts.verify,
        force: !!opts.force,
        source: opts.source || 'cli',
        sessionId: sessionId(opts),
      });
    } catch (error: any) {
      fail(`submit: ${(error && error.message) || error}`);
    }
    if (res.ok) {
      const comment = addBodyComment(slug, idOrRef, by, body, opts.source || 'cli');
      if (comment && !comment.ok) fail(`submit: recorded ${idOrRef}, but couldn't add evidence comment: ${comment.reason}`);
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
      if (!res.ok) process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      reportClaimFailure('submit', idOrRef, res, meta);
      return;
    }
    const submissionIdentity = res.ticket.submission.sourceRevision
      ? `${res.ticket.submission.sourceRevision.source}:${res.ticket.submission.sourceRevision.value}`
      : res.ticket.submission.commit;
    console.log(`✓ ${res.ticket.ref} READY_FOR_INTEGRATION (${submissionIdentity})  — ${meta.name}`);
    return;
  }
  if (verifyEmbedsWorktreeRoot(opts.verify, store.nearestRepoRoot(process.cwd()))) {
    fail(`submit: refused ${ticket.ref}; --verify embeds this worktree path. Run verification from the repo root and use repo-relative paths.`);
  }
  const gitRef = opts.gitref || opts['git-ref'] || `refs/sidequest/${ticket.ref}`;
  const collected = collectGitSubmissionFacts({
    slug,
    ticket,
    root: process.cwd(),
    commit: opts.commit,
    gitRef,
    base: opts.base,
  });
  const { target, range, scope } = collected;
  const unscopedPaths = commitScope.unscopedWorkingPaths(process.cwd(), scope);
  let res;
  try {
    res = store.submitTicket(slug, idOrRef, by, {
      commit: opts.commit,
      gitRef,
      range: range?.ok ? Object.assign({}, range, { integrationMode: target?.mode, integrationBranch: target?.branch }) : undefined,
      verify: opts.verify,
      worktree: opts.worktree,
      unscopedPaths,
      admissionFacts: collected.admissionFacts,
      force: !!opts.force,
      source: opts.source || 'cli',
      sessionId: sessionId(opts),
    });
  } catch (e: any) {
    fail(`submit: ${(e && e.message) || e}`);
  }
  if (res.ok) {
    const comment = addBodyComment(slug, idOrRef, by, body, opts.source || 'cli');
    if (comment && !comment.ok) fail(`submit: recorded ${idOrRef}, but couldn't add evidence comment: ${comment.reason}`);
    if (comment && comment.advisory) res.advisory = comment.advisory;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    const s = res.ticket.submission;
    console.log(`✓ ${res.ticket.ref} READY_FOR_INTEGRATION (${s.commit.slice(0, 12)} @ ${s.gitRef})  — ${meta.name}`);
    console.log(s.integrationMode === 'local'
      ? `  claim released; the orchestrator integrates and reverifies against local ${s.upstream}, then marks done without pushing.`
      : `  claim released; the orchestrator publish transaction integrates, reverifies, pushes ${s.upstream}, and marks done.`);
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
  } else {
    reportClaimFailure('submit', idOrRef, res, meta);
  }
}

function abbreviatedSessionId(value: any): string {
  const id = String(value || '').trim();
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function publishLockRefusal(holder: any, by: any, runtimeSessionId: any): string {
  const lockSessionId = String(holder?.sessionId || '').trim();
  const callerSessionId = String(runtimeSessionId || '').trim();
  if (holder?.by === by && lockSessionId && callerSessionId && lockSessionId !== callerSessionId) {
    return `integrate: publish lock session ${abbreviatedSessionId(lockSessionId)} does not match this session ${abbreviatedSessionId(callerSessionId)}; re-acquire the lock from this session (publish lock --by ${by}).`;
  }
  return `integrate: publish lock is held by ${holder?.by || lockSessionId || 'another session'}; acquire or re-acquire it before delivery.`;
}

async function cmdIntegrate(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('integrate: pass a ticket id or ref, e.g. sidequest integrate SQ-3 --by orchestrator --mode replay.');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const usesGit = store.submissionUsesGit(ticket);
  const publish = require('../lib/publish');
  const runtimeSessionId = sessionId(opts);
  if (usesGit) {
    const lock = await publish.publishLockStatus(meta.path);
    if (lock.locked && !publish.publishLockOwnedBySession(meta.path, runtimeSessionId)) {
      fail(publishLockRefusal(lock.holder, by, runtimeSessionId));
    }
  }
  let target: any = null;
  if (usesGit) {
    try {
      target = store.integrationTarget(slug);
    } catch (error: any) {
      fail(`integrate: ${(error && error.message) || error}`);
      return;
    }
  }
  if (opts['delivery-commit'] != null) {
    const recorded = store.recordDeliveredSubmission(slug, idOrRef, {
      target,
      deliveryCommit: opts['delivery-commit'],
      reason: opts.reason,
      skipVerify: !!opts['skip-verify'],
    });
    if (!recorded.ok) fail(`integrate: ${recorded.message || recorded.reason}.`);
    const closed = store.completeTicketAsControlPlane(slug, idOrRef, {
      by,
      reason: opts.reason,
      purpose: 'integration',
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(Object.assign({ project: slug, delivery: recorded.integration, verify: recorded.integration.verify }, closed), null, 2) + '\n');
      if (!closed.ok) process.exitCode = 1;
      return;
    }
    if (!closed.ok) fail(`integrate: recorded delivery for ${idOrRef}, but could not close it: ${closed.message || closed.reason}.`);
    console.log(`✓ ${closed.ticket.ref} recorded delivered commit ${recorded.integration.deliveryCommit} onto ${recorded.integration.targetBranch} — ${meta.name}`);
    return;
  }
  const mode = opts.mode == null ? store.boardConfig(slug).delivery : opts.mode;
  const delivery = store.integrateSubmission(slug, idOrRef, {
    mode,
    target,
    skipVerify: !!opts['skip-verify'],
  });
  if (!delivery.ok) {
    if (delivery.reason === 'verify_failed_post_merge' || delivery.reason === 'verify_failed_post_merge_rollback_failed') {
      const payload = { project: slug, delivery: null, verifyFailed: delivery.verify };
      if (opts.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        process.exitCode = 1;
        return;
      }
      fail(`integrate: ${delivery.message || 'verification failed after delivery and rollback'}`);
    }
    if (delivery.outside?.length) fail(`integrate: refused ${idOrRef}; submitted range changes paths outside its admitted scope: ${delivery.outside.join(', ')}.`);
    fail(`integrate: ${(delivery.message || delivery.reason)}.`);
  }
  const integration = delivery.integration;
  const verification = store.verifyIntegration(slug, idOrRef, { by, skipVerify: !!opts['skip-verify'] });
  if (!verification.ok) {
    const payload = { project: slug, delivery: integration, verifyFailed: verification.verify };
    if (opts.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }
    fail(`integrate: delivered ${idOrRef}, but verification ${verification.verify.status === 'timeout' ? `timed out after ${verification.verify.timeoutMs}ms` : `failed with exit code ${verification.verify.exitCode}`}. Log: ${verification.verify.logPath}`);
  }
  const verifyReason = verification.verify.status === 'attestation'
    ? `Attestation accepted for ${verification.verify.artifact || 'the source revision'}.`
    : verification.verify.status === 'skipped'
      ? 'Verify skipped by choice.'
      : verification.verify.status === 'manual'
        ? `Manual verification recorded: ${verification.verify.manual}.`
        : verification.verify.status === 'none'
          ? 'Verify: none.'
          : `Verify passed: ${verification.verify.command}.`;
  const reason = usesGit
    ? `Delivered via ${integration.mode} from ${integration.pinnedRef} (${integration.pinnedCommit}) onto ${integration.targetBranch}. ${verifyReason}`
    : `Delivered source revision ${integration.sourceRevision.source}:${integration.sourceRevision.value}. ${verifyReason}`;
  const closed = store.completeTicketAsControlPlane(slug, idOrRef, {
    by,
    reason,
    purpose: 'integration',
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug, delivery: integration, verify: verification.verify }, closed), null, 2) + '\n');
    if (!closed.ok) process.exitCode = 1;
    return;
  }
  if (!closed.ok) fail(`integrate: delivered ${idOrRef}, but could not close it: ${closed.message || closed.reason}.`);
  if (!opts.json && integration.ignoredDirtyPaths?.length) {
    console.log(`info: left unrelated dirty paths untouched: ${integration.ignoredDirtyPaths.join(', ')}`);
  }
  const result = integration.mode === 'source-revision'
    ? `${integration.sourceRevision.source}:${integration.sourceRevision.value}`
    : integration.mode === 'apply'
      ? `working tree changed: ${(integration.dirtyFiles || []).join(', ') || '(no files)'}`
      : `HEAD ${String(integration.resultingHead).slice(0, 12)}`;
  const destination = integration.mode === 'source-revision' ? 'the project source' : integration.targetBranch;
  console.log(`✓ ${closed.ticket.ref} delivered by ${integration.mode} onto ${destination} (${result}) — ${meta.name}`);
}

// Orchestrator control-plane surface: the cross-process publish lock plus the
// integration queue. The lock file lives in the repo's common git dir so every
// worktree/session/process serializes on the same publish transaction.
async function cmdPublish(opts: any, positional: any) {
  const publish = require('../lib/publish');
  const sub = positional[0];
  const emit = (payload: any, failed: any) => {
    if (opts.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      if (failed) process.exitCode = 1;
      return true;
    }
    return false;
  };
  if (sub === 'queue') {
    const { slug, meta } = await resolveProject(opts);
    const payload = store.submissionsPayload(slug);
    const releaseWindow = await publish.releaseWindow(meta.path, store.boardConfig(slug).integrationBranch);
    for (const ticket of payload.tickets) {
      const readiness = store.submissionReadiness(ticket.submission);
      const admittedScope = Array.isArray(ticket.submission.admittedScope) ? ticket.submission.admittedScope : [];
      ticket.rangeValidation = !readiness.ok
        ? readiness
        : !admittedScope.length
          ? {
            ok: false,
            reason: 'missing_scope_snapshot',
            message: 'submission has no admitted scope snapshot; re-submit it, or close with the explicit legacy-scope override and a recorded reason.',
          }
          : ticket.submission.sourceRevision
            ? readiness
            : ticket.submission.base
              ? commitScope.validateStoredSubmissionRange(meta.path, ticket.submission, ticket.ref)
              : { ok: false, reason: 'legacy_submission' };
    }
    const queuePayload = releaseWindow
      ? Object.assign({ project: slug, releaseWindow }, payload)
      : Object.assign({ project: slug }, payload);
    if (emit(queuePayload, false)) return;
    if (releaseWindow) {
      const release = releaseWindow.latestRelease
        ? `${releaseWindow.latestRelease.tag} (${releaseWindow.latestRelease.at})`
        : 'none yet';
      console.log(`release window: ${releaseWindow.fragmentCount} fragment(s), ${releaseWindow.heldCount} held; latest ${release}; ${releaseWindow.integrationBranch} → ${releaseWindow.publishedBranch}; next cut ${releaseWindow.nextScheduledCut}`);
    }
    if (!payload.count) {
      console.log(`no submissions awaiting integration in ${meta.name}.`);
      return;
    }
    console.log(`${payload.count} submission(s) awaiting integration — ${meta.name}:`);
    console.log(`  default delivery: ${payload.delivery || 'merge'}`);
    for (const ticket of payload.tickets) {
      const submission = ticket.submission;
      const paths = Array.isArray(submission.changedPaths) ? submission.changedPaths : [];
      if (submission.sourceRevision) {
        const revision = `${submission.sourceRevision.source}:${submission.sourceRevision.value}`;
        console.log(`  ${ticket.ref}  source revision ${revision}  (by ${submission.by}, ${submission.at})`);
      } else {
        const commits = Array.isArray(submission.commits) && submission.commits.length
          ? submission.commits
          : [submission.commit];
        console.log(`  ${ticket.ref}  ${commits.length} commit(s), tip ${submission.commit.slice(0, 12)} @ ${submission.gitRef}  (by ${submission.by}, ${submission.at})`);
        console.log(`      commits: ${commits.map((commit: any) => commit.slice(0, 12)).join(', ')}`);
      }
      console.log(`      paths: ${paths.join(', ') || '(legacy submission: unavailable)'}`);
      if (!ticket.rangeValidation.ok) {
        const rejectedPaths = Array.isArray(ticket.rangeValidation.unscopedPaths) && ticket.rangeValidation.unscopedPaths.length
          ? ticket.rangeValidation.unscopedPaths
          : Array.isArray(ticket.rangeValidation.outside) ? ticket.rangeValidation.outside : [];
        const pathSuffix = rejectedPaths.length ? `: ${rejectedPaths.join(', ')}` : '';
        console.log(`      REJECTED: ${ticket.rangeValidation.reason}${pathSuffix}`);
      }
      if (submission.verify) console.log(`      verify: ${submission.verify}`);
    }
    return;
  }
  const repo = opts.repo ? path.resolve(String(opts.repo)) : (await resolveProject(opts)).meta.path;
  if (sub === 'lock') {
    const res = await publish.acquirePublishLock(repo, {
      by: workerId(opts),
      sessionId: sessionId(opts),
      steal: !!opts.steal,
      transient: true, // the CLI process exits now; its session holds the lock
    });
    if (emit(res, !res.ok)) return;
    if (res.ok) {
      console.log(`✓ publish lock ${res.reacquired ? 're-acquired' : 'acquired'}: ${res.file}`);
    } else {
      process.exitCode = 1;
      const h = res.holder || {};
      console.log(`✗ publish lock held by "${h.by || h.sessionId || 'unknown'}" (pid ${h.pid}, since ${h.at}) — retry after it releases, or --steal a dead holder.`);
    }
    return;
  }
  if (sub === 'unlock') {
    const res = await publish.releasePublishLock(repo, { by: workerId(opts), sessionId: sessionId(opts), force: !!opts.force });
    if (emit(res, !res.ok)) return;
    if (res.ok) console.log(res.released ? `✓ publish lock released: ${res.file}` : 'publish lock was not held.');
    else {
      process.exitCode = 1;
      const h = res.holder || {};
      console.log(`✗ publish lock belongs to "${h.by || h.sessionId || 'unknown'}" (pid ${h.pid}, since ${h.at}) — not yours to release without --force.`);
    }
    return;
  }
  if (sub === 'status') {
    const res = await publish.publishLockStatus(repo);
    if (emit(res, false)) return;
    if (!res.locked) {
      console.log(`publish lock free: ${res.file}`);
    } else {
      const h = res.holder || {};
      console.log(`publish lock HELD${res.stale ? ' (STALE — reclaimable)' : ''}: ${res.file}`);
      console.log(`  by "${h.by || 'unknown'}"  session ${h.sessionId || '-'}  pid ${h.pid}  host ${h.host}  since ${h.at}`);
    }
    return;
  }
  fail('publish: expected `sidequest publish lock|unlock|status|queue`');
}


module.exports = { validateModelFilter, cmdClaim, cmdCheckpoint, cmdVerdict, cmdRelease, cmdDone, cmdGroomClose, cmdScopeRequest, cmdCommit, cmdRework, cmdSubmit, cmdIntegrate, cmdPublish };
