import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findClaudeBinary, repositoryRoot } from "./repository.mjs";
import { baselineFrom, countRun, describeRefusals, isTicketSettled, judgeOneLineFix, keepsRunFolders, judgeRiggedTicket, lastTurnAsked, nextPersonLine, overallVerdict, parseStreamLines, runsThatMetTheFailure, verdictLine } from "./speed-counts.mjs";
import { buildOneLineFixFixture, buildRiggedTicketFixture, readRiggedTicket, readSeededTickets, readVerifyRuns, RIGGED_ID, SEEDED_IDS } from "./speed-fixture.mjs";

const CHEAPEST_MODEL = "haiku";
// A plain yes approved everything the session had offered, other tickets included, and that read as the product getting louder.
const PERSON_ANSWER = "Take your recommended answer, for this ticket only. Start nothing else.";
const PERSON_GO_ON = "Go on.";
const MORE_PERSON_TURNS = 2;
const TURN_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
const baselineFile = join(repositoryRoot, "scripts", "speed-baseline.json");
const sidequestPlugin = join(repositoryRoot, "plugins", "sidequest");
const runningProcessIds = new Set();
// A test session in another harness created a real repository and opened a pull request with the person's own
// credentials. These sessions get none, and their git cannot reach the real host.
const WITHOUT_TRACKER = {
  GH_TOKEN: "blocked-for-test-sessions",
  GITHUB_TOKEN: "blocked-for-test-sessions",
  GH_CONFIG_DIR: join(tmpdir(), "speedcheck-no-tracker"),
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "url.https://blocked.invalid/.insteadOf",
  GIT_CONFIG_VALUE_0: "https://github.com/",
  GIT_CONFIG_KEY_1: "url.ssh://blocked.invalid/.insteadOf",
  GIT_CONFIG_VALUE_1: "git@github.com:",
};

function stopProcess(processId) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(processId), "/t", "/f"], { windowsHide: true });
  else process.kill(processId);
}

function stopEverythingStarted() {
  for (const processId of runningProcessIds) stopProcess(processId);
  runningProcessIds.clear();
}

function claudeArguments(prompt, sessionId) {
  const base = ["-p", prompt, "--model", CHEAPEST_MODEL, "--output-format", "stream-json", "--verbose", "--setting-sources", "project,local", "--permission-mode", "bypassPermissions", "--plugin-dir", sidequestPlugin];
  return sessionId ? [...base, "--resume", sessionId] : base;
}

function runClaudeTurn(claudeBinary, directory, prompt, sessionId) {
  return new Promise((resolve) => {
    const child = spawn(claudeBinary, claudeArguments(prompt, sessionId), { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...WITHOUT_TRACKER } });
    runningProcessIds.add(child.pid);
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.resume();
    const timer = setTimeout(() => stopProcess(child.pid), TURN_TIMEOUT_MILLISECONDS);
    child.on("close", () => {
      clearTimeout(timer);
      runningProcessIds.delete(child.pid);
      const rows = parseStreamLines(Buffer.concat(chunks).toString("utf8"));
      resolve({ rows, sessionId: rows.find((row) => row.session_id)?.session_id });
    });
  });
}

async function runConversation(claudeBinary, directory, request, personTurns) {
  let turn = await runClaudeTurn(claudeBinary, directory, request, undefined);
  const rows = [...turn.rows];
  for (let answered = 0; answered < personTurns && turn.sessionId && !isTicketSettled(readRiggedTicket(directory)); answered += 1) {
    turn = await runClaudeTurn(claudeBinary, directory, nextPersonLine(lastTurnAsked(turn.rows), PERSON_ANSWER, PERSON_GO_ON), turn.sessionId);
    rows.push(...turn.rows);
  }
  return rows;
}

