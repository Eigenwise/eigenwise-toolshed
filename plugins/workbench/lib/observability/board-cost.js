'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarningWithoutSqliteExperimentalWarning(warning, ...args) {
  if (warning === 'SQLite is an experimental feature and might change at any time' && args[0] === 'ExperimentalWarning') return;
  return originalEmitWarning.call(this, warning, ...args);
};
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} finally {
  process.emitWarning = originalEmitWarning;
}

function defaultSidequestHome(env = process.env, homedir = os.homedir()) {
  const configured = env && typeof env.SIDEQUEST_HOME === 'string' ? env.SIDEQUEST_HOME.trim() : '';
  return path.resolve(configured || path.join(homedir, '.claude', 'sidequest'));
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || '.'));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectMatches(registeredPath, requestedPath) {
  const registered = normalizedPath(registeredPath);
  const requested = normalizedPath(requestedPath);
  return registered === requested || requested.startsWith(`${registered}${path.sep}.claude${path.sep}worktrees${path.sep}`);
}

function parsedRows(database, statement, ...parameters) {
  return database.prepare(statement).all(...parameters).flatMap((row) => {
    try {
      return [{ ...row, data: JSON.parse(row.data) }];
    } catch (_) {
      return [];
    }
  });
}

function resolvedCategories(database, projectSlug) {
  const categories = new Map(parsedRows(database, 'SELECT id, data FROM categories ORDER BY id')
    .map((row) => [String(row.id).toLowerCase(), row.data]));
  const overrides = parsedRows(
    database,
    'SELECT id, kind, data FROM project_categories WHERE project = ? ORDER BY id',
    projectSlug,
  );
  for (const row of overrides) {
    const id = String(row.id).toLowerCase();
    const base = categories.get(id);
    if (row.kind === 'ADD' && !base) categories.set(id, row.data);
    else if (row.kind === 'DETACH') categories.set(id, row.data);
    else if (row.kind === 'OVERRIDE' && base) categories.set(id, { ...base, ...row.data, id });
    else if (row.kind === 'DISABLE' && id !== 'general') categories.delete(id);
  }
  return [...categories.entries()].map(([id, category]) => ({
    id,
    route: category && category.route && typeof category.route === 'object'
      ? { model: category.route.model || null, effort: category.route.effort || null }
      : { model: null, effort: null },
  }));
}

function unavailableBoard(sidequestHome, projectPath, reason) {
  return {
    available: false,
    reason,
    sidequest_home: sidequestHome,
    database_file: path.join(sidequestHome, 'sidequest.db'),
    project_path: projectPath ? path.resolve(projectPath) : null,
    project_slug: null,
    tickets: [],
    categories: [],
  };
}

function readSidequestBoard(options = {}) {
  const sidequestHome = path.resolve(options.sidequestHome || defaultSidequestHome());
  const projectPath = options.projectPath ? path.resolve(options.projectPath) : null;
  const databaseFile = path.join(sidequestHome, 'sidequest.db');
  if (!fs.existsSync(databaseFile)) return unavailableBoard(sidequestHome, projectPath, 'database_not_found');

  let database;
  try {
    database = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
    const projects = parsedRows(database, 'SELECT slug, data FROM projects ORDER BY slug');
    const matches = projectPath
      ? projects.filter((row) => row.data && row.data.path && projectMatches(row.data.path, projectPath))
      : projects;
    if (matches.length !== 1) {
      return unavailableBoard(sidequestHome, projectPath, matches.length ? 'project_ambiguous' : 'project_not_found');
    }
    const project = matches[0];
    const tickets = parsedRows(database, 'SELECT data FROM tickets WHERE project = ? ORDER BY ord', project.slug)
      .map((row) => row.data);
    return {
      available: true,
      reason: null,
      sidequest_home: sidequestHome,
      database_file: databaseFile,
      project_path: project.data.path || projectPath,
      project_slug: project.slug,
      tickets,
      categories: resolvedCategories(database, project.slug),
    };
  } catch (error) {
    return unavailableBoard(sidequestHome, projectPath, `read_failed:${error.code || error.name || 'error'}`);
  } finally {
    if (database) database.close();
  }
}

function metric(value, quality = 'derived') {
  return { value: value ?? null, quality: value === null || value === undefined ? 'unavailable' : quality };
}

