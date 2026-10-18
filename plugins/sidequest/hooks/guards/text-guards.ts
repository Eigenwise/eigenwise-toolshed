import { hereDocAt, skipHereDocBodies, type HereDoc } from './heredocs.js';

// Pure decisions for the shell guards: no Node, so the hooks module and the node tests share them.
export type Machine = { home: string; windows: boolean };

function deleteArguments(command: string): string[] {
  const commands = /(?:^|[;&|{}()\n])\s*(?:[\w.-]+\s+)*(?:remove-item|rm|rmdir|rd|ri|del|erase)\b([^;&|{}\n]*)/gi;
  return [...command.matchAll(commands)].map((match) => match[1] || '');
}

function normalizePath(value: string): string {
  return value.toLowerCase().replace(/[\\/]+$/, '');
}

const LEADING_HOME_REFERENCE = /^(?:~|\$home|\$env:userprofile|%userprofile%)(?=[\\/]|$)/i;
const HOME_REFERENCE = /\$home\b|\$env:userprofile\b|%userprofile%|(?<!\w)~(?=[\\/\s]|$)/i;
const DRIVE = /^[A-Za-z]:/;

function isAbsolute(target: string, machine: Machine): boolean {
  return machine.windows ? /^(?:[A-Za-z]:)?[\\/]/.test(target) : target.startsWith('/');
}

function resolvedSegments(target: string, separator: string): string {
  const parts: string[] = [];
  for (const part of target.split(separator)) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join(separator);
}

