import { expect, test } from 'claude-code/testing'

import { failureLabel } from './events'
import { errorWordsOf, failedCommandName, wasCutShort } from './shell-failure'

const exitOne = 'Exit code 1\nsomething went wrong'

test('exit 1 from an answering command in a chain is no failure when only echo-like commands follow, with output or not', async () => {
  expect(failedCommandName('diff a b && echo same', 'Exit code 1\n1c1\n< a\n> b')).toBeUndefined()
  expect(failedCommandName('git diff --exit-code && echo clean', 'Exit code 1\ndiff --git a/x b/x')).toBeUndefined()
  expect(failedCommandName('cd /w && grep -c x f && echo y', 'Exit code 1\n0')).toBeUndefined()
  expect(failedCommandName('test -f x && printf done && true', 'Exit code 1')).toBeUndefined()
})

test('a heredoc body is dropped and the commands after its end marker are kept', async () => {
  expect(failedCommandName('cat > run.mjs <<EOF\nconsole.log(1)\nEOF\nnode run.mjs', exitOne)).toBe('node')
  expect(failedCommandName("cat <<'EOF' > notes\nbody && more\nEOF", exitOne)).toBe('cat notes')
})

test('a script is named by the last part of its path', async () => {
  expect(failedCommandName('./scripts/run.sh --fast', exitOne)).toBe('run.sh')
  expect(failedCommandName('cd /w && C:\\tools\\build.cmd all', exitOne)).toBe('build.cmd')
})

test('a shell keyword is never the name, the last real command inside is', async () => {
  expect(failedCommandName('if [ -d out ]; then npm test; fi', exitOne)).toBe('npm test')
  expect(failedCommandName('for f in a b; do node $f; done', exitOne)).toBe('node')
  expect(failedCommandName('while read line; do make all; done', exitOne)).toBe('make all')
})

test('a bracket test is a test: its exit 1 is an answer', async () => {
  expect(failedCommandName('[ -f x ]', 'Exit code 1')).toBeUndefined()
  expect(failedCommandName('[[ -n "$HOME" ]] && echo set', 'Exit code 1')).toBeUndefined()
})

test('a call cut short by an interrupt or the end of the session is not a failure of the command', async () => {
  expect(wasCutShort('[Tool call interrupted: the session ended before it finished]')).toBe(true)
  expect(wasCutShort('[Request interrupted by user for tool use]')).toBe(true)
  expect(wasCutShort('Exit code 1\nconnection interrupted by peer')).toBe(false)
  expect(wasCutShort('Connection interrupted while reading body')).toBe(false)
  expect(wasCutShort('Error: session closed by server')).toBe(false)
})

test('an error of the environment keeps its words, wherever it sits in the output', async () => {
  expect(errorWordsOf('Exit code 127\nbash: line 1: gh: command not found')).toBe('bash: line gh: command not found')
  expect(errorWordsOf('Exit code 1\n> pkg@1.0.0 start\n> node server.js\n\nError: listen EADDRINUSE: address already in use :::3000')).toBe(
    'error: listen eaddrinuse: address already in use',
  )
  expect(errorWordsOf('Exit code 128\nfatal: not a git repository (or any of the parent directories): .git')).toBe(
    'fatal: not a git repository any of the parent',
  )
  expect(errorWordsOf("Exit code 1\nTraceback (most recent call last):\nModuleNotFoundError: No module named 'requests'")).toBe('modulenotfounderror: no module named')
  expect(errorWordsOf('Exit code 1\nerror: unknown option `--fast`')).toBe('error: unknown option')
})

// Each of these is what a real runner printed for two unrelated failures: a heading, a summary, a test's name.
test('a failing test, lint, type check or build keeps no words: it is the work, not the setup', async () => {
  const outputs = [
    '> pkg@1.0.0 test\n> node --test\n\nTests failed in 3 files',
    'TAP version 13\n# Subtest: first passes\nok 1 - first passes\n# Subtest: second uploads twice\nnot ok 2 - second uploads twice\n1..2',
    ' RUN  v3.2.4\n FAIL  src/a.test.ts > uploads > retries twice\nAssertionError: expected 1 to be 2\n Failed Tests 1 ',
    'Test Suites: 1 failed, 1 total\n    TypeError: retry is not a function',
    'test tests::upload_retries ... FAILED\nerror: test failed, to rerun pass `--lib`',
    '  3:1  error  x is defined but never used  no-unused-vars\n3 problems (3 errors, 0 warnings)',
    'file:///work/run.mjs:3\n    throw new Error("boom")\n\nError: the upload was refused twice',
    '=== test session starts ===\ncollected 3 items\nE   AssertionError: upload was retried once',
    'CI=true\n-----\nbuild failed',
  ]

  for (const output of outputs) expect(errorWordsOf(`Exit code 1\n${output}`)).toBe('')
})

test('a test named after the error it checks for is not that error', async () => {
  const tapOutput = 'TAP version 13\n# Subtest: reports permission denied on a locked file\nok 1 - reports permission denied on a locked file\nnot ok 2 - says command not found'
  const listedWithMarks = [
    ' ❯ src/parse.test.ts (3 tests | 1 failed) 12ms',
    '   ✓ reports permission denied on a locked file 1ms',
    '   × parses the header 4ms',
    '     → expected { a: 1 } to deeply equal { a: 2 }',
    ' ✔ says command not found for a missing tool (0.4ms)',
    '  12|   expect(read()).toBe("permission denied")',
  ].join('\n')

  expect(errorWordsOf(`Exit code 1\n${tapOutput}`)).toBe('')
  expect(errorWordsOf(`Exit code 1\n${listedWithMarks}`)).toBe('')
  expect(errorWordsOf('Exit code 1\n FAIL  reader.test.js > reader > reports permission denied on a locked file\nTypeError: Cannot read properties of undefined')).toBe('')
})

