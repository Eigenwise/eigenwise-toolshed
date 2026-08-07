"use strict";
const { resolveSuite } = require("../suite-resolver.js");
const { ignoredPathsMissingFromWorktree } = require("../worktrees.js");
function createWarnings({ categoryReadOnly, claimReclaimable, coerceEffort, commitScope, contractCollisionReasons, dispatchReadOnly, dispatchState, execFileSync, fs, getTicket, integrationTarget, listTickets, normalizeContracts, normalizeFiles, normalizeRouteModel, overlappingScopePaths, path, pulseDispatchState, readMeta, readOnlyOverrideActive, spawnSync, ticketCategory }) {
  const DISPATCH_DESCRIPTION_MIN = 80;
  const DISPATCH_DESCRIPTION_GUIDANCE = "the executor's entire brief is this ticket; add a description (Where / Contract / Verify) and a verify command, then dispatch";
  function executorText(value, max, label) {
    if (value == null) return "";
    const text = String(value);
    if (text.length > max) throw new Error(`${label} exceeds the ${max}-character executor-context limit.`);
    return text;
  }
  const VERIFY_BUILTINS = /* @__PURE__ */ new Set([
    "bash",
    "bun",
    "cargo",
    "cd",
    "cmake",
    "cmd",
    "composer",
    "ctest",
    "dart",
    "deno",
    "dotnet",
    "elixir",
    "eslint",
    "flutter",
    "git",
    "go",
    "gradle",
    "java",
    "jest",
    "just",
    "make",
    "mix",
    "mvn",
    "node",
    "npm",
    "npx",
    "php",
    "pnpm",
    "poetry",
    "powershell",
    "pwsh",
    "py",
    "pytest",
    "python",
    "python3",
    "rake",
    "ruby",
    "sh",
    "tox",
    "tsc",
    "uv",
    "vitest",
    "yarn"
  ]);
  function manualVerify(value) {
    return /^manual:\s+\S/i.test(String(value || "").trim());
  }
  function containsUnquotedSemicolon(command) {
    let quote = "";
    for (let index = 0; index < command.length; index += 1) {
      const character = command[index];
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === ";") return true;
    }
    return false;
  }
  function verifyCommandError(value) {
    const command = String(value || "").trim();
    if (!command || manualVerify(command)) return null;
    if (/^manual:/i.test(command)) {
      return "Manual verification must say what was checked: `manual: <what you checked>`. Otherwise provide a runnable command such as `npm run test` or `cd <repo-relative-dir> && <command>`.";
    }
    const first = command.match(/^\s*(?:["']([^"']+)["']|([^\s;&|]+))/)?.[1] || command.match(/^\s*(?:["']([^"']+)["']|([^\s;&|]+))/)?.[2] || "";
    const likelyExecutable = VERIFY_BUILTINS.has(first.toLowerCase()) || /^\(cd\s/.test(command) || /[\\/]|\.(?:bat|cmd|com|exe|ps1|sh)$/i.test(first);
    const proseStarter = /^(?:check|confirm|ensure|inspect|look|open|read|review|verify)\s/i.test(command);
    if (/\r|\n/.test(command)) {
      return "Verify must be one runnable command line. Use `npm run test` or `cd <repo-relative-dir> && <command>`.";
    }
    if (/<[^<>\r\n]+>/.test(command)) {
      return "Verify contains an unresolved placeholder. Replace it with a runnable command such as `npm run test`.";
    }
    if (containsUnquotedSemicolon(command)) {
      return "Verify cannot use `;` command chaining because it behaves differently across shells. Use one command or join dependent steps with `&&`.";
    }
    if (proseStarter || !likelyExecutable) {
      return "Verify must start with a runnable command such as `npm run test` or `cd <repo-relative-dir> && <command>`. For manual verification, use `manual: <what you checked>` so it is recorded without shell execution.";
    }
    for (const match of command.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\}|(?::[^}]*)\})/g)) {
      const name = match[1] || match[2];
      if (name && process.env[name] == null && !match[0].includes(":-")) {
        return `Verify references unset environment variable ${name}. Set a portable default such as \`${"${"}${name}:-/tmp}\`, or use \`manual: <what you checked>\`.`;
      }
    }
    for (const match of command.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
      const name = match[1];
      if (name != null && process.env[name] == null) {
        return `Verify references unset environment variable ${name}. Set a portable default or use \`manual: <what you checked>\`.`;
      }
    }
    return null;
  }
  function requireVerifyCommand(value) {
    const error = verifyCommandError(value);
    if (error) throw new Error(error);
  }
  function ticketReferenceWarnings(slug, title, description) {
    const refs = new Set((`${title || ""}
${description || ""}`.match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
    if (!refs.size) return [];
    const known = new Set(listTickets(slug).map((ticket) => String(ticket.ref).toUpperCase()));
    const unknown = [...refs].filter((ref) => !known.has(ref));
    return unknown.length ? [`Unknown ticket refs: ${unknown.join(", ")}.`] : [];
  }
  const ANCHOR_PATH_TOKEN = /(?:^|[\s`"'(])((?:\.\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+)(?::\d+)?(?=$|[\s`"',).;:])/g;
  const ANCHOR_SYMBOL_REFERENCE = /(?:^|[\s`"'(])([A-Za-z_$][\w$]*)`?\s+(?:is\s+at|in)\s+`?((?:\.\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+)(?::\d+)?(?=$|[\s`"',).;:])/g;
  const KNOWN_ANCHOR_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
    ".bash",
    ".c",
    ".cc",
    ".cjs",
    ".cpp",
    ".cs",
    ".css",
    ".csv",
    ".go",
    ".h",
    ".hpp",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".kt",
    ".md",
    ".mjs",
    ".php",
    ".png",
    ".ps1",
    ".py",
    ".rb",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".svg",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".vue",
    ".xml",
    ".yaml",
    ".yml"
  ]);
  function anchorResolutionRoots(ticket, projectPath) {
    const roots = /* @__PURE__ */ new Map();
    const addRoot = (root) => {
      if (root) roots.set(String(root).toLowerCase(), String(root));
    };
    addRoot(projectPath);
    for (const scope of normalizeFiles(ticket?.files)) addRoot(packageRootForScope(projectPath, scope));
    return [...roots.values()];
  }
  function anchorPath(ticket, projectPath, value) {
    const relative = String(value || "").replace(/^\.\//, "");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return null;
    const roots = anchorResolutionRoots(ticket, projectPath);
    const candidates = roots.map((root) => path.resolve(root, relative)).filter((absolute) => relativePathWithin(projectPath, absolute));
    const hasKnownExtension = KNOWN_ANCHOR_FILE_EXTENSIONS.has(path.extname(relative).toLowerCase());
    const firstSegment = relative.split("/")[0];
    const hasExistingPrefix = roots.some((root) => fs.existsSync(path.resolve(root, firstSegment)));
    if (!hasKnownExtension && !hasExistingPrefix) return null;
    const existing = candidates.find((absolute) => fs.existsSync(absolute));
    return { relative, absolute: existing || candidates[0], exists: Boolean(existing) };
  }
  function executorAnchorWarnings(ticket, projectPath) {
    if (!projectPath || !String(ticket?.executorAnchors || "").trim()) return [];
    const anchors = String(ticket.executorAnchors);
    const missing = /* @__PURE__ */ new Set();
    const existing = /* @__PURE__ */ new Map();
    for (const match of anchors.matchAll(ANCHOR_PATH_TOKEN)) {
      const candidate = anchorPath(ticket, projectPath, match[1]);
      if (!candidate) continue;
      if (candidate.exists) existing.set(candidate.relative.toLowerCase(), candidate.absolute);
      else missing.add(candidate.relative);
    }
    const warnings = [...missing].sort().map((relative) => `Anchor-path warning: executor anchor references path absent from this repo: ${relative}. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.`);
    const absentSymbols = /* @__PURE__ */ new Set();
    for (const match of anchors.matchAll(ANCHOR_SYMBOL_REFERENCE)) {
      const symbol = match[1];
      const candidate = anchorPath(ticket, projectPath, match[2]);
      if (!candidate || !existing.has(candidate.relative.toLowerCase())) continue;
      let contents = "";
      try {
        contents = fs.readFileSync(candidate.absolute, "utf8");
      } catch (_) {
        continue;
      }
      if (!new RegExp(`\\b${symbol}\\b`).test(contents)) absentSymbols.add(`${symbol}|${candidate.relative}`);
    }
    return [...warnings, ...[...absentSymbols].sort().map((entry) => {
      const [symbol, relative] = entry.split("|");
      return `Anchor-path warning: executor anchor says ${symbol} is in ${relative}, but ${symbol} does not appear in that file.`;
    })];
  }
  function ticketPrescribesFix(description) {
    const body = String(description || "");
    if (/^\s*fix\s*:/im.test(body)) return true;
    if (/\b(?:replace|change)\s+\S[\s\S]{0,160}?\s+(?:with|to)\s+\S/i.test(body)) return true;
    if (/```(?:diff|patch)?\s*\r?\n[\s\S]*?^-\S[\s\S]*?^\+\S[\s\S]*?```/im.test(body)) return true;
    return (body.match(/^\s*\d+[.)]\s+(?:add|change|replace|remove|rename|move|update|set|delete|edit|wire)\b/gim) || []).length >= 2;
  }
  function ticketCategoryWarnings(ticket) {
    if (ticketCategory(ticket) !== "coding.hard" || !ticketPrescribesFix(ticket && ticket.description)) return [];
    return ["coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category."];
  }
  const QUANTITATIVE_CLAIM = /(?:\b(?:rate|threshold|count|percentage|frequency|ratio|quota|limit|capacity|latency|duration)\b[\s\S]{0,100}\b(?:too\s+(?:high|low)|higher|lower|above|below|over|under|increas(?:e|es|ing|ed)|decreas(?:e|es|ing|ed)|drop(?:s|ped|ping)?|ris(?:e|es|ing|en)|(?:is|are|was|were|at)\s+\d+(?:\.\d+)?)|\b\d+(?:\.\d+)?\s*(?:%|percent|milliseconds?|ms|seconds?|minutes?|hours?|days?|times|x)\b)/i;
  const LINKED_MEASUREMENT = /(?:\b(?:measured|measurement|benchmark(?:ed)?|probe|reproduced|observed)\b[\s\S]{0,160}\bSQ-\d+\b|\bSQ-\d+\b[\s\S]{0,160}\b(?:measured|measurement|benchmark(?:ed)?|probe|reproduced|observed)\b)/i;
  const INLINE_MEASUREMENT = /\b(?:measurement|benchmark|probe|command)\b[\s\S]{0,200}\b(?:output|result|ran|run|produced|showed|shows|recorded)\b/i;
  function quantitativePremiseWarning(ticket) {
    const categoryId = String(ticketCategory(ticket) || "");
    if (!/^(?:coding(?:\.|$)|debugging$|behavior-verification$|plugin-dev$|interaction-design-implementation$)/.test(categoryId)) return null;
    const description = String(ticket?.description || "");
    if (!QUANTITATIVE_CLAIM.test(description) || LINKED_MEASUREMENT.test(description) || INLINE_MEASUREMENT.test(description)) return null;
    return "Planning-depth warning: this coding ticket relies on a quantitative or behavioral claim without measurement evidence. Include the command, output, and where it ran, or link the measurement ticket; otherwise file measurement work before the fix.";
  }
  function readonlyWriteIntentPaths(ticket) {
    return [...normalizeFiles(ticket.files), ...normalizeContracts(ticket.contracts).changes];
  }
  function readonlyCategoryWriteIntentWarning(ticket) {
    if (!categoryReadOnly(ticket)) return null;
    const paths = readonlyWriteIntentPaths(ticket);
    if (!paths.length) return null;
    const artifactRoots = ticket?.category?.artifactRoots || [];
    const outside = paths.filter((scope) => !commitScope.isInScope(scope, artifactRoots));
    if (!outside.length) return null;
    return `Readonly category contradicts declared write intent outside its artifact roots: ${outside.join(", ")}. Resolve the category or set an explicit readonly override before dispatch.`;
  }
  function noDeclaredScopeWarning(ticket) {
    if (dispatchReadOnly(ticket)) return null;
    if (Array.isArray(ticket.files) && ticket.files.length) return null;
    if (Number(ticket?.complexity) >= 4) return null;
    return "Planning-depth warning: no file scope declared for a write-scope ticket. The executor will block at its first write, request scope, and may end before a ruling with no submission. Declare files now, or dispatch only with an explicit unscoped override.";
  }
  const BROWSER_REVIEW_CATEGORIES = /* @__PURE__ */ new Set(["visual-evaluation", "visual-review"]);
  function readonlyBrowserReviewWarning(ticket) {
    if (!dispatchReadOnly(ticket) || !BROWSER_REVIEW_CATEGORIES.has(ticketCategory(ticket))) return null;
    return "Planning-depth warning: this readonly browser/visual ticket may need a driver script. Read-only executors cannot write one; grant write scope with an explicit no-repo-writes mandate, or use a browser tool that needs no script.";
  }
  function relativePathWithin(root, target) {
    const relative = path.relative(String(root), String(target));
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : relative === "" ? "." : null;
  }
  function packageRootForScope(projectPath, scope) {
    const absolute = path.resolve(String(projectPath), String(scope));
    let directory = path.dirname(absolute);
    for (; ; ) {
      if (!relativePathWithin(projectPath, directory)) return null;
      if (fs.existsSync(path.join(directory, "package.json"))) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
  function buildOutputDirectories(source) {
    const outputs = /* @__PURE__ */ new Map();
    const normalizeDirectory = (directory) => String(directory || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    const add = (directory, sourceDirectory, sourceExtension = ".ts", outputExtension = ".js") => {
      const value = normalizeDirectory(directory);
      if (!value || value.includes("..") || path.isAbsolute(value)) return;
      const current = outputs.get(value);
      outputs.set(value, {
        directory: value,
        sourceDirectory: sourceDirectory || current?.sourceDirectory || null,
        sourceExtension: sourceExtension || current?.sourceExtension || ".ts",
        outputExtension: outputExtension || current?.outputExtension || ".js"
      });
    };
    const text = String(source || "");
    for (const directories of text.matchAll(/export\s+const\s+nonBundledBuildDirectories\s*=\s*\[([^\]]*)\]/g)) {
      for (const directory of (directories[1] || "").matchAll(/["']([^"']+)["']/g)) add(directory[1], directory[1]);
    }
    for (const mappings of text.matchAll(/export\s+const\s+bundledBuildOutputs\s*=\s*\[([\s\S]*?)\];/g)) {
      for (const mapping of (mappings[1] || "").matchAll(/\{\s*sourceDirectory\s*:\s*["']([^"']+)["']\s*,\s*outputDirectory\s*:\s*["']([^"']+)["']\s*,\s*sourceExtension\s*:\s*["']([^"']+)["']\s*,\s*outputExtension\s*:\s*["']([^"']+)["']\s*,?\s*\}/g)) {
        add(mapping[2], mapping[1], mapping[3], mapping[4]);
      }
    }
    for (const match of text.matchAll(/--(?:outdir|out-dir|output-dir)\s*(?:=|\s+)\s*["']?([^"'\s;&]+)/gi)) add(match[1]);
    for (const match of text.matchAll(/(?:outdir|outDir|outputDir)\s*:\s*["']([^"']+)["']/g)) add(match[1]);
    for (const helper of text.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{([\s\S]{0,2000}?)\n\}/g)) {
      const [helperName, parameter, body] = [helper[1], helper[2], helper[3]];
      if (!helperName || !parameter || !body || !new RegExp(`(?:outdir|outDir)\\s*:\\s*path\\.join\\([^)]*,\\s*${parameter}\\s*\\)`).test(body)) continue;
      const call = new RegExp(`\\b${helperName}\\s*\\(\\s*["']([^"']+)["']`, "g");
      for (const match of text.matchAll(call)) add(match[1], match[1]);
    }
    return [...outputs.values()];
  }
  function packageBuildOutputs(packageRoot) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(String(packageRoot), "package.json"), "utf8"));
    } catch (_) {
      return [];
    }
    const build = String(manifest?.scripts?.build || "");
    if (!build) return [];
    const outputs = buildOutputDirectories(build);
    for (const match of build.matchAll(/\bnode\s+(?:["']([^"']+)["']|([^\s;&]+))/g)) {
      const script = path.resolve(String(packageRoot), match[1] || match[2]);
      if (!relativePathWithin(packageRoot, script) || !fs.existsSync(script)) continue;
      try {
        outputs.push(...buildOutputDirectories(fs.readFileSync(script, "utf8")));
      } catch (_) {
      }
    }
    return [...new Map(outputs.map((output) => [output.directory, output])).values()];
  }
  function isTrackedBuildOutput(projectPath, output) {
    const relative = relativePathWithin(projectPath, output);
    if (!relative || relative === ".") return false;
    try {
      return Boolean(execFileSync("git", ["ls-files", "--", relative], {
        cwd: projectPath,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim());
    } catch (_) {
      return false;
    }
  }
  function scopeIncludesPath(files, projectPath, target) {
    return normalizeFiles(files).some((file) => {
      const declared = path.resolve(String(projectPath), file);
      return declared === target || relativePathWithin(target, declared) !== null;
    });
  }
  function sourceBuildOutputWarnings(ticket, projectPath) {
    if (!projectPath || !Array.isArray(ticket?.files)) return [];
    const warnings = /* @__PURE__ */ new Set();
    for (const scope of normalizeFiles(ticket.files)) {
      const packageRoot = packageRootForScope(projectPath, scope);
      if (!packageRoot) continue;
      const sourceRelative = relativePathWithin(packageRoot, path.resolve(projectPath, scope))?.replace(/\\/g, "/");
      if (!sourceRelative || sourceRelative !== "src" && !sourceRelative.startsWith("src/")) continue;
      const sourceDirectory = sourceRelative.split("/")[1] || null;
      for (const output of packageBuildOutputs(packageRoot)) {
        const outputSourceDirectory = String(output.sourceDirectory || "").replace(/^src\//, "");
        if (outputSourceDirectory && sourceDirectory && outputSourceDirectory !== sourceDirectory) continue;
        const target = path.resolve(packageRoot, output.directory);
        if (!isTrackedBuildOutput(projectPath, target) || scopeIncludesPath(ticket.files, projectPath, target)) continue;
        const packageRelative = relativePathWithin(projectPath, packageRoot)?.replace(/\\/g, "/") || ".";
        const display = packageRelative === "." ? output.directory : `${packageRelative}/${output.directory}`;
        warnings.add(`Planning-depth warning: declared source scope under ${packageRelative}/src omits tracked build output ${display}. Include the generated output in this ticket; content-hashed output gets one rebuild ticket per wave.`);
      }
    }
    return [...warnings];
  }
  const NODE_TEST_FLAGS_WITH_VALUES = /* @__PURE__ */ new Set([
    "--test-concurrency",
    "--test-name-pattern",
    "--test-reporter",
    "--test-reporter-destination",
    "--test-shard",
    "--test-skip-pattern",
    "--test-timeout"
  ]);
  function nodeTestGlob(command) {
    const prefix = /^node\s+--test(?:\s|$)/.exec(String(command || ""));
    if (!prefix) return null;
    const argumentsText = String(command).slice(prefix[0].length);
    const tokens = [...argumentsText.matchAll(/(?:["']([^"']*)["']|([^\s;&|]+))/g)].map((match) => match[1] ?? match[2]);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token == null) continue;
      if (!token.startsWith("-")) return token;
      if (!token.includes("=") && NODE_TEST_FLAGS_WITH_VALUES.has(token)) index += 1;
    }
    return null;
  }
  function verifyCommandIssue(ticket, projectPath) {
    const verify = String(ticket?.executorVerify || "").trim();
    if (!verify || manualVerify(verify)) return null;
    const match = /^cd\s+(?:["']([^"']+)["']|([^&;\s]+))\s*&&/.exec(verify);
    const directory = match ? path.resolve(String(projectPath || ""), match[1] || match[2]) : String(projectPath || "");
    if (!projectPath || !relativePathWithin(projectPath, directory) || !fs.existsSync(directory)) {
      return match ? "the recorded verify command changes to a directory that does not exist in this repo. Run the exact string you record before submitting." : "the recorded verify command must run from the repository root or change to a directory that exists in this repo. Run the exact string you record before submitting.";
    }
    const command = match ? verify.slice(match[0].length).trim() : verify;
    if (!match) return null;
    const npmTest = /^npm\s+test(?:\s|$)/.test(command) ? "test" : null;
    const npmRun = /^npm\s+run\s+(?:["']([^"']+)["']|([^\s;&|]+))/.exec(command);
    const script = npmTest || npmRun && (npmRun[1] || npmRun[2]);
    if (script) {
      let scripts;
      try {
        scripts = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).scripts;
      } catch (_) {
        return `\`${npmTest ? "npm test" : `npm run ${script}`}\` requires ${path.join(relativePathWithin(projectPath, directory) || ".", "package.json").replace(/\\/g, "/")}.`;
      }
      if (!scripts || !scripts[script]) {
        return `\`${npmTest ? "npm test" : `npm run ${script}`}\` requires a \`${script}\` script in ${path.join(relativePathWithin(projectPath, directory) || ".", "package.json").replace(/\\/g, "/")}.`;
      }
      return null;
    }
    const glob = nodeTestGlob(command);
    if (glob && !fs.globSync(glob, { cwd: directory }).length) {
      return `\`node --test ${glob}\` matches no files under ${relativePathWithin(projectPath, directory) || "."}.`;
    }
    return null;
  }
  function verifyPathWarning(ticket, projectPath) {
    const verify = String(ticket?.executorVerify || "").trim();
    if (!projectPath || !verify || manualVerify(verify)) return null;
    const absent = /* @__PURE__ */ new Set();
    const tokens = [...verify.matchAll(/(?:["']([^"']*)["']|([^\s;&|()]+))/g)].map((match) => match[1] ?? match[2]);
    for (const token of tokens) {
      if (!token || token.startsWith("-") || token === "." || token === "..") continue;
      if (!/[\\/]|\.[A-Za-z0-9_-]+$/.test(token)) continue;
      const pathToken = token.replace(/[?*].*$/, "");
      if (!pathToken || fs.existsSync(path.resolve(projectPath, pathToken))) continue;
      absent.add(token);
    }
    if (!absent.size) return null;
    return `recorded verify references paths absent from this repo: ${[...absent].join(", ")}. This is allowed for greenfield work; confirm the executor creates them before verifying.`;
  }
  function derivedVerifyCommand(ticket, projectPath) {
    if (!projectPath) return null;
    const plugins = /* @__PURE__ */ new Set();
    for (const scope of normalizeFiles(ticket?.files)) {
      const relative = relativePathWithin(projectPath, path.resolve(projectPath, scope))?.replace(/\\/g, "/");
      const match = relative && /^plugins\/([^/]+)(?:\/|$)/.exec(relative);
      if (match) plugins.add(`plugins/${match[1]}`);
    }
    if (plugins.size !== 1) return null;
    const directory = [...plugins][0];
    return resolveSuite(projectPath, { name: path.basename(directory), dir: directory });
  }
  function verifyCommandWarning(ticket, projectPath) {
    const issue = verifyCommandIssue(ticket, projectPath);
    return issue ? `Planning-depth warning: ${issue}` : null;
  }
  function dispatchVerifyCommandError(ticket, projectPath) {
    if (manualVerify(ticket?.executorVerify)) return null;
    const issue = verifyCommandIssue(ticket, projectPath);
    if (!issue || /^(?:record verify commands|the recorded verify command changes)/.test(issue)) return null;
    const suite = derivedVerifyCommand(ticket, projectPath);
    const suggestion = suite ? ` Use \`cd ${suite.cwd} && ${suite.command}\` instead.` : "";
    return `dispatch: verify command cannot run: ${issue}${suggestion}`;
  }
  function dispatchDescriptionError(ticket) {
    if (!ticket || !ticket.model || !ticket.effort) return null;
    if (String(ticket.description || "").trim().length >= DISPATCH_DESCRIPTION_MIN) return null;
    return `dispatch: ${DISPATCH_DESCRIPTION_GUIDANCE}.`;
  }
  function storyContractDriftWarnings(ticket) {
    const contractDrift = ticket && (ticket.storyContractDrift || dispatchState(ticket)?.storyContractDrift);
    if (!contractDrift) return [];
    return [`Dispatch warning: ${contractDrift.storyRef || "story"} execution contract changed from revision ${contractDrift.fromRevision} to ${contractDrift.toRevision} while this ticket was claimed; the next briefing uses revision ${contractDrift.toRevision}.`];
  }
  function claudeWebSearchUnavailable(ticket) {
    const model = normalizeRouteModel(ticket && ticket.model);
    const effort = coerceEffort(ticket && ticket.effort);
    return ["opus", "sonnet", "fable"].includes(String(model)) && ["xhigh", "max"].includes(String(effort));
  }
  function crossTicketStateWarnings(ticket, slug) {
    if (!ticket || !slug) return [];
    const writtenAt = Date.parse(ticket.referenceUpdatedAt || ticket.updatedAt);
    if (!Number.isFinite(writtenAt)) return [];
    const refs = new Set((String(ticket.description || "").match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
    refs.delete(String(ticket.ref || "").toUpperCase());
    const warnings = [];
    for (const ref of refs) {
      const referenced = getTicket(slug, ref);
      const transition = referenced?.statusTransition;
      const changedAt = Date.parse(transition?.at);
      if (!referenced || !Number.isFinite(changedAt) || changedAt <= writtenAt) continue;
      const from = transition.from || "unknown";
      const to = transition.to || referenced.status || "unknown";
      warnings.push(`${ref} changed state (${from} -> ${to}) after this ticket was written; its claims may be stale.`);
    }
    return warnings;
  }
  function staleWorktreeCwdWarning(cwd, projectPath, sharedTree) {
    const workingDirectory = String(cwd || "").trim();
    const normalizedDirectory = workingDirectory.replace(/[\\/]+/g, "/").toLowerCase();
    const worktreesPath = "/.claude/worktrees/";
    const containsWorktreesPath = normalizedDirectory.includes(worktreesPath);
    if (!containsWorktreesPath) return null;
    const projectRoot = String(projectPath || "").trim();
    const normalizedProjectRoot = projectRoot.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!normalizedProjectRoot || !normalizedDirectory.startsWith(`${normalizedProjectRoot}/.claude/worktrees/`)) return null;
    if (sharedTree === true) {
      return `Shared-tree dispatch: the executor has no worktree of its own and will work in whatever cwd it inherits. Board server cwd ${workingDirectory} is a leftover .claude${path.sep}worktrees cwd; it should run from project root ${projectRoot}.`;
    }
    return `Isolated-worktree dispatch: board server cwd ${workingDirectory} is a leftover .claude${path.sep}worktrees cwd, so the dispatch may fail to bind. Restart the session so the board server starts from project root ${projectRoot}.`;
  }
  function dispatchUncertaintyWarnings(ticket, slug) {
    const warnings = [
      ...crossTicketStateWarnings(ticket, slug)
    ];
    const projectPath = slug ? readMeta(slug)?.path : null;
    const verifyPath = verifyPathWarning(ticket, projectPath);
    if (verifyPath) warnings.push(verifyPath);
    const dispatch = dispatchState(ticket);
    if (dispatch) {
      const staleWorktreeWarning = staleWorktreeCwdWarning(process.cwd(), projectPath, dispatch.sharedTree === true);
      if (staleWorktreeWarning) warnings.push(staleWorktreeWarning);
    }
    return warnings.map((warning) => `Dispatch warning: ${warning}`);
  }
  function worktreeVisibilityTokens(ticket) {
    const tokens = new Set(normalizeFiles(ticket?.files));
    const text = [ticket?.executorVerify, ticket?.description].filter(Boolean).join("\n");
    const pathLike = /(?:\.{1,2}[\\/])?(?:[A-Za-z0-9_@.-]+[\\/])+[A-Za-z0-9_@.-]+|(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+/g;
    for (const match of text.matchAll(pathLike)) tokens.add(match[0]);
    return [...tokens];
  }
  function ignoredWorktreePaths(ticket, projectPath) {
    if (!projectPath || dispatchState(ticket)?.sharedTree !== false) return [];
    const ignored = /* @__PURE__ */ new Set();
    for (const token of worktreeVisibilityTokens(ticket)) {
      const absolute = path.resolve(projectPath, token);
      const relative = relativePathWithin(projectPath, absolute);
      if (!relative || relative === "." || fs.existsSync(absolute)) continue;
      try {
        execFileSync("git", ["check-ignore", "-q", "--", relative], {
          cwd: projectPath,
          windowsHide: true,
          stdio: "ignore"
        });
        ignored.add(relative.replace(/\\/g, "/"));
      } catch (_) {
      }
    }
    return [...ignored].sort();
  }
  function ignoredPathsMissingFromDispatchedWorktree(ticket, projectPath) {
    const worktree = String(dispatchState(ticket)?.worktree || "").trim();
    return projectPath && worktree ? ignoredPathsMissingFromWorktree(projectPath, worktree, worktreeVisibilityTokens(ticket)) : [];
  }
  function worktreeVisibilityWarning(ticket, projectPath) {
    const ignored = /* @__PURE__ */ new Set([
      ...ignoredWorktreePaths(ticket, projectPath),
      ...ignoredPathsMissingFromDispatchedWorktree(ticket, projectPath)
    ]);
    if (!ignored.size) return null;
    return `Worktree visibility warning: ignored paths unavailable in a linked worktree: ${[...ignored].sort().join(", ")}. Its test results can differ from integration; use sharedTree: true, or run inline.`;
  }
  function composeFilesBindingProjectRoot(projectPath) {
    if (!projectPath) return [];
    const names = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
    const rootMount = /(?:^|\n)\s*-\s*["']?(?:\.(?:[\\/])?|\$\{(?:PWD|COMPOSE_PROJECT_DIR)\}(?:[\\/])?)["']?\s*:/m;
    const longRootMount = /type:\s*bind[\s\S]{0,300}?source:\s*["']?(?:\.(?:[\\/])?|\$\{(?:PWD|COMPOSE_PROJECT_DIR)\}(?:[\\/])?)["']?|source:\s*["']?(?:\.(?:[\\/])?|\$\{(?:PWD|COMPOSE_PROJECT_DIR)\}(?:[\\/])?)["']?[\s\S]{0,300}?type:\s*bind/m;
    const matches = [];
    for (const name of names) {
      const file = path.join(projectPath, name);
      try {
        const contents = fs.readFileSync(file, "utf8");
        if (rootMount.test(contents) || longRootMount.test(contents)) matches.push(name);
      } catch (_) {
      }
    }
    return matches;
  }
  function composeWorktreeWarning(ticket, projectPath) {
    if (dispatchState(ticket)?.sharedTree !== false) return null;
    const files = composeFilesBindingProjectRoot(projectPath);
    if (!files.length) return null;
    return `Worktree compatibility warning: ${files.join(", ")} bind-mounts the repository root, so a linked worktree is not the running app. Set worktreeIsolation: false for this board before dispatching.`;
  }
  function dispatchWarnings(ticket, slug) {
    const warnings = dispatchUncertaintyWarnings(ticket, slug);
    const noScope = noDeclaredScopeWarning(ticket);
    if (noScope) warnings.push(`Dispatch warning: ${noScope.replace("Planning-depth warning: ", "")}`);
    const projectPath = slug ? readMeta(slug)?.path : null;
    const visibility = worktreeVisibilityWarning(ticket, projectPath);
    if (visibility) warnings.push(visibility);
    const compose = composeWorktreeWarning(ticket, projectPath);
    if (compose) warnings.push(compose);
    if (projectPath) {
      const browserReview = readonlyBrowserReviewWarning(ticket);
      if (browserReview) warnings.push(`Dispatch warning: ${browserReview.replace("Planning-depth warning: ", "")}`);
      const verify = verifyCommandWarning(ticket, projectPath);
      if (verify) warnings.push(`Dispatch warning: ${verify.replace("Planning-depth warning: ", "")}`);
      for (const warning of sourceBuildOutputWarnings(ticket, projectPath)) {
        warnings.push(`Dispatch warning: ${warning.replace("Planning-depth warning: ", "")}`);
      }
    }
    if (claudeWebSearchUnavailable(ticket)) {
      warnings.push("Dispatch warning: WebSearch is unavailable on this Claude xhigh/max route. Put web research in a research-category ticket.");
    }
    if (readOnlyOverrideActive(ticket)) {
      warnings.push(ticket.readonlyOverride ? "readonly override active: this ticket closes with done + comment despite its category default." : "readonly override active: this read-only category routes through the writing executor.");
    }
    const contradiction = readonlyCategoryWriteIntentWarning(ticket);
    if (contradiction) warnings.push(`Dispatch warning: ${contradiction}`);
    const quantitativePremise = quantitativePremiseWarning(ticket);
    if (quantitativePremise) warnings.push(`Dispatch warning: ${quantitativePremise.replace("Planning-depth warning: ", "")}`);
    const worktreeWarning = dispatchState(ticket)?.worktreeWarning;
    if (worktreeWarning) warnings.push(worktreeWarning);
    const categoryId = ticket && (ticket.categoryId || ticket.category && ticket.category.id);
    if (/^(?:coding(?:\.|$)|debugging$)/.test(String(categoryId || "")) && !String(ticket.executorVerify || "").trim()) {
      warnings.push("Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts.");
    }
    warnings.push(...storyContractDriftWarnings(ticket));
    const declaredFiles = dispatchDeclaredFiles(ticket);
    const outside = externalDeclaredFiles(declaredFiles);
    if (outside.length) {
      warnings.push(`Dispatch warning: declared paths are outside the repo worktree: ${outside.join(", ")}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
    }
    if (!slug || !declaredFiles.length) return warnings;
    for (const sibling of listTickets(slug)) {
      if (sibling.id === ticket.id) continue;
      const dispatch = dispatchState(sibling);
      const liveClaim = sibling.claim && sibling.claim.by && !claimReclaimable(sibling);
      const liveDispatch = dispatch && !dispatch.terminalAt && ["prepared", "launched", "bound", "claimed"].includes(pulseDispatchState(dispatch));
      if (!liveClaim && !liveDispatch) continue;
      const overlaps = overlappingScopePaths(declaredFiles, dispatchDeclaredFiles(sibling));
      const contractReasons = contractCollisionReasons(ticket, sibling);
      if (!overlaps.length && !contractReasons.length) continue;
      if (overlaps.length) {
        const lockfilesOnly = overlaps.every((file) => /(?:^|\/)(?:Cargo\.lock|package-lock\.json|pnpm-lock\.yaml)$/i.test(file));
        const lockfileGuidance = lockfilesOnly ? " Only lockfiles overlap; serialize these tickets or regenerate the lockfile at integration." : "";
        warnings.push(`Dispatch warning: ${ticket.ref} overlaps in-flight ${sibling.ref} at ${overlaps.join(", ")} — parallel is fine in isolated worktrees unless the same symbols/regions change; assess.${lockfileGuidance}`);
      }
      for (const collision of contractReasons) {
        warnings.push(`Dispatch warning: contract edge with in-flight ${sibling.ref}: ${collision.message} Serialize unless a reviewed contract waiver applies.`);
      }
    }
    return warnings;
  }
  function dispatchDeclaredFiles(ticket) {
    const dispatch = dispatchState(ticket);
    return normalizeFiles(dispatch && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : ticket && ticket.files);
  }
  function externalDeclaredFiles(files) {
    return commitScope.validateRelativeScopes(files).outside;
  }
  function nonRepoExternalOutput(ticket, files) {
    const declaredFiles = normalizeFiles(files);
    const outside = externalDeclaredFiles(declaredFiles);
    return declaredFiles.length > 0 && outside.length === declaredFiles.length && dispatchReadOnly(ticket);
  }
  const JUDGMENT_TIER_CATEGORIES = ["coding.normal", "coding.hard", "debugging", "plugin-dev", "interaction-design-implementation"];
  const PRESOLVED_BLOCK_MIN_LINES = 20;
  const PRESOLVED_BLOCK_MIN_CHARS = 1200;
  const EVIDENCE_SHARE = 0.25;
  const EVIDENCE_LINE = /^\s*(?:\||at\s+\S.*:\d+:\d+|(?:not )?ok\s|[#$>]\s|(?:npm|node|git|pwsh|PS|yarn|pnpm|cargo|python)\s|(?:\[[^\]]*\]\s*)?(?:ERROR|WARN|INFO|DEBUG|TRACE)\b|(?:pass|fail|tests|suites|skipped|todo|cancelled|duration_ms)\s+\d|[\w.]*(?:Error|Exception):)/;
  const EVIDENCE_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
  const DEFINITION_SHAPES = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(/m,
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+[\w$]+/m,
    /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+[^=\n]*=\s*(?:async\s*)?(?:function\b|\([^)\n]*\)\s*=>|[\w$]+\s*=>)/m,
    /^\s*def\s+[\w$]+\s*\(/m,
    /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>\[\],\s]+\s+[\w$]+\s*\(/m
  ];
  function fencedBlocks(description) {
    const blocks = [];
    const body = String(description || "");
    const fence = /^[ \t]*```+[ \t]*([^\n`]*)\r?\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm;
    let match;
    while (match = fence.exec(body)) blocks.push({ info: String(match[1]).trim().toLowerCase(), body: String(match[2]) });
    return blocks;
  }
  function diffShapedBlock(block) {
    if (/^(?:diff|patch)\b/.test(block.info)) return true;
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(block.body)) return true;
    if (/^--- .+\r?\n\+\+\+ /m.test(block.body)) return true;
    const added = (block.body.match(/^\+(?!\+)\s*\S/gm) || []).length;
    const removed = (block.body.match(/^-(?!-)\s*\S/gm) || []).length;
    return added >= 2 && removed >= 2;
  }
  function evidenceShapedBlock(lines) {
    const filled = lines.filter((line) => line.trim());
    if (!filled.length) return true;
    const evidence = filled.filter((line) => EVIDENCE_LINE.test(line) || EVIDENCE_TIMESTAMP.test(line)).length;
    return evidence / filled.length >= EVIDENCE_SHARE;
  }
  function embedsCompleteEdit(description) {
    for (const block of fencedBlocks(description)) {
      const lines = block.body.split(/\r?\n/);
      if (lines.length < PRESOLVED_BLOCK_MIN_LINES && block.body.length < PRESOLVED_BLOCK_MIN_CHARS) continue;
      if (evidenceShapedBlock(lines)) continue;
      if (diffShapedBlock(block) || DEFINITION_SHAPES.some((shape) => shape.test(block.body))) return true;
    }
    return false;
  }
  function presolvedRoutingWarnings(ticket) {
    if (!JUDGMENT_TIER_CATEGORIES.includes(String(ticketCategory(ticket) || ""))) return [];
    if (!embedsCompleteEdit(ticket && ticket.description)) return [];
    return ["Planning-depth warning: this description embeds what looks like a complete edit; route by remaining uncertainty, so a fully resolved approach belongs on coding.easy or direct-ok, not a judgment tier."];
  }
  function ticketPlanningWarnings(ticket, projectPath) {
    if (!ticket) return [];
    const warnings = [];
    const outside = externalDeclaredFiles(ticket.files);
    if (outside.length) {
      warnings.push(`Planning-depth warning: declared paths are outside the repo worktree: ${outside.join(", ")}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
    }
    if (Number(ticket.complexity) >= 4) {
      const missing = [];
      if (!String(ticket.executorAnchors || "").trim()) missing.push("executor anchors");
      if (!String(ticket.executorVerify || "").trim()) missing.push("verify command");
      if (!Array.isArray(ticket.files) || !ticket.files.length) missing.push("file scope");
      if (missing.length) {
        warnings.push(`Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: ${missing.join(", ")}.`);
      }
    }
    warnings.push(...presolvedRoutingWarnings(ticket));
    const quantitativePremise = quantitativePremiseWarning(ticket);
    if (quantitativePremise) warnings.push(quantitativePremise);
    const contradiction = readonlyCategoryWriteIntentWarning(ticket);
    if (contradiction) warnings.push(contradiction);
    const noScope = noDeclaredScopeWarning(ticket);
    if (noScope) warnings.push(noScope);
    const browserReview = readonlyBrowserReviewWarning(ticket);
    if (browserReview) warnings.push(browserReview);
    const verify = verifyCommandWarning(ticket, projectPath);
    if (verify) warnings.push(verify);
    warnings.push(...executorAnchorWarnings(ticket, projectPath));
    if (!projectPath || !Array.isArray(ticket.files)) return warnings;
    warnings.push(...sourceBuildOutputWarnings(ticket, projectPath));
    const absent = ticket.files.filter((file) => {
      const declared = path.resolve(projectPath, file);
      return !fs.existsSync(declared) && fs.existsSync(path.dirname(declared));
    });
    if (absent.length) warnings.push(`Planning-depth warning: declared file scope does not exist in the repo: ${absent.join(", ")}.`);
    return warnings;
  }
  function normalizeReadonlyOverride(value) {
    return typeof value === "boolean" ? value : null;
  }
  function requestedReadonlyOverride(fields) {
    return normalizeReadonlyOverride(fields?.readonlyOverride === void 0 ? fields?.readonly : fields.readonlyOverride);
  }
  return { DISPATCH_DESCRIPTION_MIN, executorText, manualVerify, verifyCommandError, requireVerifyCommand, ticketReferenceWarnings, ticketPrescribesFix, ticketCategoryWarnings, quantitativePremiseWarning, readonlyCategoryWriteIntentWarning, noDeclaredScopeWarning, readonlyBrowserReviewWarning, relativePathWithin, packageRootForScope, buildOutputDirectories, packageBuildOutputs, isTrackedBuildOutput, scopeIncludesPath, sourceBuildOutputWarnings, verifyCommandWarning, dispatchVerifyCommandError, dispatchDescriptionError, storyContractDriftWarnings, crossTicketStateWarnings, staleWorktreeCwdWarning, dispatchUncertaintyWarnings, worktreeVisibilityTokens, ignoredWorktreePaths, worktreeVisibilityWarning, composeFilesBindingProjectRoot, composeWorktreeWarning, dispatchWarnings, dispatchDeclaredFiles, externalDeclaredFiles, nonRepoExternalOutput, fencedBlocks, diffShapedBlock, evidenceShapedBlock, embedsCompleteEdit, presolvedRoutingWarnings, ticketPlanningWarnings, normalizeReadonlyOverride, requestedReadonlyOverride };
}
module.exports = { createWarnings };
