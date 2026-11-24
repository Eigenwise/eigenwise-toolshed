import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

import { newTicket, parseTicket, serializeStory, serializeTicket, newStory } from './tickets'
import type { Ticket } from './tickets'

const ROOT = '/repo'
const BOARD = `${ROOT}/.sidequest`
const TICKETS = `${BOARD}/tickets`
const STORIES = `${BOARD}/stories`
const BOARD_JSON = `${BOARD}/board.json`
const EXCLUDE = `${ROOT}/.git/info/exclude`
const NOW = Date.parse('2026-11-20T10:02:00Z')
const STAMP = '2026-11-20T09:00Z'

// The engine hands fs hooks an absolute path in the host's own spelling (C:\repo\... on Windows).
const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const childrenUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'dir')
  }

  return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
}

// What another session or a person does to the disk while a call runs: a read that throws, a file changed after it was
// read, a write that lands as something else, a file that appears while git runs.
type Disk = {
  files: Map<string, string>
  lockedPaths?: ReadonlySet<string>
  refusedWrites?: ReadonlySet<string>
  afterRead?: (path: string) => void
  landsAs?: (path: string, text: string) => string
  whileGitRuns?: (subcommand: string) => void
}

const gitAnswer = (subcommand: string): { exitCode: number; stdout: string } => {
  if (subcommand === 'rev-parse') return { exitCode: 0, stdout: `${ROOT}/.git\n` }
  if (subcommand === 'for-each-ref') return { exitCode: 0, stdout: 'main\n' }
  if (subcommand === 'ls-files') return { exitCode: 0, stdout: '' }

  return { exitCode: 1, stdout: '' }
}

