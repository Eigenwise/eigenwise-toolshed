'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { hooks } = require('../hooks/hooks.json');

test('keeps startup-only and startup-or-resume hooks separate with their existing timeouts', () => {
  assert.deepEqual(hooks, {
    SessionStart: [
      {
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-auto-allowlist.js"',
            timeout: 10,
          },
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-nudge.js"',
            timeout: 10,
          },
        ],
      },
      {
        matcher: 'startup|resume',
        hooks: [
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-freshness.js"',
            timeout: 5,
          },
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/billing-path-check.js"',
            timeout: 5,
          },
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/marketplace-freshness-cache.js"',
            timeout: 2,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end-tally.js"',
            timeout: 30,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/stop-resupply-offer.js"',
            timeout: 10,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-freshness.js"',
            timeout: 10,
          },
        ],
      },
    ],
  });
});
