'use strict';

const { createSignalCollector, tallyFromSignals } = require('./signals.js');
const { readInstalled, unusedInstalled } = require('./catalog.js');
const { rejectedFingerprints } = require('./state.js');
const { resolveWindow } = require('./scan.js');
const { streamTranscript } = require('./stream.js');

async function mine(options = {}) {
  const env = options.env ?? process.env;
  const window = resolveWindow(options);
  const collector = createSignalCollector();

  for (const file of window.files) {
    try {
      await streamTranscript(file, collector);
    } catch {
      // One unreadable transcript never sinks the whole scan.
    }
  }

  const signals = collector.finish();
  const decisions = rejectedFingerprints(env);

  return {
    window: {
      scope: window.allProjects ? `${window.slugs.length} projects` : window.slugs[0],
      days: window.days,
      boundBy: window.boundBy,
      sessionsScanned: window.sessionsScanned,
      sessionsAvailable: window.sessionsAvailable,
      subagentsScanned: window.subagentsScanned,
      megabytesStreamed: Number((window.bytes / 1e6).toFixed(1)),
      earliest: window.earliestMs ? new Date(window.earliestMs).toISOString() : null,
      latest: window.latestMs ? new Date(window.latestMs).toISOString() : null,
    },
    ...signals,
    installed: readInstalled(env).map((plugin) => plugin.id),
    installedWithoutAttribution: unusedInstalled(signals.attribution.plugins, env),
    decisions,
  };
}

/** Tally for exactly one transcript file, used by the SessionEnd hook. */
async function tallyTranscript(transcriptFile, sessionId) {
  const collector = createSignalCollector();
  await streamTranscript({ scope: 'main', file: transcriptFile, sessionId }, collector);
  return tallyFromSignals(collector.finish());
}

module.exports = { mine, tallyTranscript };