function attemptFingerprint(attempt) {
  return JSON.stringify([
    attempt.agent_id || null,
    attempt.prepared_at || null,
    attempt.model || null,
    attempt.outcome || null,
  ]);
}

function dispatchAttempt(dispatch, rework = null) {
  if (!dispatch || typeof dispatch !== 'object') return null;
  const route = dispatch.route && typeof dispatch.route === 'object' ? dispatch.route : {};
  return {
    agent_id: dispatch.agentId || null,
    agent_name: dispatch.agentName || null,
    model: route.model || null,
    effort: route.effort || null,
    prepared_at: dispatch.preparedAt || null,
    launched_at: dispatch.launchedAt || null,
    claimed_at: dispatch.claimedAt || null,
    terminal_at: dispatch.terminalAt || null,
    outcome: dispatch.outcome || null,
    rework_kind: rework && rework.kind ? rework.kind : null,
    rework_at: rework && rework.at ? rework.at : null,
  };
}

function ticketAttempts(ticket) {
  const attempts = [];
  const seen = new Set();
  const add = (attempt) => {
    if (!attempt) return;
    const fingerprint = attemptFingerprint(attempt);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    attempts.push(attempt);
  };

  for (const event of Array.isArray(ticket.reworkEvents) ? ticket.reworkEvents : []) {
    add(dispatchAttempt(event && event.attempt, event));
  }
  const dispatch = ticket.dispatch && typeof ticket.dispatch === 'object' ? ticket.dispatch : null;
  for (const retry of dispatch && Array.isArray(dispatch.attempts) ? dispatch.attempts : []) {
    add(dispatchAttempt(retry, { kind: 'dispatch_retry', at: retry.terminalAt || null }));
  }
  add(dispatchAttempt(dispatch));
  attempts.sort((left, right) => String(left.prepared_at || left.rework_at || '')
    .localeCompare(String(right.prepared_at || right.rework_at || '')));
  return attempts.map((attempt, index) => ({ ...attempt, attempt: index + 1 }));
}

function emptyUsage() {
  return {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    context_tokens: 0,
    cost_usd: 0,
    complete: {
      input_tokens: true,
      output_tokens: true,
      cache_read_tokens: true,
      cache_creation_tokens: true,
      context_tokens: true,
      cost_usd: true,
    },
  };
}

function addUsage(usage, row) {
  usage.request_count += 1;
  for (const field of [
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'context_tokens', 'cost_usd',
  ]) {
    if (row[field] === null || row[field] === undefined || !Number.isFinite(Number(row[field]))) {
      usage.complete[field] = false;
    } else {
      usage[field] += Number(row[field]);
    }
  }
}

function aggregateRows(rows) {
  const usage = emptyUsage();
  for (const row of rows) addUsage(usage, row);
  return usage;
}

function finalizeUsage(usage) {
  const completeValue = (field) => usage.complete[field] ? usage[field] : null;
  const context = completeValue('context_tokens');
  const output = completeValue('output_tokens');
  return {
    request_count: metric(usage.request_count),
    tokens: {
      input: metric(completeValue('input_tokens')),
      output: metric(output),
      cache_read: metric(completeValue('cache_read_tokens')),
      cache_creation: metric(completeValue('cache_creation_tokens')),
      context: metric(context),
      total: metric(context === null || output === null ? null : context + output),
    },
    estimated_cost_usd: metric(completeValue('cost_usd'), 'estimated'),
  };
}

function unavailableUsage() {
  return {
    request_count: metric(null),
    tokens: {
      input: metric(null),
      output: metric(null),
      cache_read: metric(null),
      cache_creation: metric(null),
      context: metric(null),
      total: metric(null),
    },
    estimated_cost_usd: metric(null),
  };
}

function ticketCategory(ticket) {
  if (!ticket || ticket.category == null) return null;
  if (typeof ticket.category === 'object') return ticket.categoryId || ticket.category.id || null;
  return String(ticket.category).toLowerCase();
}

function gatewayRows(store) {
  return store.queryView('request_usage_resolved')
    .filter((row) => row.evidence_event === 'gateway.token.usage');
}

