import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, repositoryRoot } from "./repository.mjs";

export function listCopies() {
  const targets = readJson(join(repositoryRoot, "shared", "targets.json"));
  return Object.entries(targets).flatMap(([sharedFile, destinations]) =>
    destinations.map((destination) => ({
      sharedFile,
      source: join(repositoryRoot, "shared", sharedFile),
      destination: join(repositoryRoot, destination),
      destinationLabel: destination,
    })),
  );
}

export function isInSync(copy) {
  return existsSync(copy.destination) && readFileSync(copy.source).equals(readFileSync(copy.destination));
}

function writeCopy(copy) {
  mkdirSync(dirname(copy.destination), { recursive: true });
  writeFileSync(copy.destination, readFileSync(copy.source));
}

function reportDrift(drifted) {
  for (const copy of drifted) {
    console.error(`drift: shared/${copy.sharedFile} differs from ${copy.destinationLabel}`);
  }
  console.error(`${drifted.length} shared copy(ies) out of sync. Run: node scripts/sync-shared.mjs`);
}

function main(checkOnly) {
  const copies = listCopies();
  const drifted = copies.filter((copy) => !isInSync(copy));
  if (checkOnly) {
    if (drifted.length > 0) reportDrift(drifted);
    else console.log(`shared files in sync (${copies.length} copies)`);
    return drifted.length > 0 ? 1 : 0;
  }
  drifted.forEach(writeCopy);
  console.log(`copied ${drifted.length} of ${copies.length} shared copies`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.includes("--check"));
}
