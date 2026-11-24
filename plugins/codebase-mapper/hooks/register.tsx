import type { EngineInterface, Register } from 'claude-code'

import { staleLine } from './stale-line'

const CARD_DIRECTORY = '.claude/rules/map'

const showStaleLine = async ($: EngineInterface, cwd: string): Promise<void> => {
  if (!(await $.fs.exists(`${cwd}/${CARD_DIRECTORY}`))) return
  const result = await $.process.run(['node', `${$.plugin.root}/scripts/map-status.mjs`, '--root', cwd], { cwd })
  const line = staleLine(result.stdout)
  if (line) await $.ui.status(line)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void showStaleLine($, e.cwd).catch(() => undefined)

    return next(e)
  })
}
