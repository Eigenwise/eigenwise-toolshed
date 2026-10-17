import { tryGit } from './crap-inputs.mjs';

const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|out|vendor|vendored|venv|\.venv|__pycache__|coverage|\.next|target|generated|migrations|fixtures|tests?|__tests__|spec)(\/|$)/;
const SKIP_FILE = /(^|\/)(test_[^/]*|[^/]*(_test|\.test|\.spec|\.gen|\.generated|\.min|\.d)\.[a-z]+)$/;
const DEFINITIONS = [
  [/\.py$/, /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/],
  [/\.[cm]?[jt]sx?$/, /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/],
];
const GREP_DEFINITIONS = '^(export|async|def|class|function|const|let|var)[[:space:]*]';

// shortcut: regex, not a parser; nested definitions are missed and same-named calls in another module can count. Use a parser and symbol resolution if that matters.
function sourceHit(row) {
  const match = /^(?:HEAD:)?(.+?):(\d+):(.*)$/.exec(row);
  if (!match) return [];
  const [, file, line, text] = match;
  if (SKIP_PATH.test(file) || SKIP_FILE.test(file)) return [];
  return [{ file, line: Number(line), text }].filter(() => DEFINITIONS.some(([extension]) => extension.test(file)));
}

function definition(hit) {
  const [, expression] = DEFINITIONS.find(([extension]) => extension.test(hit.file));
  const name = expression.exec(hit.text)?.[1];
  return name ? [{ ...hit, name }] : [];
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[_-]/g, '');
}

function duplicateSignal(metric, definitions) {
  const other = definitions.find((entry) => entry.file !== metric.relativePath && normalizeName(entry.name) === normalizeName(metric.name));
  return other ? [{ kind: 'duplicate', name: metric.name, file: metric.relativePath, line: metric.line, other: { name: other.name, file: other.file, line: other.line } }] : [];
}

function callerSignal(root, metric) {
  const escapedName = metric.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const call = new RegExp(`(?<![\\w$])${escapedName}\\s*\\(`);
  const hits = (tryGit(root, ['grep', '--untracked', '-nw', '-F', '-e', metric.name, '--']) ?? '').split('\n').flatMap(sourceHit);
  const sites = hits.filter((hit) => hit.file !== metric.relativePath && call.test(hit.text) && !definition(hit).some((entry) => entry.name === metric.name));
  return sites.length ? [{ kind: 'callers-open', name: metric.name, file: metric.relativePath, line: metric.line, sites: sites.slice(0, 2).map(({ file, line }) => ({ file, line })) }] : [];
}

export function reuseSignals(root, changedMetrics, removedMetrics) {
  const definitions = (tryGit(root, ['grep', '-nE', GREP_DEFINITIONS, 'HEAD', '--']) ?? '').split('\n').flatMap(sourceHit).flatMap(definition);
  const duplicates = changedMetrics.filter((metric) => metric.classification === 'new').flatMap((metric) => duplicateSignal(metric, definitions));
  return duplicates.concat(removedMetrics.flatMap((metric) => callerSignal(root, metric)));
}

export function formatReuseSignal(signal) {
  if (signal.kind === 'duplicate') return `DUPLICATE? ${signal.name} ≈ ${signal.other.name} (${signal.other.file}:${signal.other.line})`;
  return `CALLERS OPEN ${signal.name}: ${signal.sites.map((site) => `${site.file}:${site.line}`).join(', ')}`;
}
