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
  snapshotRowsContextRetrieval,
  compactPulse,
  requiredText,
  requiredFinalReport,
  boundedSubmissionText,
  preserveRejectedSubmission,
  requiredReleaseReason,
  worktreeRoot,
  verifyEmbedsWorktreeRoot,
  withoutCategories
} = require("./mcp-shared");
function changedCategoryFields(existing, patch) {
  return Object.keys(patch).filter((key) => JSON.stringify(existing[key]) !== JSON.stringify(patch[key]));
}
const tools = [
  {
    name: "profile_list",
    description: "List routing profiles.",
    inputSchema: { type: "object", properties: { retired: { type: "boolean" } } },
    handler(args) {
      return { profiles: store.listRoutingProfiles({ retired: !!args.retired }), newBoardProfile: store.routingProfileSettings().newProjectProfileId };
    }
  },
  {
    name: "profile_get",
    description: "Read one routing profile and its categories.",
    inputSchema: { type: "object", properties: { profile: { type: "string" } }, required: ["profile"] },
    handler(args) {
      const profile = store.routingProfileDetails(args.profile);
      if (!profile) throw new Error(`profile_get: no profile "${args.profile}".`);
      return { profile };
    }
  },
  {
    name: "profile_create",
    description: "Create a routing profile by cloning another profile.",
    inputSchema: { type: "object", properties: { profile: { type: "string" }, from: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["profile"] },
    handler(args) {
      const result = store.createRoutingProfile(args.profile, args);
      return { ok: true, result, profile: store.routingProfileDetails(result.id) };
    }
  },
  {
    name: "profile_edit",
    description: "Edit routing profile metadata.",
    inputSchema: { type: "object", properties: { profile: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["profile"] },
    handler(args) {
      if (args.name == null && args.description == null) throw new Error("profile_edit: pass name or description.");
      const result = store.editRoutingProfile(args.profile, args);
      return { ok: true, result, profile: store.routingProfileDetails(result.id) };
    }
  },
  {
    name: "profile_retire",
    description: "Retire an unused routing profile.",
    inputSchema: { type: "object", properties: { profile: { type: "string" } }, required: ["profile"] },
    handler(args) {
      return { ok: true, profile: store.retireRoutingProfile(args.profile) };
    }
  },
  {
    name: "profile_use",
    description: "Assign one routing profile to one board.",
    inputSchema: { type: "object", properties: { profile: { type: "string" }, project: PROJECT_PROP, by: { type: "string" } }, required: ["profile", "project"] },
    handler(args) {
      const { slug } = resolveProject(args.project);
      return { ok: true, assignment: store.setProjectRoutingProfile(slug, args.profile, args.by || "mcp") };
    }
  },
  {
    name: "profile_repoint",
    description: "Preview or atomically repoint every board from one profile to another.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, dryRun: { type: "boolean" }, by: { type: "string" } }, required: ["from", "to"] },
    handler(args) {
      return store.repointRoutingProfiles(args.from, args.to, { dryRun: !!args.dryRun, assignedBy: args.by || "mcp-repoint" });
    }
  },
  {
    name: "profile_promote",
    description: "Materialize one board taxonomy as a profile and atomically repoint matching boards.",
    inputSchema: {
      type: "object",
      properties: { profile: { type: "string" }, fromProject: PROJECT_PROP, projects: { type: "array", items: PROJECT_PROP, minItems: 1 }, name: { type: "string" }, description: { type: "string" }, by: { type: "string" } },
      required: ["profile", "fromProject", "projects"]
    },
    handler(args) {
      const source = resolveProject(args.fromProject).slug;
      const projects = args.projects.map((project) => resolveProject(project).slug);
      return { ok: true, promotion: store.promoteRoutingProfile(args.profile, source, projects, { name: args.name, description: args.description, assignedBy: args.by || "mcp-promote" }) };
    }
  },
  {
    name: "new_board_profile",
    description: "Read or set the routing profile assigned to new boards.",
    inputSchema: { type: "object", properties: { profile: { type: "string" } } },
    handler(args) {
      if (args.profile != null) store.setNewProjectRoutingProfile(args.profile);
      const profile = store.routingProfileDetails(store.routingProfileSettings().newProjectProfileId);
      return { ok: true, profile };
    }
  },
  {
    name: "route_recipe",
    description: "Resolve a category, or one ticket in that category, into a live Workflow agent recipe. Fetch it when starting work so route edits and warnings stay current.",
    inputSchema: {
      type: "object",
      properties: { category: { type: "string" }, ticket: { type: "string", description: "Optional ticket ref. Its route override, when present, is resolved into the recipe." }, project: PROJECT_PROP },
      required: ["category"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      return workflowRecipe(slug, args.category, args.ticket);
    }
  },
  {
    name: "category_list",
    description: "List project taxonomy; compact descriptions are excerpts. Follow nextCursor; full:true is complete.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        profile: { type: "string" },
        full: { type: "boolean" },
        cursor: { type: "string", pattern: "^(0|[1-9]\\d*)$" },
        limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT_MAX }
      }
    },
    handler(args) {
      if (args.project != null && args.profile != null) throw new Error("category_list: pass at most one of profile or project.");
      const full = !!args.full;
      let slug = null;
      let meta = null;
      let profile;
      let layer = { rows: [], warnings: [] };
      let source;
      if (args.profile != null) {
        profile = store.routingProfileDetails(args.profile);
        if (!profile) throw new Error(`category_list: no profile "${args.profile}".`);
        source = profile.categories.map((category) => Object.assign({}, category, { origin: "profile", profileId: profile.id, baseProfileId: profile.id, changedFields: [], warnings: [] }));
      } else {
        ({ slug, meta } = resolveProject(args.project));
        profile = store.projectRoutingProfile(slug).profile;
        layer = store.getProjectCategories(slug);
        source = store.getCategories({ project: slug, withState: true });
      }
      const usage = (id) => slug ? store.listTickets(slug).filter((ticket) => (ticket.categoryId || ticket.category && ticket.category.id) === id).length : 0;
      const categoryProject = String(slug || `<profile:${profile.id}>`);
      const preferredCategoryOrder = new Map(["general", "coding.easy", "coding.normal", "coding.hard"].map((id, index) => [id, index]));
      const orderedCategories = source.slice().sort((left, right) => {
        const priority = (preferredCategoryOrder.get(left.id) ?? preferredCategoryOrder.size) - (preferredCategoryOrder.get(right.id) ?? preferredCategoryOrder.size);
        return priority || String(left.id).localeCompare(String(right.id));
      });
      const categoryDetails = orderedCategories.map((category) => {
        const localRow = layer.rows.find((row) => row.id === category.id) || null;
        return Object.assign({}, category, {
          origin: localRow ? localRow.kind === "ADD" ? "project" : category.linkState : "global",
          localRow: localRow ? { id: localRow.id, kind: localRow.kind } : null,
          ticketCount: usage(category.id)
        });
      });
      const categories = orderedCategories.map((category) => {
        const localRow = layer.rows.find((row) => row.id === category.id) || null;
        return categoryListEntry(category, localRow, usage(category.id), full, categoryProject);
      });
      if (full) {
        for (const localRow of layer.rows.filter((row) => row.kind === "DISABLE")) {
          const disabledCategory = { id: localRow.id, origin: "disabled", localRow: { id: localRow.id, kind: localRow.kind }, effective: null, ticketCount: usage(localRow.id) };
          categories.push(disabledCategory);
          categoryDetails.push(disabledCategory);
        }
      }
      const identity = { id: profile.id, name: profile.name, revision: profile.revision };
      const buildPayload = (page, total, nextCursor) => full ? Object.assign(args.profile != null ? { profile: identity } : { project: slug, projectName: meta.name, profile: identity }, { localRowCount: layer.rows.length, categories: page, warnings: layer.warnings, total, returned: page.length, nextCursor }) : { profile: identity, localRowCount: layer.rows.length, categories: page, total, returned: page.length, nextCursor };
      const paged = pagedPayload(categories, args, "category_list", buildPayload, full);
      if (paged) {
        if (paged.nextCursor || full && categories.some((category) => category.descriptionTruncated || category.contractTruncated)) {
          paged.retrieval = snapshotRowsContextRetrieval(
            "category_list",
            categoryProject,
            "categories",
            categoryDetails,
            0
          );
        }
        return paged;
      }
      const complete = buildPayload(categories, categories.length, null);
      delete complete.total;
      delete complete.returned;
      delete complete.nextCursor;
      return complete;
    }
  },
  {
    name: "category_add",
    description: "Create a global category by default, or a project-local ADD when project is provided. Classification always uses that project's effective taxonomy.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        profile: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        contract: { type: "string" },
        artifactRoots: { type: "array", items: { type: "string" }, description: "Shared-tree artifact roots. Empty disables." },
        routeModel: { type: "string" },
        routeEffort: { type: "string", enum: store.VALID_EFFORTS },
        fallbackModel: { type: "string" },
        fallbackEffort: { type: "string", enum: store.VALID_EFFORTS },
        enabled: { type: "boolean" },
        readonly: { type: "boolean", description: "Comment closeout." }
      },
      required: ["id", "name", "routeModel", "routeEffort"]
    },
    handler(args) {
      if (args.project == null === (args.profile == null)) throw new Error("category_add: pass exactly one of profile or project.");
      const target = args.project != null ? resolveProject(args.project) : null;
      const id = String(args.id || "").trim().toLowerCase();
      const category = {
        id,
        name: args.name,
        description: args.description || "",
        contract: args.contract || "",
        artifactRoots: args.artifactRoots || [],
        route: { model: args.routeModel, effort: args.routeEffort },
        fallback: args.fallbackModel == null && args.fallbackEffort == null ? null : { model: args.fallbackModel, effort: args.fallbackEffort },
        readonly: args.readonly === true,
        enabled: args.enabled !== false
      };
      if (target) {
        const localRow = store.setProjectCategory(target.slug, id, "ADD", category);
        return { ok: true, project: target.slug, projectName: target.meta.name, localRow, effective: store.getCategory(id, { project: target.slug }), warnings: store.getProjectCategories(target.slug).warnings };
      }
      return { ok: true, profile: args.profile, category: store.setRoutingProfileCategory(args.profile, category) };
    }
  },
  {
    name: "category_edit",
    description: "Customize a category for one board (pass project) or edit the shared default for every board (omit project). With project, editing forks the category into that board's own independent copy that no longer follows the shared default; other boards are unaffected. enabled false disables it on that board and enabled true clears that local disable; reset with category_relink to follow the shared default again. Without project you rewrite the shared default that every board without its own copy inherits.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        project: PROJECT_PROP,
        profile: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        contract: { type: "string" },
        artifactRoots: { type: "array", items: { type: "string" }, description: "Replace shared-tree artifact roots. Empty disables." },
        routeModel: { type: "string" },
        routeEffort: { type: "string", enum: store.VALID_EFFORTS },
        fallbackModel: { type: ["string", "null"], description: "Set null to clear the fallback route." },
        fallbackEffort: { type: "string", enum: store.VALID_EFFORTS },
        enabled: { type: "boolean" },
        readonly: { type: "boolean", description: "Comment closeout." }
      },
      required: ["id"]
    },
    handler(args) {
      if (args.project == null === (args.profile == null)) throw new Error("category_edit: pass exactly one of profile or project.");
      const target = args.project != null ? resolveProject(args.project) : null;
      const slug = target && target.slug;
      const id = String(args.id || "").trim().toLowerCase();
      const layer = () => store.getProjectCategories(slug);
      const localRow = () => layer().rows.find((row) => row.id === id) || null;
      if (args.project != null && args.enabled === false) {
        const row = store.setProjectCategory(slug, id, "DISABLE", {});
        return { ok: true, project: slug, id, localRow: { id: row.id, kind: row.kind }, changed: ["enabled"] };
      }
      if (args.project != null && args.enabled === true && localRow() && localRow().kind === "DISABLE") {
        store.removeProjectCategory(slug, id);
        return { ok: true, project: slug, id, localRow: null, changed: ["enabled"] };
      }
      const existing = args.project != null ? store.getCategory(id, { project: slug }) : store.routingProfileCategory(args.profile, id);
      if (!existing) throw new Error(`category_edit: no effective category "${args.id}".`);
      const patch = {};
      for (const key of ["name", "description", "contract", "artifactRoots", "readonly"]) if (args[key] !== void 0) patch[key] = args[key];
      if (args.routeModel !== void 0 || args.routeEffort !== void 0) patch.route = { model: args.routeModel === void 0 ? existing.route.model : args.routeModel, effort: args.routeEffort === void 0 ? existing.route.effort : args.routeEffort };
      if (args.fallbackModel === null) patch.fallback = null;
      else if (args.fallbackModel !== void 0 || args.fallbackEffort !== void 0) patch.fallback = { model: args.fallbackModel === void 0 ? existing.fallback && existing.fallback.model : args.fallbackModel, effort: args.fallbackEffort === void 0 ? existing.fallback && existing.fallback.effort : args.fallbackEffort };
      if (args.project == null && args.enabled !== void 0) patch.enabled = args.enabled;
      const changed = changedCategoryFields(existing, patch);
      if (args.project != null) {
        const prior = localRow();
        if (!changed.length) return { ok: true, project: slug, id, localRow: prior && { id: prior.id, kind: prior.kind }, changed };
        const kind = prior && prior.kind === "ADD" ? "ADD" : "DETACH";
        const row = store.setProjectCategory(slug, id, kind, Object.assign({}, existing, patch, { id }));
        return { ok: true, project: slug, id, localRow: { id: row.id, kind: row.kind }, changed };
      }
      if (!changed.length) return { ok: true, profile: args.profile, id, changed };
      const category = store.setRoutingProfileCategory(args.profile, existing.id, patch);
      return { ok: true, profile: args.profile, id: category.id, changed };
    }
  },
  {
    name: "category_detach",
    description: "Fork a board's category into an independent copy without other edits, so it stops following the shared default. Usually unnecessary: category_edit already forks a board category on any change; use this only to fork one as-is.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_PROP, id: { type: "string" } },
      required: ["project", "id"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || "").trim().toLowerCase();
      const localRow = store.detachCategory(slug, id);
      const layer = store.getProjectCategories(slug);
      return { ok: true, project: slug, id, localRow: { id: localRow.id, kind: localRow.kind } };
    }
  },
  {
    name: "category_relink",
    description: "Reset a board's category to the shared default, dropping its local customization or pin so it follows the shared default again.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_PROP, id: { type: "string" } },
      required: ["project", "id"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || "").trim().toLowerCase();
      const localRow = store.getProjectCategories(slug).rows.find((row) => row.id === id) || null;
      if (!localRow || !["OVERRIDE", "DETACH"].includes(localRow.kind)) throw new Error(`category_relink: "${args.id}" has no local override or detach.`);
      store.removeProjectCategory(slug, id);
      const layer = store.getProjectCategories(slug);
      return { ok: true, project: slug, id, localRow: null };
    }
  },
  {
    name: "global_fallback",
    description: "Read or set the required global routing fallback. Omit model and effort to read it; provide both to set it.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        model: { type: "string", description: "Claude runtime or discovered Codex model slug." },
        effort: { type: "string", enum: store.VALID_EFFORTS }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.model === void 0 && args.effort === void 0) {
        return { project: slug, projectName: meta.name, fallback: store.getRoutingFallback() };
      }
      return { ok: true, project: slug, projectName: meta.name, fallback: store.setRoutingFallback({ model: args.model, effort: args.effort }) };
    }
  },
  {
    name: "category_rm",
    description: "Remove global policy by default. With project, removes that local row or disables an effective global category locally. general cannot be removed or disabled.",
    inputSchema: { type: "object", properties: { project: PROJECT_PROP, profile: { type: "string" }, id: { type: "string" } }, required: ["id"] },
    handler(args) {
      if (args.project == null === (args.profile == null)) throw new Error("category_rm: pass exactly one of profile or project.");
      const target = args.project != null ? resolveProject(args.project) : null;
      const slug = target && target.slug;
      const meta = target && target.meta;
      const id = String(args.id || "").trim().toLowerCase();
      const ticketCount = target ? store.listTickets(slug).filter((ticket) => (ticket.categoryId || ticket.category && ticket.category.id) === id).length : 0;
      if (args.project != null) {
        const row = store.getProjectCategories(slug).rows.find((entry) => entry.id === id);
        const localRow = row ? (store.removeProjectCategory(slug, id), null) : store.setProjectCategory(slug, id, "DISABLE", {});
        return { ok: true, project: slug, projectName: meta.name, id, ticketCount, localRow, effective: store.getCategory(id, { project: slug }), warnings: store.getProjectCategories(slug).warnings };
      }
      if (!store.removeRoutingProfileCategory(args.profile, id)) throw new Error(`category_rm: no category "${args.id}" in profile "${args.profile}".`);
      return { ok: true, profile: args.profile, id, ticketCount };
    }
  },
  {
    name: "board_config",
    description: "Board settings.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        name: { type: "string" },
        alwaysInScope: { type: "array", items: { type: "string" }, description: "When supplied, replaces the board paths merged into every ticket scope." },
        readOnlyDeniedTools: { type: "array", items: { type: "string" } },
        generatedPairs: {},
        integrationMode: { type: "string", description: "auto is local without origin; local does not push." },
        integrationBranch: { type: "string", minLength: 1, description: "Branch used as the integration baseline. Defaults to main. Remote mode requires origin/<branch>." },
        delivery: { type: "string", description: "Default submission delivery mode. Defaults to merge." },
        integrationVerifyTimeoutMs: { type: "integer" },
        worktreeIsolation: { type: "boolean", description: "false runs executors in the shared checkout (default true)." },
        worktreeBase: { type: "string", enum: ["auto", "origin-main", "local-main"], description: "Base strategy for isolated worktrees on the configured integrationBranch. auto uses local when it is ahead of origin, otherwise origin; origin-main pins the remote ref; local-main pins the local branch." },
        notIntegratedSalvageAgeHours: { type: "integer", minimum: 168, description: "Age before an unintegrated inactive worktree is salvaged and removed (default 168 hours)." },
        autoApproveTestScope: { type: "boolean", description: "Auto-approve reachable test directories (default true)." },
        autoApproveScope: { type: "array", items: { type: "string" }, description: "Repo-relative auto-approved globs." },
        worktreeSetup: { type: ["string", "null"], description: "One-line command Sidequest runs after creating an isolated worktree; null clears it." },
        worktreeDependencyPaths: {
          type: "array",
          description: 'Dependency directories to provision from the primary checkout before dispatch. Each entry is { path: repo-relative directory, mode: "link" | "copy" }.',
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              mode: { type: "string", enum: ["link", "copy"] }
            },
            required: ["path", "mode"]
          }
        }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const patch = {};
      if (args.name !== void 0) patch.name = args.name;
      if (args.alwaysInScope != null) patch.alwaysInScope = args.alwaysInScope;
      if (args.readOnlyDeniedTools !== void 0) patch.readOnlyDeniedTools = args.readOnlyDeniedTools;
      if (args.generatedPairs !== void 0) patch.generatedPairs = args.generatedPairs;
      if (args.integrationMode != null) patch.integrationMode = args.integrationMode;
      if (args.integrationBranch != null) patch.integrationBranch = args.integrationBranch;
      if (args.delivery != null) patch.delivery = args.delivery;
      if (args.integrationVerifyTimeoutMs != null) patch.integrationVerifyTimeoutMs = args.integrationVerifyTimeoutMs;
      if (args.worktreeIsolation !== void 0) patch.worktreeIsolation = args.worktreeIsolation;
      if (args.worktreeBase !== void 0) patch.worktreeBase = args.worktreeBase;
      if (args.notIntegratedSalvageAgeHours !== void 0) patch.notIntegratedSalvageAgeHours = args.notIntegratedSalvageAgeHours;
      if (args.autoApproveTestScope !== void 0) patch.autoApproveTestScope = args.autoApproveTestScope;
      if (args.autoApproveScope !== void 0) patch.autoApproveScope = args.autoApproveScope;
      if (args.worktreeSetup !== void 0) patch.worktreeSetup = args.worktreeSetup;
      if (args.worktreeDependencyPaths !== void 0) patch.worktreeDependencyPaths = args.worktreeDependencyPaths;
      const result = Object.keys(patch).length ? store.setBoardConfig(slug, patch) : { ok: true, config: store.boardConfig(slug) };
      if (!result.ok) throw new Error(`board_config: no board "${meta.name}".`);
      return Object.assign({ ok: true, project: slug, projectName: result.config.name }, result.config);
    }
  },
  {
    name: "models",
    description: "Available models, global fallback, and compact effective category routes. Pass full:true for configured routes, resolved executors, and warnings.",
    inputSchema: { type: "object", properties: { project: PROJECT_PROP, full: { type: "boolean", description: "Include configured/resolved category detail and warnings." } } },
    handler(args) {
      const { slug } = resolveProject(args.project);
      return store.modelsPayload({ project: slug, full: !!args.full });
    }
  },
  {
    name: "projects",
    description: "Every registered board with open/doing/done counts — the switcher across all projects. Pass archived:true to list archived boards only.",
    inputSchema: { type: "object", properties: { archived: { type: "boolean", description: "List archived boards only." } } },
    handler(args) {
      return { projects: store.listProjects({ archived: !!args.archived }) };
    }
  },
  {
    name: "archive_board",
    description: "Archive a board without deleting its tickets. The board reference is required so this cannot target the caller's default board by accident.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Required registered board slug, display name, or path." } },
      required: ["project"]
    },
    handler(args) {
      if (!args.project || !String(args.project).trim()) throw new Error("archive_board: project is required.");
      const { slug, meta } = resolveProject(args.project);
      const result = store.archiveProject(slug);
      if (!result.ok) throw new Error(`archive_board: no board "${args.project}".`);
      return Object.assign({ project: slug, projectName: meta.name }, result);
    }
  },
  {
    name: "unarchive_board",
    description: "Restore an archived board. The board reference is required so this cannot target the caller's default board by accident.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Required registered board slug, display name, or path." } },
      required: ["project"]
    },
    handler(args) {
      if (!args.project || !String(args.project).trim()) throw new Error("unarchive_board: project is required.");
      const { slug, meta } = resolveProject(args.project);
      const result = store.unarchiveProject(slug);
      if (!result.ok) throw new Error(`unarchive_board: no board "${args.project}".`);
      return Object.assign({ project: slug, projectName: meta.name }, result);
    }
  }
];
module.exports = { tools };
