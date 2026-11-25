// The board page's own script. Each function is inlined into the page through its source text, after the folds
// in board-folds.mjs, so every one stays a plain function declaration. They share the page's `board`, which holds
// the rows, the time the board was built, the project order and what the person picked, and the constants below.
// Everything that reaches the page from the data goes in as text or as an attribute, never as markup.

export const BOARD_CONSTANTS = {
  SVG_NAMESPACE: 'http://www.w3.org/2000/svg',
  MONTH_NAMES: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  WEEKDAY_NAMES: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  // The palette has eight project colours; the rest share one grey group.
  COLOURED_PROJECT_SLOTS: 8,
  COMPACT_STEPS: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']],
  NICE_STEPS: [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10],
  QUOTA_LABELS: { five_hour: '5-hour window', seven_day: '7-day window', seven_day_opus: '7-day Opus window', seven_day_sonnet: '7-day Sonnet window' },
  OUTCOMES: { answer: ['var(--good)', '✓', 'Answered'], aborted: ['var(--warning)', '■', 'Aborted'], refusal: ['var(--serious)', '⊘', 'Refused'], error: ['var(--critical)', '✕', 'Error'] },
  SESSION_COLUMNS: 9,
  // Twelve weeks: the honeycomb draws a column per week.
  ACTIVITY_DAYS: 84,
  THEMES: ['system', 'light', 'dark'],
  THEME_STORAGE_KEY: 'observability-board-theme',
}

export function createBoard(data) {
  const rows = data.rows.slice().sort((first, second) => compareText(first.at, second.at))
  return {
    rows,
    now: data.now,
    // Colour follows the project by first appearance, so a filter never repaints the projects it keeps.
    projectOrder: Array.from(new Set(rows.map(row => row.project))),
    metrics: metricDefinitions(),
    picked: { project: '', period: 30, metric: 'cost', query: '', hiddenGroups: {}, cursor: null },
  }
}

export function elementById(id) {
  return document.getElementById(id)
}

export function createElement(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

export function setAttributes(element, attributes) {
  for (const name of Object.keys(attributes)) element.setAttribute(name, attributes[name])
}

export function createSvgElement(tag, attributes, parent) {
  const element = document.createElementNS(SVG_NAMESPACE, tag)
  setAttributes(element, attributes)
  if (parent) parent.append(element)
  return element
}

export function twoDigits(number) {
  return String(number).padStart(2, '0')
}

export function colourOfProject(project) {
  const position = board.projectOrder.indexOf(project)
  return position >= 0 && position < COLOURED_PROJECT_SLOTS ? 'var(--s' + (position + 1) + ')' : 'var(--s-other)'
}

export function swatch(colour) {
  const element = createElement('span', 'swatch')
  element.style.setProperty('--c', colour)
  return element
}

export function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's')
}

export function money(amount) {
  if (amount > 0 && amount < 0.01) return '<$0.01'
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function compactNumber(number) {
  const step = COMPACT_STEPS.find(candidate => Math.abs(number) >= candidate[0])
  return step ? +(number / step[0]).toFixed(1) + step[1] : String(Math.round(number))
}

export function longDuration(minutes) {
  if (minutes >= 2880) return Math.floor(minutes / 1440) + 'd ' + Math.floor((minutes % 1440) / 60) + 'h'
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm'
}

export function duration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return seconds + 's'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's'
  return longDuration(Math.round(seconds / 60))
}

export function latency(milliseconds) {
  return milliseconds < 1000 ? Math.round(milliseconds) + ' ms' : (milliseconds / 1000).toFixed(1) + ' s'
}

export function percent(share) {
  return Math.round(share * 100) + '%'
}

export function shortDate(day) {
  return MONTH_NAMES[Number(day.slice(5, 7)) - 1] + ' ' + Number(day.slice(8, 10))
}

export function clockTime(milliseconds) {
  const date = new Date(milliseconds)
  return twoDigits(date.getHours()) + ':' + twoDigits(date.getMinutes())
}

export function stamp(milliseconds) {
  return shortDate(dayKey(milliseconds)) + ', ' + clockTime(milliseconds)
}

export function sessionKey(row) {
  return row.session + '@' + row.startedAt
}

export function metricDefinitions() {
  return {
    cost: { label: 'Cost', pick: row => finiteOrZero(row.turnCostUsd), format: money },
    time: { label: 'Agent time', pick: row => finiteOrZero(row.durationMs), format: duration },
    tokens: { label: 'Tokens', pick: row => usageTokens(row.usage), format: compactNumber },
    turns: { label: 'Turns', pick: () => 1, format: compactNumber },
  }
}

export function scopedRows() {
  const project = board.picked.project
  return project ? board.rows.filter(row => row.project === project) : board.rows
}

export function rowsWithin(rows, keys) {
  const days = new Set(keys)
  return rows.filter(row => days.has(dayKey(Date.parse(row.at))))
}

export function periodText() {
  return board.picked.period === 90 ? 'last 90 days, all the ledger keeps' : 'last ' + board.picked.period + ' days'
}

export function sessionCount(rows) {
  return new Set(rows.map(sessionKey)).size
}