test('coloured output is read as its plain text, with or without the escape character', async () => {
  const escape = String.fromCharCode(27)
  const coloured = `   ${escape}[32m✓${escape}[39m parser${escape}[2m > ${escape}[22mreports permission denied on a locked file 1ms\n    ${escape}[90m  2| ${escape}[39m  it('reports permission denied on a locked file', () => {`
  const escapeDropped = coloured.split(escape).join('')

  expect(errorWordsOf(`Exit code 1\n${coloured}`)).toBe('')
  expect(errorWordsOf(`Exit code 1\n${escapeDropped}`)).toBe('')
  expect(errorWordsOf(`Exit code 127\n${escape}[31mbash: line 1: gh: command not found${escape}[39m`)).toBe('bash: line gh: command not found')
})

test('a setup phrase inside quotes is what a test expected, and a source line that threw is not the error', async () => {
  expect(errorWordsOf("Exit code 1\nAssertionError: expected 'ok' to be 'permission denied' // Object.is equality")).toBe('')
  expect(errorWordsOf("Exit code 1\nAssertionError: expected 'EACCES' to be 'ENOENT' // Object.is equality")).toBe('')
  const nodeOutput =
    "node:internal/modules/package_json_reader:268\n  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);\n        ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad' imported from /work/a.mjs\n    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:268:9)"

  expect(errorWordsOf(`Exit code 1\n${nodeOutput}`)).toBe('error cannot find package imported from')
})

test('a test that ran out of time is the work, a connection that timed out is the setup', async () => {
  expect(errorWordsOf('Exit code 1\nError: Test timed out in 50ms.\nIf this is a long-running test, pass a timeout value')).toBe('')
  expect(errorWordsOf('Exit code 28\ncurl: (28) Connection timed out after 5002 milliseconds')).toBe('curl: connection timed out after milliseconds')
  expect(errorWordsOf('Exit code 1\nError: connect ETIMEDOUT 10.0.0.1:443')).toBe('error: connect etimedout')
})

test('setup errors in the words other shells and runtimes use', async () => {
  expect(errorWordsOf("Exit code 1\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad' imported from /work/a.mjs")).not.toBe('')
  expect(errorWordsOf('Exit code 7\ncurl: (7) Failed to connect: Could not connect to server')).not.toBe('')
  expect(errorWordsOf("Exit code 1\nAccess to the path 'C:\\locked\\a.txt' is denied.")).not.toBe('')
  expect(errorWordsOf("Exit code 1\nCannot find path 'C:\\work\\missing' because it does not exist.")).not.toBe('')
})

test('a command that can only report is never the one that failed', async () => {
  expect(failedCommandName('npm test && echo ok', 'Exit code 1\nTests failed in 3 files')).toBe('npm test')
  expect(failedCommandName('cd /work && npm run build && echo done', 'Exit code 2\nbuild failed')).toBe('npm run')
})

test('a very long command is named from its start and costs no time', async () => {
  const padded = `npm test${' '.repeat(6000)}\n${' '.repeat(6000)}node check.mjs`
  const manyChained = `make${' && true'.repeat(10_000)}`
  const startedAt = Date.now()

  expect(failedCommandName(padded, 'Exit code 1\ncheck failed badly')).toBe('npm test')
  expect(failedCommandName(manyChained, 'Exit code 2\nmake: *** No rule to make target')).toBe('make')
  expect(failedCommandName(`a${'&'.repeat(19_990)}`, 'Exit code 2\nsyntax error')).toBe('a')
  expect(failedCommandName('\n'.repeat(20_000), 'Exit code 2\nsyntax error')).toBe('')
  expect(Date.now() - startedAt).toBeLessThan(500)
})

test('a short blank-padded chain still names its last command', async () => {
  expect(failedCommandName(`npm test${' '.repeat(600)}\n${' '.repeat(600)}node check.mjs`, 'Exit code 1\ncheck failed badly')).toBe('node')
})

test('a result with nothing after the exit line names no error', async () => {
  expect(errorWordsOf('Exit code 1')).toBe('')
  expect(errorWordsOf('Exit code 1\n\n  \n---\n')).toBe('')
})

test('an error line keeps no credential word and no host name', async () => {
  expect(errorWordsOf('Exit code 1\nauthentication failed with password hunter for admin at db.internal.example')).toBe(
    'authentication failed with password for admin at',
  )
  expect(errorWordsOf('Exit code 1\nconnection refused: bad token abc and bearer secretvalue rejected')).toBe(
    'connection refused: bad token and bearer rejected',
  )
})

test('a failure with no command name is labelled by the tool alone', async () => {
  const at = '2026-11-16T10:00:00.000Z'

  expect(failureLabel({ kind: 'failure', at, tool: 'Bash', signature: '', error: 'x' })).toBe('Bash: x')
  expect(failureLabel({ kind: 'failure', at, tool: 'Bash', signature: '' })).toBe('Bash')
})
