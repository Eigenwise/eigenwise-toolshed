'use strict';

// The board server delivers here so its own request loop stays free while the merged-tree gate runs
// (SQ-3884). The delivery records its outcome on the board itself, so it finishes even when the server
// that asked for it has gone away.

import { integrationProgressSummary, onIntegrationProgress } from './integration-tests.js';

const { integrateInProcess } = require('./mcp-lifecycle.js');

function sendToServer(type: 'progress' | 'result' | 'error', value: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) return resolve();
    try {
      process.send({ type, value }, undefined, {}, () => resolve());
    } catch {
      resolve();
    }
  });
}

function requestedArguments(message: unknown): unknown {
  return typeof message === 'object' && message !== null && 'args' in message ? message.args : {};
}

async function deliver(message: unknown): Promise<void> {
  onIntegrationProgress((progress) => { void sendToServer('progress', integrationProgressSummary(progress)); });
  try {
    await sendToServer('result', await integrateInProcess(requestedArguments(message)));
  } catch (error: unknown) {
    await sendToServer('error', error instanceof Error ? error.message : String(error));
  }
  process.exit(0);
}

process.once('message', (message: unknown) => { void deliver(message); });
