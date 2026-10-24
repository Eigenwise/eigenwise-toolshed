'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'board-sample.json'), 'utf8'))
const SAMPLE_NOW = Date.parse(SAMPLE[SAMPLE.length - 1].at) + 3600000
const SECTION_IDS = ['kpis', 'quota', 'stream', 'models', 'tools', 'tickets', 'sessions', 'activity']
const HOSTILE = 'Fix </script><script>alert(1)</script> \u2028 & "quotes"'

const load = () => import('../lib/board.mjs')

function row(overrides) {
  return {
    v: 1, at: '2026-10-17T10:00:00.000Z', project: 'alpha', session: 's1', startedAt: Date.parse('2026-10-17T09:00:00.000Z'), name: 'First',
    turn: 1, reason: 'answer', durationMs: 1000, costUsd: 0.5, turnCostUsd: 0.5, model: 'claude-opus-5-5',
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    models: { 'claude-opus-5-5': { requests: 3, latencyMs: 300, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } },
    tools: {}, agents: {}, context: { tokens: 50000, window: 200000 }, rateLimits: [], compacted: false, version: '2.1.302',
    ...overrides,
  }
}

// Just enough DOM for the page script: elements keep children, attributes and listeners, and
// getElementById answers only for ids the generated HTML really contains.
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
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join('') }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null }
  addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener) }
  dispatch(type, event) { for (const listener of this.listeners[type] || []) listener(event) }
  getBoundingClientRect() { return { width: 900, height: 280, left: 0, top: 0 } }
  closest() { return this }
  find(predicate) {
    if (predicate(this)) return this
    for (const child of this.children) {
      const found = child instanceof FakeNode && child.find(predicate)
      if (found) return found
    }
    return null
  }
  findAll(predicate) {
    return [].concat(predicate(this) ? [this] : [], ...this.children.map((child) => (child instanceof FakeNode ? child.findAll(predicate) : [])))
  }
}
class FakeText {
  constructor(text) { this.textContent = text }
}

function runPage(html) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))
  const scripts = [...html.matchAll(/<script(?: type="application\/json" id="board-data")?>([\s\S]*?)<\/script>/g)].map((match) => match[1])
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
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (namespace, tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeText(text),
  }
  const window = new FakeNode('window')
  const storage = {}
  const localStorage = { getItem: (key) => storage[key] || null, setItem: (key, value) => { storage[key] = value } }
  vm.runInNewContext(scripts[1], { document, window, localStorage, setTimeout: () => 0, clearTimeout: () => {} })
  return { byId: (id) => document.getElementById(id), document, storage }
}

function button(attribute, value) {
  const node = new FakeNode('button')
  node.setAttribute(attribute, value)
  return node
}

test('the sample fixture carries every feature the page shows', () => {
  assert.ok(new Set(SAMPLE.map((r) => r.project)).size >= 2)
  assert.ok(new Set(SAMPLE.flatMap((r) => Object.keys(r.models))).size >= 2)
  assert.ok(SAMPLE.some((r) => r.ticket))
  assert.ok(SAMPLE.some((r) => r.compacted))
  assert.ok(SAMPLE.some((r) => Object.values(r.tools).some((tool) => tool.denies > 0)))
  assert.ok(SAMPLE[SAMPLE.length - 1].rateLimits.length === 2)
})

