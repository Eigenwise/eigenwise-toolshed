const BOARD_WRITING_TOOLS = /^mcp__sidequest__(start|ticket|finish)$/;
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const QUESTION_WORDS = /\b(reply|pick one|your call|which (one|do you|would you)|do you want|should i|let me know)\b/i;
const OVER_BASELINE_FACTOR = 1.2;
const FIX_FIELDS_THAT_MUST_STAY_ZERO = [
  ["agentSpawns", "an agent was spawned"],
  ["refusals", "a tool call was refused"],
  ["questions", "the person was asked"],
  ["seededTouches", "a seeded ticket was touched"],
];
const REPORTED_FIELDS = ["toolCalls", "agentSpawns", "questions", "refusals", "inputTokens", "wallSeconds", "seededTouches", "riggedRestarts", "verifyRuns", "redVerifyRuns"];
const SETTLED_TICKET_STATUSES = ["done", "needs-you"];
const REFUSAL_TEXT_LENGTH = 200;
export const RIGGED_RESTART_LIMIT = 1;
export const RIGGED_VERIFY_LIMIT = 2;
export const RIGGED_RED_RUNS = 2;

function parseLine(line) {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
}

export function parseStreamLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap(parseLine);
}

function contentBlocks(row) {
  const content = row.message?.content;
  return Array.isArray(content) ? content : [];
}

function toolUses(rows) {
  return rows.filter((row) => row.type === "assistant").flatMap((row) => contentBlocks(row).filter((block) => block.type === "tool_use"));
}

function toolResults(rows) {
  return rows.filter((row) => row.type === "user").flatMap((row) => contentBlocks(row).filter((block) => block.type === "tool_result"));
}

function lastTextOf(row) {
  const texts = contentBlocks(row).filter((block) => block.type === "text" && block.text.trim());
  return texts.length > 0 ? texts[texts.length - 1].text : "";
}

export function endsByAsking(text) {
  const lastLines = text
    .split("\n")
    .filter((line) => line.trim())
    .slice(-2)
    .map((line) => line.trimEnd());
  return lastLines.some((line) => line.endsWith("?")) || QUESTION_WORDS.test(lastLines.join("\n"));
}

function finalMessagesOfTurns(rows) {
  const finals = [];
  let latest;
  for (const row of rows) {
    if (row.type === "assistant" && !row.parent_tool_use_id) latest = row;
    if (row.type === "result") {
      finals.push(latest);
      latest = undefined;
    }
  }
  return finals.filter(Boolean);
}

function countQuestions(rows) {
  const askedInText = finalMessagesOfTurns(rows).filter((row) => endsByAsking(lastTextOf(row))).length;
  const askedThroughTool = toolUses(rows).filter((block) => block.name === "AskUserQuestion").length;
  return askedInText + askedThroughTool;
}

export function lastTurnAsked(rows) {
  const finals = finalMessagesOfTurns(rows);
  return finals.length > 0 && endsByAsking(lastTextOf(finals[finals.length - 1]));
}

function inputTokensOf(usage) {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export function sumInputTokens(rows) {
  return rows.filter((row) => row.type === "result").reduce((sum, row) => sum + inputTokensOf(row.usage ?? {}), 0);
}

function namesTicket(input, id) {
  return new RegExp(`(^|[^0-9A-Za-z-])${id}(?![0-9])`).test(JSON.stringify(input));
}

function isBoardWriteOrAgentSpawn(block) {
  return BOARD_WRITING_TOOLS.test(block.name) || AGENT_TOOLS.has(block.name);
}

export function idsNamedByBoardCalls(rows, ids) {
  const calls = toolUses(rows).filter(isBoardWriteOrAgentSpawn);
  return ids.filter((id) => calls.some((block) => namesTicket(block.input, id)));
}

export function countStarts(rows, id) {
  return toolUses(rows).filter((block) => block.name === "mcp__sidequest__start" && block.input?.id === id).length;
}

export function idsChangedOnDisk(ticketsBefore, ticketsAfter) {
  return Object.keys(ticketsBefore).filter((id) => ticketsBefore[id] !== ticketsAfter[id]);
}

function textOfResult(block) {
  const content = block.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => part.text ?? "").join(" ") : "";
}

export function describeRefusals(rows) {
  const namesById = new Map(toolUses(rows).map((block) => [block.id, block.name]));
  return toolResults(rows)
    .filter((block) => block.is_error === true)
    .map((block) => `${namesById.get(block.tool_use_id) ?? "unknown tool"}: ${textOfResult(block).replace(/\s+/g, " ").slice(0, REFUSAL_TEXT_LENGTH)}`);
}

