import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const waveSource = readFileSync(fileURLToPath(new URL("../workflows/wave.js", import.meta.url)), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runnableSource = waveSource.replace("export const meta", "const meta");

const RESULT = { result: "Done.", checked: "ok 0", uncertain: "", needs: "nothing", branch: "worktree-a", commits: 1, changedFiles: [] };
const VERDICT = { verdict: "pass", result: "Fine.", checked: "ok 0", uncertain: "", needs: "nothing" };

async function runWave(args, implementResult = RESULT) {
  const calls = [];
  const agent = async (prompt, options) => {
    calls.push({ prompt, options });
    return options.phase === "Review" ? VERDICT : implementResult;
  };
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item) => {
        let value = item;
        for (const stage of stages) value = await stage(value, item);
        return value;
      }),
    );
  const outcome = await new AsyncFunction("args", "agent", "pipeline", runnableSource)(args, agent, pipeline);
  return { calls, outcome };
}

const route = { agentType: "sidequest:worker", model: "sonnet", effort: "medium", worktree: true };

for (const prefix of ["SQ", "PL"]) {
  test(`${prefix}-12 runs from its id and brief file, and neither prompt carries brief text`, async () => {
    const briefFile = `/work/photo-library/.sidequest/briefs/${prefix}-12.md`;
    const tickets = [{ id: `${prefix}-12`, title: "Retry failed uploads", briefFile, ...route }];
    const { calls } = await runWave({ tickets, reviewRoute: { model: "sonnet", effort: "low" } });
    const [implement, review] = calls;

    assert.ok(implement.prompt.startsWith(`Ticket ${prefix}-12: Retry failed uploads`));
    assert.ok(implement.prompt.includes(briefFile));
    assert.deepEqual(
      { label: implement.options.label, agentType: implement.options.agentType, model: implement.options.model, isolation: implement.options.isolation },
      { label: `${prefix}-12`, agentType: "sidequest:worker", model: "sonnet", isolation: "worktree" },
    );
    assert.ok(review.prompt.startsWith(`${prefix}-12 [route:review]`));
    assert.ok(review.prompt.includes(briefFile));
    assert.equal(review.options.model, "sonnet");
    assert.equal(review.options.effort, "low");
  });
}

test("a ticket that says review false gets no review run, and a ticket outside a worktree gets no isolation", async () => {
  const tickets = [{ id: "PL-3", title: "Fix a typo", briefFile: "/work/p/.sidequest/briefs/PL-3.md", ...route, worktree: false, review: false }];
  const { calls, outcome } = await runWave({ tickets, reviewRoute: { model: "sonnet", effort: "low" } });

  assert.equal(calls.length, 1);
  assert.equal("isolation" in calls[0].options, false);
  assert.equal(outcome.results[0].review, null);
});

test("the arguments may arrive as text", async () => {
  const tickets = [{ id: "PL-4", title: "Name it", briefFile: "/work/p/.sidequest/briefs/PL-4.md", ...route }];
  const { calls } = await runWave(JSON.stringify({ tickets, reviewRoute: { model: "sonnet", effort: "low" } }));

  assert.equal(calls.length, 2);
});

test("a ticket whose agent returned nothing is reported failed, with no review run and no review note to write", async () => {
  const tickets = [{ id: "PL-5", title: "Name it", briefFile: "/work/p/.sidequest/briefs/PL-5.md", ...route }];
  const { calls, outcome } = await runWave({ tickets, reviewRoute: {} }, null);

  assert.equal(calls.length, 1);
  assert.equal(outcome.results[0].outcome, "failed");
  assert.equal(outcome.results[0].run, null);
  assert.ok(outcome.results[0].result.includes("write no review note"));
});
