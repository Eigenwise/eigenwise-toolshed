'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { SCANNED_SOURCE, unmeasuredDefinitionLines, withBodySpans } = require('../lib/crap-core.cjs');

test('a widened body counts its own branches and leaves each nested function to its own row', () => {
  const source = [
    'function outer(read = (v) => v || 0, label?: string) {',
    '  const pick = (x) => x ? 1 : 2',
    '  if (read) return pick(read)',
    '  items.forEach(function each(item) { if (item) use(item) })',
    '  return fetch().catch(() => null) ?? label',
    '}',
    '',
  ].join('\n');

  const [row] = withBodySpans([{ file: 'src/outer.ts', name: 'outer', ordinal: 0, complexity: 1, start: 1, end: 1 }], () => source);

  assert.deepEqual([row.end, row.complexity], [6, 3]);
});

test('a widened body reads block comments and template text as no code, and counts the code inside a template expression', () => {
  const source = [
    'function describe(read = (v) => v, label) {',
    '  /* holds { an open brace,',
    '     an if (x) and a && */',
    "  const tag = `row ${read({ id: label }) || 'none'} \\` if (x) { ${`inner ${label}`}`;",
    '  if (label) return tag;',
    '  return `${tag}`;',
    '}',
    '',
  ].join('\n');

  const [row] = withBodySpans([{ file: 'src/describe.js', name: 'describe', ordinal: 0, complexity: 1, start: 1, end: 1 }], () => source);

  // One `||` inside the first `${...}` and the `if` on line 5; the comment's and the template text's `{`, `if` and `&&` count nothing.
  assert.deepEqual([row.end, row.complexity], [7, 3]);
});

// lizard 1.24.0 reports no row at all for a `function`, method or constructor whose parameter list holds a
// call (`a = f(), b`); it reports only `plain`, `arrow` and `wrapper` for this source.
const DROPPED_SOURCE = [
  'function plain(x) {',
  '  return x ? 1 : 2;',
  '}',
  'function load(path = resolve(), opts) {',
  '  if (!path) return null;',
  '  if (opts && opts.fresh) return read(path);',
  '  return cached(path);',
  '}',
  'class Store {',
  '  constructor(private db = open(), name: string) {',
  '    if (db) this.db = db;',
  '  }',
  '  async fetch<T>(key = keyOf(), fallback?: T): Promise<T | undefined> {',
  '    return this.db.get(key) ?? fallback;',
  '  }',
  '}',
  'const arrow = (a = f(), b) => {',
  '  if (a) return b;',
  '  return 0;',
  '};',
  'function wrapper(items) {',
  '  if (check(items.map((item) => item.id))) {',
  '    return items.filter(pick(1)) ? 1 : 0;',
  '  }',
  '  return cond ? run(step()) : { done: true };',
  '}',
  'class Derived extends mixin(Base(1)) {',
  '  method() {}',
  '}',
  '',
].join('\n');

const DROPPED_LIZARD_ROWS = [
  { name: 'plain', complexity: 2, start: 1, end: 3 },
  { name: 'arrow', complexity: 2, start: 17, end: 20 },
  { name: 'wrapper', complexity: 5, start: 21, end: 26 },
];

function scannedRows(source, rows = DROPPED_LIZARD_ROWS, extraFiles = []) {
  const entries = rows.map((row) => ({ file: 'src/dropped.ts', ordinal: 0, ...row }));
  return withBodySpans(entries, () => source, extraFiles)
    .filter((entry) => entry.source === SCANNED_SOURCE)
    .map((entry) => `${entry.name}@${entry.start}-${entry.end} cc=${entry.complexity} ordinal=${entry.ordinal}`);
}

test('a function lizard dropped altogether gets a row read from its source, and calls, conditions and arrows get none', () => {
  assert.deepEqual(scannedRows(DROPPED_SOURCE), [
    'load@4-8 cc=4 ordinal=0',
    'constructor@10-12 cc=2 ordinal=0',
    'fetch@13-15 cc=2 ordinal=0',
    // No parameter list holds a call here: lizard loses a plain function after a dropped one, so it is read too.
    'method@28-28 cc=1 ordinal=0',
  ]);
});

test('a file with no function lizard dropped is left as lizard measured it, plain functions without a row included', () => {
  const source = 'function plain(x) {\n  return x ? 1 : 2;\n}\nconst tag = (x) => `${x}`;\nif (check(items.map((item) => item.id))) {\n  run(step());\n}\n';

  assert.deepEqual(scannedRows(source, [], ['src/dropped.ts']), []);
});

