import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'

import { dayKeys, modelMix, newestRateLimits, perDay, resetTimeMs, sessionsFrom, streaks, ticketTotals, toolRanking } from './board-folds.mjs'
import { boardHtml } from './board-page.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const SAMPLE_NOW = Date.parse('2026-11-20T18:00:00.000Z')
const SECTION_IDS = ['kpis', 'quota', 'stream', 'models', 'tools', 'tickets', 'sessions', 'activity']
const HOSTILE = 'Fix </script><script>alert(1)</script> \u2028 & "quotes"'

function row(overrides) {
  return {
    v: 1,
    at: '2026-10-17T10:00:00.000Z',
    project: 'alpha-1a2b3c',
    session: 'session-1',
    startedAt: Date.parse('2026-10-17T09:00:00.000Z'),
    name: 'First',
    turn: 1,
    reason: 'answer',
    durationMs: 1000,
    costUsd: 0.5,
    turnCostUsd: 0.5,
    model: 'claude-opus-5-5',
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    models: { 'claude-opus-5-5': { requests: 3, latencyMs: 300, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } },
    tools: {},
    agents: {},
    context: { tokens: 50000, window: 200000 },
    rateLimits: [],
    compacted: false,
    version: '2.1.325',
    ...overrides,
  }
}

const SAMPLE_PROJECTS = ['alpha-1a2b3c', 'beta-4d5e6f', 'gamma-7a8b9c']

function sampleRow(project, position, daysBack) {
  const startedAt = SAMPLE_NOW - daysBack * DAY_MS - (position + 2) * HOUR_MS
  return row({
    at: new Date(startedAt + 10 * 60 * 1000).toISOString(),
    project,
    session: `${project}-${daysBack}`,
    startedAt,
    name: `Work on ${project}, ${daysBack} days back`,
    durationMs: 60000 * (position + 1),
    turnCostUsd: 0.25 * (position + 1),
    ticket: position === 0 ? `PL-${daysBack}` : undefined,
    compacted: daysBack % 9 === 0,
    models: {
      'claude-opus-5-5': { requests: 4, latencyMs: 800, input: 100, output: 200, cacheRead: 300, cacheWrite: 40 },
      'claude-sonnet-5-5': { requests: 6, latencyMs: 600, input: 50, output: 80, cacheRead: 120, cacheWrite: 10 },
    },
    tools: { Bash: { calls: 4, errors: 1, denies: daysBack % 2, ms: 400 }, Read: { calls: 9, errors: 0, denies: 0, ms: 90 } },
    agents: { Explore: 1 },
  })
}

// Three made-up projects over 60 days, so 30 and 90 days differ, with tickets, compactions, denials and rate limits.
function sampleRows() {
  const rows = []
  for (let daysBack = 60; daysBack >= 0; daysBack -= 3) SAMPLE_PROJECTS.forEach((project, position) => rows.push(sampleRow(project, position, daysBack)))
  const newest = rows.reduce((latest, candidate) => (candidate.at > latest.at ? candidate : latest))
  newest.rateLimits = [
    { kind: 'five_hour', percentUsed: 63, resetsAt: new Date(SAMPLE_NOW + 2 * HOUR_MS).toISOString() },
    { kind: 'seven_day', percentUsed: 41, resetsAt: Math.round((SAMPLE_NOW + 3 * DAY_MS) / 1000) },
  ]
  return rows
}

// Just enough DOM for the page script: elements keep children, attributes and listeners, and
// getElementById answers only for ids the generated page really contains.
class FakeNode {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.attributes = {}
    this.listeners = {}
    this.style = { setProperty: (name, value) => { this.style[name] = value } }
    this.classList = { toggle: () => {} }
    this.ownText = ''
    this.hidden = false
  }
  append(...nodes) { for (const node of nodes) this.children.push(typeof node === 'string' ? new FakeText(node) : node) }
  set textContent(value) { this.children = []; this.ownText = String(value) }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null }
  addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener) }
  dispatch(type, event) { for (const listener of this.listeners[type] || []) listener(event) }
  getBoundingClientRect() { return { width: 900, height: 280, left: 0, top: 0 } }
  closest() { return this }
  find(isWanted) {
    if (isWanted(this)) return this
    for (const child of this.children) {
      const found = child instanceof FakeNode && child.find(isWanted)
      if (found) return found
    }
    return null
  }
}

class FakeText {
  constructor(text) { this.textContent = text }
}