async function runScenarioOnce(claudeBinary, root, scenario, runNumber) {
  const directory = join(root, `${scenario.name}-${runNumber}`);
  const counterFile = `${directory}.count`;
  mkdirSync(directory, { recursive: true });
  const { request } = scenario.build(directory, counterFile);
  const ticketsBefore = readSeededTickets(directory);
  const startedAt = Date.now();
  const rows = await runConversation(claudeBinary, directory, request, scenario.personTurns);
  const wallMilliseconds = Date.now() - startedAt;
  writeFileSync(`${directory}.jsonl`, rows.map((row) => JSON.stringify(row)).join("\n"));
  const ticketsAfter = readSeededTickets(directory);
  const verifyRuns = readVerifyRuns(counterFile);
  const counts = countRun(rows, { wallMilliseconds, seededIds: SEEDED_IDS, ticketsBefore, ticketsAfter, riggedId: scenario.riggedId, verifyRuns });
  return { counts, refusals: describeRefusals(rows) };
}

async function runScenario(claudeBinary, root, scenario, runCount) {
  const runs = [];
  for (let runNumber = 1; runNumber <= runCount; runNumber += 1) {
    console.log(`${scenario.name} run ${runNumber} of ${runCount} ...`);
    const run = await runScenarioOnce(claudeBinary, root, scenario, runNumber);
    run.refusals.forEach((refusal) => console.log(`  refused: ${refusal}`));
    runs.push(run.counts);
  }
  return runs;
}

function readBaseline() {
  return existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : undefined;
}

function removeSessionFolders(token) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (!existsSync(projects)) return;
  for (const name of readdirSync(projects)) if (name.includes(token)) rmSync(join(projects, name), { recursive: true, force: true });
}

function removeRunFolders(root, token, keepRuns) {
  removeSessionFolders(token);
  if (keepRuns) console.log(`kept, with each run's rows beside its folder: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

function parseArguments(argumentList) {
  const runsAt = argumentList.indexOf("--runs");
  return { writeBaseline: argumentList.includes("--write-baseline"), keepRuns: argumentList.includes("--keep"), runCount: runsAt === -1 ? 3 : Number(argumentList[runsAt + 1]) };
}

function printVerdicts(fixRuns, riggedRuns, baseline) {
  const fixReasons = judgeOneLineFix(fixRuns, baseline?.fix);
  const riggedReasons = judgeRiggedTicket(riggedRuns);
  console.log(`\n${verdictLine("one-line fix", fixRuns, fixReasons)}`);
  console.log(verdictLine("rigged ticket", riggedRuns, riggedReasons));
  if (!baseline) console.log("no baseline stored: only the absolute limits were judged");
  const verdict = overallVerdict(fixReasons, riggedReasons, runsThatMetTheFailure(riggedRuns), riggedRuns.length);
  console.log(`\nVERDICT: ${verdict.text}`);
  return verdict.exitCode;
}

export async function runSpeedCheck(argumentList) {
  const { writeBaseline, keepRuns, runCount } = parseArguments(argumentList);
  const claudeBinary = findClaudeBinary();
  if (!claudeBinary || /\.(cmd|bat)$/i.test(claudeBinary)) {
    console.log("a claude binary that can be started directly was not found; set CLAUDE_BIN");
    return 1;
  }
  const root = mkdtempSync(join(tmpdir(), "speedcheck-"));
  const token = root.split(/[\\/]/).pop();
  let exitCode = 1;
  try {
    const fixRuns = await runScenario(claudeBinary, root, { name: "fix", build: buildOneLineFixFixture, personTurns: 0 }, runCount);
    const riggedRuns = await runScenario(claudeBinary, root, { name: "rigged", build: buildRiggedTicketFixture, riggedId: RIGGED_ID, personTurns: MORE_PERSON_TURNS }, runCount);
    if (writeBaseline) writeFileSync(baselineFile, `${JSON.stringify(baselineFrom(fixRuns, new Date().toISOString().slice(0, 10)), null, 2)}\n`);
    exitCode = printVerdicts(fixRuns, riggedRuns, writeBaseline ? undefined : readBaseline());
    return exitCode;
  } finally {
    stopEverythingStarted();
    removeRunFolders(root, token, keepsRunFolders(keepRuns, exitCode));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once("SIGINT", () => {
    stopEverythingStarted();
    process.exit(130);
  });
  process.exitCode = await runSpeedCheck(process.argv.slice(2));
}
