// The observability board: one self-contained HTML page built from ledger rows.
// No server, no network, no CDN: inline CSS, inline SVG and one script.
// The folds below run in Node for tests and are inlined into the page through toString(),
// so the page and the tests read the same code.

export function dayKey(ms) {
  const date = new Date(ms)
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

// Oldest first, ending today; calendar steps so a DST change never skips or repeats a day.
export function dayKeys(now, count) {
  const keys = []
  for (let back = count - 1; back >= 0; back--) {
    const date = new Date(now)
    date.setDate(date.getDate() - back)
    keys.push(dayKey(date.getTime()))
  }
  return keys
}

export function finite(value) {
  return Number.isFinite(value) ? value : 0
}

export function sum(values) {
  let total = 0
  for (const value of values) total += value
  return total
}

export function usageTokens(usage) {
  const counts = usage || {}
  return finite(counts.input) + finite(counts.output) + finite(counts.cacheRead) + finite(counts.cacheWrite)
}

export function contextPercent(row) {
  const context = row.context || {}
  if (Number.isFinite(context.percent)) return context.percent
  return context.tokens > 0 && context.window > 0 ? (context.tokens / context.window) * 100 : 0
}

export function modelRequests(row) {
  let requests = 0
  for (const stats of Object.values(row.models || {})) requests += finite(stats.requests)
  return requests
}

export function agentSpawns(row) {
  return sum(Object.values(row.agents || {}).map(finite))
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

// Sums every turn; name, model, cost and outcome come from the newest turn, since cost is the session total.
export function foldSessionRow(session, row) {
  const current = session || startSession(row)
  current.turns += 1
  current.requests += modelRequests(row)
  current.durationMs += finite(row.durationMs)
  current.tokens += usageTokens(row.usage)
  current.contextPeak = Math.max(current.contextPeak, contextPercent(row))
  current.compactions += row.compacted ? 1 : 0
  current.agents += agentSpawns(row)
  addTicket(current.tickets, row.ticket)
  const at = Date.parse(row.at)
  if (at >= current.ended) Object.assign(current, { ended: at, name: row.name || current.name, model: row.model, costUsd: finite(row.costUsd), outcome: row.reason })
  return current
}

// One entry per session + startedAt, newest first.
export function sessionsFrom(rows) {
  const sessions = new Map()
  for (const row of rows) {
    const key = row.session + '@' + row.startedAt
    sessions.set(key, foldSessionRow(sessions.get(key), row))
  }
  return [...sessions.values()].sort(
    (a, b) => b.started - a.started,
  )
}

export function accumulate(totals, name, stats, fields) {
  const entry = totals[name] || (totals[name] = { name })
  for (const field of fields) entry[field] = (entry[field] || 0) + finite(stats[field])
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
  for (const row of rows) for (const [name, stats] of Object.entries(row.models || {})) accumulate(models, name, stats, fields)
  return Object.values(models).map(finishModel).sort(
    (a, b) => b.tokens - a.tokens,
  )
}

export function toolRanking(rows) {
  const tools = {}
  for (const row of rows) for (const [name, stats] of Object.entries(row.tools || {})) accumulate(tools, name, stats, ['calls', 'errors', 'denies', 'ms'])
  const ranked = Object.values(tools).sort(
    (a, b) => b.calls - a.calls,
  )
  return ranked.slice(0, 10)
}

export function ticketTotals(rows) {
  const tickets = {}
  for (const row of rows) {
    if (row.ticket) accumulate(tickets, row.ticket, { costUsd: row.turnCostUsd, durationMs: row.durationMs, turns: 1, tokens: usageTokens(row.usage) }, ['costUsd', 'durationMs', 'turns', 'tokens'])
  }
  return Object.values(tickets).sort(
    (a, b) => b.costUsd - a.costUsd,
  )
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
  let streak = 0
  for (let day = values[values.length - 1] > 0 ? values.length - 1 : values.length - 2; day >= 0 && values[day] > 0; day--) streak++
  return streak
}

export function streaks(values) {
  let run = 0
  let longest = 0
  let active = 0
  for (const value of values) {
    run = value > 0 ? run + 1 : 0
    active += value > 0 ? 1 : 0
    longest = Math.max(longest, run)
  }
  return { active, longest, current: currentStreak(values) }
}

// Rate limits are account-wide, so only the newest turn of any project speaks for them.
export function newestRateLimits(rows) {
  if (!rows.length) return []
  let newest = rows[0]
  for (const row of rows) if (row.at > newest.at) newest = row
  return newest.rateLimits || []
}

export function resetMs(value) {
  if (typeof value === 'string') return Date.parse(value)
  return value < 1e12 ? value * 1000 : value
}

const SHARED = [
  dayKey, dayKeys, finite, sum, usageTokens, contextPercent, modelRequests, agentSpawns, addTicket, startSession,
  foldSessionRow, sessionsFrom, accumulate, finishModel, modelMix, toolRanking, ticketTotals, perDay, currentStreak,
  streaks, newestRateLimits, resetMs,
]

const DARK = 'color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--hover:rgba(255,255,255,.06);--seg-on:#2c2c2a;--tip:#0d0d0d;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;--s-other:#6b6a64;--good-ink:#0ca30c;--bad-ink:#e66767;--track:#0d366b;--h0:#242423;--h1:#104281;--h2:#1c5cab;--h3:#2a78d6;--h4:#5598e7;--h5:#9ec5f4;--shadow:none'

const CSS = `:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--hover:rgba(11,11,11,.05);--seg-on:#fff;--tip:#fff;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;--s-other:#a3a29b;--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--good-ink:#006300;--bad-ink:#b02a2a;--track:#cde2fb;--h0:#eeede8;--h1:#cde2fb;--h2:#9ec5f4;--h3:#5598e7;--h4:#256abf;--h5:#104281;--shadow:0 1px 2px rgba(11,11,11,.04)}
:root[data-theme=dark]{${DARK}}
@media (prefers-color-scheme:dark){:root[data-theme=system]{${DARK}}}
*{box-sizing:border-box}html,body{margin:0}[hidden]{display:none!important}
body{background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--s1);outline-offset:2px}
.num,td.r,th.r,.axis{font-variant-numeric:tabular-nums}
.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
.side{border-right:1px solid var(--border);padding:22px 14px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:15px;padding:0 10px 22px}
.mark{width:22px;height:22px;flex:none;color:var(--s1)}
.side-label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:6px 10px}
.nav-item{display:flex;align-items:center;gap:10px;width:100%;border:0;background:transparent;color:var(--ink-2);padding:7px 10px;border-radius:8px;cursor:pointer;text-align:left}
.nav-item .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-item:hover{background:var(--hover)}.nav-item.on{background:var(--hover);color:var(--ink);font-weight:550}
.nav-item .n{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.swatch{width:8px;height:8px;border-radius:50%;flex:none;background:var(--c)}
.side-foot{margin-top:auto;display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted);padding:12px 2px 0 10px;border-top:1px solid var(--border)}.foot-text{flex:1;min-width:0}
.theme{display:grid;place-items:center;width:32px;height:32px;flex:none;border:0;border-radius:8px;background:transparent;color:var(--ink-2);cursor:pointer}.theme:hover{background:var(--hover)}.theme svg{display:none}
.theme[data-choice=system] .i-system,.theme[data-choice=light] .i-light,.theme[data-choice=dark] .i-dark{display:block}
main{padding:24px 32px 56px;min-width:0;max-width:1440px;width:100%;margin:0 auto}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.crumb{color:var(--muted);font-size:13px}.crumb b{color:var(--ink-2);font-weight:500}
h1{margin:2px 0 0;font-size:26px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere}.top p{margin:2px 0 0;color:var(--ink-2)}
h2{margin:0 0 4px;font-size:18px;font-weight:600}
h3{margin:0;font-size:15px;font-weight:600}h3 .n{color:var(--muted);font-weight:400;margin-left:6px}
.seg{display:inline-flex;background:var(--hover);border:1px solid var(--border);border-radius:10px;padding:3px;flex:none;flex-wrap:wrap}
.seg button{border:0;background:transparent;color:var(--ink-2);font-size:13px;padding:5px 12px;border-radius:7px;cursor:pointer}
.seg button.on{background:var(--seg-on);color:var(--ink);box-shadow:0 0 0 1px var(--border),0 1px 2px rgba(0,0,0,.06)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);margin-bottom:14px}
.sub{font-size:12px;color:var(--muted)}
.empty{padding:28px}.empty p{margin:0;color:var(--ink-2)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:14px}.kpis .card{margin:0}
.kpi{padding:16px 18px 12px;min-width:0}
.kpi-label{color:var(--ink-2);font-size:13px}
.kpi-value{font-size:28px;font-weight:600;line-height:1.2;margin-top:2px;white-space:nowrap}
.delta{font-size:12px;font-weight:500;margin-left:8px;color:var(--ink-2);white-space:nowrap}.delta.good{color:var(--good-ink)}.delta.bad{color:var(--bad-ink)}
.kpi-note{color:var(--muted);font-size:12px}
.spark{display:block;width:100%;height:36px;margin-top:8px}
.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;padding:18px 20px 0}
.quota .meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px 28px;padding:14px 20px 18px}
.meter-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.meter-head b{font-size:22px;font-weight:600}
.bar-track{height:8px;border-radius:4px;background:var(--track);overflow:hidden;margin:6px 0 6px}
.bar-fill{height:100%;border-radius:4px;background:var(--s1)}
.meter.warning .bar-fill{background:var(--warning)}.meter.critical .bar-fill{background:var(--critical)}
.meter-foot{font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center}
.status-icon{font-style:normal;font-weight:700}.meter.warning .status-icon{color:var(--warning)}.meter.critical .status-icon{color:var(--critical)}
.chart-card{padding:18px 20px 16px}
.chart-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.label{color:var(--ink-2);font-size:13px}.big{font-size:44px;font-weight:600;line-height:1.1;margin-top:2px}
.chart-wrap{position:relative;margin-top:10px}
#stream-chart{display:block;width:100%;height:280px;overflow:visible;cursor:crosshair}
.axis{fill:var(--muted);font-size:11px}.gridline{stroke:var(--grid);stroke-width:1}.baseline{stroke:var(--axis);stroke-width:1}
.crosshair{stroke:var(--ink-2);stroke-width:1}.empty-chart{fill:var(--muted);font-size:13px}
.tip{position:absolute;pointer-events:none;background:var(--tip);color:var(--ink);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);min-width:150px;z-index:2}
.tip-head{color:var(--ink-2);margin-bottom:2px}.tip-total{font-weight:600;font-size:13px;margin-bottom:4px}
.tip-row{display:flex;align-items:center;gap:6px;white-space:nowrap}.tip-row .name{flex:1;max-width:180px;overflow:hidden;text-overflow:ellipsis}.tip-row .v{font-variant-numeric:tabular-nums;margin-left:12px}
.legend{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:7px;padding:4px 10px;border-radius:999px;background:transparent;border:1px solid var(--border);color:var(--ink);font-size:12px;cursor:pointer;max-width:260px}
.chip .label-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chip[aria-pressed=false]{color:var(--muted)}.chip[aria-pressed=false] .swatch{background:transparent;box-shadow:inset 0 0 0 1.5px var(--c)}
.table-view{margin-top:10px;font-size:13px}.table-view summary{cursor:pointer;color:var(--ink-2);width:max-content}.table-view .table-wrap{max-height:320px;overflow:auto;margin-top:8px}
.grid2{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px;align-items:start}.grid2>.card{margin-bottom:14px}
.list{padding:18px 0 6px}
.list-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 20px 12px;flex-wrap:wrap}
.key{display:flex;gap:12px;font-size:12px;color:var(--muted)}.key span{display:inline-flex;align-items:center;gap:5px}.key i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.search{display:flex;align-items:center;gap:8px;background:var(--hover);border:1px solid var(--border);border-radius:9px;padding:5px 10px;width:240px;color:var(--muted)}
.search input{border:0;outline:0;background:transparent;color:var(--ink);font:inherit;font-size:13px;width:100%}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:400;color:var(--muted);font-size:12px;padding:0 10px 8px;white-space:nowrap}
th:first-child,td:first-child{padding-left:20px}th:last-child,td:last-child{padding-right:20px}
td{padding:9px 10px;border-top:1px solid var(--grid);white-space:nowrap;vertical-align:middle}
th.r,td.r{text-align:right}td.dim{color:var(--muted)}td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
td.wrap{white-space:normal;min-width:220px;max-width:380px}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inline-bar{display:flex;align-items:center;gap:8px;min-width:150px}.inline-bar .bar-track{flex:1;margin:0;height:6px;background:transparent}.inline-bar .v{min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
.stack{display:flex;gap:2px;height:6px}.stack i{display:block;height:100%;background:var(--c)}.stack i:first-child{border-radius:3px 0 0 3px}.stack i:last-child{border-radius:0 3px 3px 0}.stack i:only-child{border-radius:3px}
.mini{display:inline-flex;align-items:center;gap:8px}.mini .bar-track{width:56px;height:6px;margin:0}
.flag{display:inline-flex;align-items:center;gap:5px}.flag i{font-style:normal;font-weight:700;color:var(--c)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid var(--border);color:var(--ink-2)}
.pill i{font-style:normal;font-weight:700;color:var(--c,var(--muted))}
td.empty-row{text-align:center;color:var(--muted);padding:28px}
.heat{padding:18px 20px}
.heat-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:28px;align-items:start}
#heat{display:block;max-width:100%;height:auto;margin-top:12px}.hx{stroke:var(--surface);stroke-width:2}.hx0{fill:var(--h0)}.hx1{fill:var(--h1)}.hx2{fill:var(--h2)}.hx3{fill:var(--h3)}.hx4{fill:var(--h4)}.hx5{fill:var(--h5)}.day{fill:var(--muted);font-size:11px}
.heroes{display:grid;grid-template-columns:1fr 1fr;gap:16px}.hero-label{color:var(--ink-2);font-size:12px}.hero-value{font-size:30px;font-weight:600;line-height:1.2}.hero-sub{font-size:12px;color:var(--muted)}
#facts{margin-top:14px}.fact{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--grid);color:var(--ink-2);font-size:13px}.fact span:last-child{color:var(--ink);font-variant-numeric:tabular-nums;text-align:right}
footer{color:var(--muted);font-size:12px;margin-top:20px}
@media (max-width:1280px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:1100px){.grid2,.heat-grid{grid-template-columns:minmax(0,1fr)}}
@media (max-width:860px){.app{grid-template-columns:minmax(0,1fr)}.side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;border-right:0;border-bottom:1px solid var(--border);padding:12px 16px}
.side-label,.foot-text{display:none}.side-foot{margin:0 0 0 auto;padding:0;border:0}.brand{padding:2px 10px 2px 0}#projects{display:flex;gap:4px;flex-wrap:wrap;width:100%;order:3}.nav-item{width:auto;max-width:220px}
main{padding:18px 16px 40px}.big{font-size:34px}}
@media (max-width:520px){.kpis{grid-template-columns:minmax(0,1fr)}.top{align-items:stretch}.top .seg{align-self:flex-start}.search{width:100%}.list-head{padding:0 16px 12px}th:first-child,td:first-child{padding-left:16px}th:last-child,td:last-child{padding-right:16px}.chart-card,.heat{padding:16px}.big{font-size:30px}#stream-chart{height:220px}.heroes{grid-template-columns:1fr}}`

// Everything that reaches the DOM from the data goes through textContent or setAttribute, never as HTML.
const APP = String.raw`
var data = JSON.parse(document.getElementById('board-data').textContent)
var now = data.now
var rows = data.rows.slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0 })
var NS = 'http://www.w3.org/2000/svg'
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
var SLOTS = 8
var state = { project: '', period: 30, metric: 'cost', query: '', hidden: {} }
// Colour follows the project, by first appearance, so a filter never repaints a survivor.
var seen = Array.from(new Set(rows.map(function (r) { return r.project })))

function byId(id) { return document.getElementById(id) }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
function svgEl(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e }
function two(n) { return (n < 10 ? '0' : '') + n }
function colorOf(project) { var i = seen.indexOf(project); return i >= 0 && i < SLOTS ? 'var(--s' + (i + 1) + ')' : 'var(--s-other)' }
function swatch(color) { var s = el('span', 'swatch'); s.style.setProperty('--c', color); return s }
function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's') }
function money(n) { return n > 0 && n < 0.01 ? '<$0.01' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function compact(n) {
  var a = Math.abs(n)
  if (a < 1000) return String(Math.round(n))
  if (a < 1e6) return +(n / 1e3).toFixed(1) + 'K'
  if (a < 1e9) return +(n / 1e6).toFixed(1) + 'M'
  return +(n / 1e9).toFixed(1) + 'B'
}
function duration(ms) {
  var s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
  var m = Math.round(s / 60)
  if (m >= 2880) return Math.floor(m / 1440) + 'd ' + Math.floor(m % 1440 / 60) + 'h'
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
}
function latency(ms) { return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s' }
function percent(share) { return Math.round(share * 100) + '%' }
function shortDate(key) { return MONTHS[+key.slice(5, 7) - 1] + ' ' + +key.slice(8, 10) }
function clock(ms) { var d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()) }
function stamp(ms) { return shortDate(dayKey(ms)) + ', ' + clock(ms) }
function sessionKey(r) { return r.session + '@' + r.startedAt }

var METRICS = {
  cost: { label: 'Cost', pick: function (r) { return finite(r.turnCostUsd) }, format: money },
  time: { label: 'Agent time', pick: function (r) { return finite(r.durationMs) }, format: duration },
  tokens: { label: 'Tokens', pick: function (r) { return usageTokens(r.usage) }, format: compact },
  turns: { label: 'Turns', pick: function () { return 1 }, format: compact }
}

function scoped() { return state.project ? rows.filter(function (r) { return r.project === state.project }) : rows }
function within(list, keys) { var set = new Set(keys); return list.filter(function (r) { return set.has(dayKey(Date.parse(r.at))) }) }
function periodText() { return state.period === 90 ? 'last 90 days, all the ledger keeps' : 'last ' + state.period + ' days' }
function sessionCount(list) { return new Set(list.map(sessionKey)).size }
function sessionsPerDay(list, keys) {
  var sets = keys.map(function () { return new Set() }), index = new Map(keys.map(function (k, i) { return [k, i] }))
  list.forEach(function (r) { var i = index.get(dayKey(Date.parse(r.at))); if (i !== undefined) sets[i].add(sessionKey(r)) })
  return sets.map(function (s) { return s.size })
}
function projectsIn(list) { var present = new Set(list.map(function (r) { return r.project })); return seen.filter(function (p) { return present.has(p) }) }

// Monotone cubic through the points (as d3's curveMonotoneX): never overshoots a day's value.
function smooth(p) {
  var n = p.length, m = [], d = 'M' + p[0][0].toFixed(1) + ',' + p[0][1].toFixed(1)
  function slope(i) { return (p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]) }
  if (n < 3) return n < 2 ? d : d + 'L' + p[1][0].toFixed(1) + ',' + p[1][1].toFixed(1)
  for (var i = 1; i < n - 1; i++) {
    var s0 = slope(i - 1), s1 = slope(i)
    m[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), Math.abs(s0 + s1) / 4) || 0
  }
  m[0] = (3 * slope(0) - m[1]) / 2; m[n - 1] = (3 * slope(n - 2) - m[n - 2]) / 2
  for (i = 0; i < n - 1; i++) {
    var dx = (p[i + 1][0] - p[i][0]) / 3
    d += 'C' + (p[i][0] + dx).toFixed(1) + ',' + (p[i][1] + m[i] * dx).toFixed(1) + ' ' + (p[i + 1][0] - dx).toFixed(1) + ',' + (p[i + 1][1] - m[i + 1] * dx).toFixed(1) + ' ' + p[i + 1][0].toFixed(1) + ',' + p[i + 1][1].toFixed(1)
  }
  return d
}
function niceMax(v) {
  if (!(v > 0)) return 1
  var step = Math.pow(10, Math.floor(Math.log10(v))), steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  for (var i = 0; i < steps.length; i++) if (steps[i] * step >= v) return steps[i] * step
  return 10 * step
}

function sidebar() {
  var nav = byId('projects'), counts = {}, sessions = sessionsFrom(rows); nav.textContent = ''
  sessions.forEach(function (s) { counts[s.project] = (counts[s.project] || 0) + 1 })
  var latest = {}; rows.forEach(function (r) { latest[r.project] = r.at })
  var order = seen.slice().sort(function (a, b) { return latest[b] < latest[a] ? -1 : latest[b] > latest[a] ? 1 : 0 })
  ;[['', 'All projects', sessions.length]].concat(order.map(function (p) { return [p, p, counts[p] || 0] })).forEach(function (item) {
    var b = el('button', 'nav-item' + (state.project === item[0] ? ' on' : '')); b.type = 'button'; b.title = item[1]
    b.setAttribute('aria-pressed', String(state.project === item[0]))
    if (item[0]) b.append(swatch(colorOf(item[0])))
    b.append(el('span', 'name', item[1]), el('span', 'n', String(item[2])))
    b.addEventListener('click', function () { state.project = item[0]; state.hidden = {}; render() })
    nav.append(b)
  })
  byId('generated').textContent = 'Local board · ' + stamp(now)
}

function header(current) {
  var name = state.project || 'All projects'
  byId('crumb').textContent = name
  byId('title').textContent = name
  byId('subtitle').textContent = plural(sessionCount(current), 'session') + ' · ' + plural(current.length, 'turn') + ' · ' + periodText()
}

function renderEmpty(current) {
  var box = byId('empty')
  box.hidden = current.length > 0
  byId('empty-title').textContent = rows.length ? 'No turns in the ' + periodText() : 'Nothing recorded yet'
  byId('empty-text').textContent = rows.length ? 'Pick a longer period or another project.' : 'Run /observability:track on in a project. Every finished turn there lands on this board.'
}

function sparkline(values, color) {
  var W = 120, H = 32, s = svgEl('svg', { viewBox: '0 0 120 32', preserveAspectRatio: 'none', 'class': 'spark', 'aria-hidden': 'true' })
  var max = Math.max.apply(null, values.concat([0]))
  var pts = values.map(function (v, i) { return [values.length > 1 ? i * W / (values.length - 1) : W / 2, max > 0 ? H - 3 - v / max * (H - 6) : H - 3] })
  var line = smooth(pts)
  svgEl('path', { d: line + 'L' + W + ',' + H + 'L0,' + H + 'Z', style: 'fill:' + color + ';fill-opacity:.1' }, s)
  svgEl('path', { d: line, fill: 'none', style: 'stroke:' + color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }, s)
  return s
}

var KPIS = [
  { label: 'Cost', metric: 'cost', upIsBad: true },
  { label: 'Agent time', metric: 'time' },
  { label: 'Tokens', metric: 'tokens' },
  { label: 'Sessions', total: sessionCount, daily: sessionsPerDay, format: String }
]
function renderKpis(list, keys, current) {
  var wrap = byId('kpis'), previous = within(list, dayKeys(now, state.period * 2).slice(0, state.period)); wrap.textContent = ''
  wrap.hidden = !rows.length
  KPIS.forEach(function (k) {
    var M = METRICS[k.metric]
    var total = k.total || function (l) { return sum(l.map(M.pick)) }
    var daily = k.daily || function (l, ks) { return perDay(l, ks, M.pick) }
    var format = k.format || M.format
    var v = total(current), p = total(previous)
    var tile = el('div', 'card kpi'), value = el('div', 'kpi-value', format(v))
    if (p > 0) {
      var pct = Math.round((v - p) / p * 100)
      var tone = !k.upIsBad || pct === 0 ? '' : pct > 0 ? ' bad' : ' good'
      value.append(el('span', 'delta' + tone, (pct > 0 ? '↑ ' : pct < 0 ? '↓ ' : '') + Math.abs(pct) + '%'))
    }
    tile.append(el('div', 'kpi-label', k.label), value, el('div', 'kpi-note', p > 0 ? 'vs the ' + state.period + ' days before' : periodText()), sparkline(daily(list, keys), 'var(--s1)'))
    wrap.append(tile)
  })
}

var QUOTA_LABELS = { five_hour: '5-hour window', seven_day: '7-day window', seven_day_opus: '7-day Opus window', seven_day_sonnet: '7-day Sonnet window' }
function renderQuota() {
  var limits = newestRateLimits(rows), box = byId('quota-meters'); box.textContent = ''
  byId('quota').hidden = !limits.length
  if (!limits.length) return
  var newest = rows[rows.length - 1]
  byId('quota-sub').textContent = 'As of the last turn, ' + stamp(Date.parse(newest.at))
  limits.forEach(function (limit) {
    var used = Math.max(0, Math.min(100, finite(limit.percentUsed)))
    var level = used >= 90 ? 'critical' : used >= 70 ? 'warning' : 'normal'
    var meter = el('div', 'meter ' + level), head = el('div', 'meter-head'), track = el('div', 'bar-track'), fill = el('div', 'bar-fill'), foot = el('div', 'meter-foot')
    track.setAttribute('role', 'meter'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', String(Math.round(used)))
    var label = QUOTA_LABELS[limit.kind] || String(limit.kind).replace(/_/g, ' ')
    track.setAttribute('aria-label', label)
    head.append(el('span', 'label', label), el('b', '', Math.round(used) + '%'))
    fill.style.width = used + '%'; track.append(fill)
    if (level !== 'normal') foot.append(el('i', 'status-icon', level === 'critical' ? '!' : '▲'), el('span', '', level === 'critical' ? 'Near the limit.' : 'Getting close.'))
    var at = resetMs(limit.resetsAt)
    foot.append(el('span', '', Number.isFinite(at) ? (at > now ? 'Resets in ' + duration(at - now) + ', ' : 'Reset ') + WEEKDAYS[new Date(at).getDay()] + ' ' + clock(at) : 'Reset time not reported'))
    meter.append(head, track, foot)
    box.append(meter)
  })
}

function streamGroups(projects) {
  var groups = projects.filter(function (p) { return seen.indexOf(p) < SLOTS }).map(function (p) { return { name: p, color: colorOf(p), members: [p] } })
  var rest = projects.filter(function (p) { return seen.indexOf(p) >= SLOTS })
  if (rest.length) groups.push({ name: 'Other (' + rest.length + ')', color: 'var(--s-other)', members: rest })
  return groups
}

function renderStream(current, keys) {
  byId('stream').hidden = !current.length
  if (!current.length) return
  var M = METRICS[state.metric], box = byId('stream-chart'), tip = byId('tip'); tip.hidden = true; state.cursor = null
  var groups = streamGroups(projectsIn(current)), visible = groups.filter(function (g) { return !state.hidden[g.name] })
  var series = visible.map(function (g) { return perDay(current.filter(function (r) { return g.members.indexOf(r.project) >= 0 }), keys, M.pick) })
  var totals = keys.map(function (_, i) { return series.reduce(function (a, s) { return a + s[i] }, 0) })
  byId('stream-label').textContent = M.label + ', ' + periodText()
  byId('stream-total').textContent = M.format(sum(totals))
  box.setAttribute('aria-label', M.label + ' per project and day, ' + periodText() + '. The table below lists the same values.')
  legend(groups)
  streamTable(visible, series, totals, keys, M)
  var n = keys.length, W = Math.max(320, Math.round(box.getBoundingClientRect().width) || 900), H = Math.round(box.getBoundingClientRect().height) || 280
  var left = 52, right = 10, top = 12, base = H - 26
  box.setAttribute('viewBox', '0 0 ' + W + ' ' + H); box.textContent = ''
  var x = function (i) { return left + (n > 1 ? i * (W - left - right) / (n - 1) : (W - left - right) / 2) }
  var max = niceMax(Math.max.apply(null, totals.concat([0])))
  var y = function (v) { return base - v / max * (base - top) }
  ;[0.5, 1].forEach(function (f) {
    svgEl('line', { x1: left, x2: W - right, y1: y(max * f), y2: y(max * f), 'class': 'gridline' }, box)
    svgEl('text', { x: left - 8, y: y(max * f) + 4, 'text-anchor': 'end', 'class': 'axis' }, box).textContent = M.format(max * f)
  })
  svgEl('text', { x: left - 8, y: base + 4, 'text-anchor': 'end', 'class': 'axis' }, box).textContent = M.format(0)
  for (var w = 0, step = Math.max(1, Math.ceil(n / 7)); w < n; w += step) svgEl('text', { x: x(w), y: H - 4, 'class': 'axis', 'text-anchor': w ? 'middle' : 'start' }, box).textContent = shortDate(keys[w])
  var acc = keys.map(function () { return 0 }), tops = []
  series.forEach(function (s, li) {
    var lower = acc, upper = acc.map(function (a, i) { return a + s[i] }), color = visible[li].color; acc = upper
    var up = smooth(upper.map(function (v, i) { return [x(i), y(v)] })), low = smooth(lower.map(function (v, i) { return [x(i), y(v)] }).reverse())
    svgEl('path', { d: up + 'L' + low.slice(1) + 'Z', style: 'fill:' + color + ';fill-opacity:.22' }, box)
    tops.push({ d: up, color: color, values: upper })
  })
  // The top edge of each layer is its 2px line; the surface-coloured underlay keeps neighbouring edges apart.
  tops.forEach(function (t) { svgEl('path', { d: t.d, fill: 'none', style: 'stroke:var(--surface)', 'stroke-width': 4 }, box) })
  tops.forEach(function (t) { svgEl('path', { d: t.d, fill: 'none', style: 'stroke:' + t.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, box) })
  svgEl('line', { x1: left, x2: W - right, y1: base, y2: base, 'class': 'baseline' }, box)
  var hair = svgEl('line', { y1: top, y2: base, 'class': 'crosshair', visibility: 'hidden' }, box)
  var dots = tops.map(function (t) { return svgEl('circle', { r: 4, style: 'fill:' + t.color + ';stroke:var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, box) })
  function show(i) {
    var r = box.getBoundingClientRect(), scale = (r.width || W) / W
    hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('visibility', 'visible')
    dots.forEach(function (d, li) { d.setAttribute('cx', x(i)); d.setAttribute('cy', y(tops[li].values[i])); d.setAttribute('visibility', 'visible') })
    tip.textContent = ''
    tip.append(el('div', 'tip-head', WEEKDAYS[new Date(keys[i] + 'T12:00').getDay()] + ' ' + shortDate(keys[i])), el('div', 'tip-total', M.format(totals[i])))
    for (var li = visible.length - 1; li >= 0; li--) {
      if (!series[li][i] || visible.length < 2) continue
      var row = el('div', 'tip-row'); row.append(swatch(visible[li].color), el('span', 'name', visible[li].name), el('span', 'v', M.format(series[li][i]))); tip.append(row)
    }
    var px = x(i) * scale, width = r.width || W
    tip.style.left = Math.min(Math.max(0, px + 14), Math.max(0, width - 200)) + 'px'
    tip.style.top = Math.max(0, y(totals[i]) * scale - 30) + 'px'
    tip.hidden = false
    state.cursor = i
  }
  function hide() { hair.setAttribute('visibility', 'hidden'); dots.forEach(function (d) { d.setAttribute('visibility', 'hidden') }); tip.hidden = true }
  box.onmousemove = function (e) {
    var r = box.getBoundingClientRect(), px = (e.clientX - r.left) / (r.width || W) * W
    show(Math.max(0, Math.min(n - 1, Math.round((px - left) / Math.max(1, W - left - right) * (n - 1)))))
  }
  box.onmouseleave = hide
  box.onblur = hide
  box.onfocus = function () { show(n - 1) }
  box.onkeydown = function (e) {
    var i = state.cursor == null ? n - 1 : state.cursor
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1)
    else if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1)
    else if (e.key === 'Home') i = 0
    else if (e.key === 'End') i = n - 1
    else return
    if (e.preventDefault) e.preventDefault()
    show(i)
  }
}

function legend(groups) {
  var box = byId('legend'); box.textContent = ''
  if (groups.length < 2) return
  groups.forEach(function (g) {
    var b = el('button', 'chip'); b.type = 'button'; b.setAttribute('aria-pressed', String(!state.hidden[g.name])); b.title = (state.hidden[g.name] ? 'Show ' : 'Hide ') + g.name
    b.append(swatch(g.color), el('span', 'label-text', g.name))
    b.addEventListener('click', function () { state.hidden[g.name] = !state.hidden[g.name]; var list = scoped(), keys = dayKeys(now, state.period); renderStream(within(list, keys), keys) })
    box.append(b)
  })
}

function streamTable(visible, series, totals, keys, M) {
  var head = byId('stream-head'), body = byId('stream-rows'), tr = el('tr'); head.textContent = ''; body.textContent = ''
  tr.append(el('th', '', 'Day'))
  visible.forEach(function (g) { tr.append(el('th', 'r', g.name)) })
  tr.append(el('th', 'r', 'Total')); head.append(tr)
  for (var i = keys.length - 1; i >= 0; i--) {
    if (!totals[i]) continue
    var row = el('tr'); row.append(el('td', '', shortDate(keys[i])))
    series.forEach(function (s) { row.append(el('td', 'r', M.format(s[i]))) })
    row.append(el('td', 'r', M.format(totals[i]))); body.append(row)
  }
}

function inlineBar(value, max, text, color) {
  var wrap = el('div', 'inline-bar'), track = el('div', 'bar-track'), fill = el('div', 'bar-fill')
  fill.style.width = Math.max(2, max > 0 ? value / max * 100 : 0) + '%'
  if (color) fill.style.background = color
  track.append(fill); wrap.append(track, el('span', 'v', text)); return wrap
}
function cell(content, cls) { var td = el('td', cls || ''); if (typeof content === 'string') td.textContent = content; else td.append(content); return td }
function miniMeter(share, text) {
  var wrap = el('span', 'mini'), track = el('span', 'bar-track'), fill = el('span', 'bar-fill')
  fill.style.display = 'block'; fill.style.width = Math.min(100, Math.max(0, share * 100)) + '%'; track.style.display = 'block'
  track.append(fill); wrap.append(track, el('span', '', text)); return wrap
}

function renderModels(current) {
  var mix = modelMix(current), body = byId('models-rows'); body.textContent = ''
  byId('models').hidden = !mix.length
  if (!mix.length) return
  var requests = sum(mix.map(function (m) { return m.requests })), read = sum(mix.map(function (m) { return m.cacheRead })), side = sum(mix.map(function (m) { return m.input + m.cacheRead + m.cacheWrite }))
  byId('models-sub').textContent = plural(requests, 'request') + ' · cache reads ' + percent(side ? read / side : 0) + ' of input'
  var max = mix[0].tokens
  mix.forEach(function (m) {
    var tr = el('tr')
    tr.append(cell(m.name, 'mono'), cell(inlineBar(m.tokens, max, compact(m.tokens))), cell(compact(m.requests), 'r'), cell(m.requests ? latency(m.meanLatencyMs) : '–', 'r'), cell(miniMeter(m.cacheShare, percent(m.cacheShare))))
    body.append(tr)
  })
}

function flag(count, icon, color) {
  if (!count) return el('span', 'dim', '–')
  var f = el('span', 'flag'), i = el('i', '', icon); f.style.setProperty('--c', color); f.append(i, el('span', '', compact(count))); return f
}
function renderTools(current) {
  var tools = toolRanking(current), body = byId('tools-rows'); body.textContent = ''
  byId('tools').hidden = !tools.length
  if (!tools.length) return
  var max = tools[0].calls
  tools.forEach(function (t) {
    var ok = Math.max(0, t.calls - t.errors - t.denies), wrap = el('div', 'inline-bar'), stack = el('div', 'stack')
    stack.style.width = Math.max(2, max > 0 ? t.calls / max * 100 : 0) + '%'; stack.style.flex = 'none'
    ;[[ok, 'var(--s1)'], [t.errors, 'var(--critical)'], [t.denies, 'var(--warning)']].forEach(function (part) {
      if (!part[0]) return
      var seg = el('i'); seg.style.setProperty('--c', part[1]); seg.style.flexGrow = String(part[0]); stack.append(seg)
    })
    var holder = el('div', ''); holder.style.flex = '1'; holder.append(stack)
    wrap.append(holder, el('span', 'v', compact(t.calls)))
    var tr = el('tr')
    tr.append(cell(t.name, 'mono'), cell(wrap), cell(flag(t.errors, '✕', 'var(--critical)'), 'r'), cell(flag(t.denies, '⊘', 'var(--warning)'), 'r'), cell(t.calls ? latency(t.ms / t.calls) : '–', 'r'))
    body.append(tr)
  })
}

function renderTickets(current) {
  var tickets = ticketTotals(current), body = byId('tickets-rows'); body.textContent = ''
  byId('tickets').hidden = !tickets.length
  if (!tickets.length) return
  byId('tickets-sub').textContent = plural(tickets.length, 'ticket') + ' · ' + money(sum(tickets.map(function (t) { return t.costUsd })))
  var max = tickets[0].costUsd
  tickets.forEach(function (t) {
    var tr = el('tr')
    tr.append(cell(t.name, 'mono'), cell(compact(t.turns), 'r'), cell(compact(t.tokens), 'r'), cell(duration(t.durationMs), 'r'), cell(inlineBar(t.costUsd, max, money(t.costUsd))))
    body.append(tr)
  })
}

var OUTCOMES = { answer: ['var(--good)', '✓', 'Answered'], aborted: ['var(--warning)', '■', 'Aborted'], refusal: ['var(--serious)', '⊘', 'Refused'], error: ['var(--critical)', '✕', 'Error'] }
function pill(reason) {
  var o = OUTCOMES[reason] || ['var(--muted)', '•', String(reason || 'unknown')], p = el('span', 'pill'), i = el('i', '', o[1])
  p.style.setProperty('--c', o[0]); p.append(i, el('span', '', o[2])); return p
}
function renderSessions(list, keys) {
  var start = new Date(keys[0] + 'T00:00').getTime(), q = state.query.trim().toLowerCase(), body = byId('sessions-rows'); body.textContent = ''
  var all = sessionsFrom(list).filter(function (s) { return s.ended >= start })
  byId('sessions').hidden = !all.length
  var shown = all.filter(function (s) { return !q || [s.name, s.project, s.model].concat(s.tickets).join(' ').toLowerCase().indexOf(q) >= 0 })
  byId('sessions-count').textContent = String(shown.length)
  if (!shown.length) { var tr = el('tr'), td = el('td', 'empty-row', 'No session matches.'); td.colSpan = 9; tr.append(td); body.append(tr); return }
  shown.forEach(function (s) {
    var tr = el('tr'), name = el('td', 'wrap'), title = el('div', 'title', s.name || 'Untitled session')
    title.title = s.name
    var bits = [state.project ? '' : s.project, stamp(s.started)].concat(s.tickets)
    if (s.compactions) bits.push('compacted ×' + s.compactions)
    if (s.agents) bits.push(plural(s.agents, 'subagent'))
    name.append(title, el('div', 'sub', bits.filter(Boolean).join(' · ')))
    tr.append(name, cell(s.model || '–', 'mono'), cell(String(s.turns), 'r'), cell(compact(s.requests), 'r'), cell(money(s.costUsd), 'r'), cell(duration(s.durationMs), 'r'), cell(compact(s.tokens), 'r'), cell(miniMeter(s.contextPeak / 100, Math.round(s.contextPeak) + '%')), cell(pill(s.outcome)))
    body.append(tr)
  })
}

function hexPath(cx, cy, r) {
  var d = ''
  for (var k = 0; k < 6; k++) { var a = Math.PI / 3 * k - Math.PI / 2; d += (k ? 'L' : 'M') + (cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1) }
  return d + 'Z'
}
// The last 12 weeks as a honeycomb: a column per week, a row per weekday, one blue ramp for agent time.
function renderActivity(list, current) {
  var s = byId('heat'), keys = dayKeys(now, 84), vals = perDay(list, keys, METRICS.time.pick), max = Math.max.apply(null, vals.concat([0])); s.textContent = ''
  byId('activity').hidden = !(max > 0)
  if (!(max > 0)) return
  var r = 15, w = Math.sqrt(3) * r, left = 34, top = r + 2, firstDow = new Date(keys[0] + 'T12:00').getDay(), cols = Math.ceil((84 + firstDow) / 7)
  keys.forEach(function (k, i) {
    var pos = i + firstDow, row = pos % 7, level = vals[i] > 0 ? Math.max(1, Math.ceil(vals[i] / max * 5)) : 0
    var p = svgEl('path', { d: hexPath(left + Math.floor(pos / 7) * w + (row % 2 ? w / 2 : 0), top + row * r * 1.5, r), 'class': 'hx hx' + level }, s)
    svgEl('title', {}, p).textContent = WEEKDAYS[row] + ' ' + shortDate(k) + ': ' + (vals[i] ? duration(vals[i]) : 'no turns')
  })
  ;['Mon', 'Wed', 'Fri'].forEach(function (d, i) { svgEl('text', { x: 0, y: top + (1 + 2 * i) * r * 1.5 + 4, 'class': 'day' }, s).textContent = d })
  var right = left + cols * w + w / 2, ly = top + 6 * r * 1.5 + r + 18
  svgEl('text', { x: right - 34 - 5 * 14 - 12, y: ly + 4, 'text-anchor': 'end', 'class': 'day' }, s).textContent = 'Less'
  ;[0, 1, 2, 3, 4, 5].forEach(function (level, i) { svgEl('path', { d: hexPath(right - 34 - (5 - i) * 14, ly, 6.5), 'class': 'hx hx' + level }, s) })
  svgEl('text', { x: right, y: ly + 4, 'text-anchor': 'end', 'class': 'day' }, s).textContent = 'More'
  s.setAttribute('viewBox', '0 0 ' + Math.ceil(right + 2) + ' ' + Math.ceil(ly + 10))
  s.setAttribute('width', Math.ceil(right + 2))
  var run = streaks(vals)
  byId('h-active').textContent = String(run.active)
  byId('h-active-sub').textContent = percent(run.active / 84) + ' of the last 84 days'
  byId('h-streak').textContent = plural(run.current, 'day')
  byId('h-streak-sub').textContent = 'longest ' + plural(run.longest, 'day')
  var sessions = sessionsFrom(current), byDay = {}, facts = byId('facts'); facts.textContent = ''
  current.forEach(function (t) { var k = dayKey(Date.parse(t.at)); byDay[k] = (byDay[k] || 0) + finite(t.durationMs) })
  var busiest = Object.keys(byDay).sort(function (a, b) { return byDay[b] - byDay[a] })[0]
  var longest = sessions.reduce(function (m, x) { return !m || x.durationMs > m.durationMs ? x : m }, null)
  var compactions = sum(current.map(function (t) { return t.compacted ? 1 : 0 })), agents = sum(current.map(agentSpawns))
  ;[['Busiest day', busiest ? shortDate(busiest) + ' · ' + duration(byDay[busiest]) : '–'],
    ['Longest session', longest ? duration(longest.durationMs) : '–'],
    ['Average time per session', sessions.length ? duration(sum(sessions.map(function (x) { return x.durationMs })) / sessions.length) : '–'],
    ['Average cost per session', sessions.length ? money(sum(current.map(METRICS.cost.pick)) / sessions.length) : '–'],
    ['Subagents spawned', compact(agents)],
    ['Context compactions', compact(compactions)]].forEach(function (f) {
    var row = el('div', 'fact'); row.append(el('span', '', f[0]), el('span', '', f[1])); facts.append(row)
  })
  byId('facts-sub').textContent = 'Facts cover the ' + periodText() + '.'
}

function render() {
  var list = scoped(), keys = dayKeys(now, state.period), current = within(list, keys)
  sidebar(); header(current); renderEmpty(current); renderKpis(list, keys, current); renderQuota()
  renderStream(current, keys); renderModels(current); renderTools(current); renderTickets(current); renderSessions(list, keys); renderActivity(list, current)
}

function segment(id, apply) {
  var seg = byId(id)
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return
    Array.from(seg.children).forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)) })
    apply(b)
  })
}
segment('period', function (b) { state.period = +b.getAttribute('data-period'); render() })
segment('metric', function (b) { state.metric = b.getAttribute('data-metric'); var list = scoped(), keys = dayKeys(now, state.period); renderStream(within(list, keys), keys) })
byId('q').addEventListener('input', function (e) { state.query = e.target.value; renderSessions(scoped(), dayKeys(now, state.period)) })
var resizing; window.addEventListener('resize', function () { clearTimeout(resizing); resizing = setTimeout(function () { var list = scoped(), keys = dayKeys(now, state.period); renderStream(within(list, keys), keys) }, 120) })

var THEMES = ['system', 'light', 'dark']
function applyTheme(choice) {
  var next = THEMES[(THEMES.indexOf(choice) + 1) % THEMES.length], b = byId('theme')
  document.documentElement.setAttribute('data-theme', choice)
  b.setAttribute('data-choice', choice); b.setAttribute('aria-label', 'Theme: ' + choice + ', switch to ' + next); b.title = 'Theme: ' + choice
}
var saved = 'system'
try { saved = localStorage.getItem('observability-board-theme') || 'system' } catch (e) {}
applyTheme(THEMES.indexOf(saved) >= 0 ? saved : 'system')
byId('theme').addEventListener('click', function () {
  var next = THEMES[(THEMES.indexOf(byId('theme').getAttribute('data-choice')) + 1) % THEMES.length]
  applyTheme(next)
  try { localStorage.setItem('observability-board-theme', next) } catch (e) {}
})

render()
`

const THEME_BUTTON = '<button type="button" class="theme" id="theme" data-choice="system" aria-label="Theme: system" title="Theme: system"><svg class="i-system" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg><svg class="i-light" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="i-dark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>'

const MARK = '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l5-6 4 3 6-8"/><path d="M3 21h18"/></svg>'

const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2a78d6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 6-8"/><path d="M3 21h18"/></svg>')

const SEARCH_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'

// A leading ">" marks a right-aligned numeric column.
const headerCell = (label) => (label.startsWith('>') ? `<th class="r">${label.slice(1)}</th>` : `<th>${label}</th>`)

const head = (cells) => '<thead><tr>' + cells.map(headerCell).join('') + '</tr></thead>'

const listCard = (id, title, columns, extra) =>
  `<section id="${id}" class="card list" hidden><div class="list-head"><h3>${title}</h3>${extra}</div><div class="table-wrap"><table>${head(columns)}<tbody id="${id}-rows"></tbody></table></div></section>`

const seg = (id, label, attribute, items, on) =>
  `<div class="seg" id="${id}" role="group" aria-label="${label}">` +
  items.map(([value, text]) => `<button type="button" data-${attribute}="${value}" aria-pressed="${value === on}"${value === on ? ' class="on"' : ''}>${text}</button>`).join('') +
  '</div>'

const TOOL_KEY = '<div class="key"><span><i style="--c:var(--s1)"></i>OK</span><span><i style="--c:var(--critical)"></i>Error</span><span><i style="--c:var(--warning)"></i>Denied</span></div>'

const BODY = `<div class="app">
<aside class="side"><div class="brand">${MARK}observability</div><div class="side-label">Projects</div><nav id="projects" aria-label="Projects"></nav><div class="side-foot"><div class="foot-text" id="generated"></div>${THEME_BUTTON}</div></aside>
<main>
<div class="top"><div><div class="crumb">Board / <b id="crumb"></b></div><h1 id="title"></h1><p id="subtitle"></p></div>
${seg('period', 'Period', 'period', [['7', '7d'], ['30', '30d'], ['90', 'All (90d)']], '30')}</div>
<section id="empty" class="card empty" hidden><h2 id="empty-title"></h2><p id="empty-text"></p></section>
<section id="kpis" class="kpis" aria-label="Totals"></section>
<section id="quota" class="card quota" hidden><div class="card-head"><h3>Plan usage</h3><span class="sub" id="quota-sub"></span></div><div class="meters" id="quota-meters"></div></section>
<section id="stream" class="card chart-card" hidden><div class="chart-head"><div><div class="label" id="stream-label"></div><div class="big" id="stream-total"></div></div>
${seg('metric', 'Metric', 'metric', [['cost', 'Cost'], ['time', 'Agent time'], ['tokens', 'Tokens'], ['turns', 'Turns']], 'cost')}</div>
<div class="chart-wrap"><svg id="stream-chart" role="img" tabindex="0" aria-label="Per project and day"></svg><div class="tip" id="tip" hidden></div></div><div class="legend" id="legend"></div>
<details class="table-view"><summary>Show as table</summary><div class="table-wrap"><table><thead id="stream-head"></thead><tbody id="stream-rows"></tbody></table></div></details></section>
<div class="grid2">
${listCard('models', 'Models', ['Model', 'Tokens', '>Requests', '>Mean latency', 'Cache reads'], '<span class="sub" id="models-sub"></span>')}
${listCard('tools', 'Tools', ['Tool', 'Calls', '>Errors', '>Denied', '>Avg time'], TOOL_KEY)}
</div>
${listCard('tickets', 'Tickets', ['Ticket', '>Turns', '>Tokens', '>Agent time', 'Cost'], '<span class="sub" id="tickets-sub"></span>')}
${listCard('sessions', 'Sessions<span class="n" id="sessions-count"></span>', ['Session', 'Model', '>Turns', '>Requests', '>Cost', '>Time', '>Tokens', 'Context peak', 'Outcome'], `<label class="search">${SEARCH_ICON}<input id="q" type="search" placeholder="Search sessions" aria-label="Search sessions"></label>`)}
<section id="activity" class="card heat" hidden><div class="heat-grid"><div><h3>Activity</h3><div class="sub">Agent time per day, last 12 weeks</div><svg id="heat" role="img" aria-label="Agent time per day, last 12 weeks"></svg></div>
<div><div class="heroes"><div><div class="hero-label">Active days</div><div class="hero-value" id="h-active"></div><div class="hero-sub" id="h-active-sub"></div></div>
<div><div class="hero-label">Current streak</div><div class="hero-value" id="h-streak"></div><div class="hero-sub" id="h-streak-sub"></div></div></div><div id="facts"></div><div class="sub" id="facts-sub"></div></div></div></section>
<footer>Recorded by the observability mod in Claude Code. Cost is the session cost Claude Code itself reports, not a bill; nothing here is estimated. The ledger keeps the last 90 days.</footer>
</main></div>`

// JSON inside a script block: "<" and the two JS line separators are escaped so no value can end the block.
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

export function boardHtml(rows, now) {
  const data = scriptJson({ now, rows: Array.isArray(rows) ? rows : [] })
  const script = '(function () {\n' + SHARED.map(String).join('\n') + '\n' + APP + '\n})()'
  return `<!doctype html><html lang="en" data-theme="system"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Observability board</title><link rel="icon" href="${FAVICON}"><style>${CSS}</style></head>
<body>${BODY}
<script type="application/json" id="board-data">${data}</script>
<script>${script}</script></body></html>`
}
