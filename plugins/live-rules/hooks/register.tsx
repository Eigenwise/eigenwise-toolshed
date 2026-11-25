import type { Register } from 'claude-code'

import { tellAboutOlderToolshed } from './older-toolshed-session'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await tellAboutOlderToolshed($, e.cwd, 'rules').catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))
}
