import { expect, test } from 'claude-code/testing'

import { failedCommandName, wasRejectedByPerson } from './shell-failure'

const exitOne = 'Exit code 1\nsomething went wrong'

test('a leading cd into a folder is skipped and the command after it is named', async () => {
  expect(failedCommandName('cd /work/repo && npm test', exitOne)).toBe('npm test')
  expect(failedCommandName('cd "my folder" && cargo build --release', exitOne)).toBe('cargo build')
})

test('the last command of a chain is the one named', async () => {
  expect(failedCommandName('cd /work/repo && git add . && git commit -m "x"', exitOne)).toBe('git commit')
  expect(failedCommandName('make clean; make all', exitOne)).toBe('make all')
  expect(failedCommandName('make all || make fallback', exitOne)).toBe('make fallback')
  expect(failedCommandName('cat log.txt | sort | uniq -c', exitOne)).toBe('uniq')
})

test('a subshell, an environment assignment and a redirect do not change the name', async () => {
  expect(failedCommandName('(cd /work/repo && make test)', exitOne)).toBe('make test')
  expect(failedCommandName('NODE_ENV=production node build.mjs', exitOne)).toBe('node')
  expect(failedCommandName('npm test 2>&1 | tail -5', exitOne)).toBe('tail')
  expect(failedCommandName('cd /work/repo && FORCE_COLOR=1 npm run build 2>&1', exitOne)).toBe('npm run')
})

test('a cd that failed itself is named when its own message is in the error', async () => {
  const message = 'Exit code 1\nbash: line 1: cd: /gone: No such file or directory'

  expect(failedCommandName('cd /gone && npm test', message)).toBe('cd')
  expect(failedCommandName('cd /gone', message)).toBe('cd')
})

test('a heredoc body and a trailing separator never become the command', async () => {
  expect(failedCommandName('git commit -m "$(cat <<\'EOF\'\nfix the thing\nEOF\n)"', exitOne)).toBe('git commit')
  expect(failedCommandName('npm test &', exitOne)).toBe('npm test')
})

test('exit 1 from a command that uses it as an answer is no failure', async () => {
  for (const command of ['grep -r needle src', 'rg needle', 'diff a.txt b.txt', 'test -f missing.txt', 'git diff --exit-code']) {
    expect(failedCommandName(command, 'Exit code 1')).toBeUndefined()
  }
  expect(failedCommandName('cd /work/repo && rg needle src', 'Exit code 1')).toBeUndefined()
})

test('a silent exit 1 in a chain goes to the command that uses exit 1 as an answer', async () => {
  expect(failedCommandName('rg needle src && echo found', 'Exit code 1')).toBeUndefined()
  expect(failedCommandName('rg needle src && sort out.txt', 'Exit code 1')).toBeUndefined()
  expect(failedCommandName('rg needle src && sort out.txt', 'Exit code 1\nsort: cannot read')).toBe('sort')
})

test('exit 2 from grep or rg, and exit 1 from anything else, still fail', async () => {
  expect(failedCommandName('rg "(" src', 'Exit code 2\nregex parse error')).toBe('rg src')
  expect(failedCommandName('git status', 'Exit code 1\nfatal: not a git repository')).toBe('git status')
  expect(failedCommandName('grep needle missing.txt', 'Exit code 2\ngrep: missing.txt: No such file')).toBe('grep needle')
})

test('what the host says to the model when the person refuses is a rejection', async () => {
  expect(wasRejectedByPerson("The user doesn't want to proceed with this tool use. The tool use was rejected.")).toBe(true)
  expect(wasRejectedByPerson('The user doesn’t want to take this action right now. STOP.')).toBe(true)
  expect(wasRejectedByPerson('[Request interrupted by user for tool use]')).toBe(true)
  expect(wasRejectedByPerson('Exit code 1\nthe user does not exist')).toBe(false)
})