export function sessionsPerDay(rows, keys) {
  const sessionsByDay = keys.map(() => new Set())
  const positionOfDay = new Map(keys.map((key, position) => [key, position]))
  rows.forEach(row => {
    const position = positionOfDay.get(dayKey(Date.parse(row.at)))
    if (position !== undefined) sessionsByDay[position].add(sessionKey(row))
  })
  return sessionsByDay.map(sessions => sessions.size)
}

export function projectsIn(rows) {
  const present = new Set(rows.map(row => row.project))
  return board.projectOrder.filter(project => present.has(project))
}

export function pointText(point) {
  return point[0].toFixed(1) + ',' + point[1].toFixed(1)
}

export function slopeBetween(points, index) {
  return (points[index + 1][1] - points[index][1]) / (points[index + 1][0] - points[index][0])
}

export function innerTangent(points, index) {
  const before = slopeBetween(points, index - 1)
  const after = slopeBetween(points, index)
  return (Math.sign(before) + Math.sign(after)) * Math.min(Math.abs(before), Math.abs(after), Math.abs(before + after) / 4) || 0
}

export function monotoneTangents(points) {
  const last = points.length - 1
  const tangents = points.map((point, index) => (index > 0 && index < last ? innerTangent(points, index) : 0))
  tangents[0] = (3 * slopeBetween(points, 0) - tangents[1]) / 2
  tangents[last] = (3 * slopeBetween(points, last - 1) - tangents[last - 1]) / 2
  return tangents
}

export function cubicSegment(points, tangents, index) {
  const third = (points[index + 1][0] - points[index][0]) / 3
  const firstControl = [points[index][0] + third, points[index][1] + tangents[index] * third]
  const secondControl = [points[index + 1][0] - third, points[index + 1][1] - tangents[index + 1] * third]
  return 'C' + pointText(firstControl) + ' ' + pointText(secondControl) + ' ' + pointText(points[index + 1])
}

// A monotone cubic through the points, as d3's curveMonotoneX: it never overshoots a day's value.
export function smoothPath(points) {
  const start = 'M' + pointText(points[0])
  if (points.length < 2) return start
  if (points.length < 3) return start + 'L' + pointText(points[1])
  const tangents = monotoneTangents(points)
  return start + points.slice(1).map((point, index) => cubicSegment(points, tangents, index)).join('')
}

export function niceMaximum(value) {
  if (!(value > 0)) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)))
  const step = NICE_STEPS.find(candidate => candidate * magnitude >= value)
  return (step === undefined ? 10 : step) * magnitude
}

export function projectButton(project, label, count) {
  const isPicked = board.picked.project === project
  const button = createElement('button', 'nav-item' + (isPicked ? ' on' : ''))
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-pressed', String(isPicked))
  if (project) button.append(swatch(colourOfProject(project)))
  button.append(createElement('span', 'name', label), createElement('span', 'n', String(count)))
  button.addEventListener('click', () => pickProject(project))
  return button
}

export function pickProject(project) {
  board.picked.project = project
  board.picked.hiddenGroups = {}
  renderBoard()
}

export function projectsByLatestTurn() {
  const latestTurn = {}
  board.rows.forEach(row => {
    latestTurn[row.project] = row.at
  })
  return board.projectOrder.slice().sort((first, second) => compareText(latestTurn[second], latestTurn[first]))
}

export function renderProjectNav() {
  const navigation = elementById('projects')
  const sessions = sessionsFrom(board.rows)
  const sessionsOfProject = {}
  sessions.forEach(session => {
    sessionsOfProject[session.project] = (sessionsOfProject[session.project] || 0) + 1
  })
  navigation.textContent = ''
  navigation.append(projectButton('', 'All projects', sessions.length))
  projectsByLatestTurn().forEach(project => navigation.append(projectButton(project, project, sessionsOfProject[project] || 0)))
  elementById('generated').textContent = 'Local page · ' + stamp(board.now)
}

export function renderHeader(current) {
  const name = board.picked.project || 'All projects'
  elementById('crumb').textContent = name
  elementById('title').textContent = name
  elementById('subtitle').textContent = plural(sessionCount(current), 'session') + ' · ' + plural(current.length, 'turn') + ' · ' + periodText()
}

export function renderEmptyState(current) {
  const hasRows = board.rows.length > 0
  elementById('empty').hidden = current.length > 0
  elementById('empty-title').textContent = hasRows ? 'No turns in the ' + periodText() : 'Nothing recorded yet'
  elementById('empty-text').textContent = hasRows
    ? 'Pick a longer period or another project.'
    : 'Run /track on in a project. Every finished turn there lands on this page.'
}

export function sparklineAcross(index, count, width) {
  return count > 1 ? (index * width) / (count - 1) : width / 2
}

export function sparklineDown(value, highest, height) {
  return highest > 0 ? height - 3 - (value / highest) * (height - 6) : height - 3
}

export function sparkline(values, colour) {
  const width = 120
  const height = 32
  const chart = createSvgElement('svg', { viewBox: '0 0 120 32', preserveAspectRatio: 'none', class: 'spark', 'aria-hidden': 'true' })
  const highest = Math.max(0, ...values)
  const line = smoothPath(values.map((value, index) => [sparklineAcross(index, values.length, width), sparklineDown(value, highest, height)]))
  createSvgElement('path', { d: line + 'L' + width + ',' + height + 'L0,' + height + 'Z', style: 'fill:' + colour + ';fill-opacity:.1' }, chart)
  const lineStyle = { fill: 'none', style: 'stroke:' + colour, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }
  createSvgElement('path', Object.assign({ d: line }, lineStyle), chart)
  return chart
}

