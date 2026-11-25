#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CARD_DIRECTORY = ".claude/rules/map";
export const CARD_BYTE_LIMIT = 2560;

function unquote(text) {
  return text.trim().replace(/^["']|["']$/g, "");
}

function frontmatterLines(text) {
  const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1].split("\n") : [];
}

function readBlockList(lines) {
  const items = [];
  for (const line of lines) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (!item) break;
    items.push(unquote(item[1]));
  }
  return items;
}

function readInlineList(text) {
  return text.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
}

function readPaths(lines) {
  const start = lines.findIndex((line) => line.startsWith("paths:"));
  if (start === -1) return [];
  const inline = lines[start].slice("paths:".length).trim();
  if (inline.startsWith("[")) return readInlineList(inline);
  if (inline) return [unquote(inline)];
  return readBlockList(lines.slice(start + 1));
}

function readVerifiedAt(lines) {
  const found = lines.map((line) => line.match(/^verified-at:\s*(\S+)/)).find(Boolean);
  return found ? unquote(found[1]) : null;
}

export function parseCard(text) {
  const lines = frontmatterLines(text);
  return { paths: readPaths(lines), verifiedAt: readVerifiedAt(lines) };
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// The host matches a card's paths from the folder that holds the card's .claude folder: a name with no slash
// matches at any depth, and a leading slash means that folder only. Git needs its own spelling of both.
export function cardPathspec(glob) {
  if (glob.startsWith("./")) return null;
  if (glob.startsWith("/")) return `:(glob)${glob.slice(1)}`;
  return glob.includes("/") ? `:(glob)${glob}` : `:(glob)**/${glob}`;
}

function classifyPatterns(paths) {
  return {
    loadable: paths.filter((glob) => cardPathspec(glob) !== null),
    neverLoaded: paths.filter((glob) => cardPathspec(glob) === null),
  };
}

function matchesAnyFile(root, glob) {
  const output = runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--", cardPathspec(glob)]);
  return Boolean(output && output.trim());
}

function isKnownCommit(root, sha) {
  return runGit(root, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) !== null;
}

function uncountableReason(root, verifiedAt) {
  return isKnownCommit(root, verifiedAt)
    ? "git could not count the commits"
    : "verified-at is not a commit in this repository";
}

function noPathsReason(neverLoaded) {
  return neverLoaded.length > 0 ? "only patterns the host never loads (a ./ pattern)" : "no paths";
}

function staleReason(root, { paths, neverLoaded, verifiedAt, commits }) {
  if (paths.length === 0) return noPathsReason(neverLoaded);
  if (commits !== null) return null;
  return verifiedAt ? uncountableReason(root, verifiedAt) : "no verified-at";
}

function cardFilePath(fileName) {
  return `${CARD_DIRECTORY}/${fileName}`;
}

function commitList(root, args) {
  const output = runGit(root, args);
  return output === null ? [] : output.split("\n").filter(Boolean);
}

// --follow keeps a rename from looking like a new card: a rename adds no verified-at line, only the path changes.
function stampCommit(root, fileName) {
  const args = ["log", "-1", "--follow", "--format=%H", "-G^verified-at:", "--", cardFilePath(fileName)];
  return commitList(root, args)[0] ?? null;
}

function commitsTouchingCardSince(root, fileName, sha) {
  return commitList(root, ["log", "--follow", "--format=%H", `${sha}..HEAD`, "--", cardFilePath(fileName)]);
}

// A merge commit is not counted: it only joins commits that are counted on their own side.
// A commit that changed the card together with its area vouches for itself only. The stamp vouches for what came before it.
function countCommitsSince(root, fileName, sha, paths) {
  const areaCommits = runGit(root, ["rev-list", "--no-merges", `${sha}..HEAD`, "--", ...paths.map(cardPathspec)]);
  if (areaCommits === null) return null;
  const commitsWithCard = new Set(commitsTouchingCardSince(root, fileName, sha));
  return areaCommits.split("\n").filter((commit) => commit && !commitsWithCard.has(commit)).length;
}

function isAncestor(root, olderSha, newerSha) {
  return runGit(root, ["merge-base", "--is-ancestor", olderSha, newerSha]) !== null;
}

// A stamp counts only when it is on this history, so two clones agree. Otherwise the last commit that moved the stamp does.
function countingBase(root, fileName, verifiedAt) {
  if (verifiedAt && isAncestor(root, verifiedAt, "HEAD")) return { sha: verifiedAt, source: "verified-at" };
  const stamped = stampCommit(root, fileName);
  return stamped ? { sha: stamped, source: "card-commit" } : null;
}

function countCardCommits(root, fileName, verifiedAt, paths) {
  const base = paths.length > 0 ? countingBase(root, fileName, verifiedAt) : null;
  const commits = base ? countCommitsSince(root, fileName, base.sha, paths) : null;
  return { commits, countedFrom: commits === null ? null : base.source };
}

export function assessCard(root, fileName) {
  const filePath = join(root, CARD_DIRECTORY, fileName);
  const { paths: declaredPaths, verifiedAt } = parseCard(readFileSync(filePath, "utf8"));
  const { loadable: paths, neverLoaded } = classifyPatterns(declaredPaths);
  const { commits, countedFrom } = countCardCommits(root, fileName, verifiedAt, paths);
  const reason = staleReason(root, { paths, neverLoaded, verifiedAt, commits });
  return {
    card: fileName,
    status: !reason && commits === 0 ? "fresh" : "stale",
    commits,
    countedFrom,
    reason,
    emptyGlobs: paths.filter((glob) => !matchesAnyFile(root, glob)),
    neverLoaded,
    oversize: statSync(filePath).size > CARD_BYTE_LIMIT,
  };
}

export function listCardFiles(root) {
  const directory = join(root, CARD_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".md")).sort();
}

