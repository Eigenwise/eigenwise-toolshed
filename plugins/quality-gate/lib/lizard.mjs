import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function csvFields(row) {
  return [...row.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)].map((match) => match[1].replace(/^"|"$/g, '').replaceAll('""', '"'));
}

export function parseLizardCsv(text) {
  return text.split(/\r?\n/).map(csvFields).filter((fields) => fields.length >= 11).map((fields) => ({ file: fields[6], name: fields[7], complexity: Number(fields[1]), line: Number(fields[9]), endLine: Number(fields[10]) })).filter((entry) => [entry.complexity, entry.line, entry.endLine].every(Number.isFinite));
}

function runLizard(file, root, language) {
  for (const [command, leading] of [['lizard', []], ['uvx', ['lizard']], ['pipx', ['run', 'lizard']]]) {
    const result = spawnSync(command, [...leading, '--csv', '-l', language, file], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (result.error?.code === 'ENOENT') continue;
    if (result.status !== 0) throw new Error(`Lizard failed: ${result.stderr || result.error?.message}. Install or repair lizard with uv tool install lizard, pipx install lizard, or pip install lizard.`);
    return parseLizardCsv(result.stdout);
  }
  throw new Error('Lizard is unavailable. Install it with uv tool install lizard, pipx install lizard, or pip install lizard, then rerun the gate.');
}

function phpDefinitions(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"/g, (token) => token.replace(/[^\r\n]/g, ' '));
  return [...code.matchAll(/\bfunction\s*&?\s*([\w]*)\s*\(/g)].map((match) => ({ name: match[1] || '(anonymous)', line: code.slice(0, match.index).split('\n').length }));
}

function boundRows(rows, definitions, text) {
  const counts = new Map();
  return rows.map((row) => {
    const ordinal = counts.get(row.name) ?? 0;
    counts.set(row.name, ordinal + 1);
    const definition = definitions.find((candidate) => candidate.line === row.line && candidate.name === row.name);
    const identity = `<root>/lizard:${row.name}#${ordinal}`;
    const fingerprint = crypto.createHash('sha256').update(text.split('\n').slice(row.line - 1, row.endLine).join('\n').replace(/\s+/g, ' ')).digest('hex');
    return { ...row, identity, parent: '<root>', fingerprint, source: 'lizard', ...(definition ? {} : { unverified: 'Lizard row cannot be bound to a source definition; informational only. Update the language adapter to measure this body.' }) };
  });
}

function vueScript(text) {
  return text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>|[\s\S]/g, (match, script) => script === undefined ? match.replace(/[^\r\n]/g, ' ') : match.slice(0, match.indexOf('>') + 1).replace(/[^\r\n]/g, ' ') + script + '</script>'.replace(/./g, ' '));
}

async function languageDefinitions(text, file, analyzer) {
  if (path.extname(file).toLowerCase() === '.php') return { language: 'php', source: text, definitions: phpDefinitions(text) };
  const source = vueScript(text);
  return { language: 'javascript', source, definitions: await analyzer.collectFunctions(source, 'script.ts') };
}

export async function lizardDescriptors(text, file, analyzer, complexityCsv) {
  const { language, source, definitions } = await languageDefinitions(text, file, analyzer);
  if (complexityCsv !== undefined) return boundRows(parseLizardCsv(complexityCsv).filter((row) => path.resolve(row.file) === path.resolve(file)), definitions, source);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-lizard-'));
  try {
    const target = path.join(directory, language === 'php' ? 'source.php' : 'source.js');
    fs.writeFileSync(target, source);
    return boundRows(runLizard(target, directory, language), definitions, source);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
