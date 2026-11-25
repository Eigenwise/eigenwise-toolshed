// Type-checks the picture pipeline in screens/ against the host's types and the plugins' own code.
// The host types are untracked (see scripts/check.mjs at the repository root), so without them this says the
// pipeline's types were not measured and neither fails nor passes them.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mainCheckoutRoot, repositoryRoot } from '../../scripts/repository.mjs'

const docsFolder = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostTypesPath = ['.types', 'claude-code.d.ts']
const hostTypes = join(repositoryRoot, ...hostTypesPath)

// A linked worktree starts without the untracked types: take the main checkout's copy, as the repository's check does.
function borrowHostTypesFromMainCheckout() {
  const mainCopy = join(mainCheckoutRoot() ?? repositoryRoot, ...hostTypesPath)
  if (existsSync(hostTypes) || !existsSync(mainCopy)) return
  mkdirSync(dirname(hostTypes), { recursive: true })
  copyFileSync(mainCopy, hostTypes)
}

borrowHostTypesFromMainCheckout()

if (!existsSync(hostTypes)) {
  console.log(`screens: host types not found at ${hostTypes}, so the picture pipeline's types are not measured`)
} else {
  const typescript = join(docsFolder, 'node_modules', 'typescript', 'bin', 'tsc')
  const ran = spawnSync(process.execPath, [typescript, '-p', join(docsFolder, 'screens')], { stdio: 'inherit' })
  if (ran.status === 0) console.log('screens: types check')
  process.exitCode = ran.status ?? 1
}