export function totalTileDefinitions() {
  return [
    { label: 'Cost', metric: 'cost', isRiseBad: true },
    { label: 'Agent time', metric: 'time', isRiseBad: false },
    { label: 'Tokens', metric: 'tokens', isRiseBad: false },
    { label: 'Sessions', total: sessionCount, daily: sessionsPerDay, format: String, isRiseBad: false },
  ]
}

export function measuresOfTile(definition) {
  if (definition.total) return definition
  const metric = board.metrics[definition.metric]
  return {
    label: definition.label,
    isRiseBad: definition.isRiseBad,
    total: rows => sum(rows.map(metric.pick)),
    daily: (rows, keys) => perDay(rows, keys, metric.pick),
    format: metric.format,
  }
}

export function changeArrow(change) {
  if (change === 0) return ''
  return change > 0 ? '↑ ' : '↓ '
}

export function changeTone(change, isRiseBad) {
  if (!isRiseBad || change === 0) return ''
  return change > 0 ? ' bad' : ' good'
}

export function totalValueElement(measures, total, before) {
  const value = createElement('div', 'kpi-value', measures.format(total))
  if (!(before > 0)) return value
  const change = Math.round(((total - before) / before) * 100)
  value.append(createElement('span', 'delta' + changeTone(change, measures.isRiseBad), changeArrow(change) + Math.abs(change) + '%'))
  return value
}

export function totalTile(definition, periods) {
  const measures = measuresOfTile(definition)
  const before = measures.total(periods.previous)
  const note = before > 0 ? 'vs the ' + board.picked.period + ' days before' : periodText()
  const tile = createElement('div', 'card kpi')
  tile.append(
    createElement('div', 'kpi-label', measures.label),
    totalValueElement(measures, measures.total(periods.current), before),
    createElement('div', 'kpi-note', note),
    sparkline(measures.daily(periods.rows, periods.keys), 'var(--s1)'),
  )
  return tile
}

export function renderTotals(rows, keys, current) {
  const tiles = elementById('kpis')
  const previous = rowsWithin(rows, dayKeys(board.now, board.picked.period * 2).slice(0, board.picked.period))
  tiles.textContent = ''
  tiles.hidden = board.rows.length === 0
  totalTileDefinitions().forEach(definition => tiles.append(totalTile(definition, { rows, keys, current, previous })))
}

export function quotaLevel(used) {
  if (used >= 90) return 'critical'
  return used >= 70 ? 'warning' : 'normal'
}

export function quotaLabel(kind) {
  return Object.hasOwn(QUOTA_LABELS, kind) ? QUOTA_LABELS[kind] : String(kind).replace(/_/g, ' ')
}

export function resetText(resetsAt) {
  const at = resetTimeMs(resetsAt)
  if (!Number.isFinite(at)) return 'Reset time not reported'
  const when = WEEKDAY_NAMES[new Date(at).getDay()] + ' ' + clockTime(at)
  return at > board.now ? 'Resets in ' + duration(at - board.now) + ', ' + when : 'Reset ' + when
}

export function quotaWarning(level) {
  if (level === 'normal') return []
  const isCritical = level === 'critical'
  return [createElement('i', 'status-icon', isCritical ? '!' : '▲'), createElement('span', '', isCritical ? 'Near the limit.' : 'Getting close.')]
}

export function quotaTrack(used, label) {
  const track = createElement('div', 'bar-track')
  const fill = createElement('div', 'bar-fill')
  setAttributes(track, { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(used)), 'aria-label': label })
  fill.style.width = used + '%'
  track.append(fill)
  return track
}

export function quotaMeter(limit) {
  const used = Math.max(0, Math.min(100, finiteOrZero(limit.percentUsed)))
  const level = quotaLevel(used)
  const label = quotaLabel(limit.kind)
  const meter = createElement('div', 'meter ' + level)
  const head = createElement('div', 'meter-head')
  const foot = createElement('div', 'meter-foot')
  head.append(createElement('span', 'label', label), createElement('b', '', Math.round(used) + '%'))
  foot.append(...quotaWarning(level), createElement('span', '', resetText(limit.resetsAt)))
  meter.append(head, quotaTrack(used, label), foot)
  return meter
}

export function renderQuota() {
  const limits = newestRateLimits(board.rows)
  const meters = elementById('quota-meters')
  meters.textContent = ''
  elementById('quota').hidden = limits.length === 0
  if (limits.length === 0) return
  const newest = board.rows[board.rows.length - 1]
  elementById('quota-sub').textContent = 'As of the last turn, ' + stamp(Date.parse(newest.at))
  limits.forEach(limit => meters.append(quotaMeter(limit)))
}

export function streamGroups(projects) {
  const isColoured = project => board.projectOrder.indexOf(project) < COLOURED_PROJECT_SLOTS
  const groups = projects.filter(isColoured).map(project => ({ name: project, colour: colourOfProject(project), members: [project] }))
  const rest = projects.filter(project => !isColoured(project))
  if (rest.length > 0) groups.push({ name: 'Other (' + rest.length + ')', colour: 'var(--s-other)', members: rest })
  return groups
}