function buildBoardCostReport(store, board) {
  if (!board || !board.available) {
    return {
      available: false,
      reason: board && board.reason ? board.reason : 'board_not_loaded',
      source: board ? {
        sidequest_home: board.sidequest_home,
        database_file: board.database_file,
        project_path: board.project_path,
      } : null,
      tickets: [],
      categories: [],
      execution_split: [],
      rework: [],
      route_drift: { tickets: [], rollups: [] },
    };
  }

  const usageRows = gatewayRows(store);
  const rowsByAgent = new Map();
  for (const row of usageRows) {
    const key = row.agent_id || null;
    if (!rowsByAgent.has(key)) rowsByAgent.set(key, []);
    rowsByAgent.get(key).push(row);
  }

  const categories = new Map(board.categories.map((category) => [category.id, category]));
  const tickets = board.tickets.map((ticket) => ({
    ticket,
    ref: ticket.ref || null,
    category: ticketCategory(ticket),
    attempts: ticketAttempts(ticket),
  })).filter((entry) => entry.ref);
  const ownersByAgent = new Map();
  for (const entry of tickets) {
    for (const attempt of entry.attempts) {
      if (!attempt.agent_id) continue;
      if (!ownersByAgent.has(attempt.agent_id)) ownersByAgent.set(attempt.agent_id, new Set());
      ownersByAgent.get(attempt.agent_id).add(entry.ref);
    }
  }
  const ambiguousAgentIds = new Set([...ownersByAgent.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([agentId]) => agentId));
  const attributableRows = (entry) => entry.attempts
    .filter((attempt) => attempt.agent_id && !ambiguousAgentIds.has(attempt.agent_id))
    .flatMap((attempt) => rowsByAgent.get(attempt.agent_id) || []);

  const ticketRows = tickets.map((entry) => {
    const rows = attributableRows(entry);
    const attributedAgentIds = new Set(rows.map((row) => row.agent_id).filter(Boolean));
    const agentlessAttempts = entry.attempts.filter((attempt) => !attempt.agent_id).length;
    const ambiguousAttempts = entry.attempts.filter((attempt) => ambiguousAgentIds.has(attempt.agent_id)).length;
    const attempts = entry.attempts.map((attempt) => {
      const attributable = attempt.agent_id && !ambiguousAgentIds.has(attempt.agent_id);
      return {
        ...attempt,
        attribution: !attempt.agent_id
          ? 'agent-id-unavailable'
          : ambiguousAgentIds.has(attempt.agent_id) ? 'ambiguous-shared-agent' : 'exact-agent-id',
        usage: attributable
          ? finalizeUsage(aggregateRows(rowsByAgent.get(attempt.agent_id) || []))
          : unavailableUsage(),
      };
    });
    const completeAttribution = entry.attempts.length > 0
      && agentlessAttempts === 0 && ambiguousAttempts === 0;
    return {
      ticket_ref: entry.ref,
      category: entry.category,
      status: entry.ticket.status || null,
      attempt_count: metric(entry.attempts.length),
      bounce_count: metric((Array.isArray(entry.ticket.reworkEvents) ? entry.ticket.reworkEvents : []).length),
      attribution: completeAttribution ? 'exact-agent-id' : rows.length ? 'partial-agent-id' : 'unavailable',
      unattributed_attempt_count: agentlessAttempts,
      ambiguous_attempt_count: ambiguousAttempts,
      attributed_agent_count: attributedAgentIds.size,
      usage: rows.length || completeAttribution ? finalizeUsage(aggregateRows(rows)) : unavailableUsage(),
      attempts,
      _rows: rows,
      _ticket: entry.ticket,
    };
  });

  const categoryRows = [];
  const categoryGroups = new Map();
  for (const ticket of ticketRows.filter((entry) => entry.attempt_count.value > 0)) {
    const key = ticket.category || 'uncategorized';
    if (!categoryGroups.has(key)) categoryGroups.set(key, []);
    categoryGroups.get(key).push(ticket);
  }
  for (const [category, members] of categoryGroups) {
    const rows = members.flatMap((member) => member._rows);
    const exactAttribution = members.every((member) => member.attribution === 'exact-agent-id');
    const usage = rows.length || exactAttribution ? finalizeUsage(aggregateRows(rows)) : unavailableUsage();
    const totalTokens = usage.tokens.total.value;
    const cost = usage.estimated_cost_usd.value;
    categoryRows.push({
      category,
      attribution: exactAttribution ? 'exact-agent-id' : rows.length ? 'partial-agent-id' : 'unavailable',
      ticket_count: metric(members.length),
      attempt_count: metric(members.reduce((total, member) => total + member.attempt_count.value, 0)),
      usage,
      average_tokens_per_ticket: metric(totalTokens === null ? null : totalTokens / members.length),
      average_estimated_cost_usd_per_ticket: metric(cost === null ? null : cost / members.length, 'estimated'),
    });
  }
  categoryRows.sort((left, right) => left.category.localeCompare(right.category));

  const boardAgentIds = new Set(ownersByAgent.keys());
  const splitGroups = new Map([
    ['orchestrator', []],
    ['board_executor', []],
    ['unmapped_agent', []],
  ]);
  for (const row of usageRows) {
    if (!row.agent_id) splitGroups.get('orchestrator').push(row);
    else if (boardAgentIds.has(row.agent_id)) splitGroups.get('board_executor').push(row);
    else splitGroups.get('unmapped_agent').push(row);
  }
  const executionSplit = [...splitGroups.entries()].map(([role, group]) => ({
    role,
    usage: finalizeUsage(aggregateRows(group)),
  }));

  const rework = ticketRows
    .filter((entry) => entry.bounce_count.value > 0)
    .map((entry) => ({
      ticket_ref: entry.ticket_ref,
      category: entry.category,
      bounce_count: entry.bounce_count,
      attempt_count: entry.attempt_count,
      usage: entry.usage,
      attempts: entry.attempts,
    }));

  const driftTickets = ticketRows.flatMap((entry) => {
    const ticket = entry._ticket;
    const category = categories.get(entry.category);
    const configuredModel = category && category.route ? category.route.model : null;
    const workedByModel = ticket.workedBy && ticket.workedBy.model ? ticket.workedBy.model : null;
    const dispatchModel = ticket.dispatch && ticket.dispatch.route && ticket.dispatch.route.model
      ? ticket.dispatch.route.model
      : null;
    const workedModel = workedByModel || dispatchModel;
    if (ticket.status !== 'done' || !configuredModel || !workedModel) return [];
    return [{
      ticket_ref: entry.ticket_ref,
      category: entry.category,
      configured_model: configuredModel,
      worked_model: workedModel,
      worked_model_source: workedByModel ? 'workedBy.model' : 'dispatch.route.model',
      drifted: configuredModel !== workedModel,
      attribution: entry.attribution,
      usage: entry.usage,
      _rows: entry._rows,
    }];
  });
  const driftGroups = new Map();
  for (const entry of driftTickets) {
    const key = JSON.stringify([entry.configured_model, entry.worked_model]);
    if (!driftGroups.has(key)) driftGroups.set(key, []);
    driftGroups.get(key).push(entry);
  }
  const driftRollups = [...driftGroups.values()].map((members) => {
    const rows = members.flatMap((member) => member._rows);
    const exactAttribution = members.every((member) => member.attribution === 'exact-agent-id');
    return {
      configured_model: members[0].configured_model,
      worked_model: members[0].worked_model,
      drifted: members[0].drifted,
      attribution: exactAttribution ? 'exact-agent-id' : rows.length ? 'partial-agent-id' : 'unavailable',
      ticket_count: metric(members.length),
      usage: rows.length || exactAttribution ? finalizeUsage(aggregateRows(rows)) : unavailableUsage(),
    };
  }).sort((left, right) => `${left.configured_model}:${left.worked_model}`.localeCompare(`${right.configured_model}:${right.worked_model}`));

  return {
    available: true,
    reason: null,
    source: {
      sidequest_home: board.sidequest_home,
      database_file: board.database_file,
      project_path: board.project_path,
      project_slug: board.project_slug,
      read_only: true,
      usage_source: 'gateway.token.usage',
      join_key: 'agent_id',
    },
    coverage: {
      gateway_request_count: usageRows.length,
      board_agent_count: boardAgentIds.size,
      ambiguous_agent_ids: [...ambiguousAgentIds].sort(),
      ambiguous_agent_count: ambiguousAgentIds.size,
    },
    tickets: ticketRows.map(({ _rows, _ticket, ...entry }) => entry),
    categories: categoryRows,
    execution_split: executionSplit,
    rework,
    route_drift: {
      tickets: driftTickets.map(({ _rows, ...entry }) => entry),
      rollups: driftRollups,
    },
  };
}

module.exports = {
  buildBoardCostReport,
  defaultSidequestHome,
  readSidequestBoard,
  ticketAttempts,
};
