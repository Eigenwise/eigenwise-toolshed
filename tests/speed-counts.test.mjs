import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baselineFrom,
  countRun,
  describeRefusals,
  endsByAsking,
  isTicketSettled,
  nextPersonLine,
  keepsRunFolders,
  overallVerdict,
  idsChangedOnDisk,
  judgeOneLineFix,
  judgeRiggedTicket,
  lastTurnAsked,
  mean,
  parseStreamLines,
  runsThatMetTheFailure,
  sumInputTokens,
  verdictLine,
} from "../scripts/speed-counts.mjs";

const toolCall = (name, input = {}, parent = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", name, input }] } });
const say = (text) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
const toolResult = (isError) => ({ type: "user", message: { content: [{ type: "tool_result", is_error: isError, content: "x" }] } });
const turnEnd = (usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70 }) => ({ type: "result", usage });

const unchangedTickets = { "SQ-1": "a", "SQ-2": "b" };
const context = { wallMilliseconds: 4200, seededIds: ["SQ-1", "SQ-2"], ticketsBefore: unchangedTickets, ticketsAfter: unchangedTickets, riggedId: "SQ-6" };

test("lines that are not json are skipped", () => {
  assert.deepEqual(parseStreamLines('{"type":"a"}\nnot json\n\n{"type":"b"}'), [{ type: "a" }, { type: "b" }]);
});

test("a final message ends by asking on a question mark or an ask for a reply", () => {
  assert.equal(endsByAsking("Done.\nShould I commit this?"), true);
  assert.equal(endsByAsking("Two options.\nReply with 1A or 1B"), true);
  assert.equal(endsByAsking("The fix is in. Tests pass."), false);
  assert.equal(endsByAsking("Is it fixed? Yes.\nTests pass."), false);
});

test("only the last message of a turn decides whether the person was asked", () => {
  const asked = [say("Fixed it."), say("Want me to commit?"), turnEnd()];
  const notAsked = [say("Can I help?"), say("Fixed and tested."), turnEnd()];
  assert.equal(lastTurnAsked(asked), true);
  assert.equal(lastTurnAsked(notAsked), false);
  assert.equal(lastTurnAsked([]), false);
});

test("a run is counted for tool calls, spawns, refusals, questions and tokens", () => {
  const rows = [
    toolCall("Read"),
    toolCall("Agent", { prompt: "do it" }),
    toolCall("Edit", {}, "toolu_1"),
    toolResult(true),
    toolResult(false),
    toolCall("AskUserQuestion"),
    say("Which one do you want?"),
    turnEnd(),
  ];
  const counts = countRun(rows, context);
  assert.equal(counts.toolCalls, 4);
  assert.equal(counts.agentSpawns, 1);
  assert.equal(counts.refusals, 1);
  assert.equal(counts.questions, 2);
  assert.equal(counts.inputTokens, 100);
  assert.equal(counts.wallSeconds, 4);
});

test("input tokens add up across every turn of a conversation", () => {
  assert.equal(sumInputTokens([turnEnd(), turnEnd({ input_tokens: 5 })]), 105);
  assert.equal(sumInputTokens([{ type: "result" }]), 0);
});

test("restarts count the starts of the rigged ticket after the first", () => {
  const rows = [
    toolCall("mcp__sidequest__start", { id: "SQ-6" }),
    toolCall("mcp__sidequest__start", { id: "SQ-6" }),
    toolCall("mcp__sidequest__start", { id: "SQ-60" }),
    toolCall("mcp__sidequest__board", { view: "ticket", id: "SQ-6" }),
  ];
  assert.equal(countRun(rows, context).riggedRestarts, 1);
  assert.equal(countRun(rows.slice(2), context).riggedRestarts, 0);
  assert.equal(countRun(rows, { ...context, riggedId: undefined }).riggedRestarts, 0);
});

test("a seeded ticket is touched by a board write or spawn naming it, or by a changed file, never by reading it", () => {
  const reading = [toolCall("mcp__sidequest__board", { view: "ticket", id: "SQ-1" })];
  const writing = [toolCall("mcp__sidequest__ticket", { operations: [{ op: "update", id: "SQ-1" }] })];
  const spawning = [toolCall("Agent", { prompt: "Work on SQ-2 now" })];
  assert.equal(countRun(reading, context).seededTouches, 0);
  assert.equal(countRun(writing, context).seededTouches, 1);
  assert.equal(countRun(spawning, context).seededTouches, 1);
  assert.equal(countRun([], { ...context, ticketsAfter: { "SQ-1": "a", "SQ-2": "changed" } }).seededTouches, 1);
  assert.equal(countRun([toolCall("mcp__sidequest__start", { id: "SQ-10" })], context).seededTouches, 0);
});

test("changed ticket files are found by id", () => {
  assert.deepEqual(idsChangedOnDisk({ "SQ-1": "a", "SQ-2": "b" }, { "SQ-1": "a", "SQ-2": "c" }), ["SQ-2"]);
});

test("the mean of the runs, and zero for no runs", () => {
  assert.equal(mean([9, 1, 5]), 5);
  assert.equal(mean([4, 5]), 4.5);
  assert.equal(mean([]), 0);
});

const quietRun = { toolCalls: 10, agentSpawns: 0, questions: 0, refusals: 0, inputTokens: 1000, wallSeconds: 5, seededTouches: 0, riggedRestarts: 0, verifyRuns: 2, redVerifyRuns: 2 };