export function streamGeometry(chart, count, highest) {
  const bounds = chart.getBoundingClientRect()
  const width = Math.max(320, Math.round(bounds.width) || 900)
  const height = Math.round(bounds.height) || 280
  return { width, height, left: 52, right: 10, top: 12, base: height - 26, count, highest: niceMaximum(highest) }
}

export function acrossAt(geometry, index) {
  const plotWidth = geometry.width - geometry.left - geometry.right
  return geometry.left + (geometry.count > 1 ? (index * plotWidth) / (geometry.count - 1) : plotWidth / 2)
}

export function downAt(geometry, value) {
  return geometry.base - (value / geometry.highest) * (geometry.base - geometry.top)
}

export function svgText(chart, attributes, text) {
  createSvgElement('text', attributes, chart).textContent = text
}

export function drawStreamAxes(chart, geometry, metric, keys) {
  ;[0.5, 1].forEach(fraction => {
    const level = geometry.highest * fraction
    const down = downAt(geometry, level)
    createSvgElement('line', { x1: geometry.left, x2: geometry.width - geometry.right, y1: down, y2: down, class: 'gridline' }, chart)
    svgText(chart, { x: geometry.left - 8, y: down + 4, 'text-anchor': 'end', class: 'axis' }, metric.format(level))
  })
  svgText(chart, { x: geometry.left - 8, y: geometry.base + 4, 'text-anchor': 'end', class: 'axis' }, metric.format(0))
  const step = Math.max(1, Math.ceil(keys.length / 7))
  for (let index = 0; index < keys.length; index += step) {
    svgText(chart, { x: acrossAt(geometry, index), y: geometry.height - 4, class: 'axis', 'text-anchor': index ? 'middle' : 'start' }, shortDate(keys[index]))
  }
}

export function drawStreamLayer(chart, geometry, lower, upper, colour) {
  const pointOf = (value, index) => [acrossAt(geometry, index), downAt(geometry, value)]
  const upperPath = smoothPath(upper.map(pointOf))
  const lowerPath = smoothPath(lower.map(pointOf).reverse())
  createSvgElement('path', { d: upperPath + 'L' + lowerPath.slice(1) + 'Z', style: 'fill:' + colour + ';fill-opacity:.22' }, chart)
  return { path: upperPath, colour, values: upper }
}

export function drawStreamLayers(chart, geometry, series, visible) {
  let lower = new Array(geometry.count).fill(0)
  const layerTops = series.map((values, layer) => {
    const upper = lower.map((value, index) => value + values[index])
    const layerTop = drawStreamLayer(chart, geometry, lower, upper, visible[layer].colour)
    lower = upper
    return layerTop
  })
  // The top edge of each layer is its 2px line; the surface-coloured underlay keeps neighbouring edges apart.
  layerTops.forEach(layerTop => createSvgElement('path', { d: layerTop.path, fill: 'none', style: 'stroke:var(--surface)', 'stroke-width': 4 }, chart))
  layerTops.forEach(layerTop => createSvgElement('path', { d: layerTop.path, fill: 'none', style: 'stroke:' + layerTop.colour, 'stroke-width': 2, 'stroke-linejoin': 'round' }, chart))
  return layerTops
}

export function tipRow(group, valueText) {
  const row = createElement('div', 'tip-row')
  row.append(swatch(group.colour), createElement('span', 'name', group.name), createElement('span', 'v', valueText))
  return row
}

export function fillStreamTip(index) {
  const stream = board.stream
  const tip = elementById('tip')
  const day = stream.keys[index]
  tip.textContent = ''
  tip.append(
    createElement('div', 'tip-head', WEEKDAY_NAMES[new Date(day + 'T12:00').getDay()] + ' ' + shortDate(day)),
    createElement('div', 'tip-total', stream.metric.format(stream.totals[index])),
  )
  if (stream.visible.length < 2) return
  for (let layer = stream.visible.length - 1; layer >= 0; layer--) {
    if (stream.series[layer][index]) tip.append(tipRow(stream.visible[layer], stream.metric.format(stream.series[layer][index])))
  }
}

export function placeStreamTip(index) {
  const stream = board.stream
  const tip = elementById('tip')
  const shownWidth = stream.chart.getBoundingClientRect().width || stream.geometry.width
  const scale = shownWidth / stream.geometry.width
  tip.style.left = Math.min(Math.max(0, acrossAt(stream.geometry, index) * scale + 14), Math.max(0, shownWidth - 200)) + 'px'
  tip.style.top = Math.max(0, downAt(stream.geometry, stream.totals[index]) * scale - 30) + 'px'
  tip.hidden = false
}

export function showStreamDay(index) {
  const stream = board.stream
  const across = acrossAt(stream.geometry, index)
  setAttributes(stream.hairline, { x1: across, x2: across, visibility: 'visible' })
  stream.dots.forEach((dot, layer) => setAttributes(dot, { cx: across, cy: downAt(stream.geometry, stream.layerTops[layer].values[index]), visibility: 'visible' }))
  fillStreamTip(index)
  placeStreamTip(index)
  board.picked.cursor = index
}

export function hideStreamDay() {
  board.stream.hairline.setAttribute('visibility', 'hidden')
  board.stream.dots.forEach(dot => dot.setAttribute('visibility', 'hidden'))
  elementById('tip').hidden = true
}

