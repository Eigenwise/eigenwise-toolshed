import path from "node:path";
import { splitOutsideBraces } from "./rule-files.mjs";

export function splitPathPatterns(declared) {
  if (typeof declared === "string") return splitOutsideBraces(declared);
  if (Array.isArray(declared)) return declared.flatMap(splitPathPatterns);
  return [];
}

// Claude Code drops a trailing "/**" and treats an empty list or only "**" as no condition at all.
export function effectivePatterns(declared) {
  const patterns = splitPathPatterns(declared)
    .map((pattern) => (pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern))
    .filter((pattern) => pattern.length > 0);
  const loadsEverywhere = patterns.length === 0 || patterns.every((pattern) => pattern === "**");
  return loadsEverywhere ? null : patterns;
}

export function buildPathIndex(filePaths) {
  const entries = new Set();
  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    segments.forEach((_, index) => entries.add(segments.slice(0, index + 1).join("/")));
  }
  return [...entries];
}

// Gitignore semantics, as the engine uses: a pattern naming a directory covers everything under it,
// and a pattern with no slash matches at any depth.
export function patternMatchesIndex(pattern, pathIndex) {
  const trimmed = pattern.replace(/\/+$/, "");
  const anchored = trimmed.includes("/");
  const glob = anchored ? trimmed.replace(/^\//, "") : `**/${trimmed}`;
  return pathIndex.some((entry) => path.posix.matchesGlob(entry, glob));
}