test('a plain function lizard lost after a dropped one is read from its source', () => {
  // lizard 1.24.0 reports nothing for this file: it loses `later` too once `current` is dropped.
  const source = [
    'function current(cache, now = Date.now()) {',
    '  return now - cache >= 0 && now - cache < 5;',
    '}',
    'function later(query) {',
    '  return query;',
    '}',
    '',
  ].join('\n');

  assert.deepEqual(scannedRows(source, [], ['src/dropped.ts']), ['current@1-3 cc=2 ordinal=0', 'later@4-6 cc=1 ordinal=0']);
});

test('a dropped function counts the branches of its own parameter defaults and leaves a nested function to its own row', () => {
  const source = [
    'function pick(a = f() || g(), b = h() ? 1 : 2) {',
    '  const inner = (x) => x ? 1 : 2;',
    '  if (a) return inner(b);',
    '  return b;',
    '}',
    '',
  ].join('\n');

  assert.deepEqual(scannedRows(source, [], ['src/dropped.ts']), ['pick@1-5 cc=4 ordinal=0']);
});

test('a dropped function whose line holds a lizard row of its own name keeps that row, and a same-named one takes the next ordinal', () => {
  const source = [
    'function twice(a = f()) {',
    '  if (a) return 1;',
    '  return 0;',
    '}',
    'function twice(b = g()) {',
    '  if (b) return 2;',
    '  return 0;',
    '}',
    '',
  ].join('\n');

  assert.deepEqual(scannedRows(source, [{ name: 'twice', complexity: 2, start: 1, end: 4 }]), ['twice@5-8 cc=2 ordinal=1']);
});

test('a dropped function that starts on the line of another function\'s lizard row still gets a row of its own', () => {
  // The owner's review input (sameLine): lizard 1.24.0 reports only `outer`, at line 1 with cc 1.
  const source = [
    'export function outer(q) { return function inner(a = f()) {',
    '  if (!a) return 0;',
    '  return q && a ? 2 : 3;',
    '}; }',
    '',
  ].join('\n');

  assert.deepEqual(scannedRows(source, [{ name: 'outer', complexity: 1, start: 1, end: 1 }]), ['inner@1-4 cc=4 ordinal=0']);
});

test('a definition lizard reports as (anonymous) on its line has that row and gets no second one from the source', () => {
  // The owner's review input (arrowType): lizard names a function with an arrow-typed parameter "(anonymous)".
  const source = [
    'function f<T>(work: () => T, t = 5) {',
    '  if (t > 1 && t < 9) return work();',
    '  return t ? work() : work();',
    '}',
    '',
  ].join('\n');
  const rows = [{ file: 'src/dropped.ts', ordinal: 0, name: '(anonymous)', complexity: 4, start: 1, end: 4 }];

  assert.deepEqual(scannedRows(source, rows), []);
  assert.equal(withBodySpans(rows, () => source).length, 1);
});

for (const [label, callback] of [['function', 'function (x) { return x; }'], ['arrow', '(x) => x']]) {
  test(`a named function lizard dropped is not hidden by a ${label} callback's (anonymous) row on its first line`, () => {
    const source = [
      `export function outer(a = f(), b) { const pick = list.find(${callback});`,
      '  if (a) return 1;',
      '  if (b) return 2;',
      '  if (a && b) return 3;',
      '  return a ? 4 : 5;',
      '}',
      '',
    ].join('\n');
    const rows = [{ name: '(anonymous)', complexity: 1, start: 1, end: 1 }];

    assert.deepEqual(scannedRows(source, rows), ['outer@1-6 cc=6 ordinal=0']);
  });
}

const CALL_FIRST_DEFAULT_BODY = ['  if (a) return 1;', '  if (b) return 2;', '  if (a && b) return 3;', '  return a ? 4 : 5;', '}', ''];
const CALL_FIRST_DEFAULT_HEAD = 'export function retry(now = Date.now(), work = () => {}) {';

test('a default arrow in the parameter list and a callback on the same line leave the dropped function its own row', () => {
  // The owner's round-four input (callFirstDefault): lizard 1.24.0 gives `work` and (anonymous), both on line 1, and no row for `retry`.
  const source = [`${CALL_FIRST_DEFAULT_HEAD} const pick = list.find((x) => x);`, ...CALL_FIRST_DEFAULT_BODY].join('\n');
  const rows = [{ name: 'work', complexity: 1, start: 1, end: 1 }, { name: '(anonymous)', complexity: 1, start: 1, end: 1 }];

  assert.deepEqual(scannedRows(source, rows), ['retry@1-6 cc=6 ordinal=0']);
});

