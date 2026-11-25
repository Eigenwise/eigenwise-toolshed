// The folds from ledger rows to what the board shows. They run in Node for the tests and are inlined into the page
// through their source text, so the page and the tests read the same code: each stays a plain function declaration.

export function dayKey(milliseconds) {
  const date = new Date(milliseconds)
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

// Oldest first, ending today; calendar steps so a daylight saving change never skips or repeats a day.
export function dayKeys(now, count) {
  const keys = []
  for (let back = count - 1; back >= 0; back--) {
    const date = new Date(now)
    date.setDate(date.getDate() - back)
    keys.push(dayKey(date.getTime()))
  }
  return keys
}

export function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0
}

export function sum(values) {
  let total = 0
  for (const value of values) total += value
  return total
}

export function compareText(first, second) {
  if (first === second) return 0
  return first < second ? -1 : 1
}

export function usageTokens(usage) {
  const counts = usage || {}
  return finiteOrZero(counts.input) + finiteOrZero(counts.output) + finiteOrZero(counts.cacheRead) + finiteOrZero(counts.cacheWrite)
}

export function contextPercent(row) {
  const context = row.context || {}
  if (Number.isFinite(context.percent)) return context.percent
  return context.tokens > 0 && context.window > 0 ? (context.tokens / context.window) * 100 : 0
}

export function modelRequests(row) {
  return sum(Object.values(row.models || {}).map(tally => finiteOrZero(tally.requests)))
}

export function agentSpawns(row) {
  return sum(Object.values(row.agents || {}).map(finiteOrZero))
}

export function addTicket(tickets, ticket) {
  if (ticket && !tickets.includes(ticket)) tickets.push(ticket)
}

export function startSession(row) {
  return {
    name: '',
    project: row.project,
    model: row.model,
    turns: 0,
    requests: 0,
    costUsd: 0,
    durationMs: 0,
    tokens: 0,
    contextPeak: 0,
    outcome: row.reason,
    tickets: [],
    compactions: 0,
    agents: 0,
    started: row.startedAt,
    ended: -Infinity,
  }
}

// Name, model, cost and outcome come from the newest turn, since a row's cost is the session total so far.
export function takeNewestTurn(session, row) {
  const at = Date.parse(row.at)
  if (at < session.ended) return
  Object.assign(session, { ended: at, name: row.name || session.name, model: row.model, costUsd: finiteOrZero(row.costUsd), outcome: row.reason })
}

export function foldSessionRow(session, row) {
  const current = session || startSession(row)
  current.turns += 1
  current.requests += modelRequests(row)
  current.durationMs += finiteOrZero(row.durationMs)
  current.tokens += usageTokens(row.usage)
  current.contextPeak = Math.max(current.contextPeak, contextPercent(row))
  current.compactions += row.compacted ? 1 : 0
  current.agents += agentSpawns(row)
  addTicket(current.tickets, row.ticket)
  takeNewestTurn(current, row)
  return current
}

// One entry per session and start time, newest first: a resumed session starts a new entry.
export function sessionsFrom(rows) {
  const sessions = new Map()
  for (const row of rows) {
    const key = row.session + '@' + row.startedAt
    sessions.set(key, foldSessionRow(sessions.get(key), row))
  }
  return [...sessions.values()].sort((first, second) => second.started - first.started)
}

export function accumulate(totals, name, tally, fields) {
  const entry = totals[name] || (totals[name] = { name })
  for (const field of fields) entry[field] = (entry[field] || 0) + finiteOrZero(tally[field])
}

export function finishModel(model) {
  const inputSide = model.input + model.cacheRead + model.cacheWrite
  return Object.assign(model, {
    tokens: usageTokens(model),
    meanLatencyMs: model.requests > 0 ? model.latencyMs / model.requests : 0,
    cacheShare: inputSide > 0 ? model.cacheRead / inputSide : 0,
  })
}

export function modelMix(rows) {
  const models = {}
  const fields = ['requests', 'latencyMs', 'input', 'output', 'cacheRead', 'cacheWrite']
  for (const row of rows) for (const [name, tally] of Object.entries(row.models || {})) accumulate(models, name, tally, fields)
  return Object.values(models).map(finishModel).sort((first, second) => second.tokens - first.tokens)
}

export function toolRanking(rows) {
  const tools = {}
  for (const row of rows) for (const [name, tally] of Object.entries(row.tools || {})) accumulate(tools, name, tally, ['calls', 'errors', 'denies', 'ms'])
  return Object.values(tools).sort((first, second) => second.calls - first.calls).slice(0, 10)
}

export function ticketTotals(rows) {
  const tickets = {}
  const fields = ['costUsd', 'durationMs', 'turns', 'tokens']
  for (const row of rows) {
    if (row.ticket) accumulate(tickets, row.ticket, { costUsd: row.turnCostUsd, durationMs: row.durationMs, turns: 1, tokens: usageTokens(row.usage) }, fields)
  }
  return Object.values(tickets).sort((first, second) => second.costUsd - first.costUsd)
}

export function perDay(rows, keys, pick) {
  const values = new Array(keys.length).fill(0)
  for (const row of rows) {
    const position = keys.indexOf(dayKey(Date.parse(row.at)))
    if (position >= 0) values[position] += pick(row)
  }
  return values
}

// A streak still counts when today has no turn yet: it runs up to yesterday.
export function currentStreak(values) {
  let day = values[values.length - 1] > 0 ? values.length - 1 : values.length - 2
  let streak = 0
  for (; day >= 0 && values[day] > 0; day--) streak++
  return streak
}

export function streaks(values) {
  let run = 0
  let longest = 0
  for (const value of values) {
    run = value > 0 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return { active: values.filter(value => value > 0).length, longest, current: currentStreak(values) }
}

// Rate limits are account-wide, so only the newest turn of any project speaks for them.
export function newestRateLimits(rows) {
  if (rows.length === 0) return []
  const newest = rows.reduce((latest, row) => (row.at > latest.at ? row : latest))
  return limitEntries(newest.rateLimits)
}

// A row written by hand or by a later version may hold something else here, and one bad entry must not empty the page.
// Exported because the page inlines every exported fold by its source text.
export function limitEntries(value) {
  if (!Array.isArray(value)) return []
  return value.filter(limit => typeof limit === 'object' && limit !== null && typeof limit.kind === 'string')
}

// The engine gives a reset as a date, or as seconds or milliseconds since the epoch.
export function resetTimeMs(value) {
  if (typeof value === 'string') return Date.parse(value)
  return value < 1e12 ? value * 1000 : value
}
