"use strict";
function createStories(dependencies) {
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
    updateTicket
  } = dependencies;
  function newStoryId() {
    return "st_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
  }
  function listStories(slug) {
    const out = db.listRows(database(), "stories", { project: slug }).filter((s) => s && s.id);
    out.sort((a, b) => (a.order || 0) - (b.order || 0));
    return out;
  }
  function getStory(slug, idOrRef) {
    const wanted = String(idOrRef);
    const wantedRef = wanted.toUpperCase();
    for (const s of listStories(slug)) {
      if (s.id === wanted || String(s.ref).toUpperCase() === wantedRef) return s;
    }
    return null;
  }
  function coerceStoryId(slug, val) {
    if (val == null) return null;
    const s = String(val).trim();
    if (!s || s.toLowerCase() === "none" || s.toLowerCase() === "null") return null;
    const story = getStory(slug, s);
    return story ? story.id : null;
  }
  const STORY_EXECUTION_CONTRACT_MAX_BYTES = 256 * 1024;
  const STORY_EXECUTION_CONTRACT_PAGE_MAX_BYTES = 16 * 1024;
  const STORY_LOG_ENTRY_TEXT_MAX_BYTES = 16e3;
  const STORY_DECISION_LOG_BRIEFING_MAX_BYTES = 16 * 1024;
  const STORY_LOG_ENTRY_ADVISORY_BYTES = 4 * 1024;
  const STORY_LOG_KINDS = /* @__PURE__ */ new Set(["DECISION", "CONSTRAINT", "DISCOVERY"]);
  function normalizeStoryExecutionContract(value) {
    if (value == null) return null;
    const contract = String(value).trim();
    if (!contract) return null;
    const bytes = Buffer.byteLength(contract, "utf8");
    if (bytes > STORY_EXECUTION_CONTRACT_MAX_BYTES) {
      const overage = bytes - STORY_EXECUTION_CONTRACT_MAX_BYTES;
      throw new Error(`story execution contract is ${bytes} UTF-8 bytes, ${overage} over the ${STORY_EXECUTION_CONTRACT_MAX_BYTES}-byte capacity.`);
    }
    return contract;
  }
  function storyExecutionContract(story) {
    if (!story || !story.executionContract) return null;
    return {
      revision: Number(story.contractRevision) || 1,
      body: String(story.executionContract)
    };
  }
  function boundedUtf8Page(body, cursor, limit) {
    const source = String(body || "");
    const totalBytes = Buffer.byteLength(source, "utf8");
    const requestedCursor = Math.min(Math.max(0, Number(cursor) || 0), totalBytes);
    const requestedLimit = Math.min(
      STORY_EXECUTION_CONTRACT_PAGE_MAX_BYTES,
      Math.max(0, Number(limit) || STORY_EXECUTION_CONTRACT_PAGE_MAX_BYTES)
    );
    if (requestedLimit < 4) {
      throw new RangeError("story execution contract page limit must be at least 4 UTF-8 bytes.");
    }
    let byteOffset = 0;
    let startByte = totalBytes;
    let text = "";
    let pageBytes = 0;
    for (const character of source) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (byteOffset < requestedCursor) {
        byteOffset += characterBytes;
        continue;
      }
      if (startByte === totalBytes) startByte = byteOffset;
      if (pageBytes + characterBytes > requestedLimit) break;
      text += character;
      pageBytes += characterBytes;
      byteOffset += characterBytes;
    }
    const nextCursor = startByte === totalBytes || byteOffset >= totalBytes ? null : byteOffset;
    return { body: text, startByte, pageBytes, nextCursor, totalBytes };
  }
  function storyExecutionContractPage(story, options) {
    const contract = storyExecutionContract(story);
    const body = contract?.body || "";
    const cursor = options?.cursor ?? options?.startByte ?? 0;
    const rangeLimit = options?.endByte == null ? void 0 : Math.max(0, Number(options.endByte) - Number(cursor));
    const page = boundedUtf8Page(body, cursor, options?.limit ?? rangeLimit);
    return {
      revision: contract?.revision || 0,
      totalBytes: page.totalBytes,
      sha256: crypto.createHash("sha256").update(body, "utf8").digest("hex"),
      cursor: page.startByte,
      nextCursor: page.nextCursor,
      complete: page.nextCursor === null,
      pageBytes: page.pageBytes,
      body: page.body
    };
  }
  function normalizeStoryLogEntry(value) {
    const raw = value && typeof value === "object" ? value.text ?? value.entry ?? value.body : value;
    let text = String(raw == null ? "" : raw).replace(/\s*[\r\n]+\s*/g, " ").trim();
    const prefixed = text.match(/^(DECISION|CONSTRAINT|DISCOVERY)\s*:\s*/i);
    const explicitKind = value && typeof value === "object" && value.kind != null ? String(value.kind).trim().toUpperCase() : null;
    const kind = explicitKind || (prefixed?.[1]?.toUpperCase() ?? null);
    if (!kind || !STORY_LOG_KINDS.has(kind)) {
      throw new Error("story log entry must begin with DECISION:, CONSTRAINT:, or DISCOVERY:.");
    }
    if (prefixed && (!explicitKind || explicitKind === prefixed?.[1]?.toUpperCase())) {
      text = text.slice(prefixed[0].length).trim();
    }
    if (!text) throw new Error("story log entry text is required.");
    if (Buffer.byteLength(text, "utf8") > STORY_LOG_ENTRY_TEXT_MAX_BYTES) {
      throw new Error(`story log entry text exceeds the ${STORY_LOG_ENTRY_TEXT_MAX_BYTES}-byte limit.`);
    }
    return { kind, text };
  }
  function storyLogEntryAdvisory(value) {
    const { text } = normalizeStoryLogEntry(value);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= STORY_LOG_ENTRY_ADVISORY_BYTES) return null;
    return `entry stored in full (${(bytes / 1024).toFixed(1)} KB); briefings include only the newest entries within ${STORY_DECISION_LOG_BRIEFING_MAX_BYTES / 1024} KB.`;
  }
  function normalizeStoredStoryLogEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry && Number.isInteger(Number(entry.seq)) && STORY_LOG_KINDS.has(String(entry.kind))).map((entry) => ({
      seq: Number(entry.seq),
      at: String(entry.at),
      by: String(entry.by),
      ref: entry.ref == null ? null : String(entry.ref),
      kind: String(entry.kind),
      text: String(entry.text)
    }));
  }
  function storyDecisionLogEntries(story) {
    return normalizeStoredStoryLogEntries(story?.decisionLog);
  }
  function archivedStoryDecisionLogEntries(story) {
    return normalizeStoredStoryLogEntries(story?.archivedDecisionLog);
  }
  function renderStoryDecisionLog(story, entries) {
    const log = entries || storyDecisionLogEntries(story);
    if (!log.length) return "";
    const lastEntry = log[log.length - 1];
    const lastSeq = Number(story && story.logRevision) || lastEntry?.seq;
    const countLabel = `${log.length} ${log.length === 1 ? "entry" : "entries"}`;
    return [
      `## Story decision log (${story?.ref}, ${countLabel} through #${lastSeq})`,
      "Findings appended by sibling executors on this story. The contract above outranks these.",
      ...log.map((entry) => `- #${entry.seq} ${entry.kind} (${entry.ref || "orchestrator"}, ${entry.by}): ${entry.text}`)
    ].join("\n");
  }
  function recentStoryDecisionLogEntries(story, entries) {
    const selected = [];
    const source = entries || [];
    for (let index = source.length - 1; index >= 0; index--) {
      const candidate = [source[index], ...selected];
      if (Buffer.byteLength(renderStoryDecisionLog(story, candidate), "utf8") > STORY_DECISION_LOG_BRIEFING_MAX_BYTES) break;
      selected.unshift(source[index]);
    }
    return selected;
  }
  function storyDecisionLog(story, options) {
    const activeEntries = storyDecisionLogEntries(story);
    const archivedEntries = archivedStoryDecisionLogEntries(story);
    const full = options?.full === true;
    const entries = full ? [...archivedEntries, ...activeEntries].sort((left, right) => left.seq - right.seq) : recentStoryDecisionLogEntries(story, activeEntries);
    const totalEntries = archivedEntries.length + activeEntries.length;
    return {
      revision: Number(story && story.logRevision) || 0,
      entries,
      bytes: Buffer.byteLength(renderStoryDecisionLog(story, entries), "utf8"),
      capacity: STORY_DECISION_LOG_BRIEFING_MAX_BYTES,
      totalEntries,
      omittedEntries: totalEntries - entries.length,
      archivedEntries: archivedEntries.length
    };
  }
  function storyReadPayload(story, options) {
    if (!story) return story;
    const { archivedDecisionLog: _archivedDecisionLog, ...visibleStory } = story;
    const log = storyDecisionLog(story, options);
    return Object.assign(visibleStory, {
      decisionLog: log.entries,
      decisionLogOmittedEntries: log.omittedEntries,
      archivedDecisionLogEntries: log.archivedEntries
    });
  }
  function storyLogClaimRefusal(story, ticketRef, by) {
    return `story log: ${ticketRef} is not claimed by "${by}", or it is not a member of ${story.ref}. Append from a ticket you hold, or use story_contract.`;
  }
  function appendStoryLogEntry(slug, storyRef, value) {
    const normalized = normalizeStoryLogEntry(value);
    return transaction(() => {
      const story = getStory(slug, storyRef);
      if (!story) throw new Error(`story log: ${storyRef} was not found.`);
      const by = String(value && typeof value === "object" ? value.by || "orchestrator" : "orchestrator").trim() || "orchestrator";
      const requestedRef = value && typeof value === "object" && value.ref != null ? String(value.ref).trim() : "";
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
        at: (/* @__PURE__ */ new Date()).toISOString(),
        by,
        ref: ticketRef,
        kind: normalized.kind,
        text: normalized.text
      };
      story.decisionLog = [...entries, entry];
      story.logRevision = seq;
      story.updatedAt = entry.at;
      putStory(slug, story);
      return story;
    });
  }
  function rotateStoryLog(slug, storyRef) {
    return transaction(() => {
      const story = getStory(slug, storyRef);
      if (!story) return null;
      story.archivedDecisionLog = [...archivedStoryDecisionLogEntries(story), ...storyDecisionLogEntries(story)];
      story.decisionLog = [];
      story.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      putStory(slug, story);
      return story;
    });
  }
  function storyDecisionLogWarnings(ticket, slug) {
    if (!ticket || !ticket.storyId || !slug) return [];
    const dispatchBoundary = Number(ticket.dispatch?.storyLogRevision);
    const claimBoundary = ticket.claim ? Number(ticket.storyLogSeenSeq) : null;
    const seenSeq = Number.isInteger(dispatchBoundary) && dispatchBoundary >= 0 ? dispatchBoundary : claimBoundary;
    if (!Number.isInteger(seenSeq) || seenSeq < 0) return [];
    const boundary = Number.isInteger(dispatchBoundary) && dispatchBoundary >= 0 ? "prepared" : "claimed";
    const story = getStory(slug, ticket.storyId);
    if (!story) return [];
    const lastSeq = Number(story.logRevision) || 0;
    if (lastSeq <= seenSeq) return [];
    const gained = lastSeq - seenSeq;
    const firstSeq = seenSeq + 1;
    const range = firstSeq === lastSeq ? `#${firstSeq}` : `#${firstSeq}-#${lastSeq}`;
    const noun = gained === 1 ? "entry" : "entries";
    const pronoun = gained === 1 ? "it is" : "they are";
    return [`Dispatch warning: ${story.ref} decision log gained ${gained} ${noun} (${range}) since ${ticket.ref} was ${boundary}; ${pronoun} not in its briefing.`];
  }
  function markStoryContractDrift(slug, story, fromRevision, changedAt) {
    const toRevision = Number(story && story.contractRevision) || 0;
    for (const ticket of listTickets(slug)) {
      if (ticket.storyId !== story.id || !ticket.claim || !ticket.claim.by || claimReclaimable(ticket)) continue;
      ticket.storyContractDrift = {
        storyRef: story.ref,
        fromRevision: Number(fromRevision) || 0,
        toRevision,
        changedAt
      };
      ticket.lastEventType = "story-contract";
      ticket.lastEventSource = "story";
      ticket.updatedAt = changedAt;
      putTicket(slug, ticket);
    }
  }
  function createStory(slug, fields) {
    return transaction(() => {
      fields = fields || {};
      const id = newStoryId();
      const seq = nextStorySeq(slug);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const executionContract = normalizeStoryExecutionContract(fields.executionContract);
      const story = {
        id,
        ref: `US-${seq}`,
        title: String(fields.title || "Untitled story").trim().slice(0, 200) || "Untitled story",
        description: String(fields.description || "").trim(),
        color: parseStoryColor(fields.color) || autoStoryColor(seq - 1),
        executionContract,
        contractRevision: executionContract ? 1 : 0,
        decisionLog: [],
        archivedDecisionLog: [],
        logRevision: 0,
        createdAt: now,
        updatedAt: now,
        order: Date.now()
      };
      putStory(slug, story);
      return story;
    });
  }
  function updateStory(slug, idOrRef, patch) {
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
      const nextContract = patch.executionContract === void 0 ? s.executionContract || null : normalizeStoryExecutionContract(patch.executionContract);
      const contractChanged = nextContract !== (s.executionContract || null);
      if (contractChanged) {
        s.executionContract = nextContract;
        s.contractRevision = previousRevision + 1;
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      s.updatedAt = now;
      putStory(slug, s);
      if (contractChanged) markStoryContractDrift(slug, s, previousRevision, now);
      return s;
    });
  }
  function deleteStory(slug, idOrRef) {
    const s = getStory(slug, idOrRef);
    if (!s) return false;
    if (!deleteCachedRow(database(), "stories", s.id)) return false;
    try {
      for (const t of listTickets(slug)) {
        if (t.storyId === s.id) updateTicket(slug, t.id, { storyId: null, source: "cli" });
      }
    } catch (_) {
    }
    return true;
  }
  return {
    STORY_DECISION_LOG_BRIEFING_MAX_BYTES,
    STORY_EXECUTION_CONTRACT_MAX_BYTES,
    STORY_EXECUTION_CONTRACT_PAGE_MAX_BYTES,
    STORY_LOG_ENTRY_ADVISORY_BYTES,
    STORY_LOG_ENTRY_TEXT_MAX_BYTES,
    appendStoryLogEntry,
    coerceStoryId,
    createStory,
    deleteStory,
    getStory,
    listStories,
    normalizeStoryLogEntry,
    rotateStoryLog,
    storyLogEntryAdvisory,
    storyDecisionLog,
    storyDecisionLogWarnings,
    storyExecutionContract,
    storyExecutionContractPage,
    storyReadPayload,
    updateStory
  };
}
module.exports = { createStories };
