#!/usr/bin/env node
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { configDirectoryOf } from "../hooks/config-directory.mjs";
import { canonicalPath } from "./worktrees.mjs";

const BOARD_FOLDER = ".sidequest";
const MONTH_IN_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const TRANSCRIPT_HEAD_BYTES = 16384;
const TRANSCRIPTS_TRIED_PER_FOLDER = 3;
const OPEN_STATUSES = ["inbox", "ready", "doing", "review", "needs-you"];

const REMOVE_OPTION = "--remove=";
const CONFIG_OPTION = "--config-dir=";

function readJsonOrEmpty(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function namesIn(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

const isSidequestKey = (key) => key.startsWith("sidequest@");

const isProjectPath = (entry) => typeof entry?.projectPath === "string" && entry.projectPath !== "";

export function projectFoldersInRecord(record) {
  return Object.entries(record.plugins ?? {})
    .filter(([key, entries]) => isSidequestKey(key) && Array.isArray(entries))
    .flatMap(([, entries]) => entries.filter(isProjectPath).map((entry) => entry.projectPath));
}

function installedProjectFolders(configDirectory) {
  if (configDirectory === undefined) return [];
  return projectFoldersInRecord(readJsonOrEmpty(join(configDirectory, "plugins", "installed_plugins.json")));
}

function headOf(path) {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const length = readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(handle);
  }
}

export function workingFolderIn(transcriptHead) {
  const escaped = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(transcriptHead)?.[1];
  if (escaped === undefined) return undefined;
  try {
    return JSON.parse(`"${escaped}"`);
  } catch {
    return undefined;
  }
}

function workingFolderOfTranscript(path) {
  try {
    return workingFolderIn(headOf(path));
  } catch {
    return undefined;
  }
}

// The folder's name is a lossy spelling of the path, so the path is read from inside a transcript instead.
function workingFolderOfSessionFolder(sessionFolder) {
  const transcripts = namesIn(sessionFolder).filter((name) => name.endsWith(".jsonl")).slice(0, TRANSCRIPTS_TRIED_PER_FOLDER);
  return transcripts.map((name) => workingFolderOfTranscript(join(sessionFolder, name))).find((folder) => folder !== undefined);
}

export function sessionWorkingFolders(configDirectory) {
  if (configDirectory === undefined) return [];
  const projectsFolder = join(configDirectory, "projects");
  return namesIn(projectsFolder).map((name) => workingFolderOfSessionFolder(join(projectsFolder, name))).filter((folder) => folder !== undefined);
}

function isBoard(project) {
  try {
    return statSync(join(project, BOARD_FOLDER)).isDirectory();
  } catch {
    return false;
  }
}

// A folder can be named two ways (a short Windows name, a link), so boards are told apart by where they resolve to.
export function boardProjectsAmong(folders) {
  const existing = folders.filter(isBoard).map(canonicalPath);
  return [...new Set(existing)];
}

const frontmatterOf = (ticketText) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(ticketText.replace(/^﻿/, ""))?.[1] ?? "";

export function statusOf(ticketText) {
  const frontmatter = frontmatterOf(ticketText);
  return [...frontmatter.matchAll(/^status:\s*"?([\w-]+)/gm)].at(-1)?.[1];
}

function ticketTextsIn(boardFolder) {
  const ticketsFolder = join(boardFolder, "tickets");
  return namesIn(ticketsFolder)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(ticketsFolder, name), "utf8"));
}

const LOG_STAMP = /^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z) /gm;

