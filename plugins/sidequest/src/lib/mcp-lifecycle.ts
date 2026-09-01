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
const { sourceRevisionBaseline } = require('./source-revision-capability');

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

const VERIFICATION_WAIVER_PROP = {
  description: 'Required with skipVerify. Names the human authority, reason, affected gate, and a bounded scope or future expiry. Runtime validation rejects incomplete, expired, or non-object values.',
  properties: {
    authority: { description: 'Human authority granting this one waiver.' },
    reason: { description: 'Why the required verification cannot run.' },
    affectedGate: { description: 'Exact verification gate being waived.' },
    scope: { description: 'Bounded files, artifact, or delivery scope covered by the waiver.' },
    expiresAt: { description: 'Future ISO timestamp after which the waiver is invalid.' },
  },
};

function compactIntegrationDelivery(integration: any) {
  const { verify: _verify, ...delivery } = integration;
  return delivery;
}

function waveAssemblyAck(slug: string, result: any) {
  const wave = result.wave;
  const gate = result.gate;
  return Object.assign(mutationAck(slug, result), {
    action: result.ok ? 'wave_assembled' : 'wave_assembly_refused',
    ...(wave ? { wave } : {}),
    ...(wave?.id ? { waveId: wave.id } : {}),
    ...(Array.isArray(wave?.participants) ? { participantRefs: wave.participants } : {}),
    ...(gate ? { gate } : {}),
    ...(gate?.state ? { gateState: gate.state } : {}),
    ...(result.assembly ? { assembly: result.assembly } : {}),
    ...(result.invalidated ? { invalidated: result.invalidated } : {}),
    ...(result.conflicts ? { conflicts: result.conflicts } : {}),
    ...(result.ok ? {
      deliveryRequired: true,
      message: `Wave ${wave.id} assembled with gate ${gate?.state || 'assembled'}. Call integrate again without wave to deliver it.`,
    } : {}),
  });
}

function deliveredAck(slug: string, result: any, integration: any, changed: any = {}) {
  const delivery = compactIntegrationDelivery(integration);
  const commits = Array.isArray(delivery.pinnedCommits)
    ? delivery.pinnedCommits
    : delivery.pinnedCommit ? [delivery.pinnedCommit] : [];
  const message = commits.length
    ? `Delivered ${commits.join(', ')} to ${delivery.targetBranch || 'the integration target'}.`
    : delivery.sourceRevision
      ? `Delivered source revision ${delivery.sourceRevision.source}:${delivery.sourceRevision.value}.`
      : 'Delivered the submitted candidate.';
  return mutationAck(slug, result, {
    action: 'delivered',
    delivery,
    message,
    ...changed,
  });
}

