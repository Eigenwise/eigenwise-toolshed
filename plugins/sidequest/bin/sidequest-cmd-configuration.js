#!/usr/bin/env node
"use strict";
const path = require("path");
const os = require("os");
const fs = require("node:fs/promises");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const store = require("../lib/store");
const agentsync = require("../lib/agentsync");
const work = require("../lib/work");
const commitScope = require("../lib/commit-scope");
const worktrees = require("../lib/worktrees");
const tempCleanup = require("../lib/temp-cleanup");
const execNames = require("../lib/exec-names");
const { claimRefusalMessage } = require("../lib/refusal-guidance");
const { assertSidequestInstall, assertDispatchTransport } = require("../lib/dispatch-preflight");
const { fail, resolveProject } = require("./sidequest-cmd-shared");
const { categoryIdOrFail, categoryEcho, categoryEchoLine, contractsFromOpts, contractWaiverFromOpts, readonlyFromOpts, highStakesFromOpts } = require("./sidequest-cmd-tickets");
async function cmdProfile(opts, positional) {
  const action = String(positional[0] || "").toLowerCase();
  const id = positional[1];
  const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  const resolveBoard = async (value) => (await resolveProject({ project: value })).slug;
  if (action === "hygiene") {
    const result = store.routingProfileHygiene();
    if (opts.json) return print(result);
    if (!result.proposals.length) {
      console.log("No routing profile hygiene proposals.");
      return;
    }
    for (const proposal of result.promotions) console.log(`promote  ${proposal.projects.join(", ")}  (${proposal.localRowCount} identical local rows)`);
    for (const proposal of result.drift) {
      const target = proposal.targetProfileId ? `repoint to ${proposal.targetProfileId}` : "fork or promote";
      console.log(`${target}  ${proposal.project}  (${proposal.localRowCount}/${proposal.effectiveCategoryCount} local rows, ${proposal.foreignBaseCount} foreign-base)`);
    }
    for (const proposal of result.retirements) console.log(`retire  ${proposal.profileId}  (no board pointers)`);
    return;
  }
  if (action === "list" || action === "ls") {
    const profiles = store.listRoutingProfiles({ retired: !!opts.retired });
    if (opts.json) return print({ profiles });
    for (const profile of profiles) console.log(`${profile.id}  ${profile.name}  r${profile.revision}  (${profile.entryCount} categories)${profile.retiredAt ? "  retired" : ""}`);
    return;
  }
  if (action === "show" || action === "get") {
    if (!id) fail(`profile ${action}: pass a profile id.`);
    const profile = store.routingProfileDetails(id);
    if (!profile) fail(`profile ${action}: no profile "${id}".`);
    if (opts.json) return print({ profile });
    console.log(`${profile.id}  ${profile.name}  r${profile.revision}`);
    if (profile.description) console.log(profile.description);
    for (const category of profile.categories) console.log(`  ${category.id}  ${category.name}  → ${category.route.model}·${category.route.effort}`);
    return;
  }
  if (action === "create") {
    if (!id) fail("profile create: pass a profile id.");
    const result = store.createRoutingProfile(id, { from: opts.from, name: opts.name, description: opts.description || opts.desc });
    if (opts.json) return print({ ok: true, profile: store.routingProfileDetails(result.id) });
    console.log(`✓ created profile ${result.id} from ${result.from}`);
    return;
  }
  if (action === "edit") {
    if (!id) fail("profile edit: pass a profile id.");
    if (opts.name == null && opts.description == null && opts.desc == null) fail("profile edit: pass --name or --description.");
    const result = store.editRoutingProfile(id, { name: opts.name, description: opts.description == null ? opts.desc : opts.description });
    if (opts.json) return print({ ok: true, profile: store.routingProfileDetails(result.id) });
    console.log(`✓ updated profile ${result.id}`);
    return;
  }
  if (action === "retire") {
    if (!id) fail("profile retire: pass a profile id.");
    const result = store.retireRoutingProfile(id);
    if (opts.json) return print({ ok: true, profile: result });
    console.log(`✓ retired profile ${result.id}`);
    return;
  }
  if (action === "use") {
    if (!id || opts.project == null || Array.isArray(opts.project)) fail("profile use: pass one profile and exactly one --project.");
    const project = await resolveBoard(opts.project);
    const result = store.setProjectRoutingProfile(project, id, opts.by || "cli");
    if (opts.json) return print({ ok: true, assignment: result, config: store.boardConfig(project) });
    console.log(`✓ ${project} now uses profile ${id}`);
    return;
  }
  if (action === "repoint") {
    const to = positional[2];
    if (!id || !to) fail("profile repoint: pass <from> <to>.");
    const result = store.repointRoutingProfiles(id, to, { dryRun: !!opts["dry-run"], assignedBy: opts.by || "cli-repoint" });
    if (opts.json) return print(result);
    console.log(`${result.dryRun ? "Preview" : "Repointed"} ${result.boards.length} board${result.boards.length === 1 ? "" : "s"} from ${id} to ${to}`);
    for (const board of result.boards) console.log(`  ${board.project}  ${board.drift.hasDrift ? `drift: ${board.drift.changed.length} changed, ${board.drift.added.length} added, ${board.drift.missing.length} missing` : "no drift"}`);
    return;
  }
  if (action === "promote") {
    if (!id || !opts["from-project"]) fail("profile promote: pass <new> --from-project <board> --project <board>...");
    const requested = opts.project == null ? [] : Array.isArray(opts.project) ? opts.project : [opts.project];
    if (!requested.length) fail("profile promote: pass at least one --project target.");
    const sourceProject = await resolveBoard(opts["from-project"]);
    const projects = [];
    for (const project of requested) projects.push(await resolveBoard(project));
    const result = store.promoteRoutingProfile(id, sourceProject, projects, { name: opts.name, description: opts.description || opts.desc, assignedBy: opts.by || "cli-promote" });
    if (opts.json) return print({ ok: true, promotion: result, profile: store.routingProfileDetails(id) });
    console.log(`✓ promoted ${sourceProject} to profile ${id} and repointed ${projects.length} board${projects.length === 1 ? "" : "s"}`);
    return;
  }
  if (action === "new-board" || action === "new_board") {
    if (id) store.setNewProjectRoutingProfile(id);
    const settings = store.routingProfileSettings();
    const profile = store.routingProfileDetails(settings.newProjectProfileId);
    if (opts.json) return print({ ok: true, newBoardProfile: profile });
    console.log(`New boards use ${profile.id}  ${profile.name}`);
    return;
  }
  fail(`profile: unknown action "${action}". Use hygiene | list | show | get | create | edit | retire | use | repoint | promote | new-board.`);
}
async function cmdCategory(opts, positional) {
  const action = String(positional[0] || "").toLowerCase();
  const id = positional[1];
  const projectScope = opts.project != null;
  const profileScope = opts.profile != null;
  if (projectScope && profileScope) fail(`category ${action || "<action>"}: pass exactly one of --profile or --project.`);
  const { slug, meta } = profileScope ? { slug: null, meta: null } : await resolveProject(Object.assign({}, opts, { name: void 0 }));
  const scopeName = profileScope ? `profile ${opts.profile}` : meta.name;
  const usage = (categoryId) => profileScope ? 0 : store.listTickets(slug).filter((ticket) => (ticket.categoryId || ticket.category && ticket.category.id) === categoryId).length;
  const projectLayer = () => store.getProjectCategories(slug);
  const localRow = (categoryId) => projectLayer().rows.find((row) => row.id === String(categoryId).trim().toLowerCase()) || null;
  const details = (categoryId) => ({
    localRow: projectScope ? localRow(categoryId) : null,
    effective: profileScope ? store.routingProfileCategory(opts.profile, categoryId) : projectScope ? store.getCategory(categoryId, { project: slug }) : store.getCategory(categoryId),
    warnings: projectScope ? projectLayer().warnings : []
  });
  const output = (result) => {
    if (opts.json) process.stdout.write(JSON.stringify(Object.assign(profileScope ? { profile: String(opts.profile).toLowerCase() } : { project: slug, projectName: meta.name }, result), null, 2) + "\n");
  };
  const artifactRootsOption = () => {
    if (opts["artifact-roots"] == null || opts["artifact-roots"] === "none") return [];
    return String(opts["artifact-roots"]).split(",").map((entry) => entry.trim()).filter(Boolean);
  };
  const categoryInput = () => ({
    id,
    name: opts.name || opts.title || id,
    description: opts.desc != null ? opts.desc : opts.description || "",
    route: { model: opts["route-model"] || opts.model, effort: opts["route-effort"] || opts.effort },
    fallback: opts["no-fallback"] || opts["fallback-model"] === "none" ? null : opts["fallback-model"] != null || opts["fallback-effort"] != null ? { model: opts["fallback-model"], effort: opts["fallback-effort"] } : null,
    contract: opts.contract || "",
    artifactRoots: artifactRootsOption(),
    readonly: readonlyFromOpts(opts) === true,
    enabled: !opts.disabled
  });
  const patchFor = (existing) => {
    const route = Object.assign({}, existing.route);
    if (opts["route-model"] != null) route.model = opts["route-model"];
    if (opts["route-effort"] != null) route.effort = opts["route-effort"];
    const patch = { route };
    if (opts["no-fallback"] || opts["fallback-model"] === "none") {
      patch.fallback = null;
    } else if (opts["fallback-model"] != null || opts["fallback-effort"] != null) {
      const fallback = Object.assign({}, existing.fallback || {});
      if (opts["fallback-model"] != null) fallback.model = opts["fallback-model"];
      if (opts["fallback-effort"] != null) fallback.effort = opts["fallback-effort"];
      patch.fallback = fallback;
    }
    if (opts.name != null || opts.title != null) patch.name = opts.name != null ? opts.name : opts.title;
    if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
    if (opts.contract != null) patch.contract = opts.contract;
    if (opts["artifact-roots"] != null) patch.artifactRoots = artifactRootsOption();
    if (opts.readonly !== void 0) patch.readonly = readonlyFromOpts(opts);
    return patch;
  };
  if (action === "list" || action === "ls") {
    const layer = profileScope ? { rows: [], warnings: [] } : projectLayer();
    const rows = layer.rows;
    const source = profileScope ? store.routingProfileEntries(opts.profile).map((entry) => Object.assign({}, entry.data, { origin: "profile", profileId: String(opts.profile).toLowerCase(), baseProfileId: String(opts.profile).toLowerCase(), changedFields: [] })) : store.getCategories({ project: slug, withState: true });
    const categories = source.map((category) => {
      const row = rows.find((entry) => entry.id === category.id);
      const resolved = store.resolveCategoryRoute(category);
      return Object.assign({}, category, {
        localRow: row || null,
        ticketCount: usage(category.id),
        resolved: { model: resolved.model, effort: resolved.effort, exec: resolved.exec },
        warnings: [...category.warnings || [], ...resolved.warnings]
      });
    });
    for (const row of rows.filter((entry) => entry.kind === "DISABLE")) {
      categories.push({ id: row.id, origin: "disabled", localRow: row, effective: null, ticketCount: usage(row.id), warnings: [] });
    }
    if (opts.json) {
      const profile = profileScope ? store.routingProfileDetails(opts.profile) : store.projectRoutingProfile(slug).profile;
      return output({ profile: { id: profile.id, name: profile.name, revision: profile.revision }, localRowCount: rows.length, categories, warnings: layer.warnings });
    }
    for (const category of categories) {
      if (category.origin === "disabled") {
        console.log(`${category.id}  disabled here  (${category.ticketCount} ticket${category.ticketCount === 1 ? "" : "s"})`);
        continue;
      }
      const state = category.linkState === "overridden" || category.linkState === "detached" ? "  customized" : "";
      console.log(`${category.id}  ${category.name}  → ${category.resolved.model}·${category.resolved.effort}  ${category.readonly ? "read-only" : "write"}  (${category.ticketCount} ticket${category.ticketCount === 1 ? "" : "s"})${state}`);
      for (const warning of category.warnings) console.log(`  ! ${warning}`);
    }
    for (const warning of layer.warnings) {
      if (warning.kind === "dangling-override") console.log(`  ! ${warning.id} customization in ${warning.project} has no shared default`);
      else console.log(`  ! ${String(warning)}`);
    }
    return;
  }
  if (!id) fail(`category ${action || "<action>"}: pass a category id`);
  if (action === "add" || action === "new" || action === "create") {
    try {
      const category = categoryInput();
      if (projectScope) store.setProjectCategory(slug, id, "ADD", category);
      else if (profileScope) store.setRoutingProfileCategory(opts.profile, category);
      else store.setCategory(category);
    } catch (error) {
      fail(`category add: ${error.message}`);
    }
    const saved = details(id);
    if (opts.json) return output(projectScope ? Object.assign({ ok: true }, saved) : { ok: true, category: saved.effective });
    console.log(`✓ added category ${id}  — ${scopeName}`);
    return;
  }
  if (action === "disable") {
    if (!projectScope) fail("category disable: pass --project to disable a category only for that project.");
    try {
      store.setProjectCategory(slug, id, "DISABLE", {});
    } catch (error) {
      fail(`category disable: ${error.message}`);
    }
    if (opts.json) return output(Object.assign({ ok: true }, details(id)));
    console.log(`✓ disabled category ${id} for ${meta.name}`);
    return;
  }
  if (action === "enable") {
    if (!projectScope) fail("category enable: pass --project to remove a project-local disable.");
    const row = localRow(id);
    if (!row || row.kind !== "DISABLE") fail(`category enable: "${id}" is not disabled for ${meta.name}`);
    try {
      store.removeProjectCategory(slug, id);
    } catch (error) {
      fail(`category enable: ${error.message}`);
    }
    if (opts.json) return output(Object.assign({ ok: true }, details(id)));
    console.log(`✓ enabled category ${id} for ${meta.name}`);
    return;
  }
  if (action === "detach" || action === "pin") {
    if (!projectScope) fail("category pin: pass --project to pin a category to this board.");
    let localRow2;
    try {
      localRow2 = store.detachCategory(slug, id);
    } catch (error) {
      fail(`category pin: ${error.message}`);
    }
    if (opts.json) return output(Object.assign({ ok: true, localRow: localRow2 }, details(id)));
    console.log(`✓ pinned category ${id} for ${meta.name} (stops following the shared default)`);
    return;
  }
  if (action === "relink" || action === "reset") {
    if (!projectScope) fail("category reset: pass --project to reset a category to the shared default.");
    const row = localRow(id);
    if (!row || !["OVERRIDE", "DETACH"].includes(row.kind)) fail(`category reset: "${id}" is not customized or pinned in ${meta.name}`);
    try {
      store.removeProjectCategory(slug, id);
    } catch (error) {
      fail(`category reset: ${error.message}`);
    }
    if (opts.json) return output(Object.assign({ ok: true, id: String(id).toLowerCase(), localRow: null }, details(id)));
    console.log(`✓ reset category ${id} to the shared default for ${meta.name}`);
    return;
  }
  if (action === "edit" || action === "update" || action === "set") {
    if (projectScope && opts.disabled) {
      try {
        store.setProjectCategory(slug, id, "DISABLE", {});
      } catch (error) {
        fail(`category edit: ${error.message}`);
      }
    } else if (projectScope && opts.enabled && localRow(id) && localRow(id).kind === "DISABLE") {
      try {
        store.removeProjectCategory(slug, id);
      } catch (error) {
        fail(`category edit: ${error.message}`);
      }
    } else if (projectScope) {
      const row = localRow(id);
      const existing = store.getCategory(id, { project: slug });
      if (!existing) fail(`category edit: no effective category "${id}" in ${meta.name}`);
      const patch = patchFor(existing);
      const kind = row && row.kind === "ADD" ? "ADD" : "DETACH";
      try {
        store.setProjectCategory(slug, id, kind, Object.assign({}, existing, patch, { id }));
      } catch (error) {
        fail(`category edit: ${error.message}`);
      }
    } else if (profileScope) {
      const existing = store.routingProfileCategory(opts.profile, id);
      if (!existing) fail(`category edit: no category "${id}" in profile "${opts.profile}"`);
      const patch = patchFor(existing);
      if (opts.enabled || opts.disabled) patch.enabled = !!opts.enabled;
      try {
        store.setRoutingProfileCategory(opts.profile, id, patch);
      } catch (error) {
        fail(`category edit: ${error.message}`);
      }
    } else {
      const existing = store.getCategory(id);
      if (!existing) fail(`category edit: no shared category "${id}"`);
      const patch = patchFor(existing);
      if (opts.enabled || opts.disabled) patch.enabled = !!opts.enabled;
      try {
        store.setCategory(id, patch);
      } catch (error) {
        fail(`category edit: ${error.message}`);
      }
    }
    const saved = details(id);
    if (opts.json) return output(projectScope ? Object.assign({ ok: true }, saved) : { ok: true, category: saved.effective });
    console.log(`✓ updated category ${id}  — ${scopeName}`);
    return;
  }
  if (action === "rm" || action === "remove" || action === "delete") {
    const ticketCount = usage(String(id).toLowerCase());
    try {
      if (projectScope) {
        if (localRow(id)) store.removeProjectCategory(slug, id);
        else store.setProjectCategory(slug, id, "DISABLE", {});
      } else if (profileScope) {
        if (!store.removeRoutingProfileCategory(opts.profile, id)) fail(`category rm: no category "${id}" in profile "${opts.profile}"`);
      } else if (!store.removeCategory(id)) {
        fail(`category rm: no shared category "${id}"`);
      }
    } catch (error) {
      fail(`category rm: ${error.message}`);
    }
    if (opts.json) return output(Object.assign({ ok: true, id: String(id).toLowerCase(), ticketCount }, projectScope ? details(id) : {}));
    console.log(`✓ removed category ${id}  — ${scopeName}`);
    return;
  }
  fail(`category: unknown action "${action}". Use list | add | edit | rm | disable | enable | pin | reset.`);
}
async function cmdGlobalFallback(opts) {
  const { slug, meta } = await resolveProject(opts);
  if (opts.model == null && opts.effort == null) {
    const fallback = store.getRoutingFallback();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, fallback }, null, 2) + "\n");
      return;
    }
    console.log(`Availability fallback: ${fallback ? `${fallback.model}·${fallback.effort}` : "missing or invalid"}`);
    return;
  }
  try {
    const fallback = store.setRoutingFallback({ model: opts.model, effort: opts.effort });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, fallback }, null, 2) + "\n");
      return;
    }
    console.log(`✓ global fallback set to ${fallback.model}·${fallback.effort}  — ${meta.name}`);
  } catch (error) {
    fail(`global-fallback: ${error.message}`);
  }
}
module.exports = { cmdProfile, cmdCategory, cmdGlobalFallback };