export function onStreamPointer(event) {
  const geometry = board.stream.geometry
  const bounds = board.stream.chart.getBoundingClientRect()
  const pointer = ((event.clientX - bounds.left) / (bounds.width || geometry.width)) * geometry.width
  const plotWidth = Math.max(1, geometry.width - geometry.left - geometry.right)
  const index = Math.round(((pointer - geometry.left) / plotWidth) * (geometry.count - 1))
  showStreamDay(Math.max(0, Math.min(geometry.count - 1, index)))
}

export function nextStreamDay(key, current, last) {
  const moves = { ArrowLeft: Math.max(0, current - 1), ArrowRight: Math.min(last, current + 1), Home: 0, End: last }
  return Object.hasOwn(moves, key) ? moves[key] : undefined
}

export function onStreamKey(event) {
  const last = board.stream.geometry.count - 1
  const next = nextStreamDay(event.key, board.picked.cursor === null ? last : board.picked.cursor, last)
  if (next === undefined) return
  if (event.preventDefault) event.preventDefault()
  showStreamDay(next)
}

export function drawStreamChart(stream) {
  const chart = stream.chart
  const geometry = streamGeometry(chart, stream.keys.length, Math.max(0, ...stream.totals))
  chart.setAttribute('viewBox', '0 0 ' + geometry.width + ' ' + geometry.height)
  chart.textContent = ''
  drawStreamAxes(chart, geometry, stream.metric, stream.keys)
  const layerTops = drawStreamLayers(chart, geometry, stream.series, stream.visible)
  createSvgElement('line', { x1: geometry.left, x2: geometry.width - geometry.right, y1: geometry.base, y2: geometry.base, class: 'baseline' }, chart)
  const hairline = createSvgElement('line', { y1: geometry.top, y2: geometry.base, class: 'crosshair', visibility: 'hidden' }, chart)
  const dotStyle = layerTop => ({ r: 4, style: 'fill:' + layerTop.colour + ';stroke:var(--surface)', 'stroke-width': 2, visibility: 'hidden' })
  const dots = layerTops.map(layerTop => createSvgElement('circle', dotStyle(layerTop), chart))
  board.stream = Object.assign({}, stream, { geometry, layerTops, hairline, dots })
  chart.onmousemove = onStreamPointer
  chart.onmouseleave = hideStreamDay
  chart.onblur = hideStreamDay
  chart.onfocus = () => showStreamDay(geometry.count - 1)
  chart.onkeydown = onStreamKey
}

export function describeStream(chart, metric, total) {
  elementById('stream-label').textContent = metric.label + ', ' + periodText()
  elementById('stream-total').textContent = metric.format(total)
  chart.setAttribute('aria-label', metric.label + ' per project and day, ' + periodText() + '. The table below lists the same values.')
}

export function renderStream(current, keys) {
  elementById('stream').hidden = current.length === 0
  if (current.length === 0) return
  const metric = board.metrics[board.picked.metric]
  const chart = elementById('stream-chart')
  const groups = streamGroups(projectsIn(current))
  const visible = groups.filter(group => !board.picked.hiddenGroups[group.name])
  const series = visible.map(group => perDay(current.filter(row => group.members.includes(row.project)), keys, metric.pick))
  const totals = keys.map((key, index) => sum(series.map(values => values[index])))
  elementById('tip').hidden = true
  board.picked.cursor = null
  describeStream(chart, metric, sum(totals))
  renderLegend(groups)
  renderStreamTable(visible, series, totals, keys, metric)
  drawStreamChart({ chart, metric, keys, visible, series, totals })
}

export function renderStreamForPicked() {
  const keys = dayKeys(board.now, board.picked.period)
  renderStream(rowsWithin(scopedRows(), keys), keys)
}

export function legendChip(group) {
  const isHidden = Boolean(board.picked.hiddenGroups[group.name])
  const chip = createElement('button', 'chip')
  chip.type = 'button'
  chip.title = (isHidden ? 'Show ' : 'Hide ') + group.name
  chip.setAttribute('aria-pressed', String(!isHidden))
  chip.append(swatch(group.colour), createElement('span', 'label-text', group.name))
  chip.addEventListener('click', () => {
    board.picked.hiddenGroups[group.name] = !isHidden
    renderStreamForPicked()
  })
  return chip
}

export function renderLegend(groups) {
  const legend = elementById('legend')
  legend.textContent = ''
  if (groups.length < 2) return
  groups.forEach(group => legend.append(legendChip(group)))
}

export function streamTableRow(day, values, total, metric) {
  const row = createElement('tr')
  row.append(
    createElement('td', '', shortDate(day)),
    ...values.map(value => createElement('td', 'r', metric.format(value))),
    createElement('td', 'r', metric.format(total)),
  )
  return row
}

export function renderStreamTable(visible, series, totals, keys, metric) {
  const head = elementById('stream-head')
  const body = elementById('stream-rows')
  const headRow = createElement('tr')
  head.textContent = ''
  body.textContent = ''
  headRow.append(createElement('th', '', 'Day'), ...visible.map(group => createElement('th', 'r', group.name)), createElement('th', 'r', 'Total'))
  head.append(headRow)
  for (let index = keys.length - 1; index >= 0; index--) {
    if (totals[index]) body.append(streamTableRow(keys[index], series.map(values => values[index]), totals[index], metric))
  }
}

export function barWidth(value, highest) {
  return Math.max(2, highest > 0 ? (value / highest) * 100 : 0)
}