export function ticketStatusOf(ticketText) {
  return /^status: *(\S+)/m.exec(ticketText)?.[1];
}

export function isTicketSettled(ticketText) {
  return SETTLED_TICKET_STATUSES.includes(ticketStatusOf(ticketText));
}

export function nextPersonLine(askedLastTurn, answerLine, goOnLine) {
  return askedLastTurn ? answerLine : goOnLine;
}

export function countRun(rows, { wallMilliseconds, seededIds, ticketsBefore, ticketsAfter, riggedId, verifyRuns = 0 }) {
  const touched = new Set([...idsNamedByBoardCalls(rows, seededIds), ...idsChangedOnDisk(ticketsBefore, ticketsAfter)]);
  return {
    toolCalls: toolUses(rows).length,
    agentSpawns: toolUses(rows).filter((block) => AGENT_TOOLS.has(block.name)).length,
    questions: countQuestions(rows),
    refusals: toolResults(rows).filter((block) => block.is_error === true).length,
    inputTokens: sumInputTokens(rows),
    wallSeconds: Math.round(wallMilliseconds / 1000),
    seededTouches: touched.size,
    riggedRestarts: riggedId ? Math.max(countStarts(rows, riggedId) - 1, 0) : 0,
    verifyRuns,
    redVerifyRuns: Math.min(verifyRuns, RIGGED_RED_RUNS),
  };
}

// A mean, because a one-line fix takes 4 or 5 tool calls from run to run and a median of three flips between them.
export function mean(numbers) {
  return numbers.length === 0 ? 0 : numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
}

export function meanOf(runs, field) {
  return mean(runs.map((run) => run[field]));
}

function isOverBaseline(runs, field, baselineValue) {
  return baselineValue !== undefined && meanOf(runs, field) > baselineValue * OVER_BASELINE_FACTOR;
}

export function judgeOneLineFix(runs, baseline) {
  const reasons = FIX_FIELDS_THAT_MUST_STAY_ZERO.filter(([field]) => runs.some((run) => run[field] > 0)).map(([, label]) => label);
  if (isOverBaseline(runs, "toolCalls", baseline?.toolCalls)) reasons.push("tool calls more than a fifth over the baseline");
  if (isOverBaseline(runs, "inputTokens", baseline?.inputTokens)) reasons.push("input tokens more than a fifth over the baseline");
  return reasons;
}

export function runsThatMetTheFailure(runs) {
  return runs.filter((run) => run.redVerifyRuns > 0).length;
}

export function judgeRiggedTicket(runs) {
  const reasons = [];
  if (runs.some((run) => run.riggedRestarts > RIGGED_RESTART_LIMIT)) reasons.push(`the ticket was restarted more than ${RIGGED_RESTART_LIMIT} time`);
  if (runs.some((run) => run.seededTouches > 0)) reasons.push("a seeded ticket was touched");
  if (runs.some((run) => run.verifyRuns > RIGGED_VERIFY_LIMIT)) reasons.push(`verify was run again after ${RIGGED_VERIFY_LIMIT} failures on one ticket`);
  return reasons;
}

export function overallVerdict(fixReasons, riggedReasons, runsThatMetIt, runCount) {
  if (runsThatMetIt === 0) return { exitCode: 1, text: "the rigged scenario was NOT EXERCISED, no run got as far as a red verify, so nothing is said about the failure loop" };
  const metIn = `the rigged failure was met in ${runsThatMetIt} of ${runCount} runs`;
  if (fixReasons.length + riggedReasons.length > 0) return { exitCode: 1, text: `stop and look, this version has become slower or louder (${metIn})` };
  return { exitCode: 0, text: `this version is not slower than the baseline (${metIn})` };
}

// A flag with no transcript says nothing about its cause: a fault met in 1 run of 6 took three more passes to see.
export const keepsRunFolders = (askedToKeep, exitCode) => askedToKeep || exitCode !== 0;

function listPerRun(runs, field) {
  return `${field} ${runs.map((run) => run[field]).join("/")}`;
}

export function verdictLine(name, runs, reasons) {
  const verdict = reasons.length === 0 ? "ok, not slower" : `STOP AND LOOK: ${reasons.join("; ")}`;
  return `${name}: ${REPORTED_FIELDS.map((field) => listPerRun(runs, field)).join(", ")} -> ${verdict}`;
}

export function baselineFrom(fixRuns, recordedOn) {
  return {
    recordedOn,
    runs: fixRuns.length,
    fix: { toolCalls: meanOf(fixRuns, "toolCalls"), inputTokens: Math.round(meanOf(fixRuns, "inputTokens")) },
  };
}
