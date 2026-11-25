import fs from "node:fs";
import { parseFrontmatterLines, RuleParseError } from "./rule-files.mjs";
import { slugify } from "./rule-naming.mjs";

const FENCE = "---";

export function readRulesPage(filePath) {
  const rules = splitRulesPage(fs.readFileSync(filePath, "utf8"));
  return rules.map((rule, index) => ({ ...rule, name: ruleName(rule.data, index + 1) }));
}

export function splitRulesPage(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const fenceLines = lines.flatMap((line, index) => (line.trim() === FENCE ? [index] : []));
  if (fenceLines.length === 0) return text.trim() === "" ? [] : [{ data: {}, body: text.trim() }];
  if (fenceLines.length % 2 === 1) {
    throw new RuleParseError(`the page has ${fenceLines.length} --- lines, so one never pairs up. A rule body cannot hold a bare --- line`);
  }
  return pairFences(fenceLines).map(({ open, close, next }, index) => ({
    data: parseRuleFrontmatter(lines.slice(open + 1, close), open + 2, index + 1),
    body: lines.slice(close + 1, next).join("\n").trim(),
  }));
}

function pairFences(fenceLines) {
  const pairs = [];
  for (let index = 0; index < fenceLines.length; index += 2) {
    pairs.push({ open: fenceLines[index], close: fenceLines[index + 1], next: fenceLines[index + 2] });
  }
  return pairs;
}

function parseRuleFrontmatter(frontmatterLines, firstLineNumber, ruleNumber) {
  try {
    return parseFrontmatterLines(frontmatterLines, firstLineNumber);
  } catch (error) {
    if (error instanceof RuleParseError) throw new RuleParseError(`rule ${ruleNumber}: ${error.message}`);
    throw error;
  }
}

function ruleName(data, ruleNumber) {
  const fromDescription = typeof data.description === "string" ? slugify(data.description) : "";
  return fromDescription || `rule-${ruleNumber}`;
}
