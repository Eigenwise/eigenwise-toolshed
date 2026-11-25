import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const WALK_FILE_LIMIT = 100_000;
const GIT_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;

// Untracked files that git does not ignore count too, so a rule for a directory created this hour still finds it.
export function listProjectFiles(root) {
  return listWithGit(root) ?? walkDirectory(root);
}

function listWithGit(root) {
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walkDirectory(root) {
  const files = [];
  const pending = [""];
  while (pending.length > 0 && files.length < WALK_FILE_LIMIT) {
    const listing = listDirectory(root, pending.pop());
    files.push(...listing.files);
    pending.push(...listing.directories);
  }
  return files;
}

function readEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listDirectory(root, relativeDirectory) {
  const files = [];
  const directories = [];
  for (const entry of readEntries(path.join(root, relativeDirectory))) {
    const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (!entry.isDirectory()) files.push(relativePath);
    else if (!SKIPPED_DIRECTORIES.has(entry.name)) directories.push(relativePath);
  }
  return { files, directories };
}