export function inlineBar(value, highest, text) {
  const wrap = createElement('div', 'inline-bar')
  const track = createElement('div', 'bar-track')
  const fill = createElement('div', 'bar-fill')
  fill.style.width = barWidth(value, highest) + '%'
  track.append(fill)
  wrap.append(track, createElement('span', 'v', text))
  return wrap
}

export function tableCell(content, className) {
  const cell = createElement('td', className || '')
  if (typeof content === 'string') cell.textContent = content
  else cell.append(content)
  return cell
}

export function miniMeter(share, text) {
  const wrap = createElement('span', 'mini')
  const track = createElement('span', 'bar-track')
  const fill = createElement('span', 'bar-fill')
  fill.style.display = 'block'
  fill.style.width = Math.min(100, Math.max(0, share * 100)) + '%'
  track.style.display = 'block'
  track.append(fill)
  wrap.append(track, createElement('span', '', text))
  return wrap
}

export function modelRow(model, mostTokens) {
  const row = createElement('tr')
  row.append(
    tableCell(model.name, 'mono'),
    tableCell(inlineBar(model.tokens, mostTokens, compactNumber(model.tokens))),
    tableCell(compactNumber(model.requests), 'r'),
    tableCell(model.requests ? latency(model.meanLatencyMs) : '–', 'r'),
    tableCell(miniMeter(model.cacheShare, percent(model.cacheShare))),
  )
  return row
}

export function renderModels(current) {
  const mix = modelMix(current)
  const body = elementById('models-rows')
  body.textContent = ''
  elementById('models').hidden = mix.length === 0
  if (mix.length === 0) return
  const requests = sum(mix.map(model => model.requests))
  const cacheReads = sum(mix.map(model => model.cacheRead))
  const inputSide = sum(mix.map(model => model.input + model.cacheRead + model.cacheWrite))
  elementById('models-sub').textContent = plural(requests, 'request') + ' · cache reads ' + percent(inputSide ? cacheReads / inputSide : 0) + ' of input'
  mix.forEach(model => body.append(modelRow(model, mix[0].tokens)))
}

export function toolStack(tool, mostCalls) {
  const stack = createElement('div', 'stack')
  const succeeded = Math.max(0, tool.calls - tool.errors - tool.denies)
  const parts = [[succeeded, 'var(--s1)'], [tool.errors, 'var(--critical)'], [tool.denies, 'var(--warning)']]
  stack.style.width = barWidth(tool.calls, mostCalls) + '%'
  stack.style.flex = 'none'
  parts
    .filter(part => part[0] > 0)
    .forEach(part => {
      const segment = createElement('i')
      segment.style.setProperty('--c', part[1])
      segment.style.flexGrow = String(part[0])
      stack.append(segment)
    })
  return stack
}

export function toolCallsBar(tool, mostCalls) {
  const wrap = createElement('div', 'inline-bar')
  const holder = createElement('div', '')
  holder.style.flex = '1'
  holder.append(toolStack(tool, mostCalls))
  wrap.append(holder, createElement('span', 'v', compactNumber(tool.calls)))
  return wrap
}

export function countFlag(count, mark, colour) {
  if (!count) return createElement('span', 'dim', '–')
  const flag = createElement('span', 'flag')
  flag.style.setProperty('--c', colour)
  flag.append(createElement('i', '', mark), createElement('span', '', compactNumber(count)))
  return flag
}

export function toolRow(tool, mostCalls) {
  const row = createElement('tr')
  row.append(
    tableCell(tool.name, 'mono'),
    tableCell(toolCallsBar(tool, mostCalls)),
    tableCell(countFlag(tool.errors, '✕', 'var(--critical)'), 'r'),
    tableCell(countFlag(tool.denies, '⊘', 'var(--warning)'), 'r'),
    tableCell(tool.calls ? latency(tool.ms / tool.calls) : '–', 'r'),
  )
  return row
}

export function renderTools(current) {
  const tools = toolRanking(current)
  const body = elementById('tools-rows')
  body.textContent = ''
  elementById('tools').hidden = tools.length === 0
  if (tools.length === 0) return
  tools.forEach(tool => body.append(toolRow(tool, tools[0].calls)))
}

export function ticketRow(ticket, highestCost) {
  const row = createElement('tr')
  row.append(
    tableCell(ticket.name, 'mono'),
    tableCell(compactNumber(ticket.turns), 'r'),
    tableCell(compactNumber(ticket.tokens), 'r'),
    tableCell(duration(ticket.durationMs), 'r'),
    tableCell(inlineBar(ticket.costUsd, highestCost, money(ticket.costUsd))),
  )
  return row
}

export function renderTickets(current) {
  const tickets = ticketTotals(current)
  const body = elementById('tickets-rows')
  body.textContent = ''
  elementById('tickets').hidden = tickets.length === 0
  if (tickets.length === 0) return
  elementById('tickets-sub').textContent = plural(tickets.length, 'ticket') + ' · ' + money(sum(tickets.map(ticket => ticket.costUsd)))
  tickets.forEach(ticket => body.append(ticketRow(ticket, tickets[0].costUsd)))
}