test('fixture rows render every section id in order, and the page script draws each one', async () => {
  const { boardHtml } = await load()
  const html = boardHtml(SAMPLE, SAMPLE_NOW)
  const positions = SECTION_IDS.map((id) => html.indexOf(`id="${id}"`))
  assert.ok(positions.every((position) => position > 0), 'every section id is present')
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'sections are in contract order')
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+stylesheet|https?:\/\/(?!www\.w3\.org)/, 'self-contained: no external script, stylesheet or URL')

  const page = runPage(html)
  for (const id of SECTION_IDS) assert.equal(page.byId(id).hidden, false, `#${id} is shown with data`)
  assert.equal(page.byId('empty').hidden, true)
  assert.equal(page.byId('kpis').children.length, 4)
  assert.match(page.byId('quota-meters').textContent, /5-hour window63%/)
  assert.match(page.byId('quota-meters').textContent, /7-day window41%/)
  assert.equal(page.byId('tickets').hidden, false)
  const toolsText = page.byId('tools-rows').textContent
  assert.match(toolsText, /Bash/)
  assert.ok(page.byId('tools-rows').find((node) => node.textContent === '⊘'), 'a denied tool shows its deny mark')
  assert.match(page.byId('models-rows').textContent, /claude-opus-5-5/)
  assert.match(page.byId('models-rows').textContent, /claude-sonnet-5-5/)
  assert.match(page.byId('facts').textContent, /Context compactions[1-9]/)
  assert.ok(page.byId('stream-chart').children.some((node) => node.tag === 'path'), 'the stream draws its areas')
  assert.ok(page.byId('legend').children.length >= 2, 'legend chips for each project')
  assert.equal(page.document.documentElement.getAttribute('data-theme'), 'system')
})

test('the page controls rerender without throwing', async () => {
  const { boardHtml } = await load()
  const page = runPage(boardHtml(SAMPLE, SAMPLE_NOW))
  const sessionsAt30 = Number(page.byId('sessions-count').textContent)
  page.byId('period').dispatch('click', { target: button('data-period', '90') })
  assert.ok(Number(page.byId('sessions-count').textContent) > sessionsAt30, 'the 90-day period shows more sessions')
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
  chart.onmouseleave()
  assert.equal(page.byId('tip').hidden, true)
  page.byId('q').dispatch('input', { target: { value: 'no such session anywhere' } })
  assert.match(page.byId('sessions-rows').textContent, /No session matches/)
  page.byId('projects').children[1].dispatch('click', {})
  assert.notEqual(page.byId('title').textContent, 'All projects')
  page.byId('period').dispatch('click', { target: button('data-period', '7') })
  page.byId('theme').dispatch('click', {})
  assert.equal(page.storage['observability-board-theme'], 'light')
})

test('a hostile name never appears unescaped and reaches the DOM only as text', async () => {
  const { boardHtml } = await load()
  const html = boardHtml([row({ name: HOSTILE, project: '<img src=x onerror=alert(1)>' })], Date.parse('2026-10-17T12:00:00.000Z'))
  assert.equal(html.includes('</script><script>alert'), false)
  assert.equal(html.includes('<img src=x'), false)
  assert.equal(html.includes('\u2028'), false)
  assert.equal(html.match(/<\/script>/g).length, 2, 'only the two real script blocks close')
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  const page = runPage(html)
  const title = page.byId('sessions-rows').find((node) => node.className === 'title')
  assert.equal(title.textContent, HOSTILE)
  assert.equal(page.byId('projects').children[1].textContent.startsWith('<img src=x'), true)
})

test('empty rows render the empty state and every section stays hidden without throwing', async () => {
  const { boardHtml } = await load()
  const html = boardHtml([], Date.parse('2026-10-17T12:00:00.000Z'))
  for (const id of SECTION_IDS) assert.ok(html.includes(`id="${id}"`), `#${id} exists in the empty page`)
  const page = runPage(html)
  assert.equal(page.byId('empty').hidden, false)
  assert.equal(page.byId('empty-title').textContent, 'Nothing recorded yet')
  assert.match(page.byId('empty-text').textContent, /observability:track on/)
  for (const id of SECTION_IDS) assert.equal(page.byId(id).hidden, true, `#${id} is hidden with no data`)
  page.byId('period').dispatch('click', { target: button('data-period', '7') })
  assert.equal(page.byId('empty').hidden, false)
  assert.doesNotThrow(() => boardHtml(undefined, 0))
})

test('a period without turns shows its own empty note and keeps the totals', async () => {
  const { boardHtml } = await load()
  const page = runPage(boardHtml([row({ at: '2026-09-01T10:00:00.000Z', startedAt: Date.parse('2026-09-01T09:00:00.000Z') })], Date.parse('2026-10-17T12:00:00.000Z')))
  page.byId('period').dispatch('click', { target: button('data-period', '7') })
  assert.equal(page.byId('empty').hidden, false)
  assert.match(page.byId('empty-title').textContent, /No turns in the last 7 days/)
  assert.equal(page.byId('kpis').hidden, false)
  assert.equal(page.byId('sessions').hidden, true)
  assert.equal(page.byId('activity').hidden, false, 'the 12-week honeycomb still has the September turn')
})

