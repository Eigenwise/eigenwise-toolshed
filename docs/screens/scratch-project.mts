// A scratch folder outside the repository, and the slice of the host's engine the plugins' own readers and writers
// use, answered from the real disk. Nothing here reads the person's home or config folder.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { EngineInterface, FsBytes, FsEntry, FsReadBytesOptions, FsReadOptions, FsStat } from 'claude-code'

export const slashed = (path: string): string => path.replace(/\\/g, '/')

export const makeScratchFolder = (): string => slashed(mkdtempSync(join(tmpdir(), 'toolshed-screens-')))

export const removeScratchFolder = (folder: string): void => rmSync(folder, { recursive: true, force: true })

export const writeText = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const kindOf = (entry: { isDirectory: () => boolean; isFile: () => boolean }): FsEntry['kind'] => {
  if (entry.isDirectory()) return 'dir'
  return entry.isFile() ? 'file' : 'other'
}

// Sorted, and with no sizes or times, so two runs read a folder the same way whatever the disk returns.
const entriesOf = (folder: string): FsEntry[] =>
  readdirSync(folder, { withFileTypes: true })
    .map(entry => ({ name: entry.name, kind: kindOf(entry), size: 0, mtimeMs: 0, isLink: entry.isSymbolicLink() }))
    .sort((first, second) => first.name.localeCompare(second.name))

const statOf = (path: string): FsStat => {
  const stat = lstatSync(path)

  return { kind: kindOf(stat), size: 0, mtimeMs: 0, isLink: stat.isSymbolicLink() }
}

function readFromDisk(path: string): Promise<string>
function readFromDisk(path: string, options: FsReadBytesOptions): Promise<FsBytes>
function readFromDisk(path: string, options: FsReadOptions): Promise<string | FsBytes>
async function readFromDisk(path: string, options?: FsReadOptions): Promise<string | FsBytes> {
  return options?.as === 'bytes' ? { base64: readFileSync(path).toString('base64') } : readFileSync(path, 'utf8')
}

const notUsedByThePictures = (what: string): never => {
  throw new Error(`${what} is not used by the pictures`)
}

export const diskFiles: EngineInterface['fs'] = {
  read: readFromDisk,
  write: async (path, text) => writeText(path, text),
  exists: async path => existsSync(path),
  list: async path => entriesOf(path ?? '.'),
  stat: async path => statOf(path),
  ancestors: async () => notUsedByThePictures('fs.ancestors'),
}

// A scratch board has no environment of its own, so every variable reads as unset. Nothing the pictures draw runs a
// process or sets a variable, so either call throws, saying so.
export const engineOverDisk: Pick<EngineInterface, 'fs' | 'process' | 'env'> = {
  fs: diskFiles,
  process: {
    run: async () => notUsedByThePictures('process.run'),
    spawn: () => notUsedByThePictures('process.spawn'),
  },
  env: {
    get: async () => undefined,
    set: async () => notUsedByThePictures('env.set'),
  },
}
