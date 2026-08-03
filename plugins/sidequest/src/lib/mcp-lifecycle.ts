'use strict';

const { scopeRequestNotOwnerMessage } = require('./refusal-guidance');

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

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => any | Promise<any>;
};

const tools: ToolDefinition[] = [
  {
    name: 'claim',
    description: 'Claim a ticket; routed work needs a dispatch token and executor. direct:true needs a recorded inline-safe reason.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string', description: 'Unique per-worker id (e.g. claude-<8 hex>).' },
        effort: { type: 'string', enum: store.VALID_EFFORTS },
        executor: { type: 'string', description: 'Exact executor name from the dispatch.' },
        token: { type: 'string', description: 'Dispatch token (required for routed claims).' },
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
      const res = store.claimTicket(slug, args.ref, by, { force: !!args.force, direct: !!args.direct, reason: args.reason, token: args.token, executor: args.executor, source: 'mcp', sessionId: sessionOf(args) });
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
    description: 'Release claims whose executor was observed to stop, plus the idle/abandoned backstops (audited); live claims untouched however long they run.',
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
    description: 'Finish claimed non-repo or active artifact work; repo work submits, released work uses control-plane grooming. body carries the final report. Stamp actual model and effort.',
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
    description: 'Close an inactive ticket through grooming, or close an integrated submission with integration:true. Requires an evidence reason and records control-plane provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        reason: { type: 'string' },
        integration: { type: 'boolean' },
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
      const purpose = args.integration ? 'integration' : 'grooming';
      const res = store.completeTicketAsControlPlane(slug, args.ref, {
        by,
        reason,
        purpose,
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
    description: 'Release a claim; an oracle ask keeps the ticket doing for a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        reason: { type: 'string' },
        oracle: { type: 'string' },
        candidate: {},
        deliverable: {},
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
      const res = store.releaseTicket(slug, args.ref, by, {
        status: args.status,
        oracle: args.oracle,
        candidate: args.candidate,
        deliverable: args.deliverable,
        releaseComment: { by, body: `Released: ${reason}`, kind: 'comment', source: 'mcp' },
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
      return mutationAck(slug, store.applyExperimentVerdict(slug, args.ref, {
        text: args.text,
        outcome: args.outcome,
        why: args.why,
        constraint: args.constraint,
      }));
    },
  },
  {
    name: 'scopeRequest',
    description: 'Request scope.',
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
      if (!res.ok && res.reason === 'not_owner') res.message = scopeRequestNotOwnerMessage(args.ref, res.claim || res.ticket);
      const changed = res.ok && res.scopeRequest !== undefined ? {
        covered: res.covered || [],
        approved: res.approved || [],
        autoApproved: !!res.autoApproved,
        scopeRequest: res.scopeRequest,
        command: res.command,
      } : null;
      return mutationAck(slug, res, changed);
    },
  },
  {
    name: 'scopeDeny',
    description: 'Deny scope.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['ref', 'by', 'reason'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, 'scopeDeny');
      const reason = requiredText(args, 'reason', 'scopeDeny');
      const res = store.denyScopeRequest(slug, args.ref, by, reason, { source: 'mcp' });
      return mutationAck(slug, res, res.ok ? { denied: res.denied } : null);
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
      const pendingScopeRequest = ticket.scopeRequest;
      if (pendingScopeRequest) {
        const pending = store.normalizeFiles(pendingScopeRequest.files);
        const covered = store.normalizeFiles(pendingScopeRequest.covered);
        const requested = store.normalizeFiles(pendingScopeRequest.requested || pending);
        const approval = store.scopeExpansionCommand(ticket, requested);
        return mutationAck(slug, {
          ok: false,
          ticket,
          reason: 'scope_request_pending',
          message: `commit: refused ${ticket.ref}; scope approval remains pending for ${pending.join(', ')}.${covered.length ? ` Already effective: ${covered.join(', ')}.` : ''} Approve the request with \`${approval}\` or deny it with \`sidequest scope-deny ${ticket.ref} --reason "why"\` before committing.`,
        });
      }
      const scope = store.effectiveScope(slug, ticket.files);
      const outsideWorktree = commitScope.validateRelativeScopes(scope).outside;
      if (outsideWorktree.length) {
        return mutationAck(slug, {
          ok: false,
          ticket,
          reason: 'outside_scope',
          message: `commit: refused ${ticket.ref}; declared paths are outside the repo worktree: ${outsideWorktree.join(', ')}. This dispatch cannot commit them. For genuine non-repo output, release and reclassify as non-repo/artifact work; otherwise declare in-repo paths and dispatch again.`,
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
    name: 'submit',
    description: 'Submit a verified scoped commit range for integration and release the claim. body carries the final report: paths, verification, and skips. Pass clear:true instead to reject a pending submission without integrating it (drops commit/body/etc, optionally moves status).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        commit: { type: 'string' },
        base: { type: 'string', description: 'Optional prior submitted or integrated commit to exclude from this submission range.' },
        verify: { type: 'string' },
        gitRef: { type: 'string' },
        worktree: { type: 'string', description: 'Absolute path to this executor’s git worktree root. Required for isolated worktrees.' },
        body: { type: 'string', description: 'Final report: paths, verification, and skips.' },
        session: { type: 'string' },
        clear: { type: 'boolean', description: 'Reject this ticket’s pending submission without integrating it, so it can be re-dispatched. Ignores commit/base/verify/gitRef/worktree/body.' },
        status: { type: 'string', enum: store.VALID_STATUS, description: 'With clear:true, move the ticket to this status (usually "todo") in the same step.' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'submit');
      if (args.clear) {
        const res = store.clearSubmission(slug, args.ref, { status: args.status, source: 'mcp' });
        return mutationAck(slug, res);
      }
      const body = requiredFinalReport(args, 'submit');
      const commit = requiredText(args, 'commit', 'submit');
      if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
        throw new Error(`invalid commit "${commit}" — pass the verified commit's hex hash (7-64 chars)`);
      }
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`submit: no ticket "${args.ref}" in ${meta.name}.`);
      const root = args.worktree == null ? process.cwd() : worktreeRoot(args.worktree, 'submit');
      if (verifyEmbedsWorktreeRoot(args.verify, root)) {
        throw new Error(`submit: refused ${ticket.ref}; verify embeds this worktree path. Run verification from the repo root and use repo-relative paths.`);
      }
      const gitRef = args.gitRef || `refs/sidequest/${ticket.ref}`;
      const dispatchTarget = ticket.dispatch && ticket.dispatch.integrationTarget;
      const verify = String(args.verify || '').trim();
      const heldByExecutor = ticket.claim && ticket.claim.by === by;
      let target: any;
      try {
        target = store.integrationTarget(slug, dispatchTarget || undefined);
      } catch (error: any) {
        const reason = 'integration_target_unavailable';
        const message = (error && error.message) || String(error);
        const targetName = dispatchTarget && typeof dispatchTarget === 'object'
          ? String(dispatchTarget.upstream || dispatchTarget.branch || 'the recorded integration target')
          : String(dispatchTarget || 'the configured integration target');
        const remedy = `Fetch or recreate ${targetName}, rebase ${gitRef} onto that target, and resubmit. Or the orchestrator can cherry-pick refs/sidequest/${ticket.ref}-rejected and record the range override.`;
        if (verify && heldByExecutor) {
          return mutationAck(slug, preserveRejectedSubmission({
            slug, ticket, by, root, commit, gitRef, verify, reason, message, remedy,
          }));
        }
        return mutationAck(slug, {
          ok: false,
          ticket,
          reason,
          message: `submit: refused ${ticket.ref}; ${boundedSubmissionText(message)}. Remedy: ${remedy}`,
        });
      }
      const dispatchBase = String(ticket.dispatch?.baseCommit || '').trim() || null;
      const allowedBases = store.submissionBaseCandidates(slug, ticket.ref);
      if (dispatchBase) allowedBases.push(dispatchBase);
      const range = commitScope.submissionRange(root, {
        commit,
        gitRef,
        upstream: target.upstream,
        integrationBranch: target.branch,
        base: args.base,
        dispatchBase,
        allowedBases,
        baseCandidates: args.base ? [] : store.submissionBaseCandidates(slug, ticket.ref, { integratedOnly: true }),
      });
      if (!range.ok) {
        if (verify && heldByExecutor) {
          const remedy = `Rebase onto the current ${target.upstream} target, update ${gitRef}, and resubmit. Or the orchestrator can cherry-pick refs/sidequest/${ticket.ref}-rejected and record the range override.`;
          return mutationAck(slug, preserveRejectedSubmission({
            slug,
            ticket,
            by,
            root,
            commit,
            gitRef,
            verify,
            reason: range.reason,
            message: range.message || '',
            remedy,
          }));
        }
        return mutationAck(slug, { ok: false, ticket, reason: range.reason, message: range.message });
      }
      const duplicate = store.submissionsPayload(slug).tickets
        .filter((entry: any) => entry.ref !== ticket.ref)
        .find((entry: any) => {
          const commits = Array.isArray(entry.submission.commits) && entry.submission.commits.length
            ? entry.submission.commits : [entry.submission.commit];
          return commits.some((entryCommit: any) => range.commits.includes(entryCommit));
        });
      if (duplicate) {
        return mutationAck(slug, { ok: false, ticket, reason: 'duplicate_submission', message: `submit: refused ${ticket.ref}; its range includes commit(s) already submitted by ${duplicate.ref}.` });
      }
      const scope = store.effectiveScope(slug, ticket.files);
      const scopedRange = commitScope.validateCommitRangeScope(root, range.commits, scope);
      if (!scopedRange.ok) {
        const message = scopedRange.reason === 'missing_scope'
          ? `submit: ${ticket.ref} has no declared file scope, so its range cannot be admitted for integration.`
          : scopedRange.reason === 'outside_scope'
            ? `submit: refused ${ticket.ref}; submitted range changes paths outside its declared scope: ${scopedRange.outside.join(', ')}. Expand scope with: ${store.scopeExpansionCommand(ticket, scopedRange.outside)}`
            : `submit: could not inspect ${commit} from this worktree: ${scopedRange.message || scopedRange.reason}`;
        return mutationAck(slug, { ok: false, ticket, reason: scopedRange.reason, message });
      }
      const unscopedPaths = commitScope.unscopedWorkingPaths(root, scope);
      const res = store.submitTicket(slug, args.ref, by, {
        commit: range.commit,
        gitRef,
        range: Object.assign({}, range, { integrationMode: target.mode, integrationBranch: target.branch }),
        verify: args.verify,
        worktree: args.worktree,
        unscopedPaths,
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
    description: 'Deliver and verify a submitted range.',
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
      const lock = await publish.publishLockStatus(meta.path);
      if (lock.locked && !publish.publishLockOwnedBySession(meta.path, sessionOf(args))) {
        return mutationAck(slug, {
          ok: false,
          ticket: store.getTicket(slug, args.ref),
          reason: 'publish_lock_required',
          message: `integrate: publish lock is held by ${lock.holder?.by || lock.holder?.sessionId || 'another session'}; acquire or re-acquire it before delivery.`,
        });
      }
      let target: any;
      try {
        target = store.integrationTarget(slug);
      } catch (error: any) {
        return mutationAck(slug, { ok: false, ticket: store.getTicket(slug, args.ref), reason: 'integration_target_unavailable', message: (error && error.message) || String(error) });
      }
      const mode = args.mode == null ? store.boardConfig(slug).delivery : args.mode;
      const delivery = store.integrateSubmission(slug, args.ref, {
        mode,
        target,
        overrideLegacyScope: args.overrideLegacyScope === true,
        skipVerify: args.skipVerify === true,
      });
      if (!delivery.ok) {
        const failure: any = delivery.outside?.length ? { strayPaths: delivery.outside } : {};
        if (delivery.reason === 'verify_failed') failure.verifyFailed = delivery.verify;
        return Object.assign(mutationAck(slug, delivery), failure);
      }
      const integration = delivery.integration;
      const verification = store.verifyIntegration(slug, args.ref, { by, skipVerify: args.skipVerify === true });
      if (!verification.ok) {
        return Object.assign(mutationAck(slug, verification), { delivery: integration, verifyFailed: verification.verify });
      }
      const verifyReason = verification.verify.status === 'skipped'
        ? 'Verify skipped by choice.'
        : verification.verify.status === 'manual'
          ? `Manual verification recorded: ${verification.verify.manual}.`
          : verification.verify.status === 'none'
            ? 'Verify: none.'
            : `Verify passed: ${verification.verify.command}.`;
      const reason = `Delivered via ${integration.mode} from ${integration.pinnedRef} (${integration.pinnedCommit}) onto ${integration.targetBranch}. ${verifyReason}`;
      const closed = store.completeTicketAsControlPlane(slug, args.ref, {
        by,
        reason,
        purpose: 'integration',
        overrideLegacyScope: args.overrideLegacyScope === true,
      });
      if (closed.ok) closeDispatchExecutor(delivery.ticket);
      return mutationAck(slug, closed, {
        delivery: integration,
        verify: verification.verify,
        ...(closed.ok ? { completion: closed.ticket.completion } : {}),
      });
    },
  },
];

module.exports = { tools };
