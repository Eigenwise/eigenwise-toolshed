'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
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

function resultIsError(block, record) {
  if (block?.is_error === true) return true;
  const result = record?.toolUseResult;
  if (result && typeof result === 'object' && result.interrupted === true) return true;
  return false;
}

function mcpServerOf(toolName) {
  const match = /^mcp__(.+?)__[^_]/.exec(String(toolName ?? ''));
  if (!match) return null;
  const server = match[1];
  // Plugin-shipped servers are attributed as "plugin:<plugin>:<server>" elsewhere; the tool-name
  // prefix encodes the same id with underscores. Normalize so counts do not split across formats.
  const pluginForm = /^plugin_([^_]+(?:-[^_]+)*)_(.+)$/.exec(server);
  return pluginForm ? `plugin:${pluginForm[1]}:${pluginForm[2]}` : server;
}

/**
 * Streams one transcript and pushes normalized events at the collector, never holding the file in
 * memory. Events carry only what the signal collector needs: friction markers, attribution, and
 * enough of each tool call to recognize a habit.
 */
async function streamTranscript(source, collector) {
  const pendingTools = new Map();
  const stats = { records: 0, unparseable: 0, firstMs: null, lastMs: null };

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
      scope: source.scope,
      sessionId: source.sessionId,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    };

    if (record.isAbortedMidStream === true || record.interruptedMessageId) {
      collector.onEvent({ ...base, kind: 'interrupt' });
    }

    // A session's own title is the cheapest statement of what it was about: one line, already
    // written, present in about nine sessions out of ten. Everything else about purpose has to be
    // inferred, so this is the anchor.
    if (record.type === 'ai-title') {
      collector.onEvent({ ...base, kind: 'session_title', title: record.aiTitle ?? null });
      continue;
    }

    // An explicit /goal is rare (a couple of percent of sessions) but it is the user stating a
    // standard in their own words, which is worth more than any inference when it is there.
    if (record.type === 'queue-operation') {
      const content = String(record.content ?? '');
      if (content.startsWith('Goal set:')) {
        collector.onEvent({ ...base, kind: 'goal', condition: content.slice('Goal set:'.length), met: null });
      }
      continue;
    }

    if (record.type === 'attachment') {
      const attachment = record.attachment ?? {};
      if (attachment.hookEvent) {
        const hookName = attachment.hookName ?? attachment.hookEvent;
        if (attachment.timedOut === true) {
          collector.onEvent({ ...base, kind: 'hook_timeout', hookName });
        } else if (Number.isFinite(attachment.exitCode) && attachment.exitCode !== 0) {
          collector.onEvent({ ...base, kind: 'hook_error', hookName });
        }
      }
      if (attachment.type === 'goal_status') {
        collector.onEvent({ ...base, kind: 'goal', condition: attachment.condition ?? null, met: attachment.met === true });
      }
      continue;
    }

    if (record.type === 'assistant') {
      if (record.error || record.isApiErrorMessage) collector.onEvent({ ...base, kind: 'api_error' });
      for (const block of record.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue;
        pendingTools.set(block.id, { name: block.name, input: block.input });
        collector.onEvent({
          ...base,
          kind: 'tool_use',
          name: block.name,
          input: block.input ?? {},
          attributionSkill: record.attributionSkill ?? null,
          attributionPlugin: record.attributionPlugin ?? null,
          attributionMcpServer: record.attributionMcpServer ?? mcpServerOf(block.name),
        });
      }
      continue;
    }

    if (record.type === 'user') {
      if (isHumanPrompt(record, source.scope)) {
        collector.onEvent({ ...base, kind: 'user_prompt', text: textOf(record.message?.content) });
        continue;
      }
      for (const block of record.message?.content ?? []) {
        if (block?.type !== 'tool_result') continue;
        const call = pendingTools.get(block.tool_use_id);
        pendingTools.delete(block.tool_use_id);
        collector.onEvent({
          ...base,
          kind: 'tool_result',
          name: call?.name ?? null,
          input: call?.input ?? null,
          isError: resultIsError(block, record),
          denial: record.toolDenialKind ?? null,
        });
      }
    }
  }

  collector.onTranscriptEnd({ ...stats, source });
  return stats;
}

module.exports = { isHumanPrompt, mcpServerOf, streamTranscript, textOf };
