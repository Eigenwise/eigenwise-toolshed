import fs from "node:fs";
import path from "node:path";

export class RuleParseError extends Error {}

const FRONTMATTER_FENCE = "---";
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/;
const SINGLE_QUOTED = /^'((?:[^']|'')*)'(?:\s+#.*)?$/;
const LIST_ITEM_LINE = /^\s*-\s+(.*)$/;
const KEY_VALUE_LINE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const INDENTED_TEXT_LINE = /^\s+\S/;
const BLOCK_SCALAR_INDICATOR = /^([>|])[+-]?\d*$/;
const BLANK_OR_COMMENT_LINE = /^\s*(#.*)?$/;

export function readRuleFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const { frontmatterLines, body } = splitFrontmatter(text);
  return { data: parseFrontmatterLines(frontmatterLines), body: body.trim() };
}

export function splitFrontmatter(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return { frontmatterLines: [], body: lines.join("\n") };
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
  if (closingIndex === -1) {
    throw new RuleParseError("frontmatter opens with --- but never closes");
  }
  return {
    frontmatterLines: lines.slice(1, closingIndex),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

export function parseFrontmatterLines(lines, firstLineNumber = 2) {
  const data = {};
  let openKey = null;
  lines.forEach((line, index) => {
    openKey = applyLine(data, openKey, line, index + firstLineNumber);
  });
  return data;
}

function applyLine(data, openKey, line, lineNumber) {
  if (openKey?.kind === "block" && (line.trim() === "" || INDENTED_TEXT_LINE.test(line))) {
    return appendText(data, openKey, line.trim());
  }
  const entry = classifyLine(line, lineNumber);
  if (entry.kind === "blank") return openKey;
  if (entry.kind === "item") return appendListItem(data, openKey, entry);
  if (entry.kind === "continuation") return appendContinuation(data, openKey, entry);
  return openAfterPair(data, entry);
}

function classifyLine(line, lineNumber) {
  if (BLANK_OR_COMMENT_LINE.test(line)) return { kind: "blank" };
  const item = LIST_ITEM_LINE.exec(line);
  if (item) return { kind: "item", rawValue: item[1], lineNumber };
  const pair = KEY_VALUE_LINE.exec(line);
  if (pair) return { kind: "pair", key: pair[1], rawValue: pair[2], lineNumber };
  if (INDENTED_TEXT_LINE.test(line)) return { kind: "continuation", text: line.trim(), lineNumber };
  throw new RuleParseError(`line ${lineNumber} of the file is not "key: value" or a "- item": ${line.trim()}`);
}

function openAfterPair(data, entry) {
  const blockScalar = BLOCK_SCALAR_INDICATOR.exec(entry.rawValue.trim());
  if (blockScalar) {
    data[entry.key] = "";
    return { name: entry.key, kind: "block", joiner: blockScalar[1] === "|" ? "\n" : " " };
  }
  data[entry.key] = parseValue(entry.rawValue);
  return { name: entry.key, kind: entry.rawValue.trim() === "" ? "empty" : "plain", joiner: " " };
}

function appendContinuation(data, openKey, entry) {
  if (openKey === null || (openKey.kind !== "empty" && openKey.kind !== "plain")) {
    throw new RuleParseError(`line ${entry.lineNumber} of the file is indented text with no key above it: ${entry.text}`);
  }
  return appendText(data, { ...openKey, kind: "plain" }, entry.text);
}

function appendText(data, openKey, text) {
  if (text === "") return openKey;
  const existing = data[openKey.name];
  data[openKey.name] = existing === "" ? text : `${existing}${openKey.joiner}${text}`;
  return openKey;
}

function appendListItem(data, openKey, entry) {
  if (openKey === null || (openKey.kind !== "empty" && openKey.kind !== "list")) {
    throw new RuleParseError(`line ${entry.lineNumber} of the file is a list item with no key above it`);
  }
  const existingItems = Array.isArray(data[openKey.name]) ? data[openKey.name] : [];
  data[openKey.name] = [...existingItems, parseScalar(entry.rawValue)];
  return { ...openKey, kind: "list" };
}

function parseValue(rawValue) {
  const text = rawValue.trim();
  if (text.startsWith("[")) return parseInlineList(text);
  return parseScalar(text);
}

function parseInlineList(text) {
  const inner = text.replace(/^\[/, "").replace(/\]\s*(#.*)?$/, "");
  return splitOutsideBraces(inner).map(parseScalar);
}

function parseScalar(text) {
  const doubleQuoted = DOUBLE_QUOTED.exec(text.trim());
  if (doubleQuoted) return unescapeDoubleQuoted(doubleQuoted[1]);
  const singleQuoted = SINGLE_QUOTED.exec(text.trim());
  if (singleQuoted) return singleQuoted[1].replaceAll("''", "'");
  return coercePlainScalar(text.trim().replace(/(^|\s+)#.*$/, ""));
}

function unescapeDoubleQuoted(inner) {
  try {
    return JSON.parse(`"${inner}"`);
  } catch {
    return inner;
  }
}

function coercePlainScalar(plain) {
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (plain === "null" || plain === "~") return null;
  return /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : plain;
}

export function splitOutsideBraces(text) {
  const parts = [];
  let current = "";
  let braceDepth = 0;
  let openQuote = null;
  for (const character of text) {
    openQuote = quoteAfter(openQuote, character);
    braceDepth += braceChange(character, openQuote);
    if (character === "," && isTopLevel(braceDepth, openQuote)) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function quoteAfter(openQuote, character) {
  if (openQuote === null) return character === '"' || character === "'" ? character : null;
  return character === openQuote ? null : openQuote;
}

function braceChange(character, openQuote) {
  if (openQuote !== null) return 0;
  if (character === "{") return 1;
  return character === "}" ? -1 : 0;
}

function isTopLevel(braceDepth, openQuote) {
  return braceDepth === 0 && openQuote === null;
}

export function listMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(entryPath);
      return entry.name.endsWith(".md") ? [entryPath] : [];
    })
    .sort();
}