export function outcomePill(reason) {
  const outcome = Object.hasOwn(OUTCOMES, reason) ? OUTCOMES[reason] : ['var(--muted)', '•', String(reason || 'unknown')]
  const pill = createElement('span', 'pill')
  pill.style.setProperty('--c', outcome[0])
  pill.append(createElement('i', '', outcome[1]), createElement('span', '', outcome[2]))
  return pill
}

export function sessionMatches(session, query) {
  return !query || [session.name, session.project, session.model].concat(session.tickets).join(' ').toLowerCase().includes(query)
}

export function sessionDetails(session) {
  const details = [board.picked.project ? '' : session.project, stamp(session.started)].concat(session.tickets)
  if (session.compactions) details.push('compacted ×' + session.compactions)
  if (session.agents) details.push(plural(session.agents, 'subagent'))
  return details.filter(Boolean).join(' · ')
}

export function sessionRow(session) {
  const row = createElement('tr')
  const nameCell = createElement('td', 'wrap')
  const title = createElement('div', 'title', session.name || 'Untitled session')
  title.title = session.name
  nameCell.append(title, createElement('div', 'sub', sessionDetails(session)))
  row.append(
    nameCell,
    tableCell(session.model || '–', 'mono'),
    tableCell(String(session.turns), 'r'),
    tableCell(compactNumber(session.requests), 'r'),
    tableCell(money(session.costUsd), 'r'),
    tableCell(duration(session.durationMs), 'r'),
    tableCell(compactNumber(session.tokens), 'r'),
    tableCell(miniMeter(session.contextPeak / 100, Math.round(session.contextPeak) + '%')),
    tableCell(outcomePill(session.outcome)),
  )
  return row
}

export function noSessionRow() {
  const row = createElement('tr')
  const cell = createElement('td', 'empty-row', 'No session matches.')
  cell.colSpan = SESSION_COLUMNS
  row.append(cell)
  return row
}

export function renderSessions(rows, keys) {
  const periodStart = new Date(keys[0] + 'T00:00').getTime()
  const query = board.picked.query.trim().toLowerCase()
  const body = elementById('sessions-rows')
  const inPeriod = sessionsFrom(rows).filter(session => session.ended >= periodStart)
  const shown = inPeriod.filter(session => sessionMatches(session, query))
  body.textContent = ''
  elementById('sessions').hidden = inPeriod.length === 0
  elementById('sessions-count').textContent = String(shown.length)
  if (shown.length === 0) body.append(noSessionRow())
  shown.forEach(session => body.append(sessionRow(session)))
}

export function hexagonCorner(centre, radius, corner) {
  const angle = (Math.PI / 3) * corner - Math.PI / 2
  return (corner ? 'L' : 'M') + (centre[0] + radius * Math.cos(angle)).toFixed(1) + ',' + (centre[1] + radius * Math.sin(angle)).toFixed(1)
}

export function hexagonPath(centre, radius) {
  return [0, 1, 2, 3, 4, 5].map(corner => hexagonCorner(centre, radius, corner)).join('') + 'Z'
}

export function activityLevel(value, highest) {
  return value > 0 ? Math.max(1, Math.ceil((value / highest) * 5)) : 0
}

export function honeycombLayout(keys) {
  const radius = 15
  const firstWeekday = new Date(keys[0] + 'T12:00').getDay()
  return { radius, cellWidth: Math.sqrt(3) * radius, left: 34, top: radius + 2, firstWeekday, columns: Math.ceil((keys.length + firstWeekday) / 7) }
}

export function honeycombCentre(layout, position) {
  const weekday = position % 7
  const across = layout.left + Math.floor(position / 7) * layout.cellWidth + (weekday % 2 ? layout.cellWidth / 2 : 0)
  return [across, layout.top + weekday * layout.radius * 1.5]
}

export function drawHoneycombCells(chart, layout, keys, values) {
  const highest = Math.max(0, ...values)
  keys.forEach((key, index) => {
    const position = index + layout.firstWeekday
    const cell = createSvgElement('path', { d: hexagonPath(honeycombCentre(layout, position), layout.radius), class: 'hx hx' + activityLevel(values[index], highest) }, chart)
    createSvgElement('title', {}, cell).textContent = WEEKDAY_NAMES[position % 7] + ' ' + shortDate(key) + ': ' + (values[index] ? duration(values[index]) : 'no turns')
  })
}

export function drawHoneycombKey(chart, layout) {
  const right = layout.left + layout.columns * layout.cellWidth + layout.cellWidth / 2
  const keyDown = layout.top + 6 * layout.radius * 1.5 + layout.radius + 18
  ;['Mon', 'Wed', 'Fri'].forEach((day, index) => svgText(chart, { x: 0, y: layout.top + (1 + 2 * index) * layout.radius * 1.5 + 4, class: 'day' }, day))
  svgText(chart, { x: right - 34 - 5 * 14 - 12, y: keyDown + 4, 'text-anchor': 'end', class: 'day' }, 'Less')
  ;[0, 1, 2, 3, 4, 5].forEach(level => createSvgElement('path', { d: hexagonPath([right - 34 - (5 - level) * 14, keyDown], 6.5), class: 'hx hx' + level }, chart))
  svgText(chart, { x: right, y: keyDown + 4, 'text-anchor': 'end', class: 'day' }, 'More')
  chart.setAttribute('viewBox', '0 0 ' + Math.ceil(right + 2) + ' ' + Math.ceil(keyDown + 10))
  chart.setAttribute('width', Math.ceil(right + 2))
}