function runPage(html) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]))
  const scripts = [...html.matchAll(/<script(?: type="application\/json" id="board-data")?>([\s\S]*?)<\/script>/g)].map(match => match[1])
  assert.equal(scripts.length, 2, 'one data block and one page script')
  const elements = new Map()
  const document = {
    documentElement: new FakeNode('html'),
    getElementById(id) {
      if (!ids.has(id)) return null
      if (!elements.has(id)) {
        const element = new FakeNode(id)
        if (id === 'board-data') element.textContent = scripts[0]
        elements.set(id, element)
      }
      return elements.get(id)
    },
    createElement: tag => new FakeNode(tag),
    createElementNS: (namespace, tag) => new FakeNode(tag),
  }
  const storage = {}
  const localStorage = { getItem: key => storage[key] || null, setItem: (key, value) => { storage[key] = value } }
  vm.runInNewContext(scripts[1], { document, window: new FakeNode('window'), localStorage, setTimeout: () => 0, clearTimeout: () => {} })
  return { byId: id => document.getElementById(id), document, storage }
}

function button(attribute, value) {
  const node = new FakeNode('button')
  node.setAttribute(attribute, value)
  return node
}

test('the sample rows render every section in order, and the page script draws each one', () => {
  const html = boardHtml(sampleRows(), SAMPLE_NOW)
  const positions = SECTION_IDS.map(id => html.indexOf(`id="${id}"`))
  assert.ok(positions.every(position => position > 0), 'every section id is present')
  assert.deepEqual([...positions].sort((first, second) => first - second), positions, 'sections are in order')
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+stylesheet|https?:\/\/(?!www\.w3\.org)/, 'self-contained: no outside script, stylesheet or address')

  const page = runPage(html)
  for (const id of SECTION_IDS) assert.equal(page.byId(id).hidden, false, `#${id} is shown with data`)
  assert.equal(page.byId('empty').hidden, true)
  assert.equal(page.byId('kpis').children.length, 4)
  assert.match(page.byId('quota-meters').textContent, /5-hour window63%/)
  assert.match(page.byId('quota-meters').textContent, /7-day window41%/)
  assert.match(page.byId('tools-rows').textContent, /Bash/)
  assert.ok(page.byId('tools-rows').find(node => node.textContent === '⊘'), 'a denied tool shows its deny mark')
  assert.match(page.byId('models-rows').textContent, /claude-opus-5-5/)
  assert.match(page.byId('models-rows').textContent, /claude-sonnet-5-5/)
  assert.match(page.byId('tickets-rows').textContent, /PL-0/)
  assert.match(page.byId('facts').textContent, /Context compactions[1-9]/)
  assert.ok(page.byId('stream-chart').children.some(node => node.tag === 'path'), 'the stream draws its areas')
  assert.equal(page.byId('legend').children.length, 3, 'a legend chip for each project')
  assert.equal(page.document.documentElement.getAttribute('data-theme'), 'system')
})

test('the page controls draw again without throwing', () => {
  const page = runPage(boardHtml(sampleRows(), SAMPLE_NOW))
  const sessionsIn30Days = Number(page.byId('sessions-count').textContent)
  page.byId('period').dispatch('click', { target: button('data-period', '90') })
  assert.ok(Number(page.byId('sessions-count').textContent) > sessionsIn30Days, 'the 90-day period shows more sessions')
  assert.match(page.byId('subtitle').textContent, /all the ledger keeps/)
  for (const metric of ['time', 'tokens', 'turns', 'cost']) {
    page.byId('metric').dispatch('click', { target: button('data-metric', metric) })
    assert.notEqual(page.byId('stream-total').textContent, '')
  }
  page.byId('legend').children[0].dispatch('click', {})
  assert.equal(page.byId('legend').children[0].getAttribute('aria-pressed'), 'false', 'a legend chip hides its project')
  const chart = page.byId('stream-chart')
  chart.onmousemove({ clientX: 450 })
  assert.equal(page.byId('tip').hidden, false)
  chart.onkeydown({ key: 'ArrowLeft' })
  chart.onkeydown({ key: 'toString' })
  chart.onmouseleave()
  assert.equal(page.byId('tip').hidden, true)
  page.byId('session-search').dispatch('input', { target: { value: 'no such session anywhere' } })
  assert.match(page.byId('sessions-rows').textContent, /No session matches/)
  page.byId('projects').children[1].dispatch('click', {})
  assert.notEqual(page.byId('title').textContent, 'All projects')
  page.byId('period').dispatch('click', { target: button('data-period', '7') })
  page.byId('theme').dispatch('click', {})
  assert.equal(page.storage['observability-board-theme'], 'light')
})

