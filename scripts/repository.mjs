import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");


export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readMarketplace() {
  return readJson(join(repositoryRoot, ".claude-plugin", "marketplace.json"));
}

export function listPlugins() {
  return readMarketplace().plugins.map((entry) => ({
    name: entry.name,
    directory: resolve(repositoryRoot, entry.source),
  }));
}

export function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

export function listFilesRecursively(directory) {
  if (!isDirectory(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name === "node_modules") return [];
    return entry.isDirectory() ? listFilesRecursively(path) : [path];
  });
}

function executableCandidates(name) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return directories.flatMap((directory) => extensions.map((extension) => join(directory, name + extension)));
}

export function findExecutable(name) {
  return executableCandidates(name).find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function isUsableExecutable(path) {
  return Boolean(path) && existsSync(path) && statSync(path).isFile();
}

function homeClaudePath() {
  const fileName = process.platform === "win32" ? "claude.exe" : "claude";
  return join(homedir(), ".local", "bin", fileName);
}

export function findClaudeBinary() {
  const fromEnvironment = process.env.CLAUDE_BIN;
  if (isUsableExecutable(fromEnvironment)) return fromEnvironment;
  const onPath = findExecutable("claude");
  if (onPath?.toLowerCase().endsWith(".exe") || (onPath && process.platform !== "win32")) return onPath;
  if (isUsableExecutable(homeClaudePath())) return homeClaudePath();
  // An npm install on Windows leaves only a .cmd shim, which is all a CI runner has.
  return onPath;
}

function needsShell(command) {
  return /\.(cmd|bat)$/i.test(command);
}

function quoteForShell(argument) {
  return /[\s"]/.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument;
}

export function runChild(command, args, options = {}) {
  const shell = needsShell(command);
  const result = spawnSync(shell ? quoteForShell(command) : command, shell ? args.map(quoteForShell) : args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env,
    encoding: "utf8",
    windowsHide: true,
    shell,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
  };
}

export function mainCheckoutRoot() {
  const result = runChild("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return result.exitCode === 0 ? dirname(result.output.trim()) : undefined;
}

export function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

export function stripFrontmatter(markdown) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

export function hasHooksModule(directory) {
  const hooksFile = join(directory, "hooks", "hooks.json");
  if (!existsSync(hooksFile)) return false;
  return (readJson(hooksFile).modules ?? []).length > 0;
}

export function hasModuleTests(directory) {
  return listFilesRecursively(join(directory, "hooks")).some((path) => /\.test\.tsx?$/.test(path));
}
