'use strict';

const {
  path,
  fs,
  store,
  work,
  worktrees,
  agentsync,
  commitScope,
  publish,
  execNames,
  claimRefusalMessage,
  assertSidequestInstall,
  assertDispatchTransport,
  resolveProject,
  runtimeSessionId,
  sessionOf,
  requireDispatchSession,
  workflowRecipe,
  requireBy,
  effortDrift,
  executorDrift,
  requireKnownModelFilter,
  requireKnownModel,
  pathList,
  provenNoOpCloseout,
  PROJECT_PROP,
  FILES_PROP,
  LABELS_PROP,
  CONTRACT_PROP,
  MODEL_FILTER_PROP,
  TOOL_DESCRIPTION_OVERRIDES,
  conciseDescription,
  validateStoryId,
  compactSchema,
  LIST_CHAR_BUDGET,
  closeDispatchExecutor,
  mutationAck,
  integrationBranchAck,
  outOfScopeComment,
  COMPACT_RESULT_MAX_BYTES,
  COMPACT_PULSE_BODY_MAX_CHARS,
  PAGED_FULL_DEFAULT_LIMIT,
  PAGE_LIMIT_MAX,
  boundedExcerpt,
  compactComment,
  categoryListEntry,
  pageArguments,
  pageRows,
  pagedPayload,
  compactPulse,
  requiredText,
  requiredFinalReport,
  boundedSubmissionText,
  preserveRejectedSubmission,
  requiredReleaseReason,
  worktreeRoot,
  verifyEmbedsWorktreeRoot,
  withoutCategories,
  CATEGORY_TAXONOMY_WARNING,
  state,
} = require('./mcp-shared');
const { validateSubmissionAdmission } = require('./kernel/submission');

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => any | Promise<any>;
};

type ShippedPlugin = {
  name: string;
  source: string;
};

function compactIntegrationDelivery(integration: any) {
  const { verify: _verify, ...delivery } = integration;
  return delivery;
}

function objectProperties(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}

function marketplacePlugins(repoPath: string): ShippedPlugin[] {
  const manifestPath = path.join(repoPath, '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = objectProperties(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  return plugins.flatMap((entry) => {
    const plugin = objectProperties(entry);
    const name = typeof plugin.name === 'string' ? plugin.name.trim() : '';
    const source = typeof plugin.source === 'string' ? plugin.source.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') : '';
    return name && source && !source.startsWith('../') ? [{ name, source }] : [];
  });
}

function missingReleaseFragment(repoPath: string, ref: string, changedPaths: string[]) {
  return store.missingReleaseFragment(repoPath, ref, changedPaths);
}

function missingReleaseFragmentMessage(ref: string, fragmentPath: string, plugins: ShippedPlugin[]): string {
  return store.missingReleaseFragmentMessage(ref, fragmentPath, plugins);
}

function combinedRefusal(ticket: any, failures: Array<{ reason: string; message: string }>) {
  const primary = failures[0];
  if (!primary) throw new Error('combined refusal requires at least one failure');
  return {
    ok: false,
    ticket,
    reason: primary.reason,
    message: failures.map((failure) => failure.message).join('\n\n'),
    failures,
  };
}

function dispatchBaseMessage(ticket: any): string {
  const dispatchBase = String(ticket.dispatch?.baseCommit || '').trim();
  return dispatchBase
    ? `the pinned dispatch base commit ${dispatchBase}`
    : 'the pinned dispatch base commit recorded in the dispatch';
}