// The ticket's own word for when it last changed: its updated day and its newest log stamp.
export function lastStampOf(ticketText) {
  const updated = [...frontmatterOf(ticketText).matchAll(/^updated:\s*"?(\d{4}-\d{2}-\d{2})/gm)].map((match) => match[1]);
  const stamps = [...updated, ...[...ticketText.matchAll(LOG_STAMP)].map((match) => match[1])].map(Date.parse).filter(Number.isFinite);
  return stamps.length === 0 ? undefined : Math.max(...stamps);
}

export function countsOf(statuses) {
  return {
    open: statuses.filter((status) => OPEN_STATUSES.includes(status)).length,
    done: statuses.filter((status) => status === "done").length,
    parked: statuses.filter((status) => status === "parked").length,
  };
}

function filesOfTheBoard(boardFolder) {
  const inside = (name) => namesIn(join(boardFolder, name)).map((file) => join(boardFolder, name, file));
  return [join(boardFolder, "board.json"), ...inside("tickets"), ...inside("stories")];
}

function modifiedAt(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function lastFileChangeOf(boardFolder) {
  const times = filesOfTheBoard(boardFolder).map(modifiedAt).filter((time) => time !== undefined);
  return times.length === 0 ? (modifiedAt(boardFolder) ?? 0) : Math.max(...times);
}

// Seen on 2026-11-20: a checkout or a sync resets file times, so a board untouched for a year read as changed today.
// The tickets' own stamps say when the work last moved; file times are left for a board with no dated ticket.
export function lastChangeOf(boardFolder, ticketTexts = ticketTextsIn(boardFolder)) {
  const stamps = ticketTexts.map(lastStampOf).filter((stamp) => stamp !== undefined);
  return stamps.length === 0 ? lastFileChangeOf(boardFolder) : Math.max(...stamps);
}

export function isInsideRepository(folder) {
  const parent = dirname(folder);
  if (existsSync(join(folder, ".git"))) return true;
  return parent !== folder && isInsideRepository(parent);
}

const isUntouchedForAMonth = (lastChange, now) => now - lastChange > MONTH_IN_MILLISECONDS;

export function markOf({ open, isInRepository, lastChange }, now) {
  const facts = [open === 0 ? "no open ticket" : "", isInRepository ? "" : "no repository"].filter((fact) => fact !== "");
  return isUntouchedForAMonth(lastChange, now) && facts.length > 0 ? `untouched a month, ${facts.join(", ")}` : "";
}

export function describeBoard(project, now) {
  const boardFolder = join(project, BOARD_FOLDER);
  const ticketTexts = ticketTextsIn(boardFolder);
  const counts = countsOf(ticketTexts.map(statusOf));
  const board = { project, ...counts, lastChange: lastChangeOf(boardFolder, ticketTexts), isInRepository: isInsideRepository(project) };
  return { ...board, mark: markOf(board, now) };
}

const attentionOf = (board) => {
  if (board.mark !== "") return 0;
  return board.isInRepository ? 2 : 1;
};

// What a person would act on comes first: the marked, then the ones outside a repository, then the rest.
export const byAttention = (first, second) => attentionOf(first) - attentionOf(second) || first.project.localeCompare(second.project);

export function listBoards({ configDirectory, folders, now }) {
  const candidates = [...installedProjectFolders(configDirectory), ...sessionWorkingFolders(configDirectory), ...folders];
  return boardProjectsAmong(candidates).map((project) => describeBoard(project, now)).sort(byAttention);
}

const dayOf = (milliseconds) => new Date(milliseconds).toISOString().slice(0, 10);

const yesOrNo = (flag) => (flag ? "yes" : "no");

const boardCells = (board) => [board.project, String(board.open), String(board.done), String(board.parked), dayOf(board.lastChange), yesOrNo(board.isInRepository), board.mark];

export function countLine(boards) {
  const outside = boards.filter((board) => !board.isInRepository).length;
  const marked = boards.filter((board) => board.mark !== "").length;
  return `${boards.length} boards, ${outside} outside a git repository, ${marked} marked`;
}

export function renderBoards(boards) {
  if (boards.length === 0) return "no boards found";
  const header = ["folder", "open", "done", "parked", "last changed", "in git", ""];
  const rows = [header, ...boards.map(boardCells)];
  const widths = header.map((_, column) => Math.max(...rows.map((cells) => cells[column].length)));
  const table = rows.map((cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
  return [...table, "", countLine(boards)].join("\n");
}

function removeOneBoard(folder) {
  const board = join(canonicalPath(folder), BOARD_FOLDER);
  try {
    if (!existsSync(board)) return `kept ${folder}: no board there`;
    if (lstatSync(board).isSymbolicLink()) return `kept ${folder}: its board folder is a link, which is not followed`;
    rmSync(board, { recursive: true });
    return `removed ${board}`;
  } catch (error) {
    return `kept ${folder}: ${error.message}`;
  }
}

export const removeBoards = (folders) => folders.map(removeOneBoard);

const valuesOf = (commandLineArguments, option) =>
  commandLineArguments.filter((argument) => argument.startsWith(option)).map((argument) => argument.slice(option.length));

export function readOptions(commandLineArguments) {
  return {
    folders: commandLineArguments.filter((argument) => !argument.startsWith("--")),
    removals: valuesOf(commandLineArguments, REMOVE_OPTION),
    configDirectory: valuesOf(commandLineArguments, CONFIG_OPTION)[0],
  };
}

export function listAndRemove(commandLineArguments, environment, now) {
  const options = readOptions(commandLineArguments);
  const configDirectory = options.configDirectory ?? configDirectoryOf(environment, homedir());
  const boards = listBoards({ configDirectory, folders: options.folders, now });
  return [renderBoards(boards), ...removeBoards(options.removals)].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(listAndRemove(process.argv.slice(2), process.env, Date.now()));
}
