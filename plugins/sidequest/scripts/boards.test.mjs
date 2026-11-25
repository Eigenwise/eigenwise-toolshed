import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalPath } from "./worktrees.mjs";
import { countsOf, listAndRemove, listBoards, projectFoldersInRecord, renderBoards, statusOf, workingFolderIn } from "./boards.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "boards.mjs");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-20T12:00:00Z");

let scratch;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "sidequest-boards-"));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ticketText = (status) => `---\nid: SQ-1\ntitle: "x"\nstatus: ${status}\n---\n\n## What\nstatus: not this one\n`;

function makeBoard(name, statuses, daysAgo) {
  const project = join(scratch, name);
  const tickets = join(project, ".sidequest", "tickets");
  mkdirSync(tickets, { recursive: true });
  writeFileSync(join(project, ".sidequest", "board.json"), "{}");
  statuses.forEach((status, index) => writeFileSync(join(tickets, `SQ-${index + 1}.md`), ticketText(status)));
  const touched = new Date(NOW - daysAgo * DAY);
  for (const path of [join(project, ".sidequest", "board.json"), ...statuses.map((_, index) => join(tickets, `SQ-${index + 1}.md`))]) utimesSync(path, touched, touched);
  return project;
}

const noInstallRecord = join(tmpdir(), "sidequest-boards-no-such-config");

describe("reading a ticket", () => {
  test("takes the status from the frontmatter only", () => {
    assert.equal(statusOf(ticketText("parked")), "parked");
    assert.equal(statusOf("no frontmatter here"), undefined);
  });

  test("skips a byte-order mark", () => {
    assert.equal(statusOf(`﻿${ticketText("parked")}`), "parked");
  });

  test("takes the last of a duplicated status", () => {
    assert.equal(statusOf("---\nid: SQ-1\nstatus: ready\nstatus: done\n---\n\n## What\nx\n"), "done");
  });

  test("counts open, done and parked, and leaves dropped out", () => {
    const counts = countsOf(["ready", "doing", "needs-you", "done", "done", "parked", "dropped"]);
    assert.deepEqual(counts, { open: 3, done: 2, parked: 1 });
  });
});

describe("the installed plugins record", () => {
  test("names the project folders of this plugin only", () => {
    const record = {
      plugins: {
        "sidequest@toolshed-next": [{ scope: "project", projectPath: "/a" }, { scope: "user" }, { scope: "local", projectPath: "/b" }],
        "quartermaster@toolshed-next": [{ scope: "project", projectPath: "/c" }],
      },
    };
    assert.deepEqual(projectFoldersInRecord(record), ["/a", "/b"]);
    assert.deepEqual(projectFoldersInRecord({}), []);
  });
});

