import path from "node:path";
import { deriveLabel, isNumericId, shortName, slugify } from "./rule-naming.mjs";
import { skillDescription, splitKeywords } from "./skill-description.mjs";

export function convertV1Rule({ name, data, body }) {
  const scope = readV1Scope(data);
  if (scope.disabled) return { name, status: "skipped", reason: "disabled in v1 (enabled: false)", notes: [], outputs: [] };
  const label = deriveLabel(data, body);
  const nameFromLabel = isNumericId(name) ? shortName(label) : slugify(name);
  const content = {
    ruleSlug: nameFromLabel || slugify(name),
    skillSlug: scope.keywords.length > 0 ? nameFromLabel : "",
    title: titleFor(name, data, label),
    body,
    scope,
    keywords: splitKeywords(scope.keywords),
  };
  return { name, status: "convert", reason: "", notes: describeDroppedAndSplit(content), outputs: buildOutputs(content) };
}

function readV1Scope(data) {
  return {
    paths: [...asList(data.globs), ...asList(data.glob), ...[...asList(data.dirs), ...asList(data.dir)].map(directoryToPattern)],
    keywords: [data.prompt, data.prompts, data.keywords].flatMap(asList),
    includes: [...asList(data.include), ...asList(data.includes)],
    priority: Number(data.priority ?? 0),
    disabled: data.enabled === false,
  };
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean);
}

function directoryToPattern(directory) {
  return `${directory.replace(/^\.\//, "").replace(/\/+$/, "")}/**`;
}

function titleFor(name, data, label) {
  if (typeof data.description === "string" && data.description !== "") return data.description;
  if (isNumericId(name) && label !== "") return label;
  return name.replaceAll(/[-_]+/g, " ");
}

function describeDroppedAndSplit({ scope, skillSlug, keywords }) {
  const notes = [];
  if (scope.priority !== 0) notes.push(`priority ${scope.priority} dropped, rules have no priority`);
  return [...notes, ...skillNotes({ scope, skillSlug, keywords }), ...bareNameNotes(scope.paths), ...alwaysLoadedImportNotes(scope)];
}

function skillNotes({ scope, skillSlug, keywords }) {
  if (scope.keywords.length === 0) return [];
  if (skillSlug === "") return [noSkillNote(scope)];
  const pointerNotes = scope.paths.length > 0 ? ["had file scope and keywords: the body is in the rule file and the skill points at it"] : [];
  return [...pointerNotes, ...unconvertedKeywordNotes(keywords.unconverted)];
}

function noSkillNote(scope) {
  const original = scope.keywords.map((keyword) => `"${keyword}"`).join(", ");
  const loadsEverywhere = scope.paths.length === 0 ? " It now loads in every session." : "";
  return `no skill: nothing usable to name one from (title, description or body), so this stays a rule and the keyword trigger is dropped.${loadsEverywhere} Original trigger: ${original}`;
}

function unconvertedKeywordNotes(unconverted) {
  if (unconverted.length === 0) return [];
  const original = unconverted.map((keyword) => `"${keyword}"`).join(", ");
  return [`keywords could not be turned into words, so the skill description leaves them out and a person should decide. Original: ${original}`];
}

function bareNameNotes(paths) {
  const bareNames = paths.filter((pattern) => !pattern.includes("/") && pattern !== "**");
  if (bareNames.length === 0) return [];
  const quoted = bareNames.map((pattern) => JSON.stringify(pattern)).join(", ");
  return [`${quoted} has no slash: it loads for that name at any depth, and "/name" means only the one in the root folder`];
}

function alwaysLoadedImportNotes(scope) {
  const loadsInEverySession = scope.paths.length === 0 && scope.keywords.length === 0;
  if (!loadsInEverySession || scope.includes.length === 0) return [];
  return ["include is now an import that loads in every session, consider adding paths"];
}

function buildOutputs({ ruleSlug, skillSlug, title, body, scope, keywords }) {
  const outputs = [];
  const hasSkill = skillSlug !== "";
  const ruleTarget = `.claude/rules/${ruleSlug}.md`;
  if (!hasSkill || scope.paths.length > 0) {
    const importLines = importLinesFor(scope.includes, ".claude/rules");
    outputs.push({ kind: "rule", target: ruleTarget, content: renderRule({ title, body, paths: scope.paths, importLines }) });
  }
  if (hasSkill) {
    const importLines = importLinesFor(scope.includes, `.claude/skills/${skillSlug}`);
    const skillBody = scope.paths.length > 0 ? pointerBody(title, ruleTarget) : renderBody({ title, body, importLines });
    const description = JSON.stringify(skillDescription(title, keywords.words));
    outputs.push({ kind: "skill", target: `.claude/skills/${skillSlug}/SKILL.md`, content: `---\nname: ${skillSlug}\ndescription: ${description}\n---\n${skillBody}` });
  }
  return outputs;
}

function pointerBody(title, ruleTarget) {
  return `# ${title}\n\nRead ${ruleTarget} and follow it. The rule lives there so it is read from one place.\n`;
}

function importLinesFor(includes, outputDirectory) {
  return includes.map((include) => {
    if (path.isAbsolute(include) || include.startsWith("~")) return `@${include}`;
    return `@${path.posix.relative(outputDirectory, path.posix.normalize(include))}`;
  });
}

function renderRule({ title, body, paths, importLines }) {
  const frontmatter = paths.length === 0 ? "" : `---\npaths:\n${paths.map((pattern) => `  - ${JSON.stringify(pattern)}`).join("\n")}\n---\n`;
  return `${frontmatter}${renderBody({ title, body, importLines })}`;
}

function renderBody({ title, body, importLines }) {
  const heading = body.startsWith("# ") ? "" : `# ${title}\n\n`;
  const importBlock = importLines.length > 0 ? `\n\n${importLines.join("\n")}` : "";
  return `${heading}${body}${importBlock}\n`;
}