test('a hostile name never appears unescaped and reaches the page only as text', () => {
  const html = boardHtml([row({ name: HOSTILE, project: '<img src=x onerror=alert(1)>' })], Date.parse('2026-10-17T12:00:00.000Z'))
  assert.equal(html.includes('</script><script>alert'), false)
  assert.equal(html.includes('<img src=x'), false)
  assert.equal(html.includes('\u2028'), false)
  assert.equal(html.match(/<\/script>/g).length, 2, 'only the two real script blocks close')
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  const page = runPage(html)
  const title = page.byId('sessions-rows').find(node => node.className === 'title')
  assert.equal(title.textContent, HOSTILE)
  assert.equal(page.byId('projects').children[1].textContent.startsWith('<img src=x'), true)
})

test('no rows draw the empty state and keep every section hidden', () => {
  const html = boardHtml([], Date.parse('2026-10-17T12:00:00.000Z'))
  for (const id of SECTION_IDS) assert.ok(html.includes(`id="${id}"`), `#${id} exists in the empty page`)
  const page = runPage(html)
  assert.equal(page.byId('empty').hidden, false)
  assert.equal(page.byId('empty-title').textContent, 'Nothing recorded yet')
  assert.match(page.byId('empty-text').textContent, /Run \/track on in a project/)
  for (const id of SECTION_IDS) assert.equal(page.byId(id).hidden, true, `#${id} is hidden with no data`)
  page.byId('period').dispatch('click', { target: button('data-period', '7') })
  assert.equal(page.byId('empty').hidden, false)
  assert.doesNotThrow(() => runPage(boardHtml(undefined, 0)))
})

test('a period without turns shows its own empty note and keeps the totals', () => {
  const september = row({ at: '2026-09-01T10:00:00.000Z', startedAt: Date.parse('2026-09-01T09:00:00.000Z') })
  const page = runPage(boardHtml([september], Date.parse('2026-10-17T12:00:00.000Z')))
  page.byId('period').dispatch('click', { target: button('data-period', '7') })
  assert.equal(page.byId('empty').hidden, false)
  assert.match(page.byId('empty-title').textContent, /No turns in the last 7 days/)
  assert.equal(page.byId('kpis').hidden, false)
  assert.equal(page.byId('sessions').hidden, true)
  assert.equal(page.byId('activity').hidden, false, 'the 12-week honeycomb still has the September turn')
})

test('a quality field an older row carries is ignored: no column for it and the same sessions', () => {
  const quality = { at: '2026-10-17T10:00:00.000Z', ccMax: 8, split: 1, tests: { status: 'fail', stale: false } }
  const withQuality = sessionsFrom([row({ quality })])
  assert.deepEqual(withQuality, sessionsFrom([row({})]))
  assert.equal('quality' in withQuality[0], false)
  const html = boardHtml([row({ quality })], Date.parse('2026-10-17T12:00:00.000Z'))
  assert.doesNotMatch(html, /<th[^>]*>(Tests|CC)<\/th>/)
  const sessionRow = runPage(html).byId('sessions-rows').children[0]
  assert.equal(sessionRow.children.length, 9)
})

test('sessions group by session and start, add up their turns and take cost and outcome from the newest turn', () => {
  const sessions = sessionsFrom([
    row({ ticket: 'PL-1', agents: { Explore: 2 } }),
    row({
      at: '2026-10-17T10:05:00.000Z', turn: 2, reason: 'aborted', durationMs: 2000, costUsd: 0.75, name: 'Renamed', model: 'claude-sonnet-5-5',
      context: { percent: 61.5 }, compacted: true, ticket: 'PL-1',
      models: { 'claude-sonnet-5-5': { requests: 2 }, 'claude-haiku-4-5': { requests: 4 } },
    }),
    row({ startedAt: Date.parse('2026-10-17T11:00:00.000Z'), at: '2026-10-17T11:10:00.000Z', name: 'Resumed', ticket: 'PL-2', usage: undefined, context: undefined, models: undefined, agents: undefined }),
    row({ session: 'session-2', project: 'beta-4d5e6f', startedAt: Date.parse('2026-10-16T09:00:00.000Z'), at: '2026-10-16T09:30:00.000Z', name: '' }),
  ])
  assert.deepEqual(sessions.map(session => session.name), ['Resumed', 'Renamed', ''], 'newest start first')
  const [resumed, renamed, other] = sessions
  assert.equal(renamed.turns, 2)
  assert.equal(renamed.requests, 3 + 6)
  assert.equal(renamed.durationMs, 3000)
  assert.equal(renamed.tokens, 200)
  assert.equal(renamed.costUsd, 0.75)
  assert.equal(renamed.outcome, 'aborted')
  assert.equal(renamed.model, 'claude-sonnet-5-5')
  assert.equal(renamed.contextPeak, 61.5)
  assert.deepEqual(renamed.tickets, ['PL-1'])
  assert.equal(renamed.compactions, 1)
  assert.equal(renamed.agents, 2)
  assert.equal(renamed.ended, Date.parse('2026-10-17T10:05:00.000Z'))
  assert.equal(resumed.tokens, 0)
  assert.equal(resumed.contextPeak, 0)
  assert.equal(resumed.requests, 0)
  assert.equal(other.contextPeak, 25, 'the share of the window, from tokens over window')
})

