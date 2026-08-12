export type HereDoc = {
  delimiter: string;
  stripTabs: boolean;
};

export function hereDocAt(command: string, index: number): { hereDoc: HereDoc; end: number } | null {
  let cursor = index + 2;
  const stripTabs = command[cursor] === '-';
  if (stripTabs) cursor += 1;
  while (command[cursor] === ' ' || command[cursor] === '\t') cursor += 1;

  const quote = command[cursor];
  if (quote === "'" || quote === '"') {
    const end = command.indexOf(quote, cursor + 1);
    if (end < 0) return null;
    return { hereDoc: { delimiter: command.slice(cursor + 1, end), stripTabs }, end: end + 1 };
  }

  const match = command.slice(cursor).match(/^[^\s|&;()<>]+/);
  if (!match) return null;
  return { hereDoc: { delimiter: match[0], stripTabs }, end: cursor + match[0].length };
}

export function skipHereDocBodies(command: string, index: number, hereDocs: HereDoc[]): number {
  let cursor = index;
  for (const { delimiter, stripTabs } of hereDocs) {
    while (cursor < command.length) {
      const lineEnd = command.indexOf('\n', cursor);
      const end = lineEnd < 0 ? command.length : lineEnd;
      let line = command.slice(cursor, end).replace(/\r$/, '');
      if (stripTabs) line = line.replace(/^\t+/, '');
      cursor = lineEnd < 0 ? command.length : lineEnd + 1;
      if (line === delimiter) break;
    }
  }
  return cursor;
}

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

export function withoutHereDocBodies(command: string): string {
  let quote = '';
  let hereDocs: HereDoc[] = [];
  let result = '';
  let copiedThrough = 0;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '\n' && hereDocs.length > 0 && !escapedNewline(command, index)) {
      result += command.slice(copiedThrough, index + 1);
      index = skipHereDocBodies(command, index + 1, hereDocs) - 1;
      copiedThrough = index + 1;
      hereDocs = [];
      continue;
    }
    if (commentStart(command, index)) {
      const lineEnd = command.indexOf('\n', index);
      if (lineEnd < 0) break;
      index = lineEnd - 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '<' && command[index - 1] !== '<' && command[index + 1] === '<') {
      const parsed = hereDocAt(command, index);
      if (parsed) {
        hereDocs.push(parsed.hereDoc);
        index = parsed.end - 1;
      }
    }
  }
  return result + command.slice(copiedThrough);
}