async function cleanupDeliveredWorktree(slug: string, projectPath: string, ticket: any, claimWasLive: boolean = false): Promise<void> {
  try {
    const dispatch = ticket?.dispatch;
    if (!dispatch?.worktree || dispatch.sharedTree !== false || dispatch.continuation || store.boardConfig(slug)?.worktreeIsolation === false) return;
    const tickets = store.worktreeGcTickets().map((candidate: any) => (
      candidate.ref === ticket.ref && claimWasLive ? { ...candidate, claimLive: true } : candidate
    ));
    await worktrees.sweep(projectPath, tickets, {
      execute: true,
      currentPath: store.nearestRepoRoot(process.cwd()),
      integrationTarget: store.integrationTarget(slug),
      ticketRef: ticket.ref,
    });
  } catch (_) {
    // Delivery has already been durably recorded. SessionStart remains the backstop.
  }
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

function rejectedRelatedReleaseFragments(slug: string, ticket: any): string[] {
  const relatedRefs = Array.isArray(ticket.links)
    ? ticket.links.filter((link: any) => link?.type === 'related').map((link: any) => link.ref)
    : [];
  return relatedRefs.flatMap((relatedRef: unknown) => {
    const source = store.getTicket(slug, relatedRef);
    if (source?.submission?.review?.outcome !== 'rejected') return [];
    const fragment = commitScope.ticketReleaseFragment(source.ref);
    return fragment ? [fragment] : [];
  });
}

function ticketCommitScope(slug: string, ticket: any): string[] {
  return [...new Set([
    ...commitScope.ticketCommitScope(store.executionScope(slug, ticket), ticket.files, ticket.ref),
    ...rejectedRelatedReleaseFragments(slug, ticket),
  ])];
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

function collectGitSubmissionFacts(options: any) {
  const { slug, ticket, root, commit, gitRef, base } = options;
  const dispatchTarget = ticket.dispatch && ticket.dispatch.integrationTarget;
  let target: any = null;
  let targetFailure: any = null;
  try {
    target = store.integrationTarget(slug, dispatchTarget || undefined);
  } catch (error: any) {
    const targetName = dispatchTarget && typeof dispatchTarget === 'object'
      ? String(dispatchTarget.upstream || dispatchTarget.branch || 'the recorded integration target')
      : String(dispatchTarget || 'the configured integration target');
    targetFailure = { code: 'integration_target_unavailable', message: `submit: refused ${ticket.ref}; ${boundedSubmissionText((error && error.message) || String(error))}. Remedy: Fetch or recreate ${targetName}, then resubmit the preserved candidate.`, retryable: true };
  }
  const dispatchBase = String(ticket.dispatch?.baseCommit || '').trim() || null;
  const range = target
    ? commitScope.submissionRange(root, { commit, gitRef, upstream: target.upstream, integrationBranch: target.branch, base, dispatchBase, allowedBases: dispatchBase ? [dispatchBase] : [] })
    : null;
  const scope = ticketCommitScope(slug, ticket);
  const requirements: any[] = targetFailure ? [targetFailure] : [];
  const surfaces: any = { declared: scope, admitted: scope, changed: range?.ok ? range.changedPaths : [], pending: [] };
  if (!range?.ok) {
    surfaces.diagnostic = { code: range?.reason || 'integration_target_unavailable', message: range ? submissionRangeFailureMessage(ticket, range, gitRef) : targetFailure.message, retryable: true };
  } else {
    const pending = commitScope.scopedWorkPending(root, scope, { base: range.base });
    if (!pending.ok) {
      requirements.push({ code: pending.reason, message: `submit: could not inspect the declared scope in ${root}: ${pending.message || pending.reason}`, retryable: true });
    } else {
      surfaces.pending = pending.working;
    }
    const scopedRange = commitScope.validateCommitRangeScope(root, range.commits, scope);
    if (!scopedRange.ok) {
      surfaces.diagnostic = {
        code: scopedRange.reason,
        message: scopedRange.reason === 'missing_scope'
          ? `submit: ${ticket.ref} has no declared file scope, so its range cannot be admitted for integration.`
          : scopedRange.reason === 'outside_scope'
            ? `submit: refused ${ticket.ref}; submitted range changes paths outside its declared scope: ${scopedRange.outside.join(', ')}. Request scope only for work this ticket owns with: ${store.scopeExpansionCommand(ticket, scopedRange.outside)}. Commit only approved scope; never stash, revert, or include foreign paths.`
            : `submit: could not inspect ${commit} from ${root}: ${scopedRange.message || scopedRange.reason}.`,
        retryable: true,
      };
    }
    const missingFragment = missingReleaseFragment(root, ticket.ref, scopedRange.paths || range.changedPaths);
    if (missingFragment) requirements.push({ code: 'missing_release_fragment', message: missingReleaseFragmentMessage(ticket.ref, missingFragment.fragmentPath, missingFragment.plugins), retryable: true });
  }
  const duplicate = range?.ok
    ? store.submissionsPayload(slug).tickets
      .filter((entry: any) => entry.ref !== ticket.ref)
      .find((entry: any) => (Array.isArray(entry.submission.commits) && entry.submission.commits.length ? entry.submission.commits : [entry.submission.commit]).some((entryCommit: any) => range.commits.includes(entryCommit)))
    : null;
  return {
    target,
    range,
    scope,
    admissionFacts: {
      admittedScope: store.executionScope(slug, ticket),
      scope,
      baseline: range?.ok
        ? { candidateExists: true, containsCandidate: true }
        : { candidateExists: false, containsCandidate: false, diagnostic: surfaces.diagnostic },
      surfaces,
      duplicate: duplicate
        ? { identity: duplicate.ref, diagnostic: { code: 'duplicate_submission', message: `submit: refused ${ticket.ref}; its range includes commit(s) already submitted by ${duplicate.ref}.`, retryable: false } }
        : { identity: null },
      requirements,
    },
  };
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
      const res = store.claimTicket(slug, args.ref, by, { force: !!args.force, direct: !!args.direct, reason: args.reason, tokenFile: args.tokenFile, executor: args.executor, effort: args.effort, source: 'mcp', sessionId: sessionOf(args), requireBoundAgent: true });
      if (!res.ok) res.message = res.reason === 'executor_mismatch'
        ? claimRefusalMessage(res.reason, args.ref, res.ticket || res.claim, meta.path)
        : res.message || claimRefusalMessage(res.reason, args.ref, res.ticket || res.claim, meta.path);
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
        deliveryCommit: { type: 'string', pattern: '^[0-9a-fA-F]{7,64}$', description: 'Reachable delivered source commit or pinned working-tree candidate.' },
        deliveryInteractionCommit: { type: 'string', pattern: '^[0-9a-fA-F]{7,64}$', description: 'A reviewed merged-tree interaction after deliveryCommit, limited to submitted candidate paths.' },
        deliveryMethod: { type: 'string', enum: ['reset', 'working-tree', 'manual'], description: 'For a non-reachable pinned candidate.' },
        abandonSubmission: { type: 'boolean', description: 'Retire a candidate that never landed; refused while it is reachable from the integration branch.' },
        recoveryEvidence: { type: 'string', description: 'Observed terminal-agent evidence for an unclaimed dispatch.' },
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
        abandonSubmission: args.abandonSubmission === true,
        deliveryCommit: args.deliveryCommit,
        deliveryInteractionCommit: args.deliveryInteractionCommit,
        deliveryMethod: args.deliveryMethod,
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
    description: 'Release a held claim, or surrender this worker’s token-validated unbound dispatch with kind technical_blocker. Use kind oracle with an oracle ask to park it as awaiting-oracle for a human verdict, then exit. The oracle handoff stays visible until a verdict is recorded.',
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
    description: 'Request scope and receive an immediate ruling. Granted paths take effect immediately for hook write enforcement and commit admission. A foreign .release/unreleased/*.md fragment always refuses because only this ticket’s fragment is writable.',
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
        ...(res.message ? { message: res.message } : {}),
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
      const scope = ticketCommitScope(slug, ticket);
      const outsideWorktree = commitScope.validateRelativeScopes(scope).outside;
      if (outsideWorktree.length) {
        return mutationAck(slug, {
          ok: false,
          ticket,
          reason: 'outside_scope',
          message: `commit: refused ${ticket.ref}; declared paths are outside the repo worktree: ${outsideWorktree.join(', ')}. A different control-plane identity must run \`sidequest update ${ticket.ref} --files <in-repo-paths>\` to drop the stale path. For genuine non-repo output, release and reclassify as non-repo/artifact work; otherwise declare in-repo paths and dispatch again.`,
        });
      }
      const foreignFragments = commitScope.foreignReleaseFragmentPaths(
        root,
        ticket.ref,
        rejectedRelatedReleaseFragments(slug, ticket),
      );
      if (foreignFragments.length) {
        return mutationAck(slug, {
          ok: false,
          ticket,
          reason: 'outside_scope',
          message: commitScope.foreignReleaseFragmentRefusalMessage('commit', ticket.ref, foreignFragments),
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
      // Without this the executor's own commit reads as baseline drift and revokes its write lease, so
      // submit's release-fragment requirement becomes unsatisfiable from inside the claim (SQ-2182).
      const sanctioned = store.recordSanctionedCommit(slug, ticket.ref, { by, commit: result.commit });
      if (!sanctioned.ok && sanctioned.reason !== 'no_dispatch') warnings.push(store.unrecordedSanctionedCommitWarning(sanctioned.reason));
      if (result.unscopedPaths.length) {
        const comment = store.addComment(slug, ticket.ref, { by, body: outOfScopeComment(result.unscopedPaths), kind: 'comment', source: 'mcp' });
        if (!comment.ok) warnings.push(`out-of-scope paths weren't recorded: ${comment.reason}`);
      }
      return mutationAck(slug, { ok: true, ticket }, { commit: result.commit, ...(warnings.length ? { warnings } : {}) });
    },
  },
  {
    name: 'rework',
    description: 'Reject an unbound submission for repair; preserve its candidate and evidence until a replacement submits. Only the submitted candidate owner can reject it. A candidate bound to a review is locked: this call refuses without writing, whatever by or reviewRef says. Record a failed review as evidence on the review ticket and release it with kind oracle. When that oracle accepts the defect conclusion, Sidequest records the bound candidate as rejected; only an integrated repair can then supersede it.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        review: { type: 'string' },
        reviewRef: { type: 'string', description: 'Accepted for compatibility and ignored; it grants no authority over a bound candidate.' },
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
    description: 'Submit a verified Git range or immutable source revision for integration and release the claim. A declared command verifier requires the completed verify-capture identity produced by the dispatched wrapper, bound to this ticket, exact command, and submitted candidate. Retyping the command or prose is not execution evidence; rerun the wrapper after the final commit when the capture is missing or stale. Manual and attestation verifiers retain their existing evidence contracts. Source revisions are accepted only when the registered project path is outside Git; provide changedSurfaces and verifier evidence instead of commit, base, gitRef, or worktree. At registration, Sidequest persists the project adapter: non-Git projects use filesystem-snapshot revisions, whose source must be "filesystem-snapshot" and whose value must match the current project snapshot. The server resolves existence and baseline-membership facts from that persisted adapter; callers cannot supply them. A retry checkpoint supplies immutable candidate fields and verifier evidence when only corrected capability evidence is available. body carries the final report. To bounce an unbound candidate back for repair, use rework; a review-bound candidate cannot be rejected by any route.',
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
          description: 'Available non-Git execution adapters. Git capability and source-revision facts are resolved by the server and cannot be supplied by the caller.',
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
        clear: { type: 'boolean', description: 'Drop a pending submission only after an integration bounce. Use rework to bounce an unbound candidate; a review-bound candidate refuses both.' },
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
      const retryCandidate = ticket.submissionRetry?.candidate;
      const hydratedSourceRevision = retryCandidate
        ? (retryCandidate.source === 'git' ? null : retryCandidate)
        : args.sourceRevision;
      if (hydratedSourceRevision) {
        const adapterFacts = store.sourceRevisionAdapterFacts(slug, hydratedSourceRevision, sourceRevisionBaseline(ticket));
        const res = store.submitTicket(slug, args.ref, by, {
          sourceRevision: hydratedSourceRevision,
          changedSurfaces: retryCandidate ? ticket.submissionRetry?.changedSurfaces : args.changedSurfaces,
          projectCapabilities: args.projectCapabilities,
          ...(adapterFacts ? { admissionFacts: adapterFacts } : {}),
          verify: args.verify,
          force: args.force === true,
          submissionComment: { body, by, kind: 'comment', source: 'mcp' },
          source: 'mcp',
          sessionId: sessionOf(args),
        });
        if (res.ok) closeDispatchExecutor(ticket);
        return mutationAck(slug, res);
      }
      if (retryCandidate && !args.sourceRevision && !args.commit) {
        const res = store.submitTicket(slug, args.ref, by, {
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
      const collected = collectGitSubmissionFacts({ slug, ticket, root, commit, gitRef, base: args.base });
      const { target, range, scope } = collected;
      const unscopedPaths = ticket.dispatch?.sharedTree === true
        ? commitScope.unscopedWorkingPaths(root, scope)
        : [];
      const res = store.submitTicket(slug, args.ref, by, {
        commit,
        gitRef,
        range: range?.ok ? Object.assign({}, range, { integrationMode: target?.mode, integrationBranch: target?.branch }) : undefined,
        verify: args.verify,
        worktree: args.worktree,
        unscopedPaths,
        admissionFacts: collected.admissionFacts,
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
    description: 'Deliver a ref or exact group. wave assembles and gates only; call again without wave to deliver. Terminal isolated worktrees are reclaimed best-effort after durable delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        wave: { type: 'object' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        mode: { type: 'string', enum: ['merge', 'replay', 'apply'], description: 'Defaults to the board delivery setting.' },
        deliveryCommit: { type: 'string', description: 'Reachable delivered source commit or pinned working-tree candidate.' },
        deliveryInteractionCommit: { type: 'string', description: 'Reviewed descendant interaction, limited to submitted paths; the wave gate and merged-tree verifier still pass.' },
        deliveryMethod: { type: 'string', enum: ['reset', 'working-tree', 'manual'], description: 'For a non-reachable pinned candidate.' },
        reason: { type: 'string' },
        skipVerify: { type: 'boolean', description: 'Skip the pinned verifier only when verificationWaiver carries an authorized bounded waiver.' },
        verificationWaiver: VERIFICATION_WAIVER_PROP,
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    async handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'integrate');
      const refs = String(args.ref).split(',').map((ref: string) => ref.trim()).filter(Boolean);
      if (!refs.length) throw new Error('integrate: pass one or more ticket refs.');
      if (args.wave != null) {
        return waveAssemblyAck(slug, store.assembleSubmissionWave(slug, refs, args.wave));
      }
      const failures: Array<{ reason: string; message: string }> = [];
      const ticket = store.getTicket(slug, refs[0]!);
      if (refs.length > 1) {
        const groupUsesGit = store.submissionUsesGit(ticket);
        if (groupUsesGit) {
          const lock = await publish.publishLockStatus(meta.path);
          if (lock.locked && !publish.publishLockOwnedBySession(meta.path, sessionOf(args))) {
            return mutationAck(slug, combinedRefusal(ticket, [{
              reason: 'publish_lock_required',
              message: `integrate: publish lock is held by ${lock.holder?.by || lock.holder?.sessionId || 'another session'}; acquire or re-acquire it before delivery.`,
            }]));
          }
        }
        const target = groupUsesGit ? store.integrationTarget(slug) : undefined;
        const mode = args.mode == null ? store.boardConfig(slug).delivery : args.mode;
        const delivery = store.integrateSubmissionWave(slug, refs, {
          mode,
          target,
          skipVerify: args.skipVerify === true,
          verificationWaiver: args.verificationWaiver,
        });
        if (!delivery.ok) return mutationAck(slug, delivery);
        const reason = `Delivered assembled wave ${refs.join(', ')} via ${delivery.integration.mode}.`;
        const ticketsBeforeClosure = refs.map((ref: string) => store.getTicket(slug, ref));
        const closures = refs.map((ref: string) => store.completeTicketAsControlPlane(slug, ref, { by, reason, purpose: 'integration' }));
        const failedClosure = closures.find((closure: any) => !closure.ok);
        for (const [index, closure] of closures.entries()) {
          if (!closure.ok) continue;
          closeDispatchExecutor(closure.ticket);
          await cleanupDeliveredWorktree(slug, meta.path, closure.ticket, Boolean(ticketsBeforeClosure[index]?.claim?.by));
        }
        return deliveredAck(slug, failedClosure || closures[0], delivery.integration, {
          verify: delivery.integration.verify,
          tickets: closures.map((closure: any) => closure.ticket || null),
        });
      }
      if (!ticket) {
        const delivery = store.integrateSubmission(slug, args.ref, {
          mode: args.mode == null ? store.boardConfig(slug).delivery : args.mode,
          skipVerify: args.skipVerify === true,
          verificationWaiver: args.verificationWaiver,
        });
        const failure: any = delivery.outside?.length ? { strayPaths: delivery.outside } : {};
        if (delivery.verify && /^verification_[a-z_]+_post_merge(?:_rollback_failed)?$/.test(String(delivery.reason))) failure.verifyFailed = delivery.verify;
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
      const admitted = store.validateIntegrationSubmission(slug, args.ref, {
        deliveryInteractionCommit: args.deliveryInteractionCommit,
      });
      if (!admitted.ok) failures.push({
        reason: admitted.reason,
        message: admitted.message || `integrate: refused ${args.ref}; ${admitted.reason}.`,
      });
      if (failures.length) return mutationAck(slug, combinedRefusal(ticket, failures));
      if (args.deliveryCommit != null) {
        const recorded = store.recordDeliveredSubmission(slug, args.ref, {
          target,
          deliveryCommit: args.deliveryCommit,
          deliveryInteractionCommit: args.deliveryInteractionCommit,
          deliveryMethod: args.deliveryMethod,
          reason: args.reason,
          skipVerify: args.skipVerify === true,
          verificationWaiver: args.verificationWaiver,
        });
        if (!recorded.ok) return mutationAck(slug, recorded);
        const deliveryTicket = recorded.ticket;
        const closed = store.completeTicketAsControlPlane(slug, args.ref, {
          by,
          reason: args.reason,
          purpose: 'integration',
        });
        if (closed.ok) {
          closeDispatchExecutor(recorded.ticket);
          await cleanupDeliveredWorktree(slug, meta.path, closed.ticket, Boolean(deliveryTicket?.claim?.by));
        }
        return deliveredAck(slug, closed, recorded.integration, {
          verify: recorded.integration.verify,
          ...(closed.ok ? { completion: closed.ticket.completion } : {}),
        });
      }
      const mode = args.mode == null ? store.boardConfig(slug).delivery : args.mode;
      const delivery = store.integrateSubmission(slug, args.ref, {
        mode,
        target,
        skipVerify: args.skipVerify === true,
        verificationWaiver: args.verificationWaiver,
      });
      if (!delivery.ok) {
        const failure: any = delivery.outside?.length ? { strayPaths: delivery.outside } : {};
        if (delivery.verify && /^verification_[a-z_]+_post_merge(?:_rollback_failed)?$/.test(String(delivery.reason))) failure.verifyFailed = delivery.verify;
        return Object.assign(mutationAck(slug, delivery), failure);
      }
      const integration = delivery.integration;
      const verification = store.verifyIntegration(slug, args.ref, {
        by,
        skipVerify: args.skipVerify === true,
        verificationWaiver: args.verificationWaiver,
      });
      if (!verification.ok) {
        return Object.assign(mutationAck(slug, verification), { delivery: integration, verifyFailed: verification.verify });
      }
      const verifyReason = verification.verify.status === 'attestation'
        ? `Attestation accepted for ${verification.verify.artifact || 'the source revision'}.`
        : verification.verify.status === 'skipped'
          ? `Verification waived by ${verification.verify.waiver?.authority || 'an authorized human'}: ${verification.verify.waiver?.reason || verification.verify.evidence}.`
          : verification.verify.status === 'manual'
            ? `Manual verification recorded: ${verification.verify.evidence}.`
            : verification.verify.status === 'none'
              ? 'Verify: none.'
              : `Verify passed: ${verification.verify.command || verification.verify.evidence}.`;
      const reason = usesGit
        ? `Delivered via ${integration.mode} from ${integration.pinnedRef} (${integration.pinnedCommit}) onto ${integration.targetBranch}. ${verifyReason}`
        : `Delivered source revision ${integration.sourceRevision.source}:${integration.sourceRevision.value}. ${verifyReason}`;
      const deliveryTicket = delivery.ticket;
      const closed = store.completeTicketAsControlPlane(slug, args.ref, {
        by,
        reason,
        purpose: 'integration',
      });
      if (closed.ok) {
        closeDispatchExecutor(delivery.ticket);
        await cleanupDeliveredWorktree(slug, meta.path, closed.ticket, Boolean(deliveryTicket?.claim?.by));
      }
      return deliveredAck(slug, closed, integration, {
        verify: verification.verify,
        ...(closed.ok ? { completion: closed.ticket.completion } : {}),
      });
    },
  },
];

module.exports = { tools, missingReleaseFragment, missingReleaseFragmentMessage, submissionRangeFailureMessage, collectGitSubmissionFacts, rejectedRelatedReleaseFragments };