describe("listing boards", () => {
  test("names each board with its counts and last change, and marks the forgotten one", () => {
    const active = makeBoard("active", ["ready", "done", "parked"], 2);
    const forgotten = makeBoard("forgotten", ["done", "done"], 45);
    const parkedOnly = makeBoard("parked-only", ["parked"], 60);
    const noBoard = join(scratch, "no-board");
    mkdirSync(noBoard);

    const boards = listBoards({ configDirectory: undefined, folders: [active, forgotten, parkedOnly, noBoard], now: NOW });
    const byProject = Object.fromEntries(boards.map((board) => [board.project, board]));

    assert.equal(boards.length, 3);
    assert.deepEqual(
      [byProject[canonicalPath(active)].open, byProject[canonicalPath(active)].done, byProject[canonicalPath(active)].parked],
      [1, 1, 1],
    );
    assert.equal(byProject[canonicalPath(active)].mark, "");
    assert.match(byProject[canonicalPath(forgotten)].mark, /untouched a month, no open ticket/);
    assert.match(byProject[canonicalPath(parkedOnly)].mark, /untouched a month, no open ticket/);
    assert.equal(Math.round((NOW - byProject[canonicalPath(forgotten)].lastChange) / DAY), 45);

    const text = renderBoards(boards);
    assert.match(text, /2026-10-06/);
    assert.equal(text.split("\n").filter((line) => line.includes("untouched a month")).length, 2);
  });

  test("reads the folders the installed plugins record names, and counts a folder named twice once", () => {
    const configDirectory = join(scratch, "config");
    const project = makeBoard("from-record", ["ready"], 1);
    mkdirSync(join(configDirectory, "plugins"), { recursive: true });
    const record = { plugins: { "sidequest@toolshed-next": [{ scope: "project", projectPath: project }, { scope: "local", projectPath: project }] } };
    writeFileSync(join(configDirectory, "plugins", "installed_plugins.json"), JSON.stringify(record));

    const boards = listBoards({ configDirectory, folders: [project], now: NOW });

    assert.deepEqual(boards.map((board) => board.project), [canonicalPath(project)]);
  });

  test("reads the last change from the tickets' own stamps, so a checkout that reset the file times does not hide a forgotten board", () => {
    const project = makeBoard("checked-out-today", [], 0);
    const tickets = join(project, ".sidequest", "tickets");
    const dated = (id, updated, logStamp) =>
      `---\nid: ${id}\ntitle: "x"\nstatus: done\nupdated: ${updated}\n---\n\n## Log\n- ${logStamp} finished done\n`;
    writeFileSync(join(tickets, "SQ-1.md"), dated("SQ-1", "2026-09-01", "2026-09-01T10:00Z"));
    writeFileSync(join(tickets, "SQ-2.md"), dated("SQ-2", "2026-09-30", "2026-10-05T08:00Z"));

    const [board] = listBoards({ configDirectory: undefined, folders: [project], now: NOW });

    assert.equal(new Date(board.lastChange).toISOString(), "2026-10-05T08:00:00.000Z");
    assert.match(board.mark, /untouched a month, no open ticket/);
  });

  test("a board with no open ticket that changed this week is not marked", () => {
    const recent = makeBoard("recent-and-finished", ["done"], 3);
    const [board] = listBoards({ configDirectory: undefined, folders: [recent], now: NOW });
    assert.equal(board.mark, "");
  });
});

const transcriptHead = (workingFolder) => `{"type":"user","cwd":${JSON.stringify(workingFolder)},"sessionId":"x"}\n`;

function makeSessionFolder(configDirectory, slug, transcripts) {
  const folder = join(configDirectory, "projects", slug);
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(transcripts)) writeFileSync(join(folder, name), text);
}

const boardsAt = (configDirectory, folders = []) => listBoards({ configDirectory, folders, now: NOW });

describe("folders the sessions ran in", () => {
  test("reads the working folder out of a transcript head, with backslashes escaped the JSON way", () => {
    assert.equal(workingFolderIn(transcriptHead("C:\\Users\\someone\\temp folder")), "C:\\Users\\someone\\temp folder");
    assert.equal(workingFolderIn('{"type":"summary"}\n'), undefined);
    assert.equal(workingFolderIn('{"cwd":"broken \\u12"}'), undefined);
  });

  test("finds a board in a folder only a session names, skipping empty folders, a transcript with no folder and a folder that is gone", () => {
    const configDirectory = join(scratch, "config-sessions");
    const stray = makeBoard("stray", ["ready"], 50);
    const fromSecond = makeBoard("from-second-transcript", ["done"], 1);
    makeSessionFolder(configDirectory, "stray-slug", { "a.jsonl": transcriptHead(stray) });
    makeSessionFolder(configDirectory, "second-slug", { "a.jsonl": '{"type":"summary"}\n', "b.jsonl": transcriptHead(fromSecond) });
    makeSessionFolder(configDirectory, "no-transcript-slug", {});
    makeSessionFolder(configDirectory, "no-folder-slug", { "a.jsonl": '{"type":"summary"}\n' });
    makeSessionFolder(configDirectory, "gone-slug", { "a.jsonl": transcriptHead(join(scratch, "was-deleted")) });

    const projects = boardsAt(configDirectory).map((board) => board.project).sort();

    assert.deepEqual(projects, [canonicalPath(fromSecond), canonicalPath(stray)].sort());
  });

  test("a board named by the record and by a session is listed once", () => {
    const configDirectory = join(scratch, "config-both");
    const project = makeBoard("named-twice", ["ready"], 1);
    mkdirSync(join(configDirectory, "plugins"), { recursive: true });
    writeFileSync(join(configDirectory, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "sidequest@toolshed-next": [{ scope: "project", projectPath: project }] } }));
    makeSessionFolder(configDirectory, "slug", { "a.jsonl": transcriptHead(project) });

    assert.equal(boardsAt(configDirectory, [project]).length, 1);
  });

  test("reads only the head of a long transcript", () => {
    const configDirectory = join(scratch, "config-long");
    const project = makeBoard("long-transcript", ["ready"], 1);
    makeSessionFolder(configDirectory, "slug", { "a.jsonl": transcriptHead(project) + "x".repeat(2_000_000) });

    assert.equal(boardsAt(configDirectory).length, 1);
  });
});