function findingNotes({ withEmptyGlobs, withNeverLoaded }) {
  const notes = [];
  if (withEmptyGlobs > 0) notes.push(`${withEmptyGlobs} point at files that are gone`);
  if (withNeverLoaded > 0) notes.push(`${withNeverLoaded} use a path pattern Claude Code never loads`);
  return notes.map((note) => `, ${note}`).join("");
}

export function formatLine({ total, stale, withEmptyGlobs, withNeverLoaded = 0 }) {
  if (total === 0) return "Codebase map: no areas yet.";
  if (stale === 0 && withEmptyGlobs + withNeverLoaded === 0) return `Codebase map: all ${total} areas up to date.`;
  const findings = findingNotes({ withEmptyGlobs, withNeverLoaded });
  return `Codebase map: ${stale} of ${total} areas out of date${findings}. /codebase-mapper:refresh updates them.`;
}

export function mapStatus(root) {
  const cards = listCardFiles(root).map((fileName) => assessCard(root, fileName));
  const counts = {
    total: cards.length,
    stale: cards.filter((card) => card.status === "stale").length,
    withEmptyGlobs: cards.filter((card) => card.emptyGlobs.length > 0).length,
    withNeverLoaded: cards.filter((card) => card.neverLoaded.length > 0).length,
  };
  return { ...counts, line: formatLine(counts), cards };
}

export function repositoryRoot(startDirectory) {
  const topLevel = runGit(startDirectory, ["rev-parse", "--show-toplevel"]);
  return topLevel ? topLevel.trim() : startDirectory;
}

function nearestMapFolder(startDirectory, stopDirectory) {
  const stop = realpathSync.native(stopDirectory);
  let directory = startDirectory;
  while (!existsSync(join(directory, CARD_DIRECTORY))) {
    const parent = dirname(directory);
    if (parent === directory || realpathSync.native(directory) === stop) return null;
    directory = parent;
  }
  return directory;
}

// The host reads a card's paths from the folder that holds its .claude folder, which can sit below the git top level.
// Git runs from that folder too, so the pathspecs mean the same thing to both.
export function mapRoot(startDirectory) {
  if (!existsSync(startDirectory)) return startDirectory;
  const topLevel = repositoryRoot(startDirectory);
  return nearestMapFolder(resolve(startDirectory), topLevel) ?? topLevel;
}

function startDirectoryFrom(argv) {
  const flagIndex = argv.indexOf("--root");
  return flagIndex === -1 ? process.cwd() : (argv[flagIndex + 1] ?? process.cwd());
}

function main(argv) {
  const status = mapStatus(mapRoot(startDirectoryFrom(argv)));
  process.stdout.write(argv.includes("--line") ? `${status.line}\n` : `${JSON.stringify(status, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
