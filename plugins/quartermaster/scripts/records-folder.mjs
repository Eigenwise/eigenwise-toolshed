import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RECORDS_FOLDER = ".claude/quartermaster";

export function writeInto(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function keepRecordsOutOfGit(project) {
  const path = join(project, RECORDS_FOLDER, ".gitignore");
  if (!existsSync(path)) writeInto(path, "# Quartermaster's records stay personal until a team chooses to share them.\n# Delete this file to commit them.\n*\n");
}
