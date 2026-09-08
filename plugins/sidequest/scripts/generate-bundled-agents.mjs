import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function recognizedGeneratedExecutorFile(filename, bundledNames) {
  if (bundledNames.has(filename)) return true;
  return /^sidequest-exec-codex-[a-z0-9][a-z0-9-]*-(low|medium|high|xhigh|max)\.md$/.test(filename);
}

export async function generateBundledAgents(pluginRoot) {
  const agentSyncPath = path.join(pluginRoot, 'lib', 'agentsync.js');
  try {
    await fs.access(agentSyncPath);
  } catch {
    return { written: 0, removed: 0, skipped: true };
  }

  const { LEGACY_MARKER, MARKER, bundledExecutorSources } = require(agentSyncPath);
  const wanted = bundledExecutorSources();
  const bundledNames = new Set(wanted.keys());
  const directory = path.join(pluginRoot, 'agents');
  await fs.mkdir(directory, { recursive: true });
  const existing = await fs.readdir(directory, { withFileTypes: true });
  let written = 0;
  let removed = 0;

  for (const entry of existing) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || !recognizedGeneratedExecutorFile(entry.name, bundledNames)) continue;
    const filePath = path.join(directory, entry.name);
    const source = await fs.readFile(filePath, 'utf8');
    if (!source.includes(MARKER) && !source.includes(LEGACY_MARKER)) continue;
    if (!wanted.has(entry.name)) {
      await fs.unlink(filePath);
      removed++;
    }
  }

  for (const [filename, source] of wanted) {
    const filePath = path.join(directory, filename);
    let previous = null;
    try {
      previous = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
    }
    if (previous !== null && previous !== source && !previous.includes(MARKER) && !previous.includes(LEGACY_MARKER)) {
      throw new Error(`Refusing to replace unmarked agent definition: ${filePath}`);
    }
    if (previous === source) continue;
    await fs.writeFile(filePath, source);
    written++;
  }

  return { written, removed, skipped: false };
}
