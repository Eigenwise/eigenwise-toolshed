import { spawnSync } from "node:child_process";

export function isTrackedByGit(projectRoot, absolutePath) {
  const result = spawnSync("git", ["ls-files", "--", absolutePath], { cwd: projectRoot, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() !== "";
}
