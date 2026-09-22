'use strict';

function splitCsvRow(row) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (quoted && character === '"') {
      if (row[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = false;
    } else if (quoted) field += character;
    else if (character === '"') quoted = true;
    else if (character === ',') { fields.push(field); field = ''; }
    else field += character;
  }
  fields.push(field);
  return fields;
}

function parseLizardCsv(csvText) {
  const functions = [];
  const ordinals = new Map();
  for (const row of csvText.split(/\r?\n/)) {
    const fields = splitCsvRow(row);
    if (fields.length < 11) continue;
    const complexity = Number(fields[1]);
    const start = Number(fields[9]);
    const end = Number(fields[10]);
    if (![complexity, start, end].every(Number.isFinite)) continue;
    const file = fields[6];
    const name = fields[7];
    const ordinalKey = `${file}\u0000${name}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    functions.push({ file, name, ordinal, complexity, start, end });
  }
  return functions;
}

function crapScore(complexity, coverage) {
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
}

function functionTokenCount(text) {
  return text.match(/\bfunction\b|=>|\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g)?.length ?? 0;
}

module.exports = { crapScore, functionTokenCount, parseLizardCsv, splitCsvRow };
