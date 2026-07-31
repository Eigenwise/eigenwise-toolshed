'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let counter = 0;
const nextId = () => `id-${(counter += 1)}`;

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-retro-test-'));
}

/**
 * Builds a transcript in the on-disk layout the miner reads: `<root>/<slug>/<session>.jsonl` for the
 * main loop and `<root>/<slug>/<session>/subagents/<agent>.jsonl` plus a `.meta.json` sidecar for each
 * subagent. Tests exercise the real reader rather than a stand-in, so a layout change fails here.
 */
function createTranscript({ root, slug, sessionId, agent = null, startMs = Date.UTC(2026, 6, 30, 12, 0, 0) }) {
  const lines = [];
  let clock = startMs;
  const advance = (ms = 1000) => {
    clock += ms;
    return new Date(clock).toISOString();
  };

  const base = () => ({
    sessionId,
    uuid: nextId(),
    parentUuid: null,
    isSidechain: Boolean(agent),
    userType: 'external',
    entrypoint: 'cli',
    cwd: 'C:/project',
    version: '2.0.0',
    gitBranch: 'main',
  });

  const api = {
    prompt(text, gapMs) {
      lines.push({ ...base(), type: 'user', promptId: nextId(), origin: 'user', timestamp: advance(gapMs), message: { role: 'user', content: text } });
      return api;
    },

    tool(name, input, { result = '', isError = false, usage = null, gapMs, denial = null } = {}) {
      const toolUseId = nextId();
      lines.push({
        ...base(),
        type: 'assistant',
        requestId: nextId(),
        timestamp: advance(gapMs),
        message: {
          id: nextId(),
          role: 'assistant',
          usage: usage ?? { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 50 },
          content: [{ type: 'tool_use', id: toolUseId, name, input }],
        },
      });
      const record = {
        ...base(),
        type: 'user',
        timestamp: advance(200),
        toolUseResult: { stdout: isError ? '' : result, stderr: isError ? result : '', interrupted: false },
        sourceToolAssistantUUID: nextId(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result, is_error: isError }] },
      };
      if (denial) record.toolDenialKind = denial;
      lines.push(record);
      return api;
    },

    write() {
      const dir = path.join(root, slug);
      if (!agent) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
        return;
      }
      const subagents = path.join(dir, sessionId, 'subagents');
      fs.mkdirSync(subagents, { recursive: true });
      fs.writeFileSync(path.join(subagents, `${agent.id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
      fs.writeFileSync(
        path.join(subagents, `${agent.id}.meta.json`),
        JSON.stringify({ agentType: agent.type, model: agent.model ?? 'claude-codex-auto', description: agent.description ?? 'work', spawnDepth: 0 }),
        'utf8',
      );
    },
  };

  return api;
}

/** The main session file must exist for its subagents to be discovered, so tests never build one alone. */
function ensureSession(root, slug, sessionId) {
  createTranscript({ root, slug, sessionId }).prompt('start').write();
}

module.exports = { createTranscript, ensureSession, makeRoot };
