'use strict';

function createStories(dependencies: any) {
  const {
    autoStoryColor,
    claimReclaimable,
    crypto,
    database,
    deleteCachedRow,
    db,
    getTicket,
    listTickets,
    nextStorySeq,
    parseStoryColor,
    putStory,
    putTicket,
    transaction,
    updateTicket,
  } = dependencies;

function newStoryId() {
  return 'st_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

// Every story in a project, oldest-first (US-1 before US-2) so a legend/filter
// reads in creation order. Fail-soft to [] when the folder doesn't exist yet.
function listStories(slug?: any) {
  const out = db.listRows(database(), 'stories', { project: slug }).filter((s?: any) => s && s.id);
  out.sort((a?: any, b?: any) => (a.order || 0) - (b.order || 0));
  return out;
}

// Look up a story by its stable id or its human ref (US-4, case-insensitive).
function getStory(slug?: any, idOrRef?: any) {
  const wanted = String(idOrRef);
  const wantedRef = wanted.toUpperCase();
  for (const s of listStories(slug)) {
    if (s.id === wanted || String(s.ref).toUpperCase() === wantedRef) return s;
  }
  return null;
}

// Resolve a caller-supplied story reference (a US-ref, a raw id, "none"/"null",
// or null) to a valid story id in this project, or null if it clears / doesn't
// resolve. This is the single guard both createTicket and updateTicket run
// storyId through, so a ticket can never point at a story that isn't there.
function coerceStoryId(slug?: any, val?: any) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') return null;
  const story = getStory(slug, s);
  return story ? story.id : null;
}

const STORY_EXECUTION_CONTRACT_MAX_BYTES = 4 * 1024;
const STORY_DECISION_LOG_BRIEFING_MAX_BYTES = 4 * 1024;
const STORY_LOG_ENTRY_TEXT_MAX_BYTES = 280;
const STORY_LOG_KINDS = new Set(['DECISION', 'CONSTRAINT', 'DISCOVERY']);

function normalizeStoryExecutionContract(value?: any) {
  if (value == null) return null;
  const contract = String(value).trim();
  if (!contract) return null;
  const bytes = Buffer.byteLength(contract, 'utf8');
  if (bytes > STORY_EXECUTION_CONTRACT_MAX_BYTES) {
    throw new Error(`story execution contract exceeds the ${STORY_EXECUTION_CONTRACT_MAX_BYTES}-byte limit.`);
  }
  return contract;
}

function storyExecutionContract(story?: any) {
  if (!story || !story.executionContract) return null;
  return {
    revision: Number(story.contractRevision) || 1,
    body: String(story.executionContract),
  };
}

function normalizeStoryLogEntry(value?: any) {
  const raw = value && typeof value === 'object'
    ? value.text ?? value.entry ?? value.body
    : value;
  let text = String(raw == null ? '' : raw).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const prefixed = text.match(/^(DECISION|CONSTRAINT|DISCOVERY)\s*:\s*/i);
  const explicitKind = value && typeof value === 'object' && value.kind != null
    ? String(value.kind).trim().toUpperCase()
    : null;
  const kind = explicitKind || (prefixed?.[1]?.toUpperCase() ?? null);
  if (!kind || !STORY_LOG_KINDS.has(kind)) {
    throw new Error('story log entry kind must be DECISION, CONSTRAINT, or DISCOVERY.');
  }
  if (prefixed && (!explicitKind || explicitKind === prefixed?.[1]?.toUpperCase())) {
    text = text.slice(prefixed[0].length).trim();
  }
  if (!text) throw new Error('story log entry text is required.');
  if (Buffer.byteLength(text, 'utf8') > STORY_LOG_ENTRY_TEXT_MAX_BYTES) {
    throw new Error(`story log entry text exceeds the ${STORY_LOG_ENTRY_TEXT_MAX_BYTES}-byte limit.`);
  }
  return { kind, text };
}

function normalizeStoredStoryLogEntries(entries?: any) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry?: any) => entry && Number.isInteger(Number(entry.seq)) && STORY_LOG_KINDS.has(String(entry.kind)))
    .map((entry?: any) => ({
      seq: Number(entry.seq),
      at: String(entry.at),
      by: String(entry.by),
      ref: entry.ref == null ? null : String(entry.ref),
      kind: String(entry.kind),
      text: String(entry.text),
    }));
}

function storyDecisionLogEntries(story?: any) {
  return normalizeStoredStoryLogEntries(story?.decisionLog);
}

function archivedStoryDecisionLogEntries(story?: any) {
  return normalizeStoredStoryLogEntries(story?.archivedDecisionLog);
}