test('sessionsFrom groups by session and start, sums turns and keeps the newest turn for cost and outcome', async () => {
  const { sessionsFrom } = await load()
  const sessions = sessionsFrom([
    row({ ticket: 'SQ-1', agents: { Explore: 2 } }),
    row({
      at: '2026-10-17T10:05:00.000Z', turn: 2, reason: 'aborted', durationMs: 2000, costUsd: 0.75, name: 'Renamed', model: 'claude-sonnet-5-5',
      context: { percent: 61.5 }, compacted: true, ticket: 'SQ-1',
      models: { 'claude-sonnet-5-5': { requests: 2 }, 'claude-haiku-4-5': { requests: 4 } },
    }),
    row({ session: 's1', startedAt: Date.parse('2026-10-17T11:00:00.000Z'), at: '2026-10-17T11:10:00.000Z', name: 'Resumed', ticket: 'SQ-2', usage: undefined, context: undefined, models: undefined, agents: undefined }),
    row({ session: 's2', project: 'beta', startedAt: Date.parse('2026-10-16T09:00:00.000Z'), at: '2026-10-16T09:30:00.000Z', name: '' }),
  ])
  assert.equal(sessions.length, 3)
  assert.deepEqual(sessions.map((s) => s.name), ['Resumed', 'Renamed', ''], 'newest first by start')
  const first = sessions[1]
  assert.equal(first.turns, 2)
  assert.equal(first.requests, 3 + 6)
  assert.equal(first.durationMs, 3000)
  assert.equal(first.tokens, 200)
  assert.equal(first.costUsd, 0.75)
  assert.equal(first.outcome, 'aborted')
  assert.equal(first.model, 'claude-sonnet-5-5')
  assert.equal(first.contextPeak, 61.5)
  assert.deepEqual(first.tickets, ['SQ-1'])
  assert.equal(first.compactions, 1)
  assert.equal(first.agents, 2)
  assert.equal(first.project, 'alpha')
  assert.equal(first.started, Date.parse('2026-10-17T09:00:00.000Z'))
  assert.equal(first.ended, Date.parse('2026-10-17T10:05:00.000Z'))
  assert.equal(sessions[0].tokens, 0)
  assert.equal(sessions[0].contextPeak, 0)
  assert.equal(sessions[0].requests, 0)
  assert.equal(sessions[2].contextPeak, 25, 'percent derived from tokens over window')
})

test('an older turn arriving later never overwrites the newest turn', async () => {
  const { sessionsFrom } = await load()
  const [session] = sessionsFrom([row({ at: '2026-10-17T10:05:00.000Z', costUsd: 2, reason: 'error' }), row({ costUsd: 1, reason: 'answer', name: '' })])
  assert.equal(session.costUsd, 2)
  assert.equal(session.outcome, 'error')
  assert.equal(session.name, 'First')
})

test('model, tool and ticket folds total the rows', async () => {
  const { modelMix, toolRanking, ticketTotals } = await load()
  const rows = [
    row({ ticket: 'SQ-9', turnCostUsd: 0.25, tools: { Bash: { calls: 4, errors: 1, denies: 2, ms: 400 }, Read: { calls: 9, errors: 0, denies: 0, ms: 90 } } }),
    row({ turnCostUsd: 0.5, tools: { Bash: { calls: 1, errors: 0, denies: 1, ms: 100 } }, models: { 'claude-opus-5-5': { requests: 1, latencyMs: 900, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idle: {} } }),
  ]
  const [opus, idle] = modelMix(rows)
  assert.equal(opus.requests, 4)
  assert.equal(opus.meanLatencyMs, 300)
  assert.equal(opus.tokens, 100)
  assert.equal(opus.cacheShare, 30 / 80)
  assert.deepEqual([idle.name, idle.meanLatencyMs, idle.cacheShare], ['idle', 0, 0])
  assert.deepEqual(toolRanking(rows).map((tool) => [tool.name, tool.calls, tool.errors, tool.denies, tool.ms]), [['Read', 9, 0, 0, 90], ['Bash', 5, 1, 3, 500]])
  const many = { tools: Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['T' + index, { calls: index }])) }
  assert.equal(toolRanking([many]).length, 10)
  assert.deepEqual(ticketTotals(rows), [{ name: 'SQ-9', costUsd: 0.25, durationMs: 1000, turns: 1, tokens: 100 }])
})

