"use strict";
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
  snapshotContextRetrieval
} = require("./mcp-shared");
function sameBasenameSiblingDetails(project, ticket, projectPath, tool) {
  const details = store.scopeConsumerWarningDetails(ticket, projectPath);
  if (!details.length) return {};
  return {
    sameBasenameSiblingDetails: {
      groups: details.length,
      paths: details.reduce((total, detail) => total + detail.siblingPaths.length, 0),
      retrieval: snapshotContextRetrieval({
        tool,
        project,
        kind: "rows",
        field: "sameBasenameSiblingDetails",
        position: 0,
        value: details,
        reason: "collapsed"
      })
    }
  };
}
const VERIFY_ORACLE_PROP = {
  type: "string",
  maxLength: store.EXECUTOR_VERIFY_MAX,
  description: "Pin the required verifier in the prepared attempt. command and suite use one validated command, and suite names resolve during preparation. document, link, schema, manual, review, attestation, and custom preserve their own evidence contract. Attestation evidence uses `attestation: <artifact> | <evidence produced> | <what it showed>`. Executors can provide evidence but cannot replace or skip the pinned verifier. A waiver needs explicit authority, reason, affected gate, and bounded scope or expiry."
};
function liveVerificationAmendment(ticket) {
  const amendment = Array.isArray(ticket.verificationAmendments) ? ticket.verificationAmendments.at(-1) : null;
  if (!amendment || !ticket.dispatch || ticket.dispatch.terminalAt) return null;
  return {
    status: "applied_to_live_dispatch",
    oldCommand: amendment.oldCommand || null,
    newCommand: amendment.newCommand || null,
    message: `Verification was amended for ${ticket.ref}. The live dispatch now requires ${amendment.newCommand || "<none>"}; it previously required ${amendment.oldCommand || "<none>"}.`
  };
}
const REVIEW_TARGET_PROP = {
  type: "object",
  properties: {
    ref: { type: "string" },
    commit: { type: "string" },
    sourceRevision: {
      type: "object",
      properties: { source: { type: "string" }, value: { type: "string" } }
    }
  },
  required: ["ref"]
};
const tools = [
  {
    name: "add",
    description: "File a new ticket. Choose category from the returned taxonomy and pass it here, or use legacy complexity + why. Set route only when the user explicitly requests a model for this one ticket; it never changes the category route. model/effort are never set directly. description is a developer-to-developer spec (Where / Contract / Bounds / Verify), passed as a normal string (real newlines fine — no shell escaping).",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: store.VALID_PRIORITY },
        highStakes: { type: "boolean" },
        labels: LABELS_PROP,
        files: FILES_PROP,
        produces: CONTRACT_PROP("produces"),
        changes: CONTRACT_PROP("changes"),
        consumes: CONTRACT_PROP("consumes"),
        contractWaiver: { type: "boolean", description: "Explicitly reviewed waiver for contract-edge wave sequencing." },
        readonly: { type: "boolean", description: "Closeout override." },
        workingTreeDelivery: { type: "boolean", description: "Shared-checkout deliverable that forbids commits. The executor closes with done after the pinned verify-capture records the final declared working-tree paths." },
        anchors: { type: "string", maxLength: store.EXECUTOR_ANCHORS_MAX, description: "Executor anchors, verbatim in the task prompt." },
        verify: VERIFY_ORACLE_PROP,
        verifyKind: { type: "string", enum: store.VERIFY_ORACLE_KINDS, description: "Pinned verification kind. command and suite execute a validated command; document, link, schema, manual, review, attestation, and custom retain their evidence contract. attestation requires attestationArtifact, and attestationArtifact is rejected when verifyKind is command." },
        attestationArtifact: { type: "string", maxLength: store.EXECUTOR_VERIFY_MAX, description: "Required only when verifyKind is attestation: the specific URL, file, frame, or returned count observed. It is rejected when verifyKind is command." },
        storyId: { type: "string", pattern: "^US-\\d+$", description: "A story ref (US-n) to file this ticket into." },
        complexity: { type: "integer", minimum: 1, maximum: 10, description: "Legacy score. Requires why (min 20 chars)." },
        why: { type: "string", description: "Motivation for the complexity score (min 20 chars)." },
        category: { type: "string", description: "Enabled category id from category_list." },
        reviewTarget: REVIEW_TARGET_PROP,
        route: {
          type: "object",
          properties: { model: { type: "string" }, effort: { type: "string", enum: store.VALID_EFFORTS } },
          required: ["model", "effort"],
          description: "Optional route override for this ticket only. It never changes the category route."
        },
        unclassified: { type: "boolean", description: "Deliberately defer classification until an update before dispatch." }
      },
      required: ["title"]
    },
    handler(args) {
      if (!args.title || !String(args.title).trim()) throw new Error("add: title is required.");
      if (args.model != null || args.effort != null) throw new Error("add: model/effort are not set directly — use category or complexity + why.");
      const { slug, meta } = resolveProject(args.project);
      const verifyFailures = store.verifyOracleErrors(args.verifyKind, args.verify, args.attestationArtifact);
      if (verifyFailures.length) {
        return {
          ok: false,
          project: slug,
          reason: "invalid_verify",
          message: verifyFailures[0],
          failures: verifyFailures.map((message) => ({ reason: "invalid_verify", message }))
        };
      }
      let category = null;
      if (args.category != null) {
        category = String(args.category).trim().toLowerCase();
        const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry) => entry.id);
        if (!valid.includes(category)) throw new Error(`add: unknown category "${args.category}" — valid: ${valid.join(", ")}`);
      }
      const complexity = store.coerceComplexity(args.complexity);
      if (!category && complexity == null && !args.unclassified) throw new Error("add: pass category, legacy complexity + why, or unclassified:true.");
      if (complexity != null && (!args.why || String(args.why).trim().length < 20)) throw new Error("add: why is required with complexity (min 20 chars).");
      if (args.storyId !== void 0) validateStoryId(args.storyId);
      const created = store.createTicket(slug, {
        title: args.title,
        description: args.description || "",
        priority: args.priority,
        status: args.status,
        highStakes: args.highStakes,
        labels: args.labels,
        files: args.files,
        contracts: { produces: args.produces, changes: args.changes, consumes: args.consumes },
        contractWaiver: args.contractWaiver,
        readonly: args.readonly,
        workingTreeDelivery: args.workingTreeDelivery,
        executorAnchors: args.anchors,
        executorVerifyKind: args.verifyKind,
        executorAttestationArtifact: args.attestationArtifact,
        executorVerify: args.verify,
        storyId: args.storyId,
        complexity: args.complexity,
        complexityWhy: args.why,
        category,
        route: args.route,
        source: "mcp"
      }, args.reviewTarget);
      const ticket = store.getTicket(slug, created.ref) || created;
      const warnings = store.ticketReferenceWarnings(slug, ticket.title, ticket.description);
      warnings.push(...store.ticketCategoryWarnings(ticket));
      warnings.push(...store.ticketPlanningWarnings(ticket, meta.path));
      const presentedWarnings = store.presentWarnings(ticket, warnings, sessionOf(args));
      return mutationAck(slug, { ok: true, ticket }, Object.assign(
        presentedWarnings.length ? { warnings: presentedWarnings } : {},
        sameBasenameSiblingDetails(slug, ticket, meta.path, "add")
      ));
    }
  },
  {
    name: "update",
    description: 'Update ticket fields by scope. A live claim permits closeout-affecting fields only from the runtime session that prepared its dispatch; by is a label, not proof. Executors must use scopeRequest for files. A control-plane verifier amendment updates the live dispatch requirement and records the old and new command on the ticket. Any omitted field is left unchanged. Set route only for a one-ticket model override, or "none" to clear it. Editing a category route repoints future tickets too. model/effort are not accepted. Deletion is not a status; use the permanent remove tool instead.',
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: store.VALID_PRIORITY },
        status: { type: "string", enum: store.VALID_STATUS },
        highStakes: { type: "boolean" },
        labels: LABELS_PROP,
        files: FILES_PROP,
        by: { type: "string", description: "Human-readable update label. It cannot authorize closeout fields on a live claim." },
        produces: CONTRACT_PROP("produces"),
        changes: CONTRACT_PROP("changes"),
        consumes: CONTRACT_PROP("consumes"),
        contractWaiver: { type: "boolean", description: "Explicitly reviewed waiver for contract-edge wave sequencing." },
        readonly: { type: "boolean", description: "Closeout override." },
        workingTreeDelivery: { type: "boolean", description: "Orchestrator-only live-claim declaration for a shared-checkout deliverable that forbids commits. The executor closes with done after the pinned verify-capture records the final declared working-tree paths." },
        externalDeliverable: { type: "boolean", description: "Explicitly declare the deliverable is outside the repository. The orchestrator may set this during a live claim; it lets that executor close a clean writable dispatch with its current-attempt pinned verify-capture." },
        anchors: { type: "string", maxLength: store.EXECUTOR_ANCHORS_MAX, description: "Executor anchors, verbatim in the task prompt." },
        verify: VERIFY_ORACLE_PROP,
        verifyKind: { type: "string", enum: store.VERIFY_ORACLE_KINDS, description: "Verification kind for future dispatches. An open dispatch keeps its pinned kind. command and suite execute a validated command; document, link, schema, manual, review, attestation, and custom retain their evidence contract. attestation requires attestationArtifact, and attestationArtifact is rejected when verifyKind is command." },
        attestationArtifact: { type: "string", maxLength: store.EXECUTOR_VERIFY_MAX, description: "Required only when verifyKind is attestation: the specific URL, file, frame, or returned count observed. It is rejected when verifyKind is command." },
        storyId: { anyOf: [{ type: "string", pattern: "^US-\\d+$" }, { const: "none" }] },
        complexity: { type: "integer", minimum: 1, maximum: 10 },
        why: { type: "string" },
        category: { type: "string", description: 'Enabled category id from category_list. Use "none" to clear. A bound reviewTarget pins its review-audit category.' },
        reviewTarget: REVIEW_TARGET_PROP,
        route: {
          anyOf: [
            {
              type: "object",
              properties: { model: { type: "string" }, effort: { type: "string", enum: store.VALID_EFFORTS } },
              required: ["model", "effort"]
            },
            { const: "none" }
          ],
          description: 'Set a per-ticket route override or "none" to clear it. This never changes the category route.'
        }
      },
      required: ["ref"]
    },
    handler(args) {
      if (args.model != null || args.effort != null) throw new Error("update: model/effort are not accepted — use route for a per-ticket override.");
      if (args.complexity != null && (!args.why || String(args.why).trim().length < 20)) {
        throw new Error("update: re-scoring complexity needs a fresh why (min 20 chars).");
      }
      const { slug, meta } = resolveProject(args.project);
      const existing = store.getTicket(slug, args.ref);
      if (!existing) throw new Error(`update: no ticket "${args.ref}" on ${meta.name}.`);
      if (args.verify !== void 0 || args.verifyKind !== void 0 || args.attestationArtifact !== void 0) {
        const verifyFailures = store.verifyOracleErrors(
          args.verifyKind === void 0 ? existing.executorVerifyKind : args.verifyKind,
          args.verify === void 0 ? existing.executorVerify : args.verify,
          args.attestationArtifact === void 0 ? existing.executorAttestationArtifact : args.attestationArtifact
        );
        if (verifyFailures.length) {
          return {
            ok: false,
            project: slug,
            reason: "invalid_verify",
            message: verifyFailures[0],
            failures: verifyFailures.map((message) => ({ reason: "invalid_verify", message }))
          };
        }
      }
      const verificationWasAmended = args.verify !== void 0 && args.verify !== existing.executorVerify || args.verifyKind !== void 0 && args.verifyKind !== existing.executorVerifyKind || args.attestationArtifact !== void 0 && args.attestationArtifact !== existing.executorAttestationArtifact;
      const patch = { source: "mcp", by: String(args.by || "").trim() || null };
      for (const k of ["title", "description", "priority", "status", "highStakes", "labels", "files", "complexity"]) {
        if (args[k] !== void 0) patch[k] = args[k];
      }
      if (args.produces !== void 0 || args.changes !== void 0 || args.consumes !== void 0) {
        const existing2 = store.normalizeContracts((store.getTicket(slug, args.ref) || {}).contracts);
        patch.contracts = {
          produces: args.produces === void 0 ? existing2.produces : args.produces,
          changes: args.changes === void 0 ? existing2.changes : args.changes,
          consumes: args.consumes === void 0 ? existing2.consumes : args.consumes
        };
      }
      if (args.contractWaiver !== void 0) patch.contractWaiver = args.contractWaiver;
      if (args.readonly !== void 0) patch.readonly = args.readonly;
      if (args.workingTreeDelivery !== void 0) patch.workingTreeDelivery = args.workingTreeDelivery;
      if (args.externalDeliverable !== void 0) patch.externalDeliverable = args.externalDeliverable;
      if (args.anchors !== void 0) patch.executorAnchors = args.anchors;
      if (args.verify !== void 0) patch.executorVerify = args.verify;
      if (args.verifyKind !== void 0) patch.executorVerifyKind = args.verifyKind;
      if (args.attestationArtifact !== void 0) patch.executorAttestationArtifact = args.attestationArtifact;
      if (args.storyId !== void 0) {
        validateStoryId(args.storyId, true);
        patch.storyId = args.storyId;
      }
      if (args.category !== void 0) {
        if (args.category === "none" || args.category === null) patch.category = null;
        else {
          const category = String(args.category).trim().toLowerCase();
          const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry) => entry.id);
          if (!valid.includes(category)) throw new Error(`update: unknown category "${args.category}" — valid: ${valid.join(", ")}`);
          patch.category = category;
        }
      }
      if (args.why !== void 0) patch.complexityWhy = args.why;
      if (args.route !== void 0) patch.route = args.route === "none" || args.route === null ? null : args.route;
      const updated = store.updateTicket(slug, args.ref, patch, args.reviewTarget, {
        allowLiveClaimCloseoutUpdate: true
      });
      if (!updated) throw new Error(`update: no ticket "${args.ref}" on ${meta.name}.`);
      const t = store.getTicket(slug, updated.ref) || updated;
      const warnings = store.ticketReferenceWarnings(slug, patch.title, patch.description);
      warnings.push(...store.ticketPlanningWarnings(t, meta.path));
      const presentedWarnings = store.presentWarnings(t, warnings, sessionOf(args));
      const verificationAmendment = verificationWasAmended ? liveVerificationAmendment(t) : null;
      return mutationAck(slug, { ok: true, ticket: t }, Object.assign(
        presentedWarnings.length ? { warnings: presentedWarnings } : {},
        verificationAmendment ? { verificationAmendment } : {},
        sameBasenameSiblingDetails(slug, t, meta.path, "update")
      ));
    }
  },
  {
    name: "remove",
    description: "Permanently and irreversibly delete a ticket by ref. Refuses a live claim unless force:true is passed.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        force: { type: "boolean", description: "Permanently remove a ticket with a live claim. Use only when certain." }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`remove: no ticket "${args.ref}" on ${meta.name}.`);
      if (ticket.claim && ticket.claim.by && !store.claimReclaimable(ticket) && !args.force) {
        return { ok: false, reason: "claimed", ref: ticket.ref, claim: ticket.claim, message: `${ticket.ref} is live-claimed by ${ticket.claim.by}; pass force:true to permanently remove it.` };
      }
      const ref = ticket.ref;
      if (!store.deleteTicket(slug, ticket.id, { allowLiveClaimDeletion: args.force === true })) {
        throw new Error(`remove: could not delete "${ticket.ref}" from ${meta.name}.`);
      }
      return { ok: true, ref };
    }
  },
  {
    name: "archive",
    description: "Archive one ticket by ref, or every done ticket with done:true.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        done: { type: "boolean", description: "Archive every done ticket on the board." }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.done) {
        const result2 = store.archiveAllDone(slug, { source: "mcp" });
        return { ok: result2.ok, archived: result2.archived.length };
      }
      const ref = requiredText(args, "ref", "archive");
      const result = store.archiveTicket(slug, ref, { source: "mcp" });
      if (!result.ok) throw new Error(`archive: no ticket "${ref}" on ${meta.name}.`);
      return mutationAck(slug, result);
    }
  },
  {
    name: "unarchive",
    description: "Restore an archived ticket by ref.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, project: PROJECT_PROP },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const result = store.unarchiveTicket(slug, args.ref, { source: "mcp" });
      if (!result.ok) throw new Error(`unarchive: no ticket "${args.ref}" on ${meta.name}.`);
      return mutationAck(slug, result);
    }
  }
];
module.exports = { tools };
