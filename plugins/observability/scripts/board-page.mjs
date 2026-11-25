// The usage board: one self-contained HTML page built from ledger rows. No server, no network: inline CSS, inline SVG
// and one script, made of the folds and the page functions by their own source text.

import * as boardFolds from './board-folds.mjs'
import * as boardPageScript from './board-page-script.mjs'

const functionsOf = module => Object.values(module).filter(value => typeof value === 'function')

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

const THEME_BUTTON =
  '<button type="button" class="theme" id="theme" data-choice="system" aria-label="Theme: system" title="Theme: system">' +
  '<svg class="i-system" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>' +
  '<svg class="i-light" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
  '<svg class="i-dark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>'

const MARK =
  '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l5-6 4 3 6-8"/><path d="M3 21h18"/></svg>'

const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2a78d6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 6-8"/><path d="M3 21h18"/></svg>',
  )

const SEARCH_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'

// A leading ">" marks a right-aligned numeric column.
const headerCell = label => (label.startsWith('>') ? `<th class="r">${label.slice(1)}</th>` : `<th>${label}</th>`)

const tableHead = labels => `<thead><tr>${labels.map(headerCell).join('')}</tr></thead>`

const listCard = (id, title, columns, extra) =>
  `<section id="${id}" class="card list" hidden><div class="list-head"><h3>${title}</h3>${extra}</div><div class="table-wrap"><table>${tableHead(columns)}<tbody id="${id}-rows"></tbody></table></div></section>`

const segmentButton = (attribute, picked) => ([value, text]) =>
  `<button type="button" data-${attribute}="${value}" aria-pressed="${value === picked}"${value === picked ? ' class="on"' : ''}>${text}</button>`

const segmentGroup = (id, label, items, picked) =>
  `<div class="seg" id="${id}" role="group" aria-label="${label}">${items.map(segmentButton(id, picked)).join('')}</div>`

const TOOL_KEY =
  '<div class="key"><span><i style="--c:var(--s1)"></i>OK</span><span><i style="--c:var(--critical)"></i>Error</span><span><i style="--c:var(--warning)"></i>Denied</span></div>'

const SESSION_SEARCH = `<label class="search">${SEARCH_ICON}<input id="session-search" type="search" placeholder="Search sessions" aria-label="Search sessions"></label>`

const SESSION_COLUMNS = ['Session', 'Model', '>Turns', '>Requests', '>Cost', '>Time', '>Tokens', 'Context peak', 'Outcome']

const BODY = `<div class="app">
<aside class="side"><div class="brand">${MARK}observability</div><div class="side-label">Projects</div><nav id="projects" aria-label="Projects"></nav><div class="side-foot"><div class="foot-text" id="generated"></div>${THEME_BUTTON}</div></aside>
<main>
<div class="top"><div><div class="crumb">Usage / <b id="crumb"></b></div><h1 id="title"></h1><p id="subtitle"></p></div>
${segmentGroup('period', 'Period', [['7', '7d'], ['30', '30d'], ['90', 'All (90d)']], '30')}</div>
<section id="empty" class="card empty" hidden><h2 id="empty-title"></h2><p id="empty-text"></p></section>
<section id="kpis" class="kpis" aria-label="Totals"></section>
<section id="quota" class="card quota" hidden><div class="card-head"><h3>Plan usage</h3><span class="sub" id="quota-sub"></span></div><div class="meters" id="quota-meters"></div></section>
<section id="stream" class="card chart-card" hidden><div class="chart-head"><div><div class="label" id="stream-label"></div><div class="big" id="stream-total"></div></div>
${segmentGroup('metric', 'Metric', [['cost', 'Cost'], ['time', 'Agent time'], ['tokens', 'Tokens'], ['turns', 'Turns']], 'cost')}</div>
<div class="chart-wrap"><svg id="stream-chart" role="img" tabindex="0" aria-label="Per project and day"></svg><div class="tip" id="tip" hidden></div></div><div class="legend" id="legend"></div>
<details class="table-view"><summary>Show as table</summary><div class="table-wrap"><table><thead id="stream-head"></thead><tbody id="stream-rows"></tbody></table></div></details></section>
<div class="grid2">
${listCard('models', 'Models', ['Model', 'Tokens', '>Requests', '>Mean latency', 'Cache reads'], '<span class="sub" id="models-sub"></span>')}
${listCard('tools', 'Tools', ['Tool', 'Calls', '>Errors', '>Denied', '>Avg time'], TOOL_KEY)}
</div>
${listCard('tickets', 'Tickets', ['Ticket', '>Turns', '>Tokens', '>Agent time', 'Cost'], '<span class="sub" id="tickets-sub"></span>')}
${listCard('sessions', 'Sessions<span class="n" id="sessions-count"></span>', SESSION_COLUMNS, SESSION_SEARCH)}
<section id="activity" class="card heat" hidden><div class="heat-grid"><div><h3>Activity</h3><div class="sub">Agent time per day, last 12 weeks</div><svg id="heat" role="img" aria-label="Agent time per day, last 12 weeks"></svg></div>
<div><div class="heroes"><div><div class="hero-label">Active days</div><div class="hero-value" id="h-active"></div><div class="hero-sub" id="h-active-sub"></div></div>
<div><div class="hero-label">Current streak</div><div class="hero-value" id="h-streak"></div><div class="hero-sub" id="h-streak-sub"></div></div></div><div id="facts"></div><div class="sub" id="facts-sub"></div></div></div></section>
<footer>Recorded by the observability plugin in Claude Code. Cost is the session cost Claude Code itself reports, not a bill; nothing here is estimated. This page shows the last 90 days.</footer>
</main></div>`

// JSON inside a script block: "<" and the two JavaScript line separators are escaped so no value can end the block.
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

const constantLines = constants => Object.entries(constants).map(([name, value]) => `var ${name} = ${scriptJson(value)}`)

function pageScript() {
  const { BOARD_CONSTANTS, ...pageFunctions } = boardPageScript
  return [
    '(function () {',
    ...constantLines(BOARD_CONSTANTS),
    ...functionsOf(boardFolds).map(String),
    ...functionsOf(pageFunctions).map(String),
    "var board = createBoard(JSON.parse(document.getElementById('board-data').textContent))",
    'startBoard()',
    '})()',
  ].join('\n')
}

/** The whole page for these rows, as of `now` (milliseconds). Rows that are not a list give the empty board. */
export function boardHtml(rows, now) {
  const data = scriptJson({ now, rows: Array.isArray(rows) ? rows : [] })
  return `<!doctype html><html lang="en" data-theme="system"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Observability usage</title><link rel="icon" href="${FAVICON}"><style>${CSS}</style></head>
<body>${BODY}
<script type="application/json" id="board-data">${data}</script>
<script>${pageScript()}</script></body></html>`
}