// path.resolve for an absolute target, without Node: a drive-less Windows target lands on the home drive.
export function resolveAbsolute(target: string, machine: Machine): string {
  if (!machine.windows) return `/${resolvedSegments(target, '/')}`;
  const unified = target.replace(/\//g, '\\');
  const drive = DRIVE.exec(unified)?.[0] ?? machine.home.slice(0, 2);
  return `${drive}\\${resolvedSegments(unified.replace(DRIVE, ''), '\\')}`;
}

function parentOf(resolved: string, separator: string): string {
  const cut = resolved.lastIndexOf(separator);
  return cut <= resolved.indexOf(separator) ? resolved.slice(0, cut + 1) : resolved.slice(0, cut);
}

function isProtectedPath(argumentsAfterDelete: string, machine: Machine): boolean {
  const targets = argumentsAfterDelete.replace(/["']/g, '').split(/\s+/).map((target) => target.replace(LEADING_HOME_REFERENCE, () => machine.home));
  // A home reference anywhere but the start of a target cannot be resolved here, so it still blocks.
  if (HOME_REFERENCE.test(targets.join(' '))) return true;
  const separator = machine.windows ? '\\' : '/';
  const home = resolveAbsolute(machine.home, machine);
  const root = resolveAbsolute(separator, { ...machine, home });
  const protectedRoots = [home, `${home}${separator}.claude`, parentOf(home, separator), root].map(normalizePath);
  return targets
    .filter((target) => target !== '\\' && isAbsolute(target, machine))
    .some((target) => {
      const resolved = resolveAbsolute(target, { ...machine, home });
      // Any drive root, not only the home drive's: resolveAbsolute ends in the separator only for a root.
      if (resolved.endsWith(separator)) return true;
      const normalized = normalizePath(resolved);
      return protectedRoots.some((protectedRoot) => protectedRoot === normalized || protectedRoot.startsWith(`${normalized}${separator}`));
    });
}

export function homeDeleteDenial(command: string, machine: Machine): string | null {
  const recursive = /^(?:--recursive|-[a-z]*r[a-z]*|-recurse|\/s)$/i;
  const blocked = deleteArguments(command).some((argumentsAfterDelete) => (
    argumentsAfterDelete.replace(/["']/g, '').split(/\s+/).some((argument) => recursive.test(argument))
    && isProtectedPath(argumentsAfterDelete, machine)
  ));
  return blocked ? 'sidequest: blocked a recursive delete aimed at the user profile or .claude root. Use a specific project or scratchpad path instead.' : null;
}

const COMMAND_SHIM = /\bstart-process\b[^\r\n;|]*\s-filepath\s+(?:"|')?(npm|npx|yarn|pnpm)(?:"|')?(?=\s|$)/i;

export function powershellShimContext(command: string): string | null {
  const shim = command.match(COMMAND_SHIM)?.[1]?.toLowerCase();
  if (!shim) return null;
  return `sidequest: ${shim} is a .cmd shim on Windows, so Start-Process needs the shim explicitly. Use \`Start-Process -FilePath "${shim}.cmd" -ArgumentList "run","dev"\` or \`Start-Process -FilePath "cmd" -ArgumentList "/c","${shim}","run","dev"\`.`;
}

type Quote = 'single' | 'double' | null;
type Finding = { token: string; quoted: boolean };

const WINDOWS_PATH = /^[A-Za-z]:\\[^\\\s"'`|&;(){}<>]+\\[^\s"'`|&;(){}<>]*/;
const CONTAINER_PATH_FLAG = /(?:^|[;&|(]\s*)(?:docker\s+(?:exec|run)|kubectl\s+exec)\b[^\r\n;&|]*?(?:\s(?:-w|-v)\s+|\s--(?:workdir|volume|cwd)(?:=|\s+))(?:"|')?\/(?!\/)[^\s"'`|&;(){}<>]*/im;

function escapedNewline(command: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; command[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function commentStart(command: string, index: number): boolean {
  if (command[index] !== '#') return false;
  const previous = command[index - 1];
  return previous === undefined || /[\s;&|(]/.test(previous);
}

// Double quotes keep a backslash literal except before $, `, ", \ or a newline,
// so only those shapes actually reach the shell as a different path.
function mangledInsideDoubleQuotes(command: string, token: string, index: number): boolean {
  if (/\\\$/.test(token)) return true;
  return token.endsWith('\\') && command[index + token.length] === '\n';
}

function windowsPath(command: string): Finding | null {
  let quote: Quote = null;
  let hereDocs: HereDoc[] = [];
  const substitutions: Quote[] = [];

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }

    if (character === '\n' && hereDocs.length > 0 && !escapedNewline(command, index)) {
      index = skipHereDocBodies(command, index + 1, hereDocs) - 1;
      hereDocs = [];
      continue;
    }

    // A command substitution reopens command context, heredocs and all, even
    // when it sits inside a double-quoted string.
    if (character === '$' && command[index + 1] === '(') {
      substitutions.push(quote);
      quote = null;
      index += 1;
      continue;
    }
    if (character === ')' && substitutions.length > 0) {
      quote = substitutions.pop() ?? null;
      continue;
    }

    if (quote === 'double') {
      const token = command.slice(index).match(WINDOWS_PATH)?.[0];
      if (token && mangledInsideDoubleQuotes(command, token, index)) return { token, quoted: true };
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }

    if (commentStart(command, index)) {
      const lineEnd = command.indexOf('\n', index);
      if (lineEnd < 0) break;
      index = lineEnd - 1;
      continue;
    }

    if (character === "'") {
      quote = 'single';
      continue;
    }
    if (character === '"') {
      quote = 'double';
      continue;
    }
    if (character === '<' && command[index - 1] !== '<' && command[index + 1] === '<') {
      const parsed = hereDocAt(command, index);
      if (parsed) {
        hereDocs.push(parsed.hereDoc);
        index = parsed.end - 1;
        continue;
      }
    }

    const token = command.slice(index).match(WINDOWS_PATH)?.[0];
    if (token) return { token, quoted: false };
  }

  return null;
}

export type GuardVerdict = { deny: string } | { context: string } | null;

export function bashWindowsPathVerdict(command: string): GuardVerdict {
  if (CONTAINER_PATH_FLAG.test(command)) {
    return { context: 'sidequest: Git Bash rewrites this POSIX container path before Docker or kubectl sees it. Use `MSYS_NO_PATHCONV=1 docker exec -w /app contractify-docai ...` or spell the container path as `docker exec -w //app contractify-docai ...`.' };
  }
  const found = windowsPath(command);
  if (!found) return null;
  return {
    deny: found.quoted
      ? `sidequest: double quotes eat the backslash in this Windows path (${found.token}) - a backslash before $ or a line break is not literal there; single-quote it or write it with forward slashes (C:/Users/...).`
      : `sidequest: unquoted Windows path in a POSIX shell (${found.token}) - backslashes are eaten and the path collapses into a literal filename in cwd; quote the path or write it with forward slashes (C:/Users/...).`,
  };
}
