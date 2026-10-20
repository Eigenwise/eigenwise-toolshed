'use strict';

// Loaded with --require before any test module, in the runner and in every test
// file's child process. It points the home directory and the Claude config
// directory at a throwaway folder, so a test that forgets to isolate itself
// writes there and never into the real ~/.claude (on 28 Sep 2026 a test run
// overwrote a developer's real ~/.claude/settings.json).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
// Never the real `claude`: a real Claude Code launched by a pin probe rewrote the
// real settings file. Tests that want a Claude binary set their own fake one.
process.env.CODEX_GATEWAY_CLAUDE_BIN = path.join(home, 'claude-is-not-installed-in-tests');
process.on('exit', () => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});
