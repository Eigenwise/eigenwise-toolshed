#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RECORDS_FOLDER, keepRecordsOutOfGit, writeInto } from "./records-folder.mjs";
import { KEPT_ON_ANSWER_SUBJECTS } from "./upgrade-findings.mjs";

export const KEPT_RECORD = `${RECORDS_FOLDER}/upgrade-kept.md`;

const HEADER = [
  "# Kept on purpose in the Toolshed upgrade",
  "",
  "The upgrade run writes a line here when the person answers that something stays, or, for memory notes, when what is left in",
  "them is still true and the run says why. The upgrade scan then lists it under Kept with the date and the reason, and never",
  "as still to do. Delete a line to have the next run ask again.",
  "",
];

const KEPT_LINE = /^- ([a-z-]+): kept (\d{4}-\d{2}-\d{2}), (.+)$/;

export function parseKeptRecord(text) {
  const answers = {};
  for (const line of text.split(/\r?\n/)) {
    const match = KEPT_LINE.exec(line.trim());
    if (match !== null) answers[match[1]] = { date: match[2], reason: match[3] };
  }
  return answers;
}

function readTextOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export const readKeptAnswers = (project) => parseKeptRecord(readTextOrEmpty(join(project, KEPT_RECORD)));

const keptLine = (subject, answer) => `- ${subject}: kept ${answer.date}, ${answer.reason}`;

export function renderKeptRecord(answers) {
  const lines = Object.entries(answers).map(([subject, answer]) => keptLine(subject, answer));
  return [...HEADER, ...lines, ""].join("\n");
}

const oneLine = (text) => text.replace(/\s+/g, " ").trim();

export function recordKeptAnswer(project, subject, reason, today) {
  const answers = { ...readKeptAnswers(project), [subject]: { date: today, reason: oneLine(reason) } };
  keepRecordsOutOfGit(project);
  writeInto(join(project, KEPT_RECORD), renderKeptRecord(answers));
  return keptLine(subject, answers[subject]);
}

function valueAfter(commandLineArguments, flag) {
  const index = commandLineArguments.indexOf(flag);
  return index === -1 ? undefined : commandLineArguments[index + 1];
}

const USAGE = `usage: upgrade-kept.mjs --project <root> --keep <${KEPT_ON_ANSWER_SUBJECTS.join(" | ")}> --reason "<why it stays: the person's words, or for memory notes your own>"`;

function problemWith(subject, reason) {
  if (!KEPT_ON_ANSWER_SUBJECTS.includes(subject)) return `--keep takes ${KEPT_ON_ANSWER_SUBJECTS.join(", ")}`;
  return oneLine(reason ?? "") === "" ? "--reason needs the reason it stays" : "";
}

export function runKept(commandLineArguments, cwd, today = new Date().toISOString().slice(0, 10)) {
  const subject = valueAfter(commandLineArguments, "--keep");
  const reason = valueAfter(commandLineArguments, "--reason");
  const problem = problemWith(subject, reason);
  if (problem !== "") return { exitCode: 1, lines: [problem, USAGE] };
  const project = resolve(valueAfter(commandLineArguments, "--project") ?? cwd);
  return { exitCode: 0, lines: [`${KEPT_RECORD}: ${recordKeptAnswer(project, subject, reason, today)}`] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const answer = runKept(process.argv.slice(2), process.cwd());
  (answer.exitCode === 0 ? console.log : console.error)(answer.lines.join("\n"));
  process.exitCode = answer.exitCode;
}
