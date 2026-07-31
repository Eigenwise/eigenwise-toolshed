'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createCommandDetector } = require('./detectors/commands.js');
const { createCorrectionDetector } = require('./detectors/corrections.js');
const { createHazardDetector } = require('./detectors/hazards.js');
const { createRediscoveryDetector } = require('./detectors/rediscovery.js');
const { createWriteDetector } = require('./detectors/writes.js');
const { describeWindow, resolveWindow } = require('./scan.js');
const { rank } = require('./findings.js');
const { redact, redactDeep } = require('./normalize.js');
const { streamTranscript } = require('./stream.js');

function createDetectors(options) {
  return [
    createCommandDetector(),
    createWriteDetector(),
    createRediscoveryDetector(),
    createCorrectionDetector(),
    createHazardDetector(options),
  ];
}

async function mine(options = {}) {
  const window = resolveWindow(options);
  const detectors = createDetectors({ projectPath: options.projectPath ?? process.cwd(), git: options.git });

  const transcripts = [];
  const failures = [];

  // Selection is newest-first so the window holds the most recent sessions, but streaming has to run
  // oldest-first: detectors that keep "the version that last worked" would otherwise keep whichever
  // copy happened to be read last, which is the oldest one.
  const ordered = [...window.files].sort((a, b) => a.modifiedMs - b.modifiedMs);
  for (const file of ordered) {
    try {
      const summary = await streamTranscript(file, detectors);
      transcripts.push({
        scope: file.scope,
        sessionId: file.sessionId,
        agentType: file.agentType ?? null,
        model: file.model ?? null,
        bytes: file.bytes,
        records: summary.records,
        unparseable: summary.unparseable,
        tokens: summary.tokens,
        cacheReadTokens: summary.cacheReadTokens,
      });
    } catch (error) {
      failures.push({ file: file.file, message: error.message });
    }
  }

  const raw = [];
  const notes = {};
  const salvage = [];
  for (const detector of detectors) {
    const result = detector.finish();
    raw.push(...(result.findings ?? []));
    salvage.push(...(result.salvage ?? []));
    notes[detector.name] = result.notes ?? {};
  }

  const ranked = rank(raw, { floor: options.floor });

  // Redaction happens once, here, over everything that will be reported. Doing it at each detector
  // would mean every future detector has to remember; doing it here means none of them can forget.
  const findings = redactDeep(ranked.findings);
  const dropped = redactDeep(ranked.dropped);

  return {
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    window: {
      description: describeWindow(window),
      days: window.days,
      sessionLimit: window.sessionLimit,
      boundBy: window.boundBy,
      slugs: window.slugs,
      sessionsScanned: window.sessionsScanned,
      sessionsAvailable: window.sessionsAvailable,
      skippedSessions: window.skippedSessions,
      subagentsScanned: window.subagentsScanned,
      bytes: window.bytes,
      earliest: window.earliestMs ? new Date(window.earliestMs).toISOString() : null,
      latest: window.latestMs ? new Date(window.latestMs).toISOString() : null,
    },
    totals: {
      transcripts: transcripts.length,
      records: transcripts.reduce((sum, item) => sum + item.records, 0),
      unparseable: transcripts.reduce((sum, item) => sum + item.unparseable, 0),
      tokens: transcripts.reduce((sum, item) => sum + item.tokens, 0),
      cacheReadTokens: transcripts.reduce((sum, item) => sum + item.cacheReadTokens, 0),
      readFailures: failures.length,
    },
    findings,
    dropped,
    // The bodies and their recorded output go to disk, not into findings.json: the reviewing model
    // should read a salvaged script deliberately, not inhale every one of them with the summary.
    salvage: salvage.map(({ content, proof, ...rest }) => ({
      ...rest,
      proof: proof ? { tool: proof.tool, command: redact(proof.command), sessionId: proof.sessionId, stdoutBytes: Buffer.byteLength(proof.stdout ?? '', 'utf8') } : null,
    })),
    notes: redactDeep(notes),
    failures,
    salvageBodies: salvage,
  };
}

/**
 * Writes the report next to the salvaged files so the reviewing model reads a bounded summary and only
 * opens a salvaged script when it decides to act on one. The transcripts themselves never enter
 * context; at the sizes involved a single session would exhaust it.
 */
function writeResults(result, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const { salvageBodies, ...report } = result;

  if (salvageBodies.length) {
    const salvageDir = path.join(outputDir, 'salvage');
    fs.mkdirSync(salvageDir, { recursive: true });
    for (const item of salvageBodies) {
      fs.writeFileSync(path.join(salvageDir, `${item.id}-${item.basename}`), item.content, 'utf8');
      if (item.proof?.stdout) {
        fs.writeFileSync(path.join(salvageDir, `${item.id}-${item.basename}.recorded-stdout.txt`), item.proof.stdout, 'utf8');
      }
    }
  }

  const findingsFile = path.join(outputDir, 'findings.json');
  fs.writeFileSync(findingsFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { findingsFile, outputDir };
}

module.exports = { createDetectors, mine, writeResults };