export function renderActivityHeroes(values) {
  const run = streaks(values)
  elementById('h-active').textContent = String(run.active)
  elementById('h-active-sub').textContent = percent(run.active / ACTIVITY_DAYS) + ' of the last ' + ACTIVITY_DAYS + ' days'
  elementById('h-streak').textContent = plural(run.current, 'day')
  elementById('h-streak-sub').textContent = 'longest ' + plural(run.longest, 'day')
}

export function busiestDay(current) {
  const timeOfDay = {}
  current.forEach(row => {
    const day = dayKey(Date.parse(row.at))
    timeOfDay[day] = (timeOfDay[day] || 0) + finiteOrZero(row.durationMs)
  })
  const busiest = Object.keys(timeOfDay).sort((first, second) => timeOfDay[second] - timeOfDay[first])[0]
  return busiest ? shortDate(busiest) + ' · ' + duration(timeOfDay[busiest]) : '–'
}

export function averageOverSessions(total, sessions, format) {
  return sessions.length > 0 ? format(total / sessions.length) : '–'
}

export function factList(current) {
  const sessions = sessionsFrom(current)
  const sessionTimes = sessions.map(session => session.durationMs)
  return [
    ['Busiest day', busiestDay(current)],
    ['Longest session', sessions.length > 0 ? duration(Math.max(...sessionTimes)) : '–'],
    ['Average time per session', averageOverSessions(sum(sessionTimes), sessions, duration)],
    ['Average cost per session', averageOverSessions(sum(current.map(board.metrics.cost.pick)), sessions, money)],
    ['Subagents spawned', compactNumber(sum(current.map(agentSpawns)))],
    ['Context compactions', compactNumber(current.filter(row => row.compacted).length)],
  ]
}

export function renderFacts(current) {
  const facts = elementById('facts')
  facts.textContent = ''
  factList(current).forEach(fact => {
    const row = createElement('div', 'fact')
    row.append(createElement('span', '', fact[0]), createElement('span', '', fact[1]))
    facts.append(row)
  })
  elementById('facts-sub').textContent = 'Facts cover the ' + periodText() + '.'
}

export function renderActivity(rows, current) {
  const chart = elementById('heat')
  const keys = dayKeys(board.now, ACTIVITY_DAYS)
  const values = perDay(rows, keys, board.metrics.time.pick)
  const hasActivity = values.some(value => value > 0)
  chart.textContent = ''
  elementById('activity').hidden = !hasActivity
  if (!hasActivity) return
  const layout = honeycombLayout(keys)
  drawHoneycombCells(chart, layout, keys, values)
  drawHoneycombKey(chart, layout)
  renderActivityHeroes(values)
  renderFacts(current)
}

export function renderBoard() {
  const rows = scopedRows()
  const keys = dayKeys(board.now, board.picked.period)
  const current = rowsWithin(rows, keys)
  renderProjectNav()
  renderHeader(current)
  renderEmptyState(current)
  renderTotals(rows, keys, current)
  renderQuota()
  renderStream(current, keys)
  renderModels(current)
  renderTools(current)
  renderTickets(current)
  renderSessions(rows, keys)
  renderActivity(rows, current)
}

export function wireSegment(id, apply) {
  const group = elementById(id)
  group.addEventListener('click', event => {
    const button = event.target.closest('button')
    if (!button) return
    Array.from(group.children).forEach(child => {
      child.classList.toggle('on', child === button)
      child.setAttribute('aria-pressed', String(child === button))
    })
    apply(button)
  })
}

export function pickPeriod(button) {
  board.picked.period = Number(button.getAttribute('data-period'))
  renderBoard()
}

export function pickMetric(button) {
  board.picked.metric = button.getAttribute('data-metric')
  renderStreamForPicked()
}

export function searchSessions(event) {
  board.picked.query = event.target.value
  renderSessions(scopedRows(), dayKeys(board.now, board.picked.period))
}

// A window drag fires resize many times a second; the chart is redrawn once it settles.
export function redrawAfterResize() {
  clearTimeout(board.resizeTimer)
  board.resizeTimer = setTimeout(renderStreamForPicked, 120)
}

export function nextTheme(choice) {
  return THEMES[(THEMES.indexOf(choice) + 1) % THEMES.length]
}

export function applyTheme(choice) {
  const button = elementById('theme')
  document.documentElement.setAttribute('data-theme', choice)
  button.setAttribute('data-choice', choice)
  button.setAttribute('aria-label', 'Theme: ' + choice + ', switch to ' + nextTheme(choice))
  button.title = 'Theme: ' + choice
}

// A browser that blocks storage still shows the board, in the system theme.
export function savedTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return THEMES.includes(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

export function saveTheme(choice) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    // Storage is blocked here, so the choice lasts for this page only.
  }
}

export function cycleTheme() {
  const choice = nextTheme(elementById('theme').getAttribute('data-choice'))
  applyTheme(choice)
  saveTheme(choice)
}

export function startBoard() {
  wireSegment('period', pickPeriod)
  wireSegment('metric', pickMetric)
  elementById('session-search').addEventListener('input', searchSessions)
  window.addEventListener('resize', redrawAfterResize)
  applyTheme(savedTheme())
  elementById('theme').addEventListener('click', cycleTheme)
  renderBoard()
}