test('the same function with its callback on the next line keeps its row too', () => {
  const source = [CALL_FIRST_DEFAULT_HEAD, '  const pick = list.find((x) => x);', ...CALL_FIRST_DEFAULT_BODY].join('\n');
  const rows = [{ name: 'work', complexity: 1, start: 1, end: 1 }, { name: '(anonymous)', complexity: 1, start: 2, end: 2 }];

  assert.deepEqual(scannedRows(source, rows), ['retry@1-7 cc=6 ordinal=0']);
});

test('a regex whose character class holds a slash is one literal, so the function around it still gets its row', () => {
  // The owner's review input: `[\\/]` is the usual path-separator class. `/\\+/g` is the control without a class.
  const source = [
    'export function normalize(p = cwd()) {',
    '  if (!p) return null;',
    "  return p.split(/[\\\\/]+/).join('/') || '.';",
    '}',
    'export function control(p = cwd()) {',
    '  if (!p) return null;',
    "  return p.split(/\\\\+/g).join('/') || '.';",
    '}',
    '',
  ].join('\n');

  assert.deepEqual(scannedRows(source, [], ['src/dropped.ts']), ['normalize@1-4 cc=3 ordinal=0', 'control@5-8 cc=3 ordinal=0']);
});

test('a dropped function expression is named after the variable or property it is assigned to, as lizard names it', () => {
  const source = [
    'const load = function (path = resolve()) {',
    '  return path ? 1 : 0;',
    '};',
    'const handlers = {',
    '  save: async function (data = serialize()) {',
    '    return data || null;',
    '  },',
    '};',
    'register(function* (steps = plan()) {',
    '  yield steps && steps.next;',
    '});',
    '',
  ].join('\n');

  assert.deepEqual(scannedRows(source, [], ['src/dropped.ts']), ['load@1-3 cc=2 ordinal=0', 'save@5-7 cc=2 ordinal=0', '(anonymous)@9-11 cc=2 ordinal=0']);
});

test('a dropped generator or generic method is read from its source, and a getter lizard names `get size` keeps its own row', () => {
  const source = [
    'class Box {',
    '  get size() {',
    '    return this.items ? this.items.length : 0;',
    '  }',
    '  *entries<T>(pick = (value: T) => value) {',
    '    return pick > (this.limit || 0) ? 1 : 0;',
    '  }',
    '}',
    'function* walk(root = tree()) {',
    '  if (root) yield root;',
    '}',
    '',
  ].join('\n');

  assert.deepEqual(scannedRows(source, [{ name: 'get size', complexity: 2, start: 2, end: 4 }]), ['entries@5-7 cc=3 ordinal=0', 'walk@9-11 cc=2 ordinal=0']);
});

test('a file lizard gave no row at all is scanned when it is named, and only then', () => {
  const source = 'export function only(path = resolve(), flag) {\n  if (flag) return path;\n  return null;\n}\n';

  assert.deepEqual(scannedRows(source, []), []);
  assert.deepEqual(scannedRows(source, [], ['src/dropped.ts']), ['only@1-4 cc=2 ordinal=0']);
});

// GitHub issue #471: lizard 1.24.0 loses its place at a template literal nested in another one's `${...}`.
// For this source it reports only `header@1-14` at cc 4, swallowing `later` and `evenLater`.
const NESTED_TEMPLATE_SOURCE = [
  'const header = (id: string, secret: string): string => {',
  '  const value = `Basic ${btoa(`${id}:${secret}`)}`;',
  '  if (!value) return "";',
  '  return value;',
  '};',
  '',
  'function later(a: number): number {',
  '  if (a > 1) return 1;',
  '  return 2;',
  '}',
  '',
  'function evenLater(b: string): string {',
  '  return b.length > 2 ? "long" : "short";',
  '}',
  '',
].join('\n');

function spanRows(source, rows, file = 'src/nested.ts') {
  return withBodySpans(rows.map((row) => ({ file, ordinal: 0, ...row })), () => source, [file])
    .map((entry) => `${entry.name}@${entry.start}-${entry.end} cc=${entry.complexity}${entry.source ? ` ${entry.source}` : ''}`);
}

