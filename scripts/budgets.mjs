import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { countWords, listFilesRecursively, listPlugins, stripFrontmatter } from "./repository.mjs";

export const budgets = { skillWords: 1100, agentWords: 800, readmeWords: 1500, tools: 6 };

function bodyWords(filePath) {
  return countWords(stripFrontmatter(readFileSync(filePath, "utf8")));
}

function largest(measurements) {
  return measurements.reduce((worst, current) => (current.value > worst.value ? current : worst), { label: "", value: 0 });
}

function measureSkills(directory) {
  const skillFiles = listFilesRecursively(join(directory, "skills")).filter((path) => basename(path) === "SKILL.md");
  return largest(skillFiles.map((path) => ({ label: basename(join(path, "..")), value: bodyWords(path) })));
}

function measureAgents(directory) {
  const agentFiles = listFilesRecursively(join(directory, "agents")).filter((path) => path.endsWith(".md"));
  return largest(agentFiles.map((path) => ({ label: basename(path, ".md"), value: bodyWords(path) })));
}

function measureReadme(directory) {
  const readmePath = join(directory, "README.md");
  return { label: "", value: existsSync(readmePath) ? bodyWords(readmePath) : 0 };
}

function isModuleSource(path) {
  return /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith(".d.ts");
}

// A registration loop over a list of specs hides the real count from the call sites, so count the specs themselves:
// a spec object typed ToolSpec, a spec object passed by name to a register call, and a spec written inline in one.
const TYPED_SPEC = /^(?:export )?const (\w+): ToolSpec = \{/gm;
const OBJECT_DECLARATION = /^(?:export )?const (\w+)(?:: \w+)? = \{/gm;
const REGISTERED_BY_NAME = /\$\.tool\.register\((\w+)\)/g;
const INLINE_REGISTRATION = /\$\.tool\.register\(\s*\{/g;

const namesMatching = (pattern, text) => [...text.matchAll(pattern)].map((match) => match[1]);

export function countRegisteredTools(directory) {
  const texts = listFilesRecursively(join(directory, "hooks")).filter(isModuleSource).map((path) => readFileSync(path, "utf8"));
  const objectNames = new Set(texts.flatMap((text) => namesMatching(OBJECT_DECLARATION, text)));
  const specNames = new Set(texts.flatMap((text) => namesMatching(TYPED_SPEC, text)));
  for (const name of texts.flatMap((text) => namesMatching(REGISTERED_BY_NAME, text))) {
    if (objectNames.has(name)) specNames.add(name);
  }
  return specNames.size + texts.reduce((total, text) => total + (text.match(INLINE_REGISTRATION) ?? []).length, 0);
}

export function measurePlugin(plugin) {
  return {
    name: plugin.name,
    skill: measureSkills(plugin.directory),
    agent: measureAgents(plugin.directory),
    readme: measureReadme(plugin.directory),
    tools: { label: "", value: countRegisteredTools(plugin.directory) },
  };
}

function formatCell(measurement, budget) {
  if (measurement.value === 0) return "-";
  const flag = measurement.value > budget ? " OVER" : "";
  const label = measurement.label ? ` (${measurement.label})` : "";
  return `${measurement.value}/${budget}${flag}${label}`;
}

function isBeyondDouble(measured) {
  return (
    measured.skill.value > 2 * budgets.skillWords ||
    measured.agent.value > 2 * budgets.agentWords ||
    measured.readme.value > 2 * budgets.readmeWords ||
    measured.tools.value > 2 * budgets.tools
  );
}

export function renderBudgetTable(measuredPlugins) {
  const header = ["plugin", "skill words", "agent words", "README words", "tools"];
  const rows = measuredPlugins.map((measured) => [
    measured.name,
    formatCell(measured.skill, budgets.skillWords),
    formatCell(measured.agent, budgets.agentWords),
    formatCell(measured.readme, budgets.readmeWords),
    formatCell(measured.tools, budgets.tools),
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function runBudgets() {
  const measuredPlugins = listPlugins().map(measurePlugin);
  console.log(renderBudgetTable(measuredPlugins));
  const failing = measuredPlugins.filter(isBeyondDouble).map((measured) => measured.name);
  if (failing.length > 0) console.error(`over twice a budget: ${failing.join(", ")}`);
  return failing.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runBudgets();
}