const standInForEngine = (on: On, disk: Disk): void => {
  on('fs.read', (_, e) => {
    const path = portablePath(e.path)
    if (disk.lockedPaths?.has(path)) return { deny: `EBUSY: resource busy or locked, open '${path}'` }
    const text = disk.files.get(path)
    if (text === undefined) return { deny: `ENOENT ${e.path}` }
    disk.afterRead?.(path)

    return { value: text }
  })
  on('fs.write', (_, e) => {
    const path = portablePath(e.path)
    if (disk.lockedPaths?.has(path)) return { deny: `EBUSY: resource busy or locked, open '${path}'` }
    if (disk.refusedWrites?.has(path)) return { deny: `EACCES: permission denied, open '${path}'` }
    disk.files.set(path, disk.landsAs ? disk.landsAs(path, e.text) : e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const entries = childrenUnder(disk.files, portablePath(e.path))

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('process.run', (_, e) => {
    const subcommand = e.argv[1] ?? ''
    disk.whileGitRuns?.(subcommand)

    return { value: { ...gitAnswer(subcommand), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
}

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const writeTickets = async ($: Engine, operations: Record<string, unknown>[]) => textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations }))

const readView = async ($: Engine, view: string, fields: Record<string, unknown> = {}) =>
  textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view, ...fields }))

const ticketFile = (id: string, title: string, status = 'ready'): string => serializeTicket(newTicket(id, { title, status }, STAMP))

const boardOf = (...tickets: [string, string][]): Map<string, string> =>
  new Map([
    [BOARD_JSON, JSON.stringify({ prefix: 'SA', nextTicket: tickets.length + 1, nextStory: 1 })],
    ...tickets.map(([id, title]): [string, string] => [`${TICKETS}/${id}.md`, ticketFile(id, title)]),
  ])

const FIVE_TICKETS: [string, string][] = [
  ['SA-1', 'One'],
  ['SA-2', 'Two'],
  ['SA-3', 'Three'],
  ['SA-4', 'Four'],
  ['SA-5', 'Five'],
]

const parsed = (files: Map<string, string>, id: string): Ticket => parseTicket(files.get(`${TICKETS}/${id}.md`) ?? '')

const counterIn = (files: Map<string, string>): unknown => JSON.parse(files.get(BOARD_JSON) ?? '{}').nextTicket

const theirTicket = ticketFile('REPO-1', 'Filed by the other session')

test('a ticket file that appears while the first write runs git is left alone, and this one is filed under the next id', async ($, on) => {
  const files = new Map([[EXCLUDE, '']])
  standInForEngine(on, {
    files,
    whileGitRuns: subcommand => {
      if (subcommand === 'for-each-ref') files.set(`${TICKETS}/REPO-1.md`, theirTicket)
    },
  })
  await startSession($)

  const answer = await writeTickets($, [{ op: 'create', title: 'Mine' }])

  expect(answer).toContain('created REPO-1.')
  expect(answer).toContain('REPO-1 was filed by another session at the same moment, so the one created here is REPO-2. Use REPO-2 from now on.')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toBe(theirTicket)
  expect(parsed(files, 'REPO-2').title).toBe('Mine')
  expect(counterIn(files)).toBe(3)
})

test('a ticket file overwritten by another session right after the write is read back, and this one is filed again', async ($, on) => {
  const files = new Map([[EXCLUDE, '']])
  let isFirstWriteOfOne = true
  standInForEngine(on, {
    files,
    landsAs: (path, text) => {
      if (!path.endsWith('/REPO-1.md') || !isFirstWriteOfOne) return text
      isFirstWriteOfOne = false

      return theirTicket
    },
  })
  await startSession($)

  const answer = await writeTickets($, [
    { op: 'create', title: 'Mine' },
    { op: 'create', title: 'Waits on mine', blockedBy: ['REPO-1'] },
  ])

  expect(answer).toContain('REPO-1 was filed by another session at the same moment, so the one created here is REPO-2.')
  expect(answer).toContain('REPO-2 was filed by another session at the same moment, so the one created here is REPO-3.')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toBe(theirTicket)
  expect(parsed(files, 'REPO-2').title).toBe('Mine')
  expect(parsed(files, 'REPO-3').blockedBy).toEqual(['REPO-2'])
  expect(counterIn(files)).toBe(4)
})

test('the counter in board.json never goes back when another session moved it on during the write', async ($, on) => {
  const files = boardOf(['SA-1', 'One'])
  let isArmed = false
  standInForEngine(on, {
    files,
    afterRead: path => {
      if (isArmed && path === BOARD_JSON) files.set(BOARD_JSON, JSON.stringify({ prefix: 'SA', nextTicket: 9, nextStory: 1 }))
      isArmed = isArmed && path !== BOARD_JSON
    },
  })
  await startSession($)
  isArmed = true

  expect(await writeTickets($, [{ op: 'create', title: 'Two' }])).toBe('created SA-2.')
  expect(counterIn(files)).toBe(9)
})

const COPY_NAMES = ['SA-5 (1)', 'SA-5.sync-conflict-20261120-101010-ABCDEFG', 'SA-5 - Copy']

test('a copy in the tickets folder is never read as the ticket: listed once, named as a stray, and never written', async ($, on) => {
  const files = boardOf(...FIVE_TICKETS)
  const copy = serializeTicket(newTicket('SA-5', { title: 'Five', status: 'done' }, STAMP))
  for (const name of COPY_NAMES) files.set(`${TICKETS}/${name}.md`, copy)
  files.set(`${STORIES}/SA-S1.md`, serializeStory(newStory('SA-S1', 'Story', STAMP)))
  files.set(`${STORIES}/SA-S1 (1).md`, serializeStory(newStory('SA-S1', 'Story copy', STAMP)))
  standInForEngine(on, { files })
  await startSession($)

  const list = await readView($, 'list')
  const noted = await writeTickets($, [{ op: 'note', id: 'SA-5', text: 'checked' }])

  expect(list.split('\n').filter(line => line.startsWith('SA-5 '))).toEqual(['SA-5 ready build Five'])
  expect(list).toContain(
    'Stray files, never read as a ticket or story and never written: .sidequest/tickets/SA-5 (1).md claims SA-5, .sidequest/tickets/SA-5.sync-conflict-20261120-101010-ABCDEFG.md claims SA-5, .sidequest/tickets/SA-5 - Copy.md claims SA-5.',
  )
  expect(await readView($, 'list', { of: 'stories' })).toContain('.sidequest/stories/SA-S1 (1).md claims SA-S1')
  expect(noted).toBe('noted SA-5.')
  expect(parsed(files, 'SA-5').status).toBe('ready')
  expect(parsed(files, 'SA-5').log.at(-1)).toContain('note checked')
  for (const name of COPY_NAMES) expect(files.get(`${TICKETS}/${name}.md`)).toBe(copy)
})

test('a ticket file that cannot be read is named in the reads and in a write that names it, and its number stays taken', async ($, on) => {
  const files = boardOf(...FIVE_TICKETS)
  files.set(BOARD_JSON, JSON.stringify({ prefix: 'SA', nextTicket: 5, nextStory: 1 }))
  standInForEngine(on, { files, lockedPaths: new Set([`${TICKETS}/SA-2.md`, `${TICKETS}/SA-5.md`]) })
  await startSession($)

  const summary = await readView($, 'summary')
  const noted = await writeTickets($, [{ op: 'note', id: 'SA-2', text: 'checked' }])
  const created = await writeTickets($, [{ op: 'create', title: 'Six' }])

  expect(summary).toContain(".sidequest/tickets/SA-2.md could not be read (EBUSY: resource busy or locked, open '/repo/.sidequest/tickets/SA-2.md'), so SA-2 is left out")
  expect(noted).toContain('SA-2: .sidequest/tickets/SA-2.md could not be read (EBUSY')
  expect(noted).not.toContain('no ticket SA-2 on this board')
  expect(created).toBe('created SA-6.')
  expect(parsed(files, 'SA-6').title).toBe('Six')
  expect(counterIn(files)).toBe(7)
})

test('an empty ticket file and a cut-off one are named as damaged, and a new id goes above them', async ($, on) => {
  const files = boardOf(['SA-1', 'One'])
  files.set(`${TICKETS}/SA-2.md`, '')
  files.set(`${TICKETS}/SA-3.md`, '---\nid: SA-3\ntitle: Thr')
  standInForEngine(on, { files })
  await startSession($)

  const list = await readView($, 'list')

  expect(list).toContain('.sidequest/tickets/SA-2.md is damaged (it has no id or no status), so SA-2 is left out and nothing writes to it.')
  expect(list).toContain('.sidequest/tickets/SA-3.md is damaged (it has no id or no status), so SA-3 is left out and nothing writes to it.')
  expect(await readView($, 'ticket', { id: 'SA-3' })).toContain('SA-3: .sidequest/tickets/SA-3.md is damaged')
  expect(await writeTickets($, [{ op: 'create', title: 'Four' }])).toBe('created SA-4.')
  expect(files.get(`${TICKETS}/SA-2.md`)).toBe('')
})

test('a new ticket file that cannot be written is said with the file and the reason, and the next create still works', async ($, on) => {
  const files = boardOf(['SA-1', 'One'])
  standInForEngine(on, { files, refusedWrites: new Set([`${TICKETS}/SA-2.md`]) })
  await startSession($)

  const answer = await writeTickets($, [{ op: 'create', title: 'Two' }])

  expect(answer).toBe("created SA-2.\n.sidequest/tickets/SA-2.md could not be written (EACCES: permission denied, open '/repo/.sidequest/tickets/SA-2.md'), so SA-2 was not created.")
  expect(files.has(`${TICKETS}/SA-2.md`)).toBe(false)
  expect(await writeTickets($, [{ op: 'create', title: 'Three' }])).toBe('created SA-3.')
})

test('a changed ticket file that cannot be written is said in the answer, with the file and the reason', async ($, on) => {
  const files = boardOf(['SA-1', 'One'])
  standInForEngine(on, { files, refusedWrites: new Set([`${TICKETS}/SA-1.md`]) })
  await startSession($)

  const answer = await writeTickets($, [{ op: 'note', id: 'SA-1', text: 'checked' }])

  expect(answer).toBe("noted SA-1.\n.sidequest/tickets/SA-1.md could not be written (EACCES: permission denied, open '/repo/.sidequest/tickets/SA-1.md'), so the change to SA-1 is not on the board.")
})

const HAND_LINE = '- 2026-11-20T09:30Z A line a person added by hand.\n'

// Counts only the reads after session start, so the reads the session start makes itself do not shift them.
const handEditAfterReads = (files: Map<string, string>, path: string, editAfter: readonly number[]) => {
  let reads = 0
  let isArmed = false

  return {
    arm: () => {
      isArmed = true
    },
    afterRead: (readPath: string) => {
      if (!isArmed || readPath !== path) return
      reads += 1
      if (editAfter.includes(reads)) files.set(path, `${files.get(path) ?? ''}${HAND_LINE}`)
    },
  }
}

test('a line added by hand between the read and the write is kept: the write is redone on the new text', async ($, on) => {
  const files = boardOf(['SA-1', 'One'])
  const path = `${TICKETS}/SA-1.md`
  const person = handEditAfterReads(files, path, [1])
  standInForEngine(on, { files, afterRead: person.afterRead })
  await startSession($)
  person.arm()

  const answer = await writeTickets($, [{ op: 'move', id: 'SA-1', status: 'doing' }])

  expect(answer).toBe('moved SA-1 to doing.')
  expect(files.get(path)).toContain('A line a person added by hand.')
  expect(parsed(files, 'SA-1').status).toBe('doing')
})

test('a ticket that changes again while the write is redone is left alone, and the answer says it changed on disk', async ($, on) => {
  const files = boardOf(['SA-1', 'One'])
  const path = `${TICKETS}/SA-1.md`
  const person = handEditAfterReads(files, path, [1, 3])
  standInForEngine(on, { files, afterRead: person.afterRead })
  await startSession($)
  person.arm()

  const answer = await writeTickets($, [{ op: 'move', id: 'SA-1', status: 'doing' }])

  expect(answer).toContain('SA-1 changed on disk while this call wrote it, and again after the change was redone on the new text, so nothing was written to SA-1.')
  expect(parsed(files, 'SA-1').status).toBe('ready')
  expect(files.get(path)?.split('A line a person added by hand.').length).toBe(3)
})

const prefixedTickets = (files: Map<string, string>): Map<string, string> => {
  files.delete(BOARD_JSON)

  return files
}

test('with board.json gone beside SA tickets the next ticket is SA-6, and board.json is written again with that prefix', async ($, on) => {
  const files = prefixedTickets(boardOf(...FIVE_TICKETS))
  standInForEngine(on, { files })
  await startSession($)

  const answer = await writeTickets($, [{ op: 'create', title: 'Six' }])

  expect(answer).toBe(
    'created SA-6.\n.sidequest/board.json was missing or empty, so it was written again with the counters from the files on disk and the prefix SA the tickets carry. Any settings it had are back at their defaults.',
  )
  expect(JSON.parse(files.get(BOARD_JSON) ?? '{}')).toMatchObject({ prefix: 'SA', nextTicket: 7, nextStory: 1 })
})

test('an empty board.json beside SA tickets is taken as missing and written again', async ($, on) => {
  const files = boardOf(...FIVE_TICKETS)
  files.set(BOARD_JSON, '')
  standInForEngine(on, { files })
  await startSession($)

  expect(await writeTickets($, [{ op: 'create', title: 'Six' }])).toContain('created SA-6.\n.sidequest/board.json was missing or empty')
  expect(JSON.parse(files.get(BOARD_JSON) ?? '{}')).toMatchObject({ prefix: 'SA', nextTicket: 7 })
})

test('a board.json with a missing brace is left byte for byte, ids carry SA, and the first read and first write name it once', async ($, on) => {
  const broken = '{ "prefix": "SA", "nextTicket": 6, "settings": { "verify": "npm test" }'
  const files = boardOf(...FIVE_TICKETS)
  files.set(BOARD_JSON, broken)
  standInForEngine(on, { files })
  await startSession($)
  const notice = '.sidequest/board.json is not valid JSON, so every setting is at its default until it is fixed.'

  const firstRead = await readView($, 'list')
  const secondRead = await readView($, 'frontier')
  const firstWrite = await writeTickets($, [{ op: 'create', title: 'Six' }])
  const secondWrite = await writeTickets($, [{ op: 'create', title: 'Seven' }])

  expect(firstRead).toContain(notice)
  expect(secondRead).not.toContain(notice)
  expect(firstWrite).toContain('created SA-6.')
  expect(firstWrite).toContain(notice)
  expect(secondWrite).toBe('created SA-7.')
  expect(files.get(BOARD_JSON)).toBe(broken)
})

test('a board of SQ tickets with board.json gone stays on SQ and is given no prefix', async ($, on) => {
  const files = new Map([[`${TICKETS}/SQ-1.md`, ticketFile('SQ-1', 'One')]])
  standInForEngine(on, { files })
  await startSession($)

  expect(await writeTickets($, [{ op: 'create', title: 'Two' }])).toContain('created SQ-2.')
  expect(JSON.parse(files.get(BOARD_JSON) ?? '{}').prefix).toBeUndefined()
})

const VANISHED = 'A board was here: .git/info/exclude still lists .sidequest/, but the folder is gone'

test('a board folder gone while the exclude line it wrote is still there is said on the first read, once', async ($, on) => {
  standInForEngine(on, { files: new Map([[EXCLUDE, '# local\n.sidequest/\n']]) })
  await startSession($)

  const first = await readView($, 'summary')
  const second = await readView($, 'summary')

  expect(first).toContain(VANISHED)
  expect(first).toContain('It cannot be brought back from here. The next ticket starts a new board.')
  expect(second).not.toContain(VANISHED)
})

test('the exclude line with the board folder there, or no exclude line, says nothing of a gone board', async ($, on) => {
  const files = new Map([
    [EXCLUDE, '.sidequest/\n'],
    [BOARD_JSON, JSON.stringify({ prefix: 'SA', nextTicket: 1, nextStory: 1 })],
  ])
  standInForEngine(on, { files })
  await startSession($)

  expect(await readView($, 'summary')).toBe('0 waiting on you, 0 ready to start, 0 in progress, 0 being checked. Nothing is ready to start.\nNo ticket files in /repo/.sidequest.')
  files.delete(BOARD_JSON)
  files.set(EXCLUDE, '# nothing of ours\n')
  expect(await readView($, 'summary')).toBe('0 waiting on you, 0 ready to start, 0 in progress, 0 being checked. Nothing is ready to start.\nNo ticket files in /repo/.sidequest.')
})
