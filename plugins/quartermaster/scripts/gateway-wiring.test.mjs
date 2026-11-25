import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { hasGatewayLeftovers, isWiredToTheGateway, showsTheGateway, sortEnvironmentEntriesByWhoWroteThem } from "./gateway-wiring.mjs";
import { readOptions, renderPlan, scan } from "./upgrade-scan.mjs";

const READINESS_COMMAND = 'node "/home/person/.claude/model-gateway/model-gateway.js" readiness-gate';
const READINESS_HOOKS = {
  SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: READINESS_COMMAND }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: READINESS_COMMAND }] }],
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};

describe("what the older gateway left, with or without its address", () => {
  let scratch;
  let home;
  let caseNumber = 0;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-gateway-"));
    home = join(scratch, "home");
    mkdirSync(home);
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  // Each case gets its own home, so the gateway's folder left for one case is not there for the next.
  function planFor({ local, user, gatewayWasOnThisMachine = false }) {
    caseNumber += 1;
    const project = join(scratch, `project-${caseNumber}`);
    const caseHome = join(home, `case-${caseNumber}`);
    writeJson(join(project, ".claude", "settings.local.json"), local ?? {});
    writeJson(join(caseHome, ".claude", "settings.json"), user ?? {});
    if (gatewayWasOnThisMachine) mkdirSync(join(caseHome, ".claude", "model-gateway"));
    const report = JSON.parse(JSON.stringify(scan(readOptions(["--home", caseHome, "--project", project], {}, project))));
    return { text: renderPlan(report), leftovers: report.project.leftovers };
  }

  const ofKind = (leftovers, kind) => leftovers.filter((leftover) => leftover.kind === kind);

  test("a project whose address was deleted by hand still lists the hooks and a gateway pin", () => {
    const { leftovers, text } = planFor({
      local: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]", ENABLE_TOOL_SEARCH: "true" }, hooks: READINESS_HOOKS },
    });
    const [wiring] = ofKind(leftovers, "gateway-wiring");
    assert.equal(wiring.verdict, "ask");
    assert.equal(wiring.where, ".claude/settings.local.json env ENABLE_TOOL_SEARCH, ANTHROPIC_DEFAULT_OPUS_MODEL");
    const [hooks] = ofKind(leftovers, "gateway-hooks");
    assert.equal(hooks.where, ".claude/settings.local.json hooks (2)");
    assert.deepEqual(hooks.readyLines, [`hooks SessionStart: ${READINESS_COMMAND}`, `hooks UserPromptSubmit: ${READINESS_COMMAND}`]);
    assert.match(text, /ask\s+\.claude\/settings\.local\.json hooks \(2\)/);
  });

  test("a pin the person set themselves is kept and said to be kept", () => {
    const { leftovers, text } = planFor({
      local: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]", ANTHROPIC_DEFAULT_SONNET_MODEL: "my-own-sonnet" }, hooks: READINESS_HOOKS },
    });
    const [kept] = ofKind(leftovers, "gateway-kept-entries");
    assert.equal(kept.verdict, "keep");
    assert.equal(kept.where, ".claude/settings.local.json env ANTHROPIC_DEFAULT_SONNET_MODEL");
    assert.deepEqual(kept.readyLines, ['"ANTHROPIC_DEFAULT_SONNET_MODEL": "my-own-sonnet"']);
    assert.match(kept.why, /set by you, not a value the gateway writes, so it stays/);
    assert.doesNotMatch(ofKind(leftovers, "gateway-wiring")[0].where, /SONNET/);
    assert.match(text, /keep\s+\.claude\/settings\.local\.json env ANTHROPIC_DEFAULT_SONNET_MODEL/);
  });

  test("wiring in the user's settings file is shown as the person's to change, with its exact lines", () => {
    const { leftovers, text } = planFor({
      user: { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18764", ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5-1[1m]" }, hooks: READINESS_HOOKS },
    });
    const [wiring] = ofKind(leftovers, "gateway-wiring-user");
    assert.equal(wiring.verdict, "keep");
    assert.match(wiring.where, /settings\.json \(user settings\)$/);
    assert.match(wiring.why, /the scan never edits your user settings file/);
    assert.deepEqual(wiring.readyLines, [
      '"ANTHROPIC_BASE_URL": "http://127.0.0.1:18764"',
      '"ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5-1[1m]"',
      `hooks SessionStart: ${READINESS_COMMAND}`,
      `hooks UserPromptSubmit: ${READINESS_COMMAND}`,
    ]);
    assert.match(text, /"ANTHROPIC_BASE_URL": "http:\/\/127\.0\.0\.1:18764"/);
  });

  test("a file with only the common keys is not flagged", () => {
    const { leftovers } = planFor({ local: { env: { ENABLE_TOOL_SEARCH: "true", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" } } });
    assert.deepEqual(leftovers.map((leftover) => leftover.kind), []);
  });

  const SHIPPED_AND_RETIRED_PINS = [
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-5-5[1m]"],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-5[1m]"],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-4-8[1m]"],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-sonnet-5-5[1m]"],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-sonnet-5[1m]"],
    ["ANTHROPIC_DEFAULT_FABLE_MODEL", "claude-fable-5-1[1m]"],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-gpt-5-5[1m]"],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-codex-auto"],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-grok-4"],
  ];

  test("each pin the gateway shipped, retired or newer, and each other-provider prefix is the gateway's", () => {
    for (const [key, value] of SHIPPED_AND_RETIRED_PINS) {
      assert.deepEqual(sortEnvironmentEntriesByWhoWroteThem({ env: { [key]: value } }, true).gateway.map((entry) => entry.key), [key], value);
    }
    assert.equal(hasGatewayLeftovers({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-6[1m]" } }, true), true);
  });

  test("a person's own older pin is kept, with or without a date", () => {
    for (const value of ["claude-sonnet-4-5[1m]", "claude-sonnet-4-5-20250929[1m]", "claude-opus-4-1[1m]", "claude-opus-5-5"]) {
      const key = value.includes("opus") ? "ANTHROPIC_DEFAULT_OPUS_MODEL" : "ANTHROPIC_DEFAULT_SONNET_MODEL";
      assert.equal(hasGatewayLeftovers({ env: { [key]: value } }), false, value);
    }
    const sorted = sortEnvironmentEntriesByWhoWroteThem({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5[1m]", ANTHROPIC_BASE_URL: "http://localhost:1" } });
    assert.deepEqual(sorted.own.map((entry) => entry.key), ["ANTHROPIC_DEFAULT_SONNET_MODEL"]);
  });

  test("only the address and the readiness hooks hold the uninstall; a pin, the switch or the option alone are leftovers", () => {
    assert.equal(isWiredToTheGateway({ env: { ANTHROPIC_BASE_URL: "http://api.anthropic.com" } }), true);
    assert.equal(isWiredToTheGateway({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }), false);
    assert.equal(isWiredToTheGateway({ hooks: READINESS_HOOKS }), true);
    for (const env of [
      { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]" },
      { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" },
      { ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fable 5.1 · current Fable, through the gateway" },
    ]) {
      assert.equal(isWiredToTheGateway({ env }), false);
      assert.equal(hasGatewayLeftovers({ env }, true), true);
      assert.equal(hasGatewayLeftovers({ env }), false, "with no other trace of the gateway on the machine it is the person's own");
    }
    assert.equal(hasGatewayLeftovers({ env: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "0" } }), false);
  });

  test("a hook counts only when it runs model-gateway.js with readiness-gate", () => {
    const hook = (command) => ({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
    assert.equal(isWiredToTheGateway(hook("bash ./scripts/readiness-gate.sh")), false);
    assert.equal(isWiredToTheGateway(hook("node model-gateway.js status")), false);
    assert.equal(isWiredToTheGateway(hook(READINESS_COMMAND)), true);
  });

  test("a pin alone is listed to take out, not as wired, and a person's own pin alone says nothing", () => {
    const pinOnly = planFor({ gatewayWasOnThisMachine: true, local: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]" } } });
    assert.equal(ofKind(pinOnly.leftovers, "gateway-wiring")[0].verdict, "remove");
    assert.match(ofKind(pinOnly.leftovers, "gateway-wiring")[0].why, /do not hold its uninstall/);
    const own = planFor({ local: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5[1m]" } } });
    assert.deepEqual(own.leftovers.map((leftover) => leftover.kind), []);
    const userOwn = planFor({ user: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5[1m]" } } });
    assert.deepEqual(userOwn.leftovers.map((leftover) => leftover.kind), []);
  });

  test("on a machine with no trace of the gateway, a current pin, the switch or a common key beside it is the person's own", () => {
    const ownPin = { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]" };
    for (const env of [ownPin, { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" }, { ...ownPin, ENABLE_TOOL_SEARCH: "true" }]) {
      assert.deepEqual(planFor({ local: { env } }).leftovers.map((leftover) => leftover.kind), []);
      assert.deepEqual(planFor({ user: { env } }).leftovers.map((leftover) => leftover.kind), []);
    }
  });

  test("a settings file that is wired or names the gateway plugin shows the gateway was on the machine", () => {
    assert.equal(showsTheGateway({ enabledPlugins: { "model-gateway@eigenwise-toolshed": false } }), true);
    assert.equal(showsTheGateway({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18764" } }), true);
    assert.equal(showsTheGateway({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]" } }), false);
    assert.equal(showsTheGateway({}), false);
  });

  test("the compat-mode address is the gateway's and wires the project", () => {
    const { leftovers } = planFor({ local: { env: { ANTHROPIC_BASE_URL: "http://api.anthropic.com" } } });
    assert.equal(ofKind(leftovers, "gateway-wiring")[0].verdict, "ask");
  });

  test("the provider-model reason is on pin lines only", () => {
    const { leftovers } = planFor({ local: { env: { ANTHROPIC_BASE_URL: "http://localhost:1", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5[1m]", ENABLE_TOOL_SEARCH: "false" } } });
    const [pin, other] = ofKind(leftovers, "gateway-kept-entries");
    assert.match(pin.why, /your provider does not have/);
    assert.equal(other.where.endsWith("ENABLE_TOOL_SEARCH"), true);
    assert.doesNotMatch(other.why, /your provider does not have/);
  });

  test("the by-hand check names the readiness hooks as well as the address", () => {
    const { leftovers } = planFor({ local: { enabledPlugins: { "model-gateway@eigenwise-toolshed": true } } });
    const [plugin] = ofKind(leftovers, "older-plugin");
    assert.match(plugin.why, /ANTHROPIC_BASE_URL under env, or a hook there whose command runs model-gateway.js with readiness-gate/);
  });
});
