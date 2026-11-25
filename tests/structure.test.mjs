import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import {
  findClaudeBinary,
  listFilesRecursively,
  listPlugins,
  readJson,
  readMarketplace,
  repositoryRoot,
  runChild,
} from "../scripts/repository.mjs";

const emDash = String.fromCharCode(0x2014);
const forbiddenCommandHookEvents = ["PreToolUse", "PostToolUse", "UserPromptSubmit"];
const marketplace = readMarketplace();
const marketplaceEntries = marketplace.plugins;
const plugins = listPlugins();

function readPluginManifest(plugin) {
  const manifestPath = join(plugin.directory, ".claude-plugin", "plugin.json");
  return existsSync(manifestPath) ? readJson(manifestPath) : {};
}

function readHooksFile(plugin) {
  const hooksPath = join(plugin.directory, "hooks", "hooks.json");
  return existsSync(hooksPath) ? readJson(hooksPath) : { hooks: {}, modules: [] };
}

function relativeToRepository(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function readInlineHooks(manifest) {
  const inline = manifest.hooks;
  const isInlineObject = inline !== null && typeof inline === "object" && !Array.isArray(inline);
  return isInlineObject ? (inline.hooks ?? inline) : {};
}

function listCommandHookEvents(hooksByEvent) {
  return Object.entries(hooksByEvent ?? {})
    .filter(([, groups]) => groups.some((group) => (group.hooks ?? []).some((hook) => hook.type === "command")))
    .map(([event]) => event);
}

function listRegisteredCommandNames(plugin) {
  const sourceFiles = listFilesRecursively(join(plugin.directory, "hooks")).filter((path) => /\.tsx?$/.test(path));
  const pattern = /\$\.command\.register\(\s*\{[^}]*?\bname:\s*["'`]([^"'`]+)["'`]/g;
  return sourceFiles.flatMap((path) => [...readFileSync(path, "utf8").matchAll(pattern)].map((match) => match[1]));
}

function listSkillFolderNames(plugin) {
  const skillsDirectory = join(plugin.directory, "skills");
  if (!existsSync(skillsDirectory)) return [];
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function listDependencyNames(manifest) {
  return (manifest.dependencies ?? []).map((dependency) => {
    const name = typeof dependency === "string" ? dependency : dependency.name;
    return name.split("@")[0];
  });
}

// The host writes its own type files into a plugin folder it loads in place. Git ignores them and they are not ours to word.
const isHostWrittenTypes = (path) => /[\\/]\.claude-plugin[\\/]types[\\/]/.test(path);

function listFilesCheckedForEmDashes() {
  const rootMarkdown = readdirSync(repositoryRoot).filter((name) => name.endsWith(".md")).map((name) => join(repositoryRoot, name));
  const docsMarkdown = readdirSync(join(repositoryRoot, "docs")).filter((name) => name.endsWith(".md")).map((name) => join(repositoryRoot, "docs", name));
  const folders = ["plugins", "shared", ".out-of-scope", "docs/src", "docs/scripts"].flatMap((folder) => listFilesRecursively(join(repositoryRoot, folder)));
  return [...rootMarkdown, ...docsMarkdown, ...folders].filter(
    (path) => !/\.(png|jpg|gif|ico)$/i.test(path) && !isHostWrittenTypes(path) && !isGeneratedReference(relativeToRepository(path)),
  );
}

const earlierMarketplaceName = "toolshed-next";

// Written by docs/scripts/generate-reference.mjs from the plugins, which are checked themselves, and not committed.
const isGeneratedReference = (relativePath) => relativePath.startsWith("docs/src/content/docs/reference/");

function isShippedFile(path) {
  const relativePath = relativeToRepository(path);
  return /^(plugins|shared)\//.test(relativePath) || (/^docs\/(src|scripts)\//.test(relativePath) && !isGeneratedReference(relativePath)) || /^[^/]+\.(md|json)$/.test(relativePath);
}

const agreedBulletAboutTheEarlierName =
  "- Installed a plugin from `toolshed-next` as well? Claude Code runs only one copy of a plugin name, with no warning, and lists the skills of both. Uninstall the `toolshed-next` one: `claude plugin uninstall <name>@toolshed-next`.";

// The root README is the one shipped page outside the places below that may name the earlier name, and only in that one bullet.
const withoutTheAgreedBullet = (path, text) => (relativeToRepository(path) === "README.md" ? text.replace(agreedBulletAboutTheEarlierName, "") : text);

// The earlier name is only named where it is handled: the notice, the upgrade, the pages about moving, and tests that use it as sample data.
function isPlaceThatHandlesTheEarlierName(path) {
  const relativePath = relativeToRepository(path);
  return (
    /(^|\/)older-toolshed[^/]*$/.test(relativePath) ||
    /\.test\.(mjs|tsx?)$/.test(relativePath) ||
    /^plugins\/quartermaster\/(scripts|skills\/(upgrade|inspect|outfit))\//.test(relativePath) ||
    relativePath === "plugins/quartermaster/README.md" ||
    /^(UPGRADING|ARCHITECTURE)\.md$/.test(relativePath) ||
    relativePath === "docs/src/content/docs/guides/upgrading.mdx"
  );
}

describe("the marketplace name", () => {
  it("is eigenwise-toolshed", () => {
    assert.equal(marketplace.name, "eigenwise-toolshed");
  });

  it("lists no entry that points outside this tree", () => {
    const entriesOutsideThisTree = marketplace.plugins.filter((entry) => typeof entry.source !== "string" || !entry.source.startsWith("./"));
    assert.deepEqual(entriesOutsideThisTree, []);
    for (const entry of marketplaceEntries) {
      assert.ok(existsSync(join(repositoryRoot, entry.source, ".claude-plugin", "plugin.json")), `${entry.name}: no folder at ${entry.source}`);
    }
  });

  it("is not named toolshed-next by a shipped file outside the places that handle the earlier name", () => {
    const shippedFolders = ["plugins", "shared", "docs/src", "docs/scripts"].flatMap((folder) => listFilesRecursively(join(repositoryRoot, folder)));
    const rootFiles = readdirSync(repositoryRoot).map((name) => join(repositoryRoot, name)).filter((path) => /\.(md|json)$/.test(path));
    const offenders = [...shippedFolders, ...rootFiles]
      .filter((path) => isShippedFile(path) && !isHostWrittenTypes(path) && !isPlaceThatHandlesTheEarlierName(path))
      .filter((path) => withoutTheAgreedBullet(path, readFileSync(path, "utf8")).includes(earlierMarketplaceName))
      .map(relativeToRepository);
    assert.deepEqual(offenders, []);
  });

  it("names toolshed-next in the root README only in the agreed last bullet of the section on coming from v1", () => {
    const lines = readFileSync(join(repositoryRoot, "README.md"), "utf8").split(/\r?\n/);
    const sectionStart = lines.indexOf("## Coming from v1");
    const sectionEnd = lines.findIndex((line, index) => index > sectionStart && line.startsWith("## "));
    const bullets = lines.slice(sectionStart, sectionEnd).filter((line) => line.startsWith("- "));
    assert.equal(bullets.at(-1), agreedBulletAboutTheEarlierName);
    assert.deepEqual(lines.filter((line) => line.includes(earlierMarketplaceName)), [agreedBulletAboutTheEarlierName]);
  });
});

describe("marketplace entries", () => {
  for (const entry of marketplaceEntries) {
    const plugin = plugins.find((candidate) => candidate.name === entry.name);

    it(`${entry.name} has a folder, a manifest, a README and a license`, () => {
      assert.ok(existsSync(join(plugin.directory, ".claude-plugin", "plugin.json")), "missing .claude-plugin/plugin.json");
      assert.ok(existsSync(join(plugin.directory, "README.md")), "missing README.md");
      const hasLicenseField = Boolean(readPluginManifest(plugin).license);
      const hasLicenseFile = existsSync(join(plugin.directory, "LICENSE")) || existsSync(join(repositoryRoot, "LICENSE"));
      assert.ok(hasLicenseField || hasLicenseFile, "no license field and no LICENSE file");
    });

    // The report skill files issues where the manifest's repository points, and stops when it names none.
    it(`${entry.name} manifest names the public repository`, () => {
      assert.equal(readPluginManifest(plugin).repository, "https://github.com/Eigenwise/eigenwise-toolshed");
    });

    it(`${entry.name} carries no version in the marketplace file`, () => {
      assert.equal(entry.version, undefined, "the version lives in plugin.json only");
    });

    it(`${entry.name} manifest name matches its marketplace entry`, () => {
      assert.equal(readPluginManifest(plugin).name, entry.name);
    });
  }
});

describe("hooks and commands", () => {
  for (const plugin of plugins) {
    it(`${plugin.name} registers no command hook on PreToolUse, PostToolUse or UserPromptSubmit`, () => {
      const manifest = readPluginManifest(plugin);
      const registered = [...listCommandHookEvents(readHooksFile(plugin).hooks), ...listCommandHookEvents(readInlineHooks(manifest))];
      const forbidden = registered.filter((event) => forbiddenCommandHookEvents.includes(event));
      assert.deepEqual(forbidden, []);
    });

    it(`${plugin.name} has no skill named like a command it registers`, () => {
      const commandNames = listRegisteredCommandNames(plugin);
      const shadowing = listSkillFolderNames(plugin).filter((skillName) => commandNames.includes(skillName));
      assert.deepEqual(shadowing, [], "a skill with the same name hides the command (GH-807)");
    });

    it(`${plugin.name} lists no other Toolshed plugin under dependencies`, () => {
      const toolshedNames = marketplaceEntries.map((entry) => entry.name);
      const internal = listDependencyNames(readPluginManifest(plugin)).filter((name) => toolshedNames.includes(name));
      assert.deepEqual(internal, []);
    });
  }
});

describe("text rules", () => {
  it("no em dash appears in plugins/, shared/, .out-of-scope/, the docs source or the root markdown files", () => {
    const offenders = listFilesCheckedForEmDashes()
      .filter((path) => readFileSync(path, "utf8").includes(emDash))
      .map(relativeToRepository);
    assert.deepEqual(offenders, []);
  });
});

function listModulePlugins() {
  return plugins.filter((plugin) => (readHooksFile(plugin).modules ?? []).length > 0);
}

function findGatingHooksWithoutCatch(claudeBinary, plugin) {
  const { output } = runChild(claudeBinary, ["plugin", "validate", plugin.directory, "--json"]);
  const report = JSON.parse(output);
  return (report.contents ?? [])
    .flatMap((content) => content.gatingHooks ?? [])
    .filter((gatingHook) => gatingHook.hasCatch === false)
    .map((gatingHook) => gatingHook.hook);
}

describe("gating hooks fail open", () => {
  const claudeBinary = findClaudeBinary();
  for (const plugin of listModulePlugins()) {
    it(`${plugin.name} gives every gating hook a .catch`, { skip: claudeBinary ? false : "claude binary not found, validator JSON unavailable" }, () => {
      assert.deepEqual(findGatingHooksWithoutCatch(claudeBinary, plugin), []);
    });
  }
});

function listPluginMarkdownWithFrontmatter() {
  return plugins.flatMap((plugin) =>
    listFilesRecursively(plugin.directory).filter((path) => {
      const relativePath = relative(plugin.directory, path).replaceAll("\\", "/");
      return /^skills\/[^/]+\/SKILL\.md$/.test(relativePath) || /^agents\/[^/]+\.md$/.test(relativePath);
    }),
  );
}

function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split(/\r?\n/).filter((text) => text.trim() !== "")) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) return undefined;
    fields[field[1]] = field[2].trim();
  }
  return fields;
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  "name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation",
  "user-invocable", "allowed-tools", "model", "effort", "context", "agent", "hooks", "paths", "shell",
  "tools", "disallowedTools", "maxTurns", "skills", "memory", "background", "isolation", "color",
  "permissionMode", "mcpServers", "initialPrompt", "autoCompactWindow", "omitClaudeMd",
]);

describe("skill and agent frontmatter", () => {
  for (const path of listPluginMarkdownWithFrontmatter()) {
    it(`${relativeToRepository(path)} opens with key: value frontmatter that names and describes it`, () => {
      const fields = parseFrontmatter(readFileSync(path, "utf8"));
      assert.ok(fields, "no frontmatter block, or a line in it is not key: value");
      assert.ok(fields.name, "empty or missing name");
      assert.ok(fields.description, "empty or missing description");
    });

    it(`${relativeToRepository(path)} uses only frontmatter keys the host reads`, () => {
      const unknownKeys = Object.keys(parseFrontmatter(readFileSync(path, "utf8")) ?? {}).filter(
        (key) => !KNOWN_FRONTMATTER_KEYS.has(key),
      );
      assert.deepEqual(unknownKeys, []);
    });
  }
});

function listResultContractFields() {
  const contract = readFileSync(join(repositoryRoot, "shared", "result-contract.md"), "utf8");
  return [...contract.matchAll(/^- `([A-Za-z]+)`:/gm)].map((match) => match[1]);
}

function sliceFrom(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} not found`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("result contract fields", () => {
  const fields = listResultContractFields();
  const sidequestDirectory = join(repositoryRoot, "plugins", "sidequest");

  it("shared/result-contract.md lists fields", () => {
    assert.ok(fields.length > 0);
  });

  it("every field is in the RESULT_CONTRACT text of brief.ts", () => {
    const source = readFileSync(join(sidequestDirectory, "hooks", "brief.ts"), "utf8");
    const constant = sliceFrom(source, "export const RESULT_CONTRACT", "\nexport const ");
    const missing = fields.filter((field) => !new RegExp(`- \\\\\`${field}\\\\\`:`).test(constant));
    assert.deepEqual(missing, []);
  });

  it("every field is a property of the RESULT_CONTRACT schema in wave.js", () => {
    const source = readFileSync(join(sidequestDirectory, "workflows", "wave.js"), "utf8");
    const schema = sliceFrom(source, "const RESULT_CONTRACT = {", "\n}\n");
    const missing = fields.filter((field) => !new RegExp(`^\\s+${field}:`, "m").test(schema));
    assert.deepEqual(missing, []);
  });

  it("the wave schema requires the branch and the changed files of a run", () => {
    const source = readFileSync(join(sidequestDirectory, "workflows", "wave.js"), "utf8");
    const schema = sliceFrom(source, "const RESULT_CONTRACT = {", "\n}\n");
    assert.match(schema, /required: \[[^\]]*'branch'[^\]]*'changedFiles'[^\]]*\]/);
  });
});

describe("the second reader of work the session built", () => {
  const frontDoorDirectory = join(repositoryRoot, "plugins", "sidequest", "skills", "sidequest");

  // tools.test.ts pins that this exact spawn runs on the mid tier and stays off the ticket.
  it("is spawned as a scout with the build route and no ticket id first, in the front door and its routing reference", () => {
    const frontDoor = readFileSync(join(frontDoorDirectory, "SKILL.md"), "utf8");
    const routingReference = readFileSync(join(frontDoorDirectory, "references", "routing.md"), "utf8");
    assert.match(frontDoor, /`sidequest:scout` tries to break it, its prompt starting `\[route:build\]`/);
    assert.match(routingReference, /subagent_type: "sidequest:scout"[\s\S]*?prompt: "\[route:build\] /);
  });
});

describe("the required check", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "check.yml"), "utf8");

  it("waits for the mods job and the clean-room install job", () => {
    assert.match(workflow, /needs: \[[^\]]*\bmods\b[^\]]*\bclean-room\b[^\]]*\]/);
    assert.match(workflow, /needs\.clean-room\.result/);
    assert.match(workflow, /needs\.mods\.result/);
  });

  it("runs the clean-room script", () => {
    assert.match(workflow, /node scripts\/clean-room\.mjs/);
    assert.ok(existsSync(join(repositoryRoot, "scripts", "clean-room.mjs")));
  });
});

describe("tool results the host accepts", () => {
  const isTestFile = (path) => /\.test\.tsx?$/.test(path);
  const sourcesOf = (plugin) =>
    listFilesRecursively(join(plugin.directory, "hooks")).filter((path) => /\.tsx?$/.test(path));
  const registersTools = (plugin) =>
    sourcesOf(plugin).some((path) => !isTestFile(path) && readFileSync(path, "utf8").includes("tool.register"));
  const hasShapeTest = (plugin) =>
    sourcesOf(plugin).some((path) => isTestFile(path) && readFileSync(path, "utf8").includes("answers with a result the host accepts"));

  for (const plugin of plugins.filter(registersTools)) {
    it(`${plugin.name} tests that every tool answers with a string or content blocks`, () => {
      assert.ok(hasShapeTest(plugin), "add a test named 'answers with a result the host accepts' that calls every tool operation");
    });
  }
});