test('day folds, streaks and rate limits', async () => {
  const { dayKeys, perDay, streaks, newestRateLimits, resetMs } = await load()
  const now = new Date(2026, 9, 17, 12).getTime()
  const keys = dayKeys(now, 3)
  assert.deepEqual(keys, ['2026-10-15', '2026-10-16', '2026-10-17'])
  const rows = [row({ at: new Date(2026, 9, 15, 8).toISOString() }), row({ at: new Date(2026, 9, 17, 8).toISOString() }), row({ at: new Date(2026, 8, 1).toISOString() })]
  assert.deepEqual(perDay(rows, keys, () => 1), [1, 0, 1])
  assert.deepEqual(streaks([1, 1, 0, 1, 1, 1, 0]), { active: 5, longest: 3, current: 3 }, 'today without turns keeps yesterday\'s streak')
  assert.deepEqual(streaks([1, 0, 1, 1]), { active: 3, longest: 2, current: 2 })
  assert.deepEqual(streaks([0, 0]), { active: 0, longest: 0, current: 0 })
  assert.deepEqual(newestRateLimits([]), [])
  const limits = [{ kind: 'five_hour', percentUsed: 12 }]
  assert.deepEqual(newestRateLimits([row({ at: '2026-10-17T11:00:00.000Z', rateLimits: limits }), row({ at: '2026-10-17T09:00:00.000Z', rateLimits: [] })]), limits)
  assert.deepEqual(newestRateLimits([row({ rateLimits: undefined })]), [])
  assert.equal(resetMs('2026-10-17T11:00:00.000Z'), Date.parse('2026-10-17T11:00:00.000Z'))
  assert.equal(resetMs(1792000000), 1792000000000)
  assert.equal(resetMs(1792000000000), 1792000000000)
})


test('session quality keeps latest measured tests and maximum CC with any split across unordered rows', async () => {
  const { sessionsFrom, boardHtml } = await load()
  const quality = { at: '2026-10-17T10:00:00.000Z', ccMax: 8, split: 1, unverified: true, tests: { status: 'fail', stale: false } }
  const rows = [
    row({ at: '2026-10-17T10:05:00.000Z', quality: { ...quality, ccMax: 3, split: 0, tests: { status: 'pass', stale: true } } }),
    row({ quality }),
    row({ at: '2026-10-17T10:06:00.000Z' }),
    row({ session: 'unmeasured', name: 'Unmeasured' }),
    row({ session: 'no-tests', name: 'No tests', quality: { ...quality, ccMax: 0, split: 0, tests: { status: 'none', stale: false } } }),
  ]
  const sessions = sessionsFrom(rows)
  assert.deepEqual(sessions[0].quality, { ccMax: 8, split: true, ended: Date.parse(rows[0].at), tests: { status: 'pass', stale: true } })
  assert.equal(sessions[1].quality, undefined)
  const html = boardHtml(rows, SAMPLE_NOW)
  assert.match(html, /<th>Tests<\/th>/)
  assert.match(html, /<th>CC<\/th>/)
  const page = runPage(boardHtml(rows, Date.parse('2026-10-17T12:00:00.000Z')))
  const rendered = page.byId('sessions-rows').children
  assert.match(rendered[0].textContent, /pass stale8 SPLIT$/)
  assert.equal(rendered[0].children[10].style.color, 'var(--bad-ink)')
  assert.match(rendered[1].textContent, /––$/)
  assert.match(rendered[2].textContent, /none0 ok$/)
})