test("a quiet one-line fix with no baseline passes", () => {
  assert.deepEqual(judgeOneLineFix([quietRun, quietRun, quietRun], undefined), []);
});

test("any spawn, refusal, question or seeded touch in the one-line fix says stop", () => {
  for (const field of ["agentSpawns", "refusals", "questions", "seededTouches"]) {
    const reasons = judgeOneLineFix([quietRun, { ...quietRun, [field]: 1 }, quietRun], undefined);
    assert.equal(reasons.length, 1, field);
  }
});

test("tool calls or input tokens more than a fifth over the baseline mean say stop", () => {
  const baseline = { toolCalls: 10, inputTokens: 1000 };
  assert.deepEqual(judgeOneLineFix([quietRun, quietRun, quietRun], baseline), []);
  const atTheLimit = { ...quietRun, toolCalls: 12, inputTokens: 1200 };
  assert.deepEqual(judgeOneLineFix([atTheLimit, atTheLimit, atTheLimit], baseline), []);
  const slower = { ...quietRun, toolCalls: 13, inputTokens: 1300 };
  assert.equal(judgeOneLineFix([slower, slower, slower], baseline).length, 2);
  assert.deepEqual(judgeOneLineFix([slower, quietRun, quietRun], baseline), []);
  const fourOrFive = [4, 5, 5].map((toolCalls) => ({ ...quietRun, toolCalls }));
  assert.deepEqual(judgeOneLineFix(fourOrFive, { toolCalls: 4.5, inputTokens: 1000 }), []);
});

test("the rigged ticket may be restarted once and asked about, and must leave the seeded tickets alone", () => {
  assert.deepEqual(judgeRiggedTicket([{ ...quietRun, riggedRestarts: 1, questions: 3 }]), []);
  assert.equal(judgeRiggedTicket([{ ...quietRun, riggedRestarts: 2 }]).length, 1);
  assert.equal(judgeRiggedTicket([{ ...quietRun, seededTouches: 1 }]).length, 1);
  assert.equal(judgeRiggedTicket([{ ...quietRun, riggedRestarts: 2, seededTouches: 1 }]).length, 2);
});

test("the verdict is one line per scenario", () => {
  const calm = verdictLine("one-line fix", [quietRun, quietRun], []);
  assert.equal(calm.includes("\n"), false);
  assert.match(calm, /toolCalls 10\/10/);
  assert.match(calm, /ok, not slower$/);
  assert.match(verdictLine("rigged ticket", [quietRun], ["a thing"]), /STOP AND LOOK: a thing$/);
});

test("the baseline keeps the means of the one-line fix and how many runs they come from", () => {
  const baseline = baselineFrom([quietRun, { ...quietRun, toolCalls: 20 }, { ...quietRun, toolCalls: 15 }], "2026-11-19");
  assert.deepEqual(baseline, { recordedOn: "2026-11-19", runs: 3, fix: { toolCalls: 15, inputTokens: 1000 } });
});

test("a run met the rigged failure when verify went red at least once", () => {
  assert.equal(runsThatMetTheFailure([quietRun, { ...quietRun, redVerifyRuns: 1 }, { ...quietRun, redVerifyRuns: 0 }]), 2);
  assert.equal(countRun([], { ...context, verifyRuns: 5 }).redVerifyRuns, 2);
  assert.equal(countRun([], { ...context, verifyRuns: 1 }).redVerifyRuns, 1);
  assert.equal(countRun([], context).verifyRuns, 0);
});

test("a rig no run met never passes, and the verdict says how many runs met it", () => {
  assert.match(overallVerdict([], [], 0, 3).text, /NOT EXERCISED/);
  assert.equal(overallVerdict([], [], 0, 3).exitCode, 1);
  assert.equal(overallVerdict(["a"], [], 2, 3).exitCode, 1);
  assert.equal(overallVerdict([], [], 2, 3).exitCode, 0);
  assert.match(overallVerdict([], [], 2, 3).text, /met in 2 of 3 runs/);
});

test("a third verify on the rigged ticket is a failure loop", () => {
  assert.deepEqual(judgeRiggedTicket([{ ...quietRun, verifyRuns: 2 }]), []);
  assert.match(judgeRiggedTicket([{ ...quietRun, verifyRuns: 3 }]).join(), /run again after 2 failures/);
});

test("refusals name the tool and the error text", () => {
  const rows = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Edit", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: "no\nsuch  file" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", is_error: true, content: [{ type: "text", text: "denied" }] }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: false, content: "fine" }] } },
  ];
  assert.deepEqual(describeRefusals(rows), ["Edit: no such file", "unknown tool: denied"]);
});

test("a ticket is settled when done or waiting on the person", () => {
  assert.equal(isTicketSettled("---\nid: SQ-6\nstatus: done\n---"), true);
  assert.equal(isTicketSettled("---\nstatus: needs-you\n---"), true);
  assert.equal(isTicketSettled("---\nstatus: doing\n---"), false);
  assert.equal(isTicketSettled(""), false);
});

test("the run folders are kept when asked to, and whenever the check flags something or fails", () => {
  assert.equal(keepsRunFolders(false, 0), false);
  assert.equal(keepsRunFolders(true, 0), true);
  assert.equal(keepsRunFolders(false, 1), true);
});

test("the played person answers a question and otherwise says go on", () => {
  assert.equal(nextPersonLine(true, "yes", "go on"), "yes");
  assert.equal(nextPersonLine(false, "yes", "go on"), "go on");
});
