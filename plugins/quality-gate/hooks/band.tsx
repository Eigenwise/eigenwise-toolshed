import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { MeasuredBody, TurnMeasurement } from '../types'

const turns = atom({ plugin: 'quality-gate', key: 'turn' } as const, {})
const noticeAt = atom({ plugin: 'quality-gate', key: 'bandCoverageNoticeAt' } as const, '')

function needsSplit(body: MeasuredBody): boolean {
  return body.state !== 'legacy-unchanged' && body.cc >= 6
}

function complexityText(bodies: MeasuredBody[]): string {
  const maximum = Math.max(0, ...bodies.map(body => body.cc))
  const splits = bodies.filter(needsSplit).length
  return `CC ${maximum} ${splits ? `SPLIT ${splits}` : 'ok'}`
}

async function coverageSuffix($: EngineInterface, turn: TurnMeasurement): Promise<string> {
  if (!turn.unverified) return ''
  const shownAt = await read($, noticeAt)
  return shownAt === turn.at ? ' · coverage not set up' : ''
}

async function bandText($: EngineInterface, turn: TurnMeasurement): Promise<string> {
  const usage = await $.session.usage()
  const cost = usage.cost?.usd ?? 0
  const stale = turn.tests.stale ? ' stale' : ''
  return `$${cost.toFixed(2)} · ${complexityText(turn.bodies)} · tests ${turn.tests.status}${stale}${await coverageSuffix($, turn)}`
}

export function registerBand(on: On) {
  on('state.set', { plugin: 'quality-gate', key: 'turn' }, async ($, event, next) => {
    const result = await next(event)
    const turn = event.value[await $.session.cwd()]
    if (!turn?.unverified || (await $.store.get('enabled')) === false) return result
    if (!(await read($, noticeAt))) {
      await $.state.set({ plugin: 'quality-gate', key: 'bandCoverageNoticeAt' }, turn.at)
    }
    return result
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    const below = await next(event)
    if (event.props.hasSurvey || (await $.store.get('enabled')) === false) return below
    const turn = (await read($, turns))[await $.session.cwd()]
    if (!turn) return below
    const text = await bandText($, turn)
    const { Box, Text } = $.ui.resolve(event)
    return (
      <Box flexDirection="column" width={event.props.bodyColumns}>
        <Text dimColor wrap="truncate-end">{text}</Text>
        {below}
      </Box>
    )
  })
}
