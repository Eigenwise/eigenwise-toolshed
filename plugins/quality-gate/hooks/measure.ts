import type { EngineInterface, On } from 'claude-code'
import type { TestRun, TurnReport } from '../types'

export const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bvitest\b|\bjest\b|\bgo test\b|\bcargo test\b/
const TURN = { plugin: 'quality-gate', key: 'turn' } as const
const NOTICE = { plugin: 'quality-gate', key: 'coverageNoticeShown' } as const

type ProjectTurn = { files: Set<string>; since: string; agentId?: string; tests: TestRun }

function editedPath(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return
  return [Reflect.get(input, 'file_path'), Reflect.get(input, 'notebook_path')].find((value): value is string => typeof value === 'string')
}

function unfinishedShell(output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return false
  return Reflect.get(output, 'backgroundTaskId') !== undefined || Reflect.get(output, 'interrupted') === true
}

async function coverageNotice($: EngineInterface, unverified: boolean) {
  if (!unverified) return
  if ((await $.state.get(NOTICE)).value) return
  await $.ui.status('quality-gate: complexity only, coverage not set up')
  await $.state.set(NOTICE, true)
}

async function measureProject($: EngineInterface, cwd: string, project: ProjectTurn) {
  const result = await $.process.run(['node', `${$.plugin.root}/bin/quality-gate.js`, 'turn', '--json', '--project', cwd, '--since', project.since], { cwd, timeoutMs: 20000 })
  if (result.exitCode !== 0) return
  const report: TurnReport = JSON.parse(result.stdout)
  if (!Array.isArray(report.bodies) || !Array.isArray(report.signals) || typeof report.unverified !== 'boolean') return
  const { value = {} } = await $.state.get(TURN)
  const at = new Date(await $.clock.now()).toISOString()
  await $.state.set(TURN, { ...value, [cwd]: { at, bodies: report.bodies, signals: report.signals, unverified: report.unverified, tests: { ...project.tests } } })
  await coverageNotice($, report.unverified)
}

export function registerMeasurement(on: On) {
  const projects = new Map<string, ProjectTurn>()
  const starts = new Map<string | undefined, string>()

  function projectFor(cwd: string, at: string, agentId?: string): ProjectTurn {
    let project = projects.get(cwd)
    if (!project) {
      project = { files: new Set(), since: at, agentId, tests: { status: 'none', at: '', stale: false } }
      projects.set(cwd, project)
    }
    return project
  }

  on('turn.start', async ($, event, next) => {
    const result = await next(event)
    try {
      starts.set(event.agentId, new Date(await $.clock.now()).toISOString())
    } catch {}
    return result
  })

  on('classic.PostToolUse', { tool_name: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, event, next) => {
    const result = await next(event)
    try {
      const file = editedPath(event.tool_input)
      if (!file) return result
      const at = new Date(await $.clock.now()).toISOString()
      const project = projectFor(event.cwd, at, event.agent_id)
      if (project.files.size === 0) project.since = starts.get(event.agent_id) ?? at
      project.files.add(file)
      project.tests.stale = true
    } catch {}
    return result
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'], command: TEST_COMMAND }, async ($, event, next) => {
    const result = await next(event)
    try {
      if (unfinishedShell(result.result)) return result
      const cwd = await $.session.cwd()
      const at = new Date(await $.clock.now()).toISOString()
      const project = projectFor(cwd, at, event.agentId)
      project.tests = { status: result.isError || result.deny ? 'fail' : 'pass', at, stale: false }
    } catch {}
    return result
  })

  on('turn.complete', async ($, event, next) => {
    const result = await next(event)
    for (const [cwd, project] of projects) {
      if (project.agentId !== event.agentId || project.files.size === 0) continue
      project.files.clear()
      try {
        await measureProject($, cwd, project)
      } catch {}
    }
    starts.delete(event.agentId)
    return result
  })
}
