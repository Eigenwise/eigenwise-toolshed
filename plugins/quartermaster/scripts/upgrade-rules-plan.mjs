import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./command-line.mjs";
import { isTrackedByGit } from "./git-tracking.mjs";
import { listMarkdownFiles, readRuleFile } from "./rule-files.mjs";
import { readRulesPage } from "./rules-page.mjs";
import { convertV1Rule } from "./v1-rule-conversion.mjs";

export function planMigration(projectRoot) {
  const { form, source } = locateRules(projectRoot);
  const claimedTargets = new Set();
  const converted = form === "folder" ? convertFolder(source) : convertRulesPage(source);
  const items = converted.map((item) => checkTargets(projectRoot, item, claimedTargets));
  return { projectRoot, form, source, oldRulesTracked: isTrackedByGit(projectRoot, oldRulesPath(projectRoot, form, source)), items };
}

function oldRulesPath(projectRoot, form, source) {
  return form === "folder" ? path.join(projectRoot, ".claude", "live-rules") : source;
}

function locateRules(projectRoot) {
  const folder = path.join(projectRoot, ".claude", "live-rules", "rules");
  const page = path.join(projectRoot, ".claude", "live-rules.md");
  if (fs.existsSync(folder)) return { form: "folder", source: folder };
  if (fs.existsSync(page)) return { form: "single-file", source: page };
  throw new UsageError(`no v1 rules found at ${folder} or ${page}`);
}

function convertFolder(folder) {
  return listMarkdownFiles(folder).map(convertFile);
}

function convertRulesPage(pagePath) {
  try {
    const rules = readRulesPage(pagePath);
    if (rules.length === 0) return [skippedPage(pagePath, "the page has no rules in it")];
    return rules.map(convertV1Rule);
  } catch (error) {
    return [skippedPage(pagePath, `cannot parse: ${error.message}`)];
  }
}

function skippedPage(pagePath, reason) {
  return { name: path.basename(pagePath), status: "skipped", reason, notes: [], outputs: [] };
}

function convertFile(filePath) {
  const name = path.basename(filePath, ".md");
  try {
    const { data, body } = readRuleFile(filePath);
    return convertV1Rule({ name, data, body });
  } catch (error) {
    return { name, status: "skipped", reason: `cannot parse: ${error.message}`, notes: [], outputs: [] };
  }
}

function checkTargets(projectRoot, item, claimedTargets) {
  const taken = item.outputs.find((output) => claimedTargets.has(output.target) || fs.existsSync(path.join(projectRoot, output.target)));
  if (taken) return { ...item, status: "conflict", reason: `${taken.target} already exists` };
  item.outputs.forEach((output) => claimedTargets.add(output.target));
  return item;
}

export function applyPlan(plan) {
  const written = [];
  for (const item of plan.items.filter((candidate) => candidate.status === "convert")) {
    for (const output of item.outputs) {
      const absolutePath = path.join(plan.projectRoot, output.target);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, output.content, { flag: "wx" });
      written.push(output.target);
    }
  }
  return written;
}

export function formatPlan(plan, written) {
  const lines = [`Migrating ${plan.source} (${plan.form} form)`, ""];
  for (const item of plan.items) lines.push(...formatItem(item));
  lines.push("", formatSummary(plan, written));
  return lines.join("\n");
}

function formatItem(item) {
  const heading = `${item.status.toUpperCase()} ${item.name}${item.reason ? `: ${item.reason}` : ""}`;
  const targets = item.outputs.map((output) => `  ${output.kind} -> ${output.target}`);
  const notes = item.notes.map((note) => `  note: ${note}`);
  return [heading, ...targets, ...notes];
}

function formatSummary(plan, written) {
  const countOf = (status) => plan.items.filter((item) => item.status === status).length;
  const counts = `${countOf("convert")} to convert, ${countOf("skipped")} skipped, ${countOf("conflict")} in conflict.`;
  if (written === undefined) return `${counts} Nothing written. Run again with --write to apply.`;
  return `${counts} Wrote ${written.length} files. ${oldRulesLine(plan)}`;
}

function oldRulesLine(plan) {
  const oldPath = oldRulesPath(plan.projectRoot, plan.form, plan.source);
  const kind = plan.form === "folder" ? "folder" : "file";
  if (plan.oldRulesTracked) {
    return `The old ${kind} ${oldPath} stays: git tracks it, and removing it is a committed change for the repository to make, not a step here.`;
  }
  return `The old ${kind} is untouched: delete ${oldPath} after you confirm the new rules load.`;
}
