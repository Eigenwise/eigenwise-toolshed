'use strict';

const {
  flushObservations,
  normalizeAssistantUsage,
  normalizeTerminalResult,
} = require('./sdk.js');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueFrom(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

function messageIdentity(message) {
  if (!isPlainObject(message)) return null;
  const uuid = valueFrom(message.uuid);
  const requestId = valueFrom(message.request_id);
  const parentToolUseId = valueFrom(message.parent_tool_use_id);
  const sessionId = valueFrom(message.session_id);
  if (!uuid && !requestId && !parentToolUseId && !sessionId) return null;
  return {
    type: valueFrom(message.type),
    uuid,
    requestId,
    parentToolUseId,
    sessionId,
  };
}

function mergeTraceEnvironment(options = {}, propagation = {}) {
  const source = isPlainObject(options) ? options : {};
  const traceparent = valueFrom(propagation.traceparent);
  const tracestate = valueFrom(propagation.tracestate);
  if (!traceparent && !tracestate) return { ...source };

  const callerEnvironment = isPlainObject(source.env) ? source.env : {};
  const env = { ...process.env, ...callerEnvironment };
  if (traceparent) env.TRACEPARENT = traceparent;
  if (tracestate) env.TRACESTATE = tracestate;
  return { ...source, env };
}

class AgentSdkQueryFailure extends Error {
  constructor(cause) {
    super('The Claude Agent SDK query iterator failed before yielding a result.', { cause });
    this.name = 'AgentSdkQueryFailure';
    this.code = 'agent_sdk_iterator_failed';
  }
}

function observeQuery({
  query,
  prompt,
  options,
  context = {},
  traceparent,
  tracestate,
  flushOptions,
  onIdentity,
  onObservations,
} = {}) {
  if (typeof query !== 'function') throw new TypeError('A Claude Agent SDK query function is required.');

  const propagation = {
    traceparent: valueFrom(traceparent, context.traceparent),
    tracestate: valueFrom(tracestate, context.tracestate),
  };
  const queryOptions = mergeTraceEnvironment(options, propagation);

  return (async function* observedMessages() {
    const state = {
      sessionId: valueFrom(context.sessionId),
      parentToolUseId: valueFrom(context.parentToolUseId, context.parent_tool_use_id),
      terminalSeen: false,
      assistantMessageIds: new Set(),
    };
    let stream;
    try {
      stream = query({ prompt, options: queryOptions });
      for await (const message of stream) {
        const identity = messageIdentity(message);
        if (identity) {
          state.sessionId ||= identity.sessionId;
          state.parentToolUseId ||= identity.parentToolUseId;
          if (typeof onIdentity === 'function') {
            try {
              await onIdentity(identity);
            } catch {}
          }
        }

        let observations = [];
        if (isPlainObject(message) && message.type === 'assistant') {
          const providerMessageId = isPlainObject(message.message) ? valueFrom(message.message.id) : null;
          if (providerMessageId && !state.assistantMessageIds.has(providerMessageId)) {
            state.assistantMessageIds.add(providerMessageId);
            const observation = normalizeAssistantUsage(message, {
              ...context,
              sessionId: state.sessionId,
              parentToolUseId: identity && identity.parentToolUseId,
            });
            if (observation) observations = [observation];
          }
        } else if (isPlainObject(message) && message.type === 'result' && !state.terminalSeen) {
          state.terminalSeen = true;
          observations = normalizeTerminalResult(message, {
            ...context,
            sessionId: state.sessionId,
            parentToolUseId: state.parentToolUseId,
          });
        }

        if (observations.length > 0) {
          if (typeof onObservations === 'function') {
            try {
              await onObservations(observations);
            } catch {}
          }
          await flushObservations(observations, flushOptions);
        }
        yield message;
      }
    } catch (error) {
      if (state.terminalSeen) return;
      throw new AgentSdkQueryFailure(error);
    }
  })();
}

module.exports = {
  AgentSdkQueryFailure,
  mergeTraceEnvironment,
  observeQuery,
};
