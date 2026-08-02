'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'NotebookRead', 'WebFetch', 'WebSearch']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput']);
const MAX_TOOL_DURATION_MS = 10 * 60 * 1000;

// Shell invocations that only look at things. Anything not matched here counts as a mutation, so an
// unrecognized command is treated as substantive rather than silently ignored.
const READ_ONLY_SHELL = /^(?:ls|dir|cat|head|tail|wc|find|grep|rg|type|stat|file|tree|pwd|cd|echo|which|where|Get-(?:ChildItem|Content|Location|Item)|git\s+(?:status|log|diff|show|branch|remote|config\s+--get|rev-parse|ls-files|check-ignore))\b/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function toolResultText(block, record) {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) return textOf(block.content);
  const result = record?.toolUseResult;
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const parts = [result.stdout, result.stderr].filter((value) => typeof value === 'string' && value);
    if (parts.length) return parts.join('\n');
  }
  return '';
}

function resultIsError(block, record) {
  if (block?.is_error === true) return true;
  const result = record?.toolUseResult;
  if (result && typeof result === 'object') {
    if (result.interrupted === true) return true;
    if (typeof result.stderr === 'string' && result.stderr.trim() && result.stdout === '') return true;
  }
  return false;
}

function toolDurationMs(block, record, call, timestampMs) {
  const recorded = Number(record?.durationMs ?? block?.durationMs);
  const elapsed = Number.isFinite(recorded) && recorded >= 0
    ? recorded
    : Number.isFinite(timestampMs) && Number.isFinite(call?.timestampMs)
      ? timestampMs - call.timestampMs
      : Number.NaN;
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.min(elapsed, MAX_TOOL_DURATION_MS) : null;
}

function isHumanPrompt(record, scope) {
  if (scope !== 'main' || record.type !== 'user') return false;
  if (record.toolUseResult !== undefined) return false;
  if (record.isMeta === true || record.isVisibleInTranscriptOnly === true) return false;
  if (record.isCompactSummary === true) return false;
  const content = record.message?.content;
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return false;
  return Boolean(textOf(content).trim());
}

function isMutating(name, input) {
  if (WRITE_TOOLS.has(name)) return true;
  if (name && name.startsWith('mcp__') && /add|update|commit|submit|done|dispatch|claim|integrate|release/i.test(name)) return true;
  if (!SHELL_TOOLS.has(name)) return false;
  const command = String(input?.command ?? '').trim();
  return command ? !READ_ONLY_SHELL.test(command) : false;
}

/**
 * Splits usage into tokens that were genuinely new and tokens that were cache reads.
 *
 * Folding them together is how a retro ends up claiming hundreds of billions of tokens: every request
 * re-reads the whole cached prefix, so summing cache reads across a session counts the same context
 * once per turn. Only the fresh half reflects work done.
 */
function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return { fresh: 0, cacheRead: 0 };
  const field = (key) => (Number.isFinite(usage[key]) ? usage[key] : 0);
  return {
    fresh: field('input_tokens') + field('cache_creation_input_tokens') + field('output_tokens'),
    cacheRead: field('cache_read_input_tokens'),
  };
}

/**
 * Streams one transcript and pushes normalized events at each detector.
 *
 * Transcripts run to tens of megabytes, so the file is never held in memory and no event carries a
 * full tool payload beyond what a detector asks for. Token usage is reconciled per file rather than
 * per record: a retried request is written more than once with the same requestId, and only the last
 * record carries the settled numbers, so summing every record overcounts several times over.
 */
async function streamTranscript(source, detectors) {
  const actor = source.scope === 'subagent'
    ? {
      scope: 'subagent',
      label: source.agentType ?? source.agentId,
      agentId: source.agentId,
      agentType: source.agentType ?? null,
      model: source.model ?? null,
      customAgentType: source.customAgentType ?? null,
      description: source.description ?? null,
      sessionId: source.sessionId,
    }
    : { scope: 'main', label: 'main-loop', sessionId: source.sessionId };

  const pendingTools = new Map();
  const usageByRequest = new Map();
  const stats = { records: 0, unparseable: 0, errors: 0, firstMs: null, lastMs: null, measuredToolDurationMs: 0 };

  const emit = (event) => {
    for (const detector of detectors) {
      if (typeof detector.onEvent === 'function') detector.onEvent(event);
    }
  };

  const input = fs.createReadStream(source.file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.unparseable += 1;
      continue;
    }
    stats.records += 1;

    const timestampMs = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
    if (Number.isFinite(timestampMs)) {
      if (stats.firstMs === null) stats.firstMs = timestampMs;
      stats.lastMs = timestampMs;
    }

    const base = {
      actor,
      source,
      sessionId: source.sessionId,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
      cwd: record.cwd ?? null,
      gitBranch: record.gitBranch ?? null,
    };

    if (record.type === 'assistant') {
      const requestKey = record.requestId ?? record.message?.id ?? record.uuid;
      if (requestKey && record.message?.usage) usageByRequest.set(requestKey, record.message.usage);
      if (record.error || record.isApiErrorMessage) stats.errors += 1;

      emit({
        ...base,
        kind: 'assistant',
        requestKey: requestKey ?? null,
        usage: record.message?.usage ?? null,
        apiError: record.error ? String(record.apiErrorStatus ?? record.error).slice(0, 200) : null,
      });

      for (const block of record.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue;
        pendingTools.set(block.id, { name: block.name, input: block.input, timestampMs: base.timestampMs });
        emit({
          ...base,
          kind: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          mutating: isMutating(block.name, block.input),
          reading: READ_TOOLS.has(block.name) || (SHELL_TOOLS.has(block.name) && !isMutating(block.name, block.input)),
          attributionSkill: record.attributionSkill ?? null,
          attributionPlugin: record.attributionPlugin ?? null,
        });
      }
      continue;
    }

    if (record.type === 'user') {
      if (isHumanPrompt(record, source.scope)) {
        emit({ ...base, kind: 'user_prompt', text: textOf(record.message?.content), denial: record.toolDenialKind ?? null });
        continue;
      }
      for (const block of record.message?.content ?? []) {
        if (block?.type !== 'tool_result') continue;
        const call = pendingTools.get(block.tool_use_id);
        pendingTools.delete(block.tool_use_id);
        const durationMs = toolDurationMs(block, record, call, base.timestampMs);
        if (durationMs !== null) stats.measuredToolDurationMs += durationMs;
        emit({
          ...base,
          kind: 'tool_result',
          id: block.tool_use_id,
          name: call?.name ?? null,
          input: call?.input ?? null,
          durationMs,
          isError: resultIsError(block, record),
          text: toolResultText(block, record),
          denial: record.toolDenialKind ?? null,
        });
      }
      continue;
    }
  }

  let tokens = 0;
  let cacheReadTokens = 0;
  for (const usage of usageByRequest.values()) {
    const split = usageTotal(usage);
    tokens += split.fresh;
    cacheReadTokens += split.cacheRead;
  }

  const summary = { ...stats, tokens, cacheReadTokens, actor, source };
  for (const detector of detectors) {
    if (typeof detector.onTranscriptEnd === 'function') detector.onTranscriptEnd(summary);
  }
  return summary;
}

module.exports = {
  isHumanPrompt,
  isMutating,
  MAX_TOOL_DURATION_MS,
  READ_ONLY_SHELL,
  READ_TOOLS,
  SHELL_TOOLS,
  streamTranscript,
  textOf,
  usageTotal,
  WRITE_TOOLS,
};