test('an older turn read later never overwrites the newest turn', () => {
  const [session] = sessionsFrom([row({ at: '2026-10-17T10:05:00.000Z', costUsd: 2, reason: 'error' }), row({ costUsd: 1, reason: 'answer', name: '' })])
  assert.equal(session.costUsd, 2)
  assert.equal(session.outcome, 'error')
  assert.equal(session.name, 'First')
})

test('model, tool and ticket folds add up the rows', () => {
  const rows = [
    row({ ticket: 'PL-9', turnCostUsd: 0.25, tools: { Bash: { calls: 4, errors: 1, denies: 2, ms: 400 }, Read: { calls: 9, errors: 0, denies: 0, ms: 90 } } }),
    row({ turnCostUsd: 0.5, tools: { Bash: { calls: 1, errors: 0, denies: 1, ms: 100 } }, models: { 'claude-opus-5-5': { requests: 1, latencyMs: 900, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idle: {} } }),
  ]
  const [opus, idle] = modelMix(rows)
  assert.equal(opus.requests, 4)
  assert.equal(opus.meanLatencyMs, 300)
  assert.equal(opus.tokens, 100)
  assert.equal(opus.cacheShare, 30 / 80)
  assert.deepEqual([idle.name, idle.meanLatencyMs, idle.cacheShare], ['idle', 0, 0])
  assert.deepEqual(toolRanking(rows).map(tool => [tool.name, tool.calls, tool.errors, tool.denies, tool.ms]), [['Read', 9, 0, 0, 90], ['Bash', 5, 1, 3, 500]])
  const manyTools = { tools: Object.fromEntries(Array.from({ length: 12 }, (unused, index) => ['T' + index, { calls: index }])) }
  assert.equal(toolRanking([manyTools]).length, 10)
  assert.deepEqual(ticketTotals(rows), [{ name: 'PL-9', costUsd: 0.25, durationMs: 1000, turns: 1, tokens: 100 }])
})

test('days, streaks and rate limits', () => {
  const now = new Date(2026, 9, 17, 12).getTime()
  const keys = dayKeys(now, 3)
  assert.deepEqual(keys, ['2026-10-15', '2026-10-16', '2026-10-17'])
  const rows = [row({ at: new Date(2026, 9, 15, 8).toISOString() }), row({ at: new Date(2026, 9, 17, 8).toISOString() }), row({ at: new Date(2026, 8, 1).toISOString() })]
  assert.deepEqual(perDay(rows, keys, () => 1), [1, 0, 1])
  assert.deepEqual(streaks([1, 1, 0, 1, 1, 1, 0]), { active: 5, longest: 3, current: 3 }, "today without turns keeps yesterday's streak")
  assert.deepEqual(streaks([1, 0, 1, 1]), { active: 3, longest: 2, current: 2 })
  assert.deepEqual(streaks([0, 0]), { active: 0, longest: 0, current: 0 })
  assert.deepEqual(newestRateLimits([]), [])
  const limits = [{ kind: 'five_hour', percentUsed: 12 }]
  assert.deepEqual(newestRateLimits([row({ at: '2026-10-17T11:00:00.000Z', rateLimits: limits }), row({ at: '2026-10-17T09:00:00.000Z', rateLimits: [] })]), limits)
  assert.deepEqual(newestRateLimits([row({ rateLimits: undefined })]), [])
  assert.deepEqual(newestRateLimits([row({ rateLimits: 'none' })]), [])
  assert.deepEqual(newestRateLimits([row({ rateLimits: [null, limits[0], 7, {}, []] })]), limits)
  assert.equal(resetTimeMs('2026-10-17T11:00:00.000Z'), Date.parse('2026-10-17T11:00:00.000Z'))
  assert.equal(resetTimeMs(1792000000), 1792000000000)
  assert.equal(resetTimeMs(1792000000000), 1792000000000)
})
