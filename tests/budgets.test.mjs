import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { countRegisteredTools } from "../scripts/budgets.mjs";

const scratchFolders = [];

const scratchFolder = (prefix) => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  scratchFolders.push(folder);
  return folder;
};

// Thousands of these folders were found left in the temp folder: every run made some and nothing removed them.
after(() => scratchFolders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

function pluginWithHooks(files) {
  const directory = scratchFolder("budgets-");
  mkdirSync(join(directory, "hooks"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, "hooks", name), text);
  return directory;
}

test("tools registered in one loop are counted by their specs, not by call sites", () => {
  const directory = pluginWithHooks({
    "tool-specs.ts": [
      "export const FIRST_TOOL: ToolSpec = {",
      "  name: 'first',",
      "}",
      "export const SECOND_TOOL: ToolSpec = {",
      "  name: 'second',",
      "}",
      "export const ALL_TOOLS: readonly ToolSpec[] = [FIRST_TOOL, SECOND_TOOL]",
    ].join("\n"),
    "register.tsx": "for (const tool of ALL_TOOLS) await $.tool.register(tool)\n",
  });

  assert.equal(countRegisteredTools(directory), 2);
});

test("an untyped spec registered by name and an inline spec both count", () => {
  const directory = pluginWithHooks({
    "tool-specs.ts": "export const NAMED_TOOL = {\n  name: 'named',\n}\n",
    "register.tsx": "await $.tool.register(NAMED_TOOL)\nawait $.tool.register({ name: 'inline' })\n",
  });

  assert.equal(countRegisteredTools(directory), 2);
});

test("an object that starts with a name but is never registered is not a tool", () => {
  const directory = pluginWithHooks({ "colors.ts": "export const PRIMARY = {\n  name: 'blue',\n}\n" });

  assert.equal(countRegisteredTools(directory), 0);
});