function renderStoryDecisionLog(story?: any, entries?: any) {
  const log = entries || storyDecisionLogEntries(story);
  if (!log.length) return '';
  const lastEntry = log[log.length - 1];
  const lastSeq = Number(story && story.logRevision) || lastEntry?.seq;
  const countLabel = `${log.length} ${log.length === 1 ? 'entry' : 'entries'}`;
  return [
    `## Story decision log (${story?.ref}, ${countLabel} through #${lastSeq})`,
    'Findings appended by sibling executors on this story. The contract above outranks these.',
    ...log.map((entry?: any) => `- #${entry.seq} ${entry.kind} (${entry.ref || 'orchestrator'}, ${entry.by}): ${entry.text}`),
  ].join('\n');
}

function recentStoryDecisionLogEntries(story?: any, entries?: any) {
  const selected: any[] = [];
  const source = entries || [];
  for (let index = source.length - 1; index >= 0; index--) {
    const candidate = [source[index], ...selected];
    if (Buffer.byteLength(renderStoryDecisionLog(story, candidate), 'utf8') > STORY_DECISION_LOG_BRIEFING_MAX_BYTES) break;
    selected.unshift(source[index]);
  }
  return selected;
}

function storyDecisionLog(story?: any, options?: any) {
  const activeEntries = storyDecisionLogEntries(story);
  const archivedEntries = archivedStoryDecisionLogEntries(story);
  const full = options?.full === true;
  const entries = full
    ? [...archivedEntries, ...activeEntries].sort((left, right) => left.seq - right.seq)
    : recentStoryDecisionLogEntries(story, activeEntries);
  const totalEntries = archivedEntries.length + activeEntries.length;
  return {
    revision: Number(story && story.logRevision) || 0,
    entries,
    bytes: Buffer.byteLength(renderStoryDecisionLog(story, entries), 'utf8'),
    capacity: STORY_DECISION_LOG_BRIEFING_MAX_BYTES,
    totalEntries,
    omittedEntries: totalEntries - entries.length,
    archivedEntries: archivedEntries.length,
  };
}

function storyReadPayload(story?: any, options?: any) {
  if (!story) return story;
  const { archivedDecisionLog: _archivedDecisionLog, ...visibleStory } = story;
  const log = storyDecisionLog(story, options);
  return Object.assign(visibleStory, {
    decisionLog: log.entries,
    decisionLogOmittedEntries: log.omittedEntries,
    archivedDecisionLogEntries: log.archivedEntries,
  });
}

function storyLogClaimRefusal(story?: any, ticketRef?: any, by?: any) {
  return `story log: ${ticketRef} is not claimed by "${by}", or it is not a member of ${story.ref}. Append from a ticket you hold, or use story_contract.`;
}

function appendStoryLogEntry(slug?: any, storyRef?: any, value?: any) {
  const normalized = normalizeStoryLogEntry(value);
  return transaction(() => {
    const story = getStory(slug, storyRef);
    if (!story) throw new Error(`story log: ${storyRef} was not found.`);
    const by = String(value && typeof value === 'object' ? value.by || 'orchestrator' : 'orchestrator').trim() || 'orchestrator';
    const requestedRef = value && typeof value === 'object' && value.ref != null
      ? String(value.ref).trim()
      : '';
    let ticketRef = null;
    if (requestedRef) {
      const ticket = getTicket(slug, requestedRef);
      ticketRef = ticket ? ticket.ref : requestedRef;
      if (!ticket || ticket.storyId !== story.id || !ticket.claim || ticket.claim.by !== by || claimReclaimable(ticket)) {
        throw new Error(storyLogClaimRefusal(story, ticketRef, by));
      }
    }
    const entries = storyDecisionLogEntries(story);
    const seq = (Number(story.logRevision) || 0) + 1;
    const entry = {
      seq,
      at: new Date().toISOString(),
      by,
      ref: ticketRef,
      kind: normalized.kind,
      text: normalized.text,
    };
    story.decisionLog = [...entries, entry];
    story.logRevision = seq;
    story.updatedAt = entry.at;
    putStory(slug, story);
    return story;
  });
}

function clearStoryLog(slug?: any, storyRef?: any) {
  return transaction(() => {
    const story = getStory(slug, storyRef);
    if (!story) return null;
    story.archivedDecisionLog = [...archivedStoryDecisionLogEntries(story), ...storyDecisionLogEntries(story)];
    story.decisionLog = [];
    story.updatedAt = new Date().toISOString();
    putStory(slug, story);
    return story;
  });
}

