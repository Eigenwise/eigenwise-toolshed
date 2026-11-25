import type { EngineInterface } from 'claude-code'

import { homeDirectoryOf } from './config-directory.mjs'

export async function homeOf($: EngineInterface): Promise<string | undefined> {
  const [HOME, USERPROFILE] = await Promise.all([$.env.get('HOME'), $.env.get('USERPROFILE')])

  return homeDirectoryOf({ HOME, USERPROFILE })
}