function submissionRangeRemedy(ticket: any, range: any, gitRef: string): string {
  const reason = String(range.reason || '').trim();
  const pinnedBase = dispatchBaseMessage(ticket);
  const remedies: Record<string, string> = {
    missing_git_ref: `${gitRef} is missing or does not point to the submitted commit. Run \`git update-ref ${gitRef} <commit>\`, then resubmit.`,
    missing_upstream: `fetch or recreate the recorded integration ref, then resubmit the preserved commit without changing its base.`,
    missing_commit: `preserve the work commit, restore it in this worktree, update ${gitRef}, and resubmit.`,
    tip_mismatch: `${gitRef} points to a different commit. Point it back at the submitted commit with \`git update-ref ${gitRef} <commit>\`, then resubmit.`,
    missing_recorded_upstream: `fetch the recorded upstream commit, then resubmit the preserved commit without changing its base.`,
    expected_upstream_diverged: `preserve the submission for orchestrator reconciliation; do not replace it by syncing to a branch tip.`,
    unrelated_history: `rebuild only this ticket's work from ${pinnedBase}, update ${gitRef}, and resubmit.`,
    missing_base: `restore the recorded base commit, or rebuild only this ticket's work from ${pinnedBase}, then resubmit.`,
    merge_commit: `the submitted range includes merge commit ${range.commit || 'unknown'}. Do not use \`git pull\`: it creates the refused shape. Submit the pre-merge work commit, or rebuild the work range from ${pinnedBase} without a merge commit.`,
    empty_range: `the submitted commit has no work beyond its base. Submit the commit that contains this ticket's work, or use the explicit no-op closeout when no work was produced.`,
    base_not_reachable: `the supplied base no longer reaches the submitted commit. Recreate the ticket work from ${pinnedBase}, preserve only this ticket's commits, update ${gitRef}, and resubmit.`,
    unrecognized_base: `use the recorded ${pinnedBase} or an approved submitted-ticket boundary, then resubmit only this ticket's commits.`,
    range_changed: `the stored submission range changed. Preserve the original submission for the orchestrator to reconcile; do not replace it by syncing to a branch tip.`,
    no_op_changed: `the stored no-op state changed. Preserve the original submission for the orchestrator to reconcile; do not replace it by syncing to a branch tip.`,
    reconciled_path_diverged: `the already-reconciled path diverged at the integration tip. Preserve the original submission for the orchestrator to reconcile; do not replace it by syncing to a branch tip.`,
    git_error: `preserve the submitted commit and retry once the Git error is resolved; do not change the range merely because the integration tip advanced.`,
  };
  return remedies[reason] || `preserve the submitted commit and inspect the refusal before changing the range. If a new range is necessary, rebuild it from ${pinnedBase}, never from a live branch tip.`;
}

function submissionRangeFailureMessage(ticket: any, range: any, gitRef: string) {
  const reason = String(range.reason || '').trim();
  const validationMessage = String(range.message || '').trim();
  const detail = `${reason}${validationMessage ? `: ${validationMessage}` : ''}`;
  return `submit: refused ${ticket.ref}; ${detail}. Remedy: ${submissionRangeRemedy(ticket, range, gitRef)} A dispatch base behind the integration tip is expected and does not need syncing.`;
}

function uncommittedScopeFailureMessage(ticket: any, paths: string[]) {
  return `submit: refused ${ticket.ref}; uncommitted changes fall inside this ticket's declared scope: ${paths.join(', ')}. Commit these paths, or explain why they are deliberately excluded before resubmitting.`;
}

function submissionRoot(meta: any, worktree: any, commit: string, gitRef: string): string {
  if (worktree == null) return process.cwd();
  try {
    return worktreeRoot(worktree, 'submit');
  } catch (worktreeError: any) {
    const supplied = String(worktree || '').trim();
    if (supplied && fs.existsSync(supplied)) throw worktreeError;
    let repository: string;
    try {
      repository = commitScope.repoRoot(meta.path);
    } catch (repositoryError: any) {
      throw new Error(`submit: worktree is gone and the board repository is unavailable: ${repositoryError?.message || repositoryError}`);
    }
    const preserved = commitScope.preserveCommitRef(repository, commit, gitRef);
    if (!preserved.ok) {
      throw new Error(`submit: worktree is gone and ${commit} is unavailable from the board repository: ${preserved.message || preserved.reason}. Release this ticket to todo for a fresh board dispatch; the board cannot submit a candidate it cannot inspect.`);
    }
    return repository;
  }
}