describe("boards inside and outside a git repository", () => {
  test("says which, marks a stale one outside a repository even with an open ticket, and puts the marked first", () => {
    const insideRepository = makeBoard("inside", ["done"], 1);
    mkdirSync(join(insideRepository, ".git"));
    const staleInside = makeBoard("stale-inside", ["done"], 50);
    mkdirSync(join(staleInside, ".git"));
    const staleStrayWithOpenTicket = makeBoard("stale-stray", ["ready"], 50);
    const freshOutside = makeBoard("fresh-outside", ["ready"], 1);

    const boards = boardsAt(undefined, [insideRepository, staleInside, staleStrayWithOpenTicket, freshOutside]);
    const byName = Object.fromEntries(boards.map((board) => [board.project.split(/[\\/]/).at(-1), board]));

    assert.equal(byName.inside.isInRepository, true);
    assert.equal(byName["fresh-outside"].isInRepository, false);
    assert.equal(byName["stale-stray"].mark, "untouched a month, no repository");
    assert.equal(byName["stale-inside"].mark, "untouched a month, no open ticket");
    assert.equal(byName.inside.mark, "");
    assert.deepEqual(boards.map((board) => board.project.split(/[\\/]/).at(-1)), ["stale-inside", "stale-stray", "fresh-outside", "inside"]);
  });

  test("ends with one count line", () => {
    const stray = makeBoard("counted-stray", ["done"], 50);
    const inside = makeBoard("counted-inside", ["ready"], 1);
    mkdirSync(join(inside, ".git"));

    const text = renderBoards(boardsAt(undefined, [stray, inside]));

    assert.equal(text.split("\n").at(-1), "2 boards, 1 outside a git repository, 1 marked");
  });
});

describe("removing boards", () => {
  test("removes only the board folder it was told to and says what went", () => {
    const named = makeBoard("to-remove", ["done"], 90);
    const other = makeBoard("to-keep", ["done"], 90);
    writeFileSync(join(named, "source.txt"), "project file");

    const answer = listAndRemove([`--remove=${named}`, other, `--config-dir=${noInstallRecord}`], {}, NOW);

    assert.equal(existsSync(join(named, ".sidequest")), false);
    assert.equal(existsSync(join(named, "source.txt")), true);
    assert.equal(existsSync(join(other, ".sidequest", "board.json")), true);
    assert.match(answer, /removed .*to-remove.*\.sidequest/);
  });

  test("says so when the named folder has no board, and removes nothing", () => {
    const empty = join(scratch, "no-board-to-remove");
    mkdirSync(empty);

    const answer = listAndRemove([`--remove=${empty}`, `--config-dir=${noInstallRecord}`], {}, NOW);

    assert.match(answer, /kept .*no-board-to-remove: no board there/);
    assert.equal(existsSync(empty), true);
  });

  test("lists without removing anything when no folder is named", () => {
    const project = makeBoard("only-listed", ["done"], 90);
    const answer = listAndRemove([project, `--config-dir=${noInstallRecord}`], {}, NOW);

    assert.doesNotMatch(answer, /removed/);
    assert.equal(existsSync(join(project, ".sidequest", "board.json")), true);
  });
});

describe("the command", () => {
  test("prints the listing for a folder given as an argument", () => {
    const project = makeBoard("by-command", ["ready", "done"], 0);
    const printed = execFileSync(process.execPath, [scriptPath, project, `--config-dir=${noInstallRecord}`], { encoding: "utf8" });

    assert.match(printed, /folder\s+open\s+done\s+parked\s+last changed/);
    assert.match(printed, /by-command\s+1\s+1\s+0/);
  });
});
