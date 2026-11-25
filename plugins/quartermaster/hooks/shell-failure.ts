import { commandPrefix, errorLineWords, withoutQuotedStrings } from './events'

const FINISHED_HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
const UNFINISHED_HEREDOC = /<<(?!<)[\s\S]*$/
const REDIRECT_TO_DESCRIPTOR = /\d*[<>]&\d*-?|&>>?/g
const CHAIN_SPLIT = /(&&|\|\||[|;&\n])/
const GROUPING = /[(){}]/g
const KEYWORD_OPENING_A_COMMAND = /(^|[;&|\n]\s*)(?:if|while|until|then|else|elif|do|time|!)\s+/g
const KEYWORD_CLOSING_A_BLOCK = /(^|[;&|\n]\s*)(?:fi|done|esac)\b/g
// Written so no stretch of whitespace can be matched two ways: this runs inside the tool-call hook on every failed call.
const REPEATED_SEPARATORS = /[;\n](?:[ \t]*[;\n])+/g
// A command longer than this is named from its start. Some patterns below take time that grows with the square of
// the length (660 ms measured at 20,000 characters of newlines), and this runs inside the tool-call hook.
const PARSED_AT_MOST = 4_000
const TRAILING_SEPARATORS = /[\s;&|]+$/
const EXIT_CODE_LINE = /^Exit code (\d+)[^\S\n]*\n?/
const CD_REPORTING_ITSELF = /(^|\s)cd: /
const REJECTED_BY_PERSON = /^(?:the user doesn.t want to|the user rejected|\[request interrupted by user)/i
// The host's own bracketed words only: another tool's error may well say "interrupted" about something else.
const CUT_SHORT = /^\[(?:tool call|request) interrupted\b/i
const BRACKET_TEST = /^\[\[?\s/
const PATH_SEPARATOR = /[\\/]/
const PLAIN_FILE_NAME = /^[\w.-]{1,24}$/
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_]\w*=/
const BANNER_LINE = /^(?:>|TAP version\b|\w+=)/i

const EXIT_ONE_IS_AN_ANSWER = new Set(['grep', 'rg', 'diff', 'test'])
const EXIT_ONE_IS_AN_ANSWER_WITH_SUBCOMMAND = 'git diff'
const CANNOT_FAIL_ON_ITS_OWN = new Set(['echo', 'printf', 'true', ':'])

/**
 * The host marks a rejected call as any other error (a tool result carries
 * `isError` and text, no field for who refused), so the words the host gives
 * the model are the only sign.
 */
export const wasRejectedByPerson = (errorText: string): boolean => REJECTED_BY_PERSON.test(errorText.trim())

const firstLineOf = (text: string): string => text.trim().split('\n')[0] ?? ''

/** A call cut short by an interrupt or the end of the session says nothing about the command. */
export const wasCutShort = (errorText: string): boolean => CUT_SHORT.test(firstLineOf(errorText))

const exitCodeOf = (errorText: string): number | undefined => {
  const digits = EXIT_CODE_LINE.exec(errorText)?.[1]

  return digits === undefined ? undefined : Number(digits)
}

/** The error text without the host's `Exit code N` line, which says nothing about what went wrong. */
export const errorTextWithoutExitCode = (errorText: string): string => errorText.replace(EXIT_CODE_LINE, '')

const ERROR_OF_THE_ENVIRONMENT =
  /command not found|is not recognized as|permission denied|access is denied|access to the path|operation not permitted|no such file or directory|cannot find path|not a git repository|cannot find module|cannot find package|no module named|address already in use|connection refused|could not connect to server|could not resolve host|connection timed out|operation timed out|authentication failed|not logged in|unknown option|unrecognized option|\b(?:EACCES|EPERM|ENOENT|EADDRINUSE|ECONNREFUSED|ETIMEDOUT|ERR_MODULE_NOT_FOUND)\b/i

// A test runner prints the names of its tests, passed ones too, and a test may well be named after the error it
// checks for: TAP lines, a result mark in front of a name, a numbered line of a code frame. A runtime echoes the
// source line that threw (`throw new ERR_...(`) above the error itself, and a stack frame names files.
const NEVER_THE_ERROR_LINE = /^\s*(?:#|ok\b|not ok\b|fail\b|[✓✔√×✖✗→●❯]|\d+\s*\||throw\b|at\s)/i

// Runners colour their output also when it is piped (seen on Windows), and the code sits before the result mark.
// The escape character itself may be gone by the time the text gets here, so the bracketed code alone counts too.
const COLOUR_CODE = /\u001b?\[[\d;]*m/g

const withoutColourCodes = (text: string): string => text.replace(COLOUR_CODE, '')

// Quoted text is what a program was given or expected (`expected 'ok' to be 'permission denied'`), never its own report.
const isAnErrorOfTheEnvironment = (line: string): boolean =>
  ERROR_OF_THE_ENVIRONMENT.test(withoutQuotedStrings(line)) && !NEVER_THE_ERROR_LINE.test(line) && !BANNER_LINE.test(line.trim())

/**
 * The words of the first line that reports an error of the environment: a
 * command that is not there, a permission, a missing file or module, a
 * connection, a login. Empty for everything else. A failing test, lint, type
 * check or build is the work itself, and picking "the" error line out of a
 * runner's output was tried three ways on real output: each stored a heading
 * or a summary that is the same for unrelated failures. Such a failure is
 * still counted, and never repeats an error.
 */
export const errorWordsOf = (errorText: string): string =>
  errorLineWords(withoutColourCodes(errorTextWithoutExitCode(errorText)).split('\n').find(isAnErrorOfTheEnvironment) ?? '')

const withoutHeredocBodies = (command: string): string =>
  command.replace(FINISHED_HEREDOC, '$3').replace(UNFINISHED_HEREDOC, '')

const commandPieces = (command: string): string[] =>
  withoutQuotedStrings(withoutHeredocBodies(command.slice(0, PARSED_AT_MOST)))
    .replace(REDIRECT_TO_DESCRIPTOR, ' ')
    .replace(GROUPING, ' ')
    .replace(KEYWORD_OPENING_A_COMMAND, '$1')
    .replace(KEYWORD_CLOSING_A_BLOCK, '$1')
    .replace(REPEATED_SEPARATORS, ';')
    .replace(TRAILING_SEPARATORS, '')
    .split(CHAIN_SPLIT)

// A loop, since a command of thousands of `&&` would overflow the stack as a recursion.
const lastAndRun = (pieces: readonly string[]): string[] => {
  const fromTheEnd = [pieces[pieces.length - 1] ?? '']
  for (let at = pieces.length - 2; at >= 1 && pieces[at] === '&&'; at -= 2) fromTheEnd.push(pieces[at - 1] ?? '')

  return fromTheEnd.reverse()
}

/**
 * The commands that could have set the call's exit status: the last command,
 * and the ones before it while each is joined to the next by `&&`. A `;`, a
 * pipe or a `||` before the last command ends the run, since the status is the
 * last command's whatever came before.
 */
export const commandsThatCouldHaveFailed = (command: string): string[] =>
  lastAndRun(commandPieces(command)).map(piece => piece.trim())

const firstWordOf = (text: string): string => text.split(' ')[0] ?? ''

const scriptNameOf = (piece: string): string => {
  const word = piece.split(/\s+/).find(candidate => !ENVIRONMENT_ASSIGNMENT.test(candidate)) ?? ''
  const lastPart = PATH_SEPARATOR.test(word) ? (word.split(PATH_SEPARATOR).pop() ?? '') : ''

  return PLAIN_FILE_NAME.test(lastPart) ? lastPart.toLowerCase() : ''
}

/** What a person calls the command: `[` is `test`, a script is its file name, anything else its first two plain words. */
const nameOf = (piece: string): string => {
  if (BRACKET_TEST.test(piece)) return 'test'

  return scriptNameOf(piece) || commandPrefix(piece)
}

const isExitOneAnAnswer = (name: string): boolean =>
  EXIT_ONE_IS_AN_ANSWER.has(firstWordOf(name)) || name === EXIT_ONE_IS_AN_ANSWER_WITH_SUBCOMMAND

const cannotFailOnItsOwn = (piece: string): boolean =>
  CANNOT_FAIL_ON_ITS_OWN.has(firstWordOf(nameOf(piece))) || piece === ':'

const isAnAnswerPiece = (piece: string): boolean => isExitOneAnAnswer(nameOf(piece))

const isChangeDirectory = (piece: string): boolean => firstWordOf(nameOf(piece)) === 'cd'

const lastIndexOf = (pieces: readonly string[], test: (piece: string) => boolean): number =>
  pieces.map(test).lastIndexOf(true)

// Exit 1 after such a command is its answer when nothing after it could have failed by itself.
const exitOneWasAnAnswer = (pieces: readonly string[]): boolean => {
  const answerAt = lastIndexOf(pieces, isAnAnswerPiece)

  return answerAt >= 0 && pieces.slice(answerAt + 1).every(cannotFailOnItsOwn)
}

const changeDirectoryThatFailed = (pieces: readonly string[], errorText: string): string | undefined =>
  CD_REPORTING_ITSELF.test(errorText) ? pieces.find(isChangeDirectory) : undefined

const silentExitOne = (pieces: readonly string[], errorText: string): string | undefined =>
  exitCodeOf(errorText) === 1 && errorTextWithoutExitCode(errorText).trim() === '' ? pieces.find(isAnAnswerPiece) : undefined

// A trailing `echo done` never ran when the chain failed, so it is not the one to name.
const lastThatCanFail = (pieces: readonly string[]): string =>
  pieces.findLast(piece => !cannotFailOnItsOwn(piece)) ?? pieces[pieces.length - 1] ?? ''

// A chain's exit status does not say which command set it. `cd` is named when its own message is in the error,
// a silent exit 1 goes to the first command in the chain that uses exit 1 as an answer, and otherwise the last
// command that can fail is named.
const pieceThatFailed = (pieces: readonly string[], errorText: string): string =>
  changeDirectoryThatFailed(pieces, errorText) ?? silentExitOne(pieces, errorText) ?? lastThatCanFail(pieces)

/**
 * The name of the command that failed in a failed shell call, or undefined
 * when the call did not fail: exit 1 from a command that uses it to say "no
 * match" or "they differ", with nothing after it that could have failed.
 */
export const failedCommandName = (command: string, errorText: string): string | undefined => {
  const pieces = commandsThatCouldHaveFailed(command)
  if (exitCodeOf(errorText) === 1 && exitOneWasAnAnswer(pieces)) return undefined
  const name = nameOf(pieceThatFailed(pieces, errorText))

  return exitCodeOf(errorText) === 1 && isExitOneAnAnswer(name) ? undefined : name
}