function validateSubmissionCandidate(options: any) {
  const { slug, ticket, by, root, commit, gitRef, verify, base, force = false, source = 'mcp' } = options;
  const attestation = ticket.executorVerifyKind === 'attestation';
  const admission = validateSubmissionAdmission({
    ownershipFailure: (candidate: any, owner: string, allowSubmittedOwner: boolean) => store.submissionOwnershipFailure(candidate, owner, { allowSubmittedOwner }),
    completionCheck: (project: string, candidate: any, explicitNoOp: boolean) => store.completionTreeCheck(project, candidate, { explicitNoOp }),
    verifyErrors: (candidate: any, submittedVerify: string) => attestation
      ? store.attestationErrors(submittedVerify, candidate.executorAttestationArtifact)
      : store.verifyCommandErrors(submittedVerify),
    declaredVerify: (candidate: any) => attestation ? '' : String(candidate.executorVerify || '').trim(),
  }, { slug, ticket, by, verify, base, commit, force });
  if (!Array.isArray(admission)) return admission;
  const independentFailures: Array<{ reason: string; message: string }> = [...admission];
  const dispatchTarget = ticket.dispatch && ticket.dispatch.integrationTarget;
  let target: any;
  try {
    target = store.integrationTarget(slug, dispatchTarget || undefined);
  } catch (error: any) {
    const reason = 'integration_target_unavailable';
    const message = (error && error.message) || String(error);
    const targetName = dispatchTarget && typeof dispatchTarget === 'object'
      ? String(dispatchTarget.upstream || dispatchTarget.branch || 'the recorded integration target')
      : String(dispatchTarget || 'the configured integration target');
    const remedy = `Fetch or recreate ${targetName}, rebase ${gitRef} onto that target, and resubmit. Or the orchestrator can cherry-pick a recorded rejection quarantine ref and record the range override.`;
    if (independentFailures.length) return combinedRefusal(ticket, [...independentFailures, { reason, message: `submit: refused ${ticket.ref}; ${boundedSubmissionText(message)}. Remedy: ${remedy}` }]);
    if (!verify) return { ok: false, ticket, reason, message: `submit: refused ${ticket.ref}; ${boundedSubmissionText(message)}. Remedy: ${remedy}` };
    return preserveRejectedSubmission({ slug, ticket, by, root, commit, gitRef, verify, reason, message, remedy, source });
  }
  const dispatchBase = String(ticket.dispatch?.baseCommit || '').trim() || null;
  const allowedBases = store.submissionBaseCandidates(slug, ticket.ref);
  if (dispatchBase) allowedBases.push(dispatchBase);
  const rangeOptions = {
    commit,
    gitRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
    base,
    dispatchBase,
    allowedBases,
    baseCandidates: base ? [] : store.submissionBaseCandidates(slug, ticket.ref, { integratedOnly: true }),
  };
  const range = commitScope.submissionRange(root, rangeOptions);
  const submissionFailures: Array<{ reason: string; message: string }> = [];
  if (!range.ok) submissionFailures.push({ reason: range.reason, message: submissionRangeFailureMessage(ticket, range, gitRef) });
  const scope = commitScope.ticketCommitScope(store.executionScope(slug, ticket), ticket.files, ticket.ref);
  if (range.ok) {
    const pending = commitScope.scopedWorkPending(root, scope, { base: range.base });
    if (!pending.ok) {
      submissionFailures.push({ reason: pending.reason, message: `submit: could not inspect the declared scope in ${root}: ${pending.message || pending.reason}` });
    } else if (pending.working.length) {
      submissionFailures.push({ reason: 'dirty_scope', message: uncommittedScopeFailureMessage(ticket, pending.working) });
    }
    const duplicate = store.submissionsPayload(slug).tickets
      .filter((entry: any) => entry.ref !== ticket.ref)
      .find((entry: any) => {
        const commits = Array.isArray(entry.submission.commits) && entry.submission.commits.length
          ? entry.submission.commits : [entry.submission.commit];
        return commits.some((entryCommit: any) => range.commits.includes(entryCommit));
      });
    if (duplicate) {
      submissionFailures.push({ reason: 'duplicate_submission', message: `submit: refused ${ticket.ref}; its range includes commit(s) already submitted by ${duplicate.ref}.` });
    }
  }
  const rangeForChecks = range.ok ? range : null;
  if (rangeForChecks) {
    const scopedRange = commitScope.validateCommitRangeScope(root, rangeForChecks.commits, scope);
    if (!scopedRange.ok) {
      const validationMessage = scopedRange.reason === 'missing_scope'
        ? `submit: ${ticket.ref} has no declared file scope, so its range cannot be admitted for integration. An executor cannot declare its own scope: release with kind "handback", naming the paths this range changes, so the orchestrator can declare them and redispatch.`
        : scopedRange.reason === 'outside_scope'
          ? `submit: refused ${ticket.ref}; submitted range changes paths outside its declared scope: ${scopedRange.outside.join(', ')}. Request scope only for work this ticket owns with: ${store.scopeExpansionCommand(ticket, scopedRange.outside)}. Commit only approved scope; never stash, revert, or include foreign paths.`
          : `submit: could not inspect ${commit} from ${root}: ${scopedRange.message || scopedRange.reason}. If the commit is pinned on ${gitRef} it survives this tree; release with kind "handback" naming this failure so the orchestrator can deliver it from the repository.`;
      submissionFailures.push({ reason: scopedRange.reason, message: validationMessage });
    }
    const missingFragment = missingReleaseFragment(root, ticket.ref, scopedRange.paths || rangeForChecks.changedPaths);
    if (missingFragment) {
      submissionFailures.push({ reason: 'missing_release_fragment', message: missingReleaseFragmentMessage(ticket.ref, missingFragment.fragmentPath, missingFragment.plugins) });
    }
  }
  const failures = [...submissionFailures, ...independentFailures];
  if (!range.ok && failures.length === 1 && verify) {
    const remedy = submissionRangeRemedy(ticket, range, gitRef);
    return preserveRejectedSubmission({ slug, ticket, by, root, commit, gitRef, verify, reason: range.reason, message: range.message || '', remedy, source, force });
  }
  if (failures.length) return combinedRefusal(ticket, failures);
  return { ok: true, ticket, target, range, scope };
}

