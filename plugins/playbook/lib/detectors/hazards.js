'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const MAX_PATHS = 2000;
const BULK_ADD = /\bgit\s+add\s+(?:-A\b|--all\b|\.(?:\s|$))|\bgit\s+commit\s+(?:-\w*a\w*|--all)\b/;

const SENSITIVE_PATHS = [
  ['env file', /(?:^|[\\/])\.env(?:\.|$)/i],
  ['credential file', /(?:^|[\\/])(?:credentials?|secrets?|auth)\.(?:json|ya?ml|toml|ini)$/i],
  ['private key', /\.(?:pem|key|p12|pfx)$/i],
  ['ssh key', /(?:^|[\\/])id_(?:rsa|ed25519|ecdsa)$/i],
  ['registry token file', /(?:^|[\\/])\.(?:npmrc|pypirc|netrc)$/i],
  ['service account key', /service[-_]?account.*\.json$/i],
];

// Matched to classify a file, never to quote. A hazard report says which pattern hit and where; the
// value itself stays out of the report, out of the findings file, and out of the model's context.
const SENSITIVE_CONTENT = [
  ['private key block', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  ['inline password', /["']?pass(?:word|wd)["']?\s*[:=]\s*["'][^"'\s]{6,}["']/i],
];

function git(projectPath, args) {
  try {
    return execFileSync('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function untrackedUnignored(projectPath) {
  const output = git(projectPath, ['status', '--porcelain', '--untracked-files=all']);
  if (output === null) return null;
  const paths = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('?? ')) continue;
    paths.add(line.slice(3).trim().replace(/^"|"$/g, ''));
  }
  return paths;
}

function classify(filePath, content) {
  const reasons = [];
  for (const [label, pattern] of SENSITIVE_PATHS) if (pattern.test(filePath)) reasons.push(label);
  if (typeof content === 'string' && content.length < 2 * 1024 * 1024) {
    for (const [label, pattern] of SENSITIVE_CONTENT) if (pattern.test(content)) reasons.push(label);
  }
  return reasons;
}

/**
 * Flags the two ways private data reaches a commit: a file the repo neither tracks nor ignores, and a
 * bulk `git add` staged while such a file exists.
 *
 * These are reported ahead of every frequency-ranked finding regardless of how often they happened,
 * because the cost is not proportional to the count. Once is enough.
 */
function createHazardDetector(options = {}) {
  const projectPath = options.projectPath ?? process.cwd();
  const runGit = options.git ?? untrackedUnignored;
  const written = new Map();
  const bulkAdds = [];
  let dropped = 0;

  return {
    name: 'hazards',

    onEvent(event) {
      if (event.kind === 'tool_use' && (event.name === 'Write' || event.name === 'Edit' || event.name === 'MultiEdit')) {
        const filePath = event.input?.file_path;
        if (typeof filePath !== 'string' || !filePath) return;
        if (written.size >= MAX_PATHS && !written.has(filePath)) {
          dropped += 1;
          return;
        }
        const record = written.get(filePath) ?? { filePath, writes: 0, sessions: new Set(), reasons: new Set(), lastMs: null };
        record.writes += 1;
        record.sessions.add(event.sessionId);
        record.lastMs = event.timestampMs;
        for (const reason of classify(filePath, event.input?.content)) record.reasons.add(reason);
        written.set(filePath, record);
        return;
      }

      if (event.kind !== 'tool_use' || (event.name !== 'Bash' && event.name !== 'PowerShell')) return;
      const command = String(event.input?.command ?? '');
      if (!BULK_ADD.test(command)) return;
      if (bulkAdds.length < 20) {
        bulkAdds.push({
          command: command.replace(/\s+/g, ' ').trim().slice(0, 200),
          sessionId: event.sessionId,
          timestampMs: event.timestampMs,
        });
      }
    },

    finish() {
      const findings = [];
      const untracked = runGit(projectPath);
      const insideProject = [...written.values()].filter((record) => {
        const relative = path.relative(projectPath, record.filePath);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      });

      const exposed = [];
      if (untracked) {
        for (const record of insideProject) {
          const relative = path.relative(projectPath, record.filePath).split(path.sep).join('/');
          if (untracked.has(relative)) exposed.push({ ...record, relative });
        }
      }

      const sensitive = exposed.filter((record) => record.reasons.size > 0);
      if (sensitive.length) {
        findings.push({
          kind: 'hazard-private-data',
          severity: 'critical',
          title: `${sensitive.length} file(s) holding private data are untracked but not gitignored`,
          occurrences: sensitive.length,
          sessions: new Set(sensitive.flatMap((record) => [...record.sessions])).size,
          actors: [{ label: 'workspace', count: sensitive.length }],
          paths: sensitive.map((record) => record.relative),
          evidence: [
            {
              label: 'one `git add -A` from being committed',
              text: sensitive.map((record) => `${record.relative} (${[...record.reasons].join(', ')})`).join('\n'),
            },
            {
              label: 'bulk staging seen',
              text: bulkAdds.length ? bulkAdds.map((add) => add.command).join('\n') : 'none in this window',
            },
          ],
        });
      }

      // Untracked source that was just authored is normal, not a hazard: it is untracked because it is
      // new. What makes it dangerous is a bulk stage sweeping it in before anyone looked, so this only
      // becomes a finding when a `git add -A` actually happened while those files sat there.
      const plainExposed = exposed.filter((record) => record.reasons.size === 0);
      if (plainExposed.length >= 3 && bulkAdds.length) {
        findings.push({
          kind: 'hazard-untracked',
          severity: 'high',
          title: `${plainExposed.length} untracked, unignored files were present during a bulk \`git add\``,
          occurrences: plainExposed.length,
          sessions: new Set(plainExposed.flatMap((record) => [...record.sessions])).size,
          actors: [{ label: 'workspace', count: plainExposed.length }],
          paths: plainExposed.map((record) => record.relative).slice(0, 20),
          evidence: [
            { label: 'untracked and unignored', text: plainExposed.slice(0, 12).map((record) => record.relative).join('\n') },
            { label: 'bulk staging seen', text: bulkAdds.length ? bulkAdds.map((add) => add.command).join('\n') : 'none in this window' },
          ],
        });
      }

      const notes = {
        writtenPaths: written.size,
        droppedPaths: dropped,
        bulkAdds: bulkAdds.length,
        untrackedUnignored: exposed.length,
        gitAvailable: untracked !== null,
      };
      if (plainExposed.length && !bulkAdds.length) {
        notes.untrackedNote = `${plainExposed.length} written file(s) are untracked and unignored, which is expected for new work. No bulk \`git add\` happened in this window, so it is reported here rather than as a hazard.`;
      }
      if (untracked === null) {
        notes.warning = 'git status was unavailable, so untracked-but-unignored files could not be checked';
      }
      return { findings, notes };
    },
  };
}

module.exports = { BULK_ADD, classify, createHazardDetector, untrackedUnignored };