test('a row lizard ran past its function\'s end is clamped to the body and recounted, and the functions it swallowed get rows', () => {
  assert.deepEqual(spanRows(NESTED_TEMPLATE_SOURCE, [{ name: 'header', complexity: 4, start: 1, end: 14 }]), [
    'header@1-5 cc=2',
    'later@7-10 cc=2 source-scan',
    'evenLater@12-14 cc=2 source-scan',
  ]);
  // The control without the nesting, as lizard reads it: `later` ends on the next token's line, which is no overrun,
  // and the gate ends the row with the body so `evenLater`'s signature line is never `later`'s.
  const control = NESTED_TEMPLATE_SOURCE.replace('`Basic ${btoa(`${id}:${secret}`)}`', '"Basic " + btoa(id + ":" + secret)');
  const controlRows = [{ name: 'header', complexity: 2, start: 1, end: 5 }, { name: 'later', complexity: 2, start: 7, end: 12 }, { name: 'evenLater', complexity: 2, start: 12, end: 14 }];
  assert.deepEqual(spanRows(control, controlRows), ['header@1-5 cc=2', 'later@7-10 cc=2', 'evenLater@12-14 cc=2']);
});

// GitHub issue #477: for an arrow whose `=>` ends a line, lizard reports `(anonymous)@6-6`, the body's first line.
const MULTI_LINE_ARROW_SOURCE = [
  'const wrap = (name) => (fn) => fn;',
  'const keyset = (...parts) => parts.join(",");',
  '',
  'export const repo = {',
  '  listX: wrap("repo.listX")(() =>',
  '    keyset(',
  '      "a",',
  '      "b",',
  '    ),',
  '  ),',
  '};',
  '',
].join('\n');

test('a row lizard starts on an arrow\'s body line restarts at the arrow and ends with its body', () => {
  const rows = [{ name: 'wrap', complexity: 1, start: 1, end: 1 }, { name: 'keyset', complexity: 1, start: 2, end: 2 }, { name: '(anonymous)', complexity: 1, start: 6, end: 6 }];

  // Line 10 closes `wrap(...)(`, not the arrow, whose V8 function range is lines 5-9.
  assert.deepEqual(spanRows(MULTI_LINE_ARROW_SOURCE, rows, 'src/repo.mjs'), ['wrap@1-1 cc=1', 'keyset@2-2 cc=1', '(anonymous)@5-9 cc=1']);
});

test('the safety net reads a function type in a type alias, interface, annotation or type argument as no function', () => {
  const source = [
    'type Handler = (event: string) => void;',
    'type Unwrap<T> = T extends (...args: any[]) => infer R ? R : never;',
    'type Maybe = ((value: string) => void) | null;',
    'interface Props { onPick?: (id: string) => void; render(row: (x: number) => string): void }',
    'declare const table: Record<string, (key: string) => number>;',
    'class Store { private listener: (next: number) => void; }',
    'declare function run(options: { onProgress?: (done: number) => void }): void;',
    'const real = (x: number) => x + 1;',
    'register((y) => y, [(z) => z]);',
    'export const api = { get: (id: string) => id };',
    '',
  ].join('\n');

  assert.deepEqual(unmeasuredDefinitionLines(source, []), [8, 9, 10]);
});

test('an arrow whose template literal body runs over several lines keeps the row lizard ended on its closing line', () => {
  const source = ['const moves = list.map((move) => `create ${move.to}', 'delete ${move.from}', 'done`);', ''].join('\n');
  const rows = [{ name: '(anonymous)', complexity: 1, start: 1, end: 3 }];

  assert.deepEqual(spanRows(source, rows, 'src/moves.js'), ['(anonymous)@1-3 cc=1']);
  assert.deepEqual(unmeasuredDefinitionLines(source, rows), []);
});

const NESTED_RISKY_SOURCE = (value) => [
  'export function outer() {',
  `  const value = ${value};`,
  '  const risky = (n: number) => {',
  ...[1, 2, 3, 4, 5, 6].map((branch) => `    if (n === ${branch}) return ${branch};`),
  '    return 0;',
  '  };',
  '  return risky;',
  '}',
  'export function last(n: number): number {',
  '  return n;',
  '}',
  '',
].join('\n');

test('a nested function lizard dropped is unmeasured however far the parent row reaches, and the parent keeps its own lines', () => {
  const source = NESTED_RISKY_SOURCE('1');
  const outerOnly = [{ name: 'outer', complexity: 1, start: 1, end: 13 }, { name: 'last', complexity: 1, start: 14, end: 16 }];
  assert.deepEqual(unmeasuredDefinitionLines(source, outerOnly), [3, 4, 5, 6, 7, 8, 9, 10, 11], 'risky has no row of its own');
  assert.deepEqual(unmeasuredDefinitionLines(source, [...outerOnly, { name: 'risky', complexity: 7, start: 3, end: 11 }]), []);
  assert.deepEqual(unmeasuredDefinitionLines(source, [{ name: 'risky', complexity: 7, start: 3, end: 11 }, outerOnly[1]]), [1, 2, 12, 13], 'outer owns the lines outside risky');
});