const tools: ToolDefinition[] = [
  {
    name: 'claim',
    description: 'Claim before work; routed work needs executor and token file. direct:true needs an inline-safe reason.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string', description: 'Unique per-worker id (e.g. claude-<8 hex>).' },
        effort: { type: 'string', enum: store.VALID_EFFORTS },
        executor: { type: 'string', description: 'Exact executor name from the dispatch.' },
        token: { type: 'string', description: 'Legacy token.' },
        tokenFile: { type: 'string', description: 'Dispatched token-file path.' },
        direct: { type: 'boolean', description: 'Inline-safe exception; requires a recorded reason.' },
        reason: { type: 'string', description: 'Inline-safe rationale (20+ chars, required with direct:true).' },
        force: { type: 'boolean', description: 'Steal a live claim only when certain.' },
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'claim');
      const drift = executorDrift(slug, args.ref, args.effort, args.executor, args.token, !!args.direct);
      if (drift) {
        const ticket = store.getTicket(slug, args.ref);
        const guidance = drift.reason === 'executor_mismatch'
          ? { message: claimRefusalMessage(drift.reason, args.ref, ticket || {}, meta.path) }
          : {};
        return Object.assign({ ok: false }, drift, guidance);
      }
      const res = store.claimTicket(slug, args.ref, by, { force: !!args.force, direct: !!args.direct, reason: args.reason, token: args.token, tokenFile: args.tokenFile, executor: args.executor, source: 'mcp', sessionId: sessionOf(args), requireBoundAgent: true });
      if (!res.ok) res.message = claimRefusalMessage(res.reason, args.ref, res.ticket || res.claim, meta.path);
      return mutationAck(slug, res);
    },
  },
  {
    name: 'checkpoint',
    description: 'Record a verified live review candidate without releasing the claim or ending the dispatch. Use the returned checkpoint id in linked review findings.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        commit: { type: 'string', pattern: '^[0-9a-fA-F]{7,64}$' },
        worktree: { type: 'string', description: 'Absolute path to the verified candidate worktree.' },
        verify: { type: 'string', minLength: 1, maxLength: 4000, description: 'Verification command and result evidence.' },
        ttlMinutes: { type: 'integer', minimum: 1, maximum: store.MAX_CHECKPOINT_TTL_MIN },
      },
      required: ['ref', 'by', 'verify'],
      anyOf: [
        { required: ['commit'] },
        { required: ['worktree'] },
      ],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, 'checkpoint');
      const res = store.checkpointTicket(slug, args.ref, by, {
        commit: args.commit,
        worktree: args.worktree,
        verify: args.verify,
        ttlMinutes: args.ttlMinutes,
        source: 'mcp',
      });
      return mutationAck(slug, res, res.ok ? { checkpoint: res.checkpoint, commentId: res.comment.id } : null);
    },
  },
  {
    name: 'sweepClaims',
    description: 'Audit residual reclaimable claims. Observed terminal executor failures release their exact claim immediately; this only handles unobserved idle/abandoned backstops and missing worktrees.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_PROP },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      return store.sweepStaleClaims({ project: slug, source: 'mcp' });
    },
  },
  {
    name: 'next',
    description: 'Atomically claim the top-priority available ticket. Filter by resolved model and/or category ID. Returns ok:false reason:empty when nothing is claimable.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        by: { type: 'string' },
        model: { type: 'string', description: 'Filter to a resolved Claude runtime or discovered Codex model slug.' },
        category: { type: 'string', description: 'Filter to a category ID.' },
        priority: { type: 'string', enum: store.VALID_PRIORITY },
        direct: { type: 'boolean', description: 'Inline-safe exception; requires a recorded reason.' },
        reason: { type: 'string', description: 'Inline-safe rationale (20+ chars, required with direct:true).' },
        session: { type: 'string' },
      },
      required: ['by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'next');
      requireKnownModelFilter('next', args.model);
      const res = store.claimNext(slug, by, { priority: args.priority, model: args.model, category: args.category, direct: !!args.direct, reason: args.reason, source: 'mcp', sessionId: sessionOf(args) });
      if (!res.ok) res.message = claimRefusalMessage(res.reason, res.ticket && res.ticket.ref || 'next ticket', res.ticket || res.claim);
      return mutationAck(slug, res, res.ok ? { claim: res.ticket.claim } : null);
    },
  },
  {
    name: 'done',
    description: 'Finish claimed non-repo or active artifact work; repo work submits, while a recorded no-op release can close with done. body carries the final report. Stamp actual model and effort.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        model: { type: 'string', description: 'Concrete runtime model that actually worked this ticket (provenance).' },
        effort: { type: 'string', enum: store.VALID_EFFORTS },
        body: { type: 'string', description: 'Final report stored as the completion comment.' },
        session: { type: 'string' },
      },
      required: ['ref', 'by', 'body'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'done');
      const body = requiredFinalReport(args, 'done');
      const ticket = store.getTicket(slug, args.ref);
      const model = requireKnownModel('done', args.model, ticket);
      const opts = { source: 'mcp', model, effort: args.effort, body, sessionId: sessionOf(args) };
      let res = store.completeTicket(slug, args.ref, by, opts);
      if (!res.ok && ['submission_required', 'empty_declared_scope'].includes(res.reason)) {
        const noOp = provenNoOpCloseout(slug, res.ticket);
        if (noOp.ok) {
          res = store.completeTicket(slug, args.ref, by, Object.assign({}, opts, {
            cleanDeclaredScope: true,
            completionProvenance: { closeout: 'no-repo-changes', worktree: noOp.root },
          }));
        } else {
          res.message = `${res.message} ${noOp.detail}`;
        }
      }
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res);
    },
  },
  {
    name: 'groomClose',
    description: 'Close with evidence, including a delivered commit.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        reason: { type: 'string' },
        integration: { type: 'boolean' },
        deliveryCommit: { type: 'string', pattern: '^[0-9a-fA-F]{7,64}$', description: 'Commit already on the integration branch.' },
        recoveryEvidence: { type: 'string', description: 'Observed terminal-agent evidence for an unclaimed dispatch.' },
        overrideLegacyScope: { type: 'boolean', description: 'Permit only a legacy submission without an admitted scope snapshot; the required reason is recorded on the ticket.' },
      },
      required: ['ref', 'by', 'reason'],
    },
    async handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'groomClose');
      const reason = String(args.reason || '').trim();
      if (!reason) throw new Error('groomClose: reason is required.');
      const ticket = store.getTicket(slug, args.ref);
      if (args.recoveryEvidence) {
        const recovered = store.clearUnclaimedDispatch(slug, args.ref, { by, evidence: args.recoveryEvidence });
        if (!recovered.ok) return mutationAck(slug, recovered);
      }
      const purpose = args.integration ? 'integration' : args.deliveryCommit ? 'delivery' : 'grooming';
      const res = store.completeTicketAsControlPlane(slug, args.ref, {
        by,
        reason,
        purpose,
        deliveryCommit: args.deliveryCommit,
        overrideLegacyScope: args.overrideLegacyScope === true,
      });
      if (res.ok) closeDispatchExecutor(ticket);
      if (res.ok && args.integration) {
        // Advance before sweeping: a local integration branch that just moved
        // makes this ticket's worktree reachable, which the sweep collects on.
        try {
          const integrationTarget = store.integrationTarget(slug);
          res.integrationBranch = await worktrees.advanceIntegrationBranch(meta.path, {
            integrationTarget,
            submissionCommit: res.ticket.submission ? res.ticket.submission.commit : null,
            submissionWorktree: res.ticket.submission ? res.ticket.submission.worktree : null,
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
      return mutationAck(slug, res, res.ok
        ? Object.assign({ completion: res.ticket.completion }, integrationBranchAck(res.integrationBranch))
        : null);
    },
  },
  {
    name: 'release',
    description: 'Release a claim. Use kind oracle with an oracle ask to park it as awaiting-oracle for a human verdict, then exit. The oracle handoff stays visible until a verdict is recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        reason: { type: 'string' },
        kind: { type: 'string', enum: ['technical_blocker', 'contradiction', 'oracle', 'handback'] },
        command: { type: 'string', description: 'Required for blocker/contradiction.' },
        exitCode: { type: 'integer' },
        outputTail: { type: 'string', description: 'Required blocker/contradiction output.' },
        oracle: { type: 'string' },
        candidate: { type: 'string' },
        deliverable: { type: 'string' },
        status: { type: 'string', enum: store.VALID_STATUS },
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'release');
      const reason = requiredReleaseReason(args);
      const ticket = store.getTicket(slug, args.ref);
      const evidence = store.technicalBlockerRelease(Object.assign({}, args, { releaseKind: args.kind }));
      if (!evidence.ok) return mutationAck(slug, { ok: false, ticket, reason: evidence.reason, message: evidence.message });
      const res = store.releaseTicket(slug, args.ref, by, {
        status: args.kind === 'oracle' ? 'awaiting-oracle' : args.status,
        oracle: args.oracle,
        candidate: args.candidate,
        deliverable: args.deliverable,
        releaseComment: { by, body: store.releaseCommentBody(reason, evidence.evidence), kind: 'comment', source: 'mcp' },
        releaseKind: evidence.releaseKind,
        releaseReason: reason,
        releaseEvidence: evidence.evidence,
        source: 'mcp',
        sessionId: sessionOf(args),
      });
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res);
    },
  },
  {
    name: 'verdict',
    description: 'Record an oracle verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        text: { type: 'string' },
        outcome: { type: 'string', enum: ['accepted', 'rejected', 'inconclusive'] },
        why: { type: 'string' },
        constraint: { type: 'string' },
      },
      required: ['ref', 'text', 'outcome'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const result = store.applyExperimentVerdict(slug, args.ref, {
        text: args.text,
        outcome: args.outcome,
        why: args.why,
        constraint: args.constraint,
      });
      if (result.ok) {
        store.addComment(slug, args.ref, {
          by: 'oracle',
          body: `Oracle verdict (${args.outcome}): ${args.text}`,
          kind: 'comment',
          source: 'mcp',
        });
      }
      return mutationAck(slug, result);
    },
  },
  {
    name: 'scopeRequest',
    description: 'Request scope and receive an immediate ruling.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['ref', 'by', 'files'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, 'scopeRequest');
      const res = store.requestScope(slug, args.ref, by, args.files, { source: 'mcp' });
      const changed = res.ok ? {
        covered: res.covered || [],
        approved: res.approved || [],
        refused: res.refused || [],
        autoApproved: !!res.autoApproved,
        state: res.state,
        effectiveScope: res.resolution?.effectiveScope,
        resolution: res.resolution || null,
        ...(res.state === 'refused' ? {
          instruction: 'Commit in-scope work, then release with kind "handback" and name the refused paths.',
        } : {}),
      } : null;
      return mutationAck(slug, res, changed);
    },
  },
  {
    name: 'commit',
    description: 'Commit only a claimed ticket’s declared paths in an explicit local git worktree. Returns the commit hash; foreign staged paths stay staged.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        message: { type: 'string' },
        worktree: { type: 'string', description: 'Absolute path to this executor’s git worktree root.' },
      },
      required: ['ref', 'by', 'message', 'worktree'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'commit');
      const message = requiredText(args, 'message', 'commit');
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`commit: no ticket "${args.ref}" in ${meta.name}.`);
      if (!ticket.claim || ticket.claim.by !== by) {
        const released = !ticket.claim && ticket.claimRelease
          ? ` ${store.autoReleasedClaimMessage(ticket.ref, ticket.claimRelease)}`
          : '';
        return mutationAck(slug, { ok: false, ticket, reason: 'not_owner', message: `commit: ${ticket.ref} must be claimed by "${by}" before committing.${released}` });
      }
      const root = worktreeRoot(args.worktree, 'commit');
      if (ticket.dispatch && ticket.dispatch.sharedTree === false) {
        const location = commitScope.linkedWorktree(root);
        if (!location.ok || !location.linked) {
          return mutationAck(slug, {
            ok: false,
            ticket,
            reason: 'worktree_isolation',
            message: `commit: refused ${ticket.ref}; this dispatch requires a linked worktree. Do not commit in the shared tree. Report that the executor lost its worktree to the orchestrator and re-dispatch.`,
          });
        }
      }
      const scope = commitScope.ticketCommitScope(store.executionScope(slug, ticket), ticket.files, ticket.ref);
      const outsideWorktree = commitScope.validateRelativeScopes(scope).outside;
      if (outsideWorktree.length) {
        return mutationAck(slug, {
          ok: false,
          ticket,
          reason: 'outside_scope',
          message: `commit: refused ${ticket.ref}; declared paths are outside the repo worktree: ${outsideWorktree.join(', ')}. A different control-plane identity must run \`sidequest update ${ticket.ref} --files <in-repo-paths>\` to drop the stale path. For genuine non-repo output, release and reclassify as non-repo/artifact work; otherwise declare in-repo paths and dispatch again.`,
        });
      }
      const foreignFragments = commitScope.foreignReleaseFragmentPaths(root, ticket.ref);
      if (foreignFragments.length) {
        return mutationAck(slug, {
          ok: false,
          ticket,
          reason: 'outside_scope',
          message: `commit: refused ${ticket.ref}; only ${commitScope.ticketReleaseFragment(ticket.ref)} is implicitly writable. Other release fragments: ${foreignFragments.join(', ')}.`,
        });
      }
      const result = commitScope.commitScoped(root, message, scope);
      if (!result.ok) {
        const message = result.reason === 'missing_scope'
          ? `commit: ${ticket.ref} has no declared file scope.`
          : result.reason === 'outside_scope'
            ? `commit: refused ${ticket.ref}; commit contains paths outside its declared scope: ${(result.outside || []).join(', ')}. Expand scope with: ${store.scopeExpansionCommand(ticket, result.outside)}`
            : result.reason === 'no_existing_scope'
              ? `commit: ${ticket.ref} has no declared paths that exist in this worktree. Missing: ${(result.missingScopes || []).join(', ')}.`
              : `commit: git failed: ${result.message || result.reason}`;
        return mutationAck(slug, { ok: false, ticket, reason: result.reason, message });
      }
      store.touchClaim(slug, ticket.ref, by); // committing is proof of life; keep the backstop honest
      const warnings: string[] = [];
      if (result.unscopedPaths.length) {
        const comment = store.addComment(slug, ticket.ref, { by, body: outOfScopeComment(result.unscopedPaths), kind: 'comment', source: 'mcp' });
        if (!comment.ok) warnings.push(`out-of-scope paths weren't recorded: ${comment.reason}`);
      }
      return mutationAck(slug, { ok: true, ticket }, { commit: result.commit, ...(warnings.length ? { warnings } : {}) });
    },
  },
  {
    name: 'rework',
    description: 'Reject a reviewed submission for repair; preserve its candidate and evidence until a replacement submits. Only the submitted candidate owner can reject it.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        review: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['ref', 'by', 'review', 'reason'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, 'rework');
      return mutationAck(slug, store.reworkSubmission(slug, args.ref, {
        by,
        review: args.review,
        reason: args.reason,
        source: 'mcp',
      }));
    },
  },
  {
    name: 'submit',
    description: 'Submit a verified Git range or immutable source revision for integration and release the claim. Source revisions are accepted only when the registered project path is outside Git; provide changedSurfaces and non-Git adapter capabilities instead of commit, base, gitRef, or worktree. body carries the final report. For a review rejection, use rework to retain the candidate and review evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        commit: { type: 'string' },
        sourceRevision: {
          type: 'object',
          description: 'Immutable non-Git project revision.',
          properties: {
            source: { type: 'string' },
            value: { type: 'string' },
            observedAt: { type: 'string' },
          },
          required: ['source', 'value', 'observedAt'],
        },
        changedSurfaces: { type: 'array', items: { type: 'string' }, description: 'Declared project surfaces changed by a source revision.' },
        projectCapabilities: {
          type: 'object',
          description: 'Available non-Git project adapters. Git capability is observed from the registered project path and cannot be disabled by the caller.',
          properties: {
            process: { type: 'boolean' },
            worktree: { type: 'boolean' },
            review: { type: 'boolean' },
          },
        },
        base: { type: 'string', description: 'Optional prior submitted or integrated commit to exclude from this submission range. Set it equal to commit for a verified no-op submission.' },
        verify: { type: 'string' },
        gitRef: { type: 'string' },
        worktree: { type: 'string', description: 'Absolute path to this executor’s git worktree root. Required for isolated worktrees.' },
        body: { type: 'string', description: 'Final report: paths, verification, and skips.' },
        session: { type: 'string' },
        clear: { type: 'boolean', description: 'Drop a pending submission only after an integration bounce. Use rework for a review rejection so the candidate and review evidence are retained.' },
        status: { type: 'string', enum: store.VALID_STATUS, description: 'With clear:true, move the ticket to this status (usually "todo") in the same step.' },
        force: { type: 'boolean', description: 'Allow the existing submitted candidate owner to replace their own pending submission without a claim. Never authorizes a foreign submit or rejection.' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'submit');
      if (args.clear) {
        const res = store.clearSubmission(slug, args.ref, {
          by,
          status: args.status,
          source: 'mcp',
        });
        return mutationAck(slug, res);
      }
      const body = requiredFinalReport(args, 'submit');
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`submit: no ticket "${args.ref}" in ${meta.name}.`);
      if (args.sourceRevision && args.commit) {
        throw new Error('submit: pass exactly one of commit or sourceRevision.');
      }
      if (args.sourceRevision) {
        const res = store.submitTicket(slug, args.ref, by, {
          sourceRevision: args.sourceRevision,
          changedSurfaces: args.changedSurfaces,
          projectCapabilities: args.projectCapabilities,
          verify: args.verify,
          force: args.force === true,
          submissionComment: { body, by, kind: 'comment', source: 'mcp' },
          source: 'mcp',
          sessionId: sessionOf(args),
        });
        if (res.ok) closeDispatchExecutor(ticket);
        return mutationAck(slug, res);
      }
      const commit = requiredText(args, 'commit', 'submit');
      if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
        throw new Error(`invalid commit "${commit}" — pass the verified commit's hex hash (7-64 chars)`);
      }
      const gitRef = args.gitRef || `refs/sidequest/${ticket.ref}`;
      const root = submissionRoot(meta, args.worktree, commit, gitRef);
      if (verifyEmbedsWorktreeRoot(args.verify, root)) {
        throw new Error(`submit: refused ${ticket.ref}; verify embeds this worktree path. Run verification from the repo root and use repo-relative paths.`);
      }
      const verify = String(args.verify || '').trim();
      const validation = validateSubmissionCandidate({
        slug,
        ticket,
        by,
        root,
        commit,
        gitRef,
        verify,
        base: args.base,
        force: args.force === true,
        source: 'mcp',
      });
      if (!validation.ok) return mutationAck(slug, validation);
      const { target, range, scope } = validation;
      const unscopedPaths = ticket.dispatch?.sharedTree === true
        ? commitScope.unscopedWorkingPaths(root, scope)
        : [];
      const res = store.submitTicket(slug, args.ref, by, {
        commit: range.commit,
        gitRef,
        range: Object.assign({}, range, { integrationMode: target.mode, integrationBranch: target.branch }),
        verify: args.verify,
        worktree: args.worktree,
        unscopedPaths,
        force: args.force === true,
        submissionComment: { body, by, kind: 'comment', source: 'mcp' },
        source: 'mcp',
        sessionId: sessionOf(args),
      });
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res);
    },
  },
  {
    name: 'integrate',
    description: 'Deliver and verify a submitted Git range or immutable source revision. Successful responses list changedPaths and deliveredFiles; they can differ for apply mode.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        mode: { type: 'string', enum: ['merge', 'replay', 'apply'], description: 'Defaults to the board delivery setting.' },
        skipVerify: { type: 'boolean' },
        overrideLegacyScope: { type: 'boolean', description: 'Permit only a legacy submission without an admitted scope snapshot.' },
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    async handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'integrate');
      const failures: Array<{ reason: string; message: string }> = [];
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) {
        const delivery = store.integrateSubmission(slug, args.ref, {
          mode: args.mode == null ? store.boardConfig(slug).delivery : args.mode,
          overrideLegacyScope: args.overrideLegacyScope === true,
          skipVerify: args.skipVerify === true,
        });
        const failure: any = delivery.outside?.length ? { strayPaths: delivery.outside } : {};
        if (delivery.reason === 'verify_failed_post_merge' || delivery.reason === 'verify_failed_post_merge_rollback_failed') failure.verifyFailed = delivery.verify;
        return Object.assign(mutationAck(slug, delivery), failure);
      }
      const usesGit = store.submissionUsesGit(ticket);
      if (usesGit) {
        const lock = await publish.publishLockStatus(meta.path);
        if (lock.locked && !publish.publishLockOwnedBySession(meta.path, sessionOf(args))) {
          failures.push({
            reason: 'publish_lock_required',
            message: `integrate: publish lock is held by ${lock.holder?.by || lock.holder?.sessionId || 'another session'}; acquire or re-acquire it before delivery.`,
          });
        }
      }
      let target: any = null;
      if (usesGit) {
        try {
          target = store.integrationTarget(slug);
        } catch (error: any) {
          failures.push({
            reason: 'integration_target_unavailable',
            message: (error && error.message) || String(error),
          });
        }
      }
      const admitted = store.validateIntegrationSubmission(slug, args.ref, { overrideLegacyScope: args.overrideLegacyScope === true });
      if (!admitted.ok) failures.push({
        reason: admitted.reason,
        message: admitted.message || `integrate: refused ${args.ref}; ${admitted.reason}.`,
      });
      if (failures.length) return mutationAck(slug, combinedRefusal(ticket, failures));
      const mode = args.mode == null ? store.boardConfig(slug).delivery : args.mode;
      const delivery = store.integrateSubmission(slug, args.ref, {
        mode,
        target,
        overrideLegacyScope: args.overrideLegacyScope === true,
        skipVerify: args.skipVerify === true,
      });
      if (!delivery.ok) {
        const failure: any = delivery.outside?.length ? { strayPaths: delivery.outside } : {};
        if (delivery.reason === 'verify_failed_post_merge' || delivery.reason === 'verify_failed_post_merge_rollback_failed') failure.verifyFailed = delivery.verify;
        return Object.assign(mutationAck(slug, delivery), failure);
      }
      const integration = delivery.integration;
      const verification = store.verifyIntegration(slug, args.ref, { by, skipVerify: args.skipVerify === true });
      if (!verification.ok) {
        return Object.assign(mutationAck(slug, verification), { delivery: integration, verifyFailed: verification.verify });
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
      const closed = store.completeTicketAsControlPlane(slug, args.ref, {
        by,
        reason,
        purpose: 'integration',
        overrideLegacyScope: args.overrideLegacyScope === true,
      });
      if (closed.ok) closeDispatchExecutor(delivery.ticket);
      return mutationAck(slug, closed, {
        delivery: compactIntegrationDelivery(integration),
        verify: verification.verify,
        ...(closed.ok ? { completion: closed.ticket.completion } : {}),
      });
    },
  },
];

module.exports = { tools, missingReleaseFragment, missingReleaseFragmentMessage, submissionRangeFailureMessage, validateSubmissionCandidate };
