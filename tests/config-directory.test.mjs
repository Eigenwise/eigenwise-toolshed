import assert from "node:assert/strict";
import { test } from "node:test";
import { configDirectoryOf, homeDirectoryOf } from "../shared/config-directory.mjs";

test("USERPROFILE wins over HOME, so Windows and Git Bash agree with os.homedir()", () => {
  assert.equal(homeDirectoryOf({ USERPROFILE: "C:/Users/a", HOME: "/c/Users/b" }), "C:/Users/a");
});

test("HOME is used when USERPROFILE is missing or empty, then the fallback", () => {
  assert.equal(homeDirectoryOf({ USERPROFILE: "", HOME: "/home/a" }), "/home/a");
  assert.equal(homeDirectoryOf({}, "/fallback"), "/fallback");
  assert.equal(homeDirectoryOf({}), undefined);
});

test("CLAUDE_CONFIG_DIR wins over any home directory", () => {
  assert.equal(configDirectoryOf({ CLAUDE_CONFIG_DIR: "/custom/", HOME: "/home/a" }), "/custom");
});

test("without CLAUDE_CONFIG_DIR the config directory is .claude under the home directory", () => {
  assert.equal(configDirectoryOf({ USERPROFILE: "C:\\Users\\a\\" }), "C:\\Users\\a/.claude");
  assert.equal(configDirectoryOf({}), undefined);
});