function storyDecisionLogWarnings(ticket?: any, slug?: any) {
  if (!ticket || !ticket.storyId || !slug) return [];
  const story = getStory(slug, ticket.storyId);
  if (!story) return [];
  const seenSeq = Number(ticket.storyLogSeenSeq) || 0;
  const lastSeq = Number(story.logRevision) || 0;
  if (lastSeq <= seenSeq) return [];
  const gained = lastSeq - seenSeq;
  const firstSeq = seenSeq + 1;
  const range = firstSeq === lastSeq ? `#${firstSeq}` : `#${firstSeq}-#${lastSeq}`;
  const noun = gained === 1 ? 'entry' : 'entries';
  const pronoun = gained === 1 ? 'it is' : 'they are';
  return [`Dispatch warning: ${story.ref} decision log gained ${gained} ${noun} (${range}) since ${ticket.ref} was claimed; ${pronoun} not in its briefing.`];
}

function markStoryContractDrift(slug?: any, story?: any, fromRevision?: any, changedAt?: any) {
  const toRevision = Number(story && story.contractRevision) || 0;
  for (const ticket of listTickets(slug)) {
    if (ticket.storyId !== story.id || !ticket.claim || !ticket.claim.by || claimReclaimable(ticket)) continue;
    ticket.storyContractDrift = {
      storyRef: story.ref,
      fromRevision: Number(fromRevision) || 0,
      toRevision,
      changedAt,
    };
    ticket.lastEventType = 'story-contract';
    ticket.lastEventSource = 'story';
    ticket.updatedAt = changedAt;
    putTicket(slug, ticket);
  }
}

function createStory(slug?: any, fields?: any) {
  return transaction(() => {
    fields = fields || {};
    const id = newStoryId();
    const seq = nextStorySeq(slug);
    const now = new Date().toISOString();
    const executionContract = normalizeStoryExecutionContract(fields.executionContract);
    const story = {
      id,
      ref: `US-${seq}`,
      title: String(fields.title || 'Untitled story').trim().slice(0, 200) || 'Untitled story',
      description: String(fields.description || '').trim(),
      color: parseStoryColor(fields.color) || autoStoryColor(seq - 1),
      executionContract,
      contractRevision: executionContract ? 1 : 0,
      decisionLog: [],
      archivedDecisionLog: [],
      logRevision: 0,
      createdAt: now,
      updatedAt: now,
      order: Date.now(),
    };
    putStory(slug, story);
    return story;
  });
}

function updateStory(slug?: any, idOrRef?: any, patch?: any) {
  return transaction(() => {
    const s = getStory(slug, idOrRef);
    if (!s) return null;
    patch = patch || {};
    if (patch.title != null) s.title = String(patch.title).trim().slice(0, 200) || s.title;
    if (patch.description != null) s.description = String(patch.description).trim();
    if (patch.color != null) {
      const c = parseStoryColor(patch.color);
      if (c) s.color = c;
    }
    if (patch.order != null && Number.isFinite(Number(patch.order))) s.order = Number(patch.order);
    const previousRevision = Number(s.contractRevision) || 0;
    const nextContract = patch.executionContract === undefined ? s.executionContract || null : normalizeStoryExecutionContract(patch.executionContract);
    const contractChanged = nextContract !== (s.executionContract || null);
    if (contractChanged) {
      s.executionContract = nextContract;
      s.contractRevision = previousRevision + 1;
    }
    const now = new Date().toISOString();
    s.updatedAt = now;
    putStory(slug, s);
    if (contractChanged) markStoryContractDrift(slug, s, previousRevision, now);
    return s;
  });
}

// Delete a story and detach it from its member tickets (clearing storyId, the
// same way deleteTicket strips dangling links) so no card is left tinted by a
// story that no longer exists.
function deleteStory(slug?: any, idOrRef?: any) {
  const s = getStory(slug, idOrRef);
  if (!s) return false;
  if (!deleteCachedRow(database(), 'stories', s.id)) return false;
  try {
    for (const t of listTickets(slug)) {
      if (t.storyId === s.id) updateTicket(slug, t.id, { storyId: null, source: 'cli' });
    }
  } catch (_: any) {
    /* best effort — the story file is already gone */
  }
  return true;
}

  return {
    STORY_DECISION_LOG_BRIEFING_MAX_BYTES,
    STORY_EXECUTION_CONTRACT_MAX_BYTES,
    STORY_LOG_ENTRY_TEXT_MAX_BYTES,
    appendStoryLogEntry,
    clearStoryLog,
    coerceStoryId,
    createStory,
    deleteStory,
    getStory,
    listStories,
    normalizeStoryLogEntry,
    storyDecisionLog,
    storyDecisionLogWarnings,
    storyExecutionContract,
    storyReadPayload,
    updateStory,
  };
}

module.exports = { createStories };
