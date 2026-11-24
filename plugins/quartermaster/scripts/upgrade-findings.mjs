export const OLDER_MARKETPLACE = "eigenwise-toolshed";
export const CURRENT_MARKETPLACE = "toolshed-next";

export const PLUGINS_WITH_A_NAMESAKE = ["sidequest", "quartermaster", "codebase-mapper", "live-rules"];
export const OLDER_PLUGINS_WITHOUT_A_SUCCESSOR = ["quality-gate", "observability"];
export const GATEWAY_PLUGIN = "model-gateway";
export const MAPPER_PLUGIN = "codebase-mapper";
export const RULES_PLUGIN = "live-rules";
const KNOWN_OLDER_PLUGINS = [...PLUGINS_WITH_A_NAMESAKE, ...OLDER_PLUGINS_WITHOUT_A_SUCCESSOR, GATEWAY_PLUGIN];

const KEEP = "keep";
const CONVERT = "convert";
const REMOVE = "remove";
const ASK = "ask";

export const USER_SCOPE = "(user)";

export const COMMITTED_SETTINGS = ".claude/settings.json";
export const LOCAL_SETTINGS = ".claude/settings.local.json";

const GATEWAY_WIRING_KEYS = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
  "ENABLE_TOOL_SEARCH",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];
const TELEMETRY_SWITCHES = ["CLAUDE_CODE_ENABLE_TELEMETRY", "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"];
const LOOPBACK_ADDRESS = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const GATEWAY_HOOK_COMMAND = /model-gateway|readiness-gate/;

// Names only the older version had: its board's MCP tools, its executor agents and the skills v2 does not ship.
const OLDER_ONLY_NAMES = [
  "mcp__plugin_sidequest_board__",
  "sidequest-exec",
  "sidequest:groom",
  "sidequest:user-story",
  "sidequest:verify-discipline",
  "quartermaster:setup",
  "quartermaster:toolshed-doctor",
  "quartermaster:update-toolshed",
  "codebase-mapper:map-codebase",
  "codebase-mapper:update-codebase-map",
  "live-rules:manage-rules",
  "model-gateway",
  "quality-gate:quality",
  ".codebase-info",
  ".claude/live-rules",
];

export const CLAUDE_MODELS = ["haiku", "sonnet", "opus", "fable"];

export const OLDER_REVIEW_REF_NAMESPACES = ["refs/sidequest/", "refs/sidequest-archived/", "refs/sidequest-rounds/"];

const recordOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

export function olderNamesIn(text) {
  return OLDER_ONLY_NAMES.filter((name) => text.includes(name));
}

function splitPluginKey(key) {
  const at = key.lastIndexOf("@");
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

export function olderPluginKeys(settings) {
  return Object.entries(recordOf(settings.enabledPlugins))
    .map(([key, value]) => ({ ...splitPluginKey(key), key, isOn: value === true }))
    .filter((plugin) => plugin.marketplace === OLDER_MARKETPLACE);
}

const isOursMarketplace = (marketplace) => marketplace === OLDER_MARKETPLACE || marketplace === CURRENT_MARKETPLACE;

// A key for one of ours, true or false, means that plugin was on here at some point: switching off keeps the key.
export function pluginNamesInSettings(...settingsFiles) {
  const keys = settingsFiles.flatMap((settings) => Object.keys(recordOf(settings.enabledPlugins)));
  return [...new Set(keys.map(splitPluginKey).filter((plugin) => isOursMarketplace(plugin.marketplace)).map((plugin) => plugin.name))];
}

const isOnIn = (settings, name, marketplace) => recordOf(settings.enabledPlugins)[`${name}@${marketplace}`] === true;
const isOffIn = (settings, name, marketplace) => recordOf(settings.enabledPlugins)[`${name}@${marketplace}`] === false;

export function isSwitchedOverLocally(local, name) {
  return isOnIn(local, name, CURRENT_MARKETPLACE) && isOffIn(local, name, OLDER_MARKETPLACE);
}

const isNamedIn = (settings, key) => key in recordOf(settings.enabledPlugins);

// A retired plugin's key does nothing, so only the ones v2 has a namesake or a gateway answer for count here.
export function olderPluginsOnOnlyAtUserScope(committed, local, user) {
  return olderPluginKeys(user)
    .filter((plugin) => plugin.isOn && KNOWN_OLDER_PLUGINS.includes(plugin.name))
    .filter((plugin) => !isNamedIn(committed, plugin.key) && !isNamedIn(local, plugin.key))
    .map((plugin) => plugin.name);
}

// The local file wins over the committed one, and the committed one over the user settings, key by key, as the host reads them.
export function olderPluginsStillOn(committed, local, user = {}) {
  const names = new Set([...olderPluginKeys(committed), ...olderPluginKeys(local)].map((plugin) => plugin.name));
  const onInTheProjectFiles = [...names].filter((name) => {
    const localValue = recordOf(local.enabledPlugins)[`${name}@${OLDER_MARKETPLACE}`];
    return localValue === undefined ? isOnIn(committed, name, OLDER_MARKETPLACE) : localValue === true;
  });
  return [...onInTheProjectFiles, ...olderPluginsOnOnlyAtUserScope(committed, local, user)];
}

const olderPluginsOnHere = (facts) => olderPluginsStillOn(facts.committed, facts.local, facts.user ?? {});

// An older plugin that is the only thing loading something git tracks: it moves for everyone with the committed change, never for one person.
export const OLDER_PLUGINS_HELD_BY_TRACKED_SOURCES = [
  {
    plugin: MAPPER_PLUGIN,
    sources: [{ fact: "olderMap", path: ".claude/.codebase-info" }],
    isConverted: (paths) => paths.currentMap === true,
    heldWhy: `stays on: git tracks the map in .claude/.codebase-info/, so it is the repository's and loads only through this plugin. The mapper moves for everyone with the committed change, never for one person; ${MAPPER_PLUGIN}@${CURRENT_MARKETPLACE} stays off here until then`,
    putBackWhy: `put the older mapper back on here: git tracks the map in .claude/.codebase-info/, it loads only through this plugin and no v2 map exists, so sessions here load no map. Run claude plugin enable ${MAPPER_PLUGIN}@${OLDER_MARKETPLACE} --scope local, and claude plugin disable ${MAPPER_PLUGIN}@${CURRENT_MARKETPLACE} --scope local when that one is on here. Undo: the same commands the other way round`,
    onNote: "(stays on: the map git tracks loads through it)",
    leftOnLine: `left on: ${MAPPER_PLUGIN}, the map git tracks loads through it`,
    keptOnWords: "the mapper, whose map git tracks,",
    stateKind: "older-mapper-state",
    stateEntries: [`${MAPPER_PLUGIN}-state`, `plugins/data/${MAPPER_PLUGIN}-${OLDER_MARKETPLACE}`],
    stateWhy: (count) =>
      `the older mapper still loads a map git tracks in ${count} project(s), and this is its state: it stays until that map moves with the committed change`,
  },
  {
    plugin: RULES_PLUGIN,
    sources: [
      { fact: "rulesFolder", path: ".claude/live-rules" },
      { fact: "rulesPage", path: ".claude/live-rules.md" },
    ],
    isConverted: (paths) => paths.convertedRules === true,
    heldWhy: `stays on: git tracks the old rules, so they are the repository's and load only through this plugin. The rules move for everyone with the committed change, never for one person; ${RULES_PLUGIN}@${CURRENT_MARKETPLACE} stays off here until then`,
    putBackWhy: `put the older rules plugin back on here: git tracks the old rules, they load only through this plugin and no converted rules exist, so sessions here load none of them. Run claude plugin enable ${RULES_PLUGIN}@${OLDER_MARKETPLACE} --scope local, and claude plugin disable ${RULES_PLUGIN}@${CURRENT_MARKETPLACE} --scope local when that one is on here. Undo: the same commands the other way round`,
    onNote: "(stays on: the rules git tracks load through it)",
    leftOnLine: `left on: ${RULES_PLUGIN}, the rules git tracks load through it`,
    keptOnWords: "the rules plugin, whose rules git tracks,",
    stateKind: "older-rules-state",
    stateEntries: [`${RULES_PLUGIN}-state`, `plugins/data/${RULES_PLUGIN}-${OLDER_MARKETPLACE}`],
    stateWhy: (count) =>
      `the older rules plugin still loads rules git tracks in ${count} project(s), and this is its state: it stays until those rules move with the committed change`,
  },
];

export const heldSourceOf = (plugin) => OLDER_PLUGINS_HELD_BY_TRACKED_SOURCES.find((held) => held.plugin === plugin);

const isSourceTrackedHere = (paths, tracked) => (source) => paths[source.fact] === true && tracked[source.fact] === true;

export const isTrackedSourceTheOnlySource = (held, paths, tracked) => !held.isConverted(paths) && held.sources.some(isSourceTrackedHere(paths, tracked));

const heldSourcesHere = (facts) => OLDER_PLUGINS_HELD_BY_TRACKED_SOURCES.filter((held) => isTrackedSourceTheOnlySource(held, facts.paths, facts.tracked));

const isKeyOnWhileHeldByTrackedSource = (plugin) => plugin.isOn && plugin.heldSource !== undefined;

const isKeySwitchedOffLocallyWhileHeldByTrackedSource = (plugin) => !plugin.isOn && plugin.file === LOCAL_SETTINGS && plugin.heldSource !== undefined;

const USER_SCOPE_WHY = (plugin) =>
  `on for every project at user scope: install ${plugin.name}@${CURRENT_MARKETPLACE} at local scope and switch this one off for this project with claude plugin disable ${plugin.name}@${OLDER_MARKETPLACE} --scope local; the user settings file is not changed by a project's run`;

const PLUGIN_KEY_RULES = [
  {
    applies: (plugin) => !KNOWN_OLDER_PLUGINS.includes(plugin.name),
    verdict: REMOVE,
    why: () => "a retired plugin of the older version; the key does nothing",
  },
  {
    applies: isKeySwitchedOffLocallyWhileHeldByTrackedSource,
    verdict: CONVERT,
    why: (plugin) => plugin.heldSource.putBackWhy,
  },
  {
    applies: (plugin) => !plugin.isOn && plugin.isSwitchedOver,
    verdict: KEEP,
    why: () => "switched off here with v2 on beside it; the half-moved part that already works",
  },
  { applies: (plugin) => !plugin.isOn, verdict: KEEP, why: () => "switched off; nothing to do" },
  { applies: isKeyOnWhileHeldByTrackedSource, verdict: KEEP, why: (plugin) => plugin.heldSource.heldWhy, isHeld: true },
  {
    applies: (plugin) => plugin.name === GATEWAY_PLUGIN,
    verdict: ASK,
    why: () => "the gateway has no v2 counterpart; follows the home question on the gateway, unwire before switching it off",
  },
  {
    applies: (plugin) => OLDER_PLUGINS_WITHOUT_A_SUCCESSOR.includes(plugin.name),
    verdict: CONVERT,
    why: (plugin) =>
      `v2 has no plugin of this name, so nothing replaces it: switch it off for this project with claude plugin disable ${plugin.name}@${OLDER_MARKETPLACE} --scope local, and say in the report that it is gone. Undo: claude plugin enable ${plugin.name}@${OLDER_MARKETPLACE} --scope local`,
  },
  { applies: (plugin) => plugin.isUserScope === true, verdict: CONVERT, why: USER_SCOPE_WHY },
  {
    applies: (plugin) => plugin.file === LOCAL_SETTINGS,
    verdict: CONVERT,
    why: (plugin) => `install ${plugin.name}@${CURRENT_MARKETPLACE} at local scope and set this key to false`,
  },
  {
    applies: () => true,
    verdict: CONVERT,
    why: (plugin) => `swap the key to ${plugin.name}@${CURRENT_MARKETPLACE}, show the diff, the person commits`,
  },
];

function firstMatchingRule(rules, subject) {
  return rules.find((rule) => rule.applies(subject));
}

export function pluginKeyLeftovers(file, settings, local, heldSources = [], isUserScope = false) {
  return olderPluginKeys(settings).map((plugin) => {
    const heldSource = heldSources.find((held) => held.plugin === plugin.name);
    const subject = { ...plugin, file, isSwitchedOver: isSwitchedOverLocally(local, plugin.name), heldSource, isUserScope };
    const rule = firstMatchingRule(PLUGIN_KEY_RULES, subject);
    const followsHomeAnswer = plugin.name === GATEWAY_PLUGIN && plugin.isOn;
    const held = rule.isHeld === true ? { isHeldByTrackedSource: true } : {};
    return { kind: "older-plugin", file, where: `${file} enabledPlugins ${plugin.key}`, verdict: rule.verdict, why: rule.why(subject), followsHomeAnswer, ...held };
  });
}

function userScopeLeftovers(facts, heldSources) {
  const names = olderPluginsOnOnlyAtUserScope(facts.committed, facts.local, facts.user ?? {});
  const onlyThoseKeys = { enabledPlugins: Object.fromEntries(names.map((name) => [`${name}@${OLDER_MARKETPLACE}`, true])) };
  return pluginKeyLeftovers(facts.userSettingsFile, onlyThoseKeys, facts.local, heldSources, true);
}

const presentKeys = (environment, keys) => keys.filter((key) => key in environment);

function gatewayWiringLeftover(file, environment) {
  if (!LOOPBACK_ADDRESS.test(String(environment.ANTHROPIC_BASE_URL ?? ""))) return [];
  const why = "the gateway wrote these; follows the home question. Unwire with the gateway's own env --remove BEFORE switching the gateway off";
  const where = `${file} env ${presentKeys(environment, GATEWAY_WIRING_KEYS).join(", ")}`;
  return [{ kind: "gateway-wiring", file, where, verdict: ASK, why, followsHomeAnswer: true }];
}

function telemetryLeftover(file, environment) {
  const endpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined) return [];
  const keys = Object.keys(environment).filter((key) => key.startsWith("OTEL_") || TELEMETRY_SWITCHES.includes(key));
  const where = `${file} env ${keys.join(", ")}`;
  if (!LOOPBACK_ADDRESS.test(String(endpoint))) {
    return [{ kind: "telemetry-export", file, where, verdict: KEEP, why: `not the older Toolshed's: it points at ${endpoint}, so it stays` }];
  }
  const why = `v2 telemetry does not use them; copy the file first. Ask instead when something listens on ${endpoint}`;
  return [{ kind: "telemetry-export", file, where, verdict: REMOVE, why }];
}

const SINGLE_KEY_ENVIRONMENT_RULES = [
  { key: "SIDEQUEST_COMPACTION_POLICY", kind: "older-board-setting", verdict: REMOVE, why: "only the older board read it" },
  { key: "PYTHONIOENCODING", kind: "python-encoding", verdict: KEEP, why: "harmless and still useful to Python on Windows" },
];

export function environmentLeftovers(file, settings) {
  const environment = recordOf(settings.env);
  const single = SINGLE_KEY_ENVIRONMENT_RULES.filter((rule) => rule.key in environment).map((rule) => ({
    kind: rule.kind,
    file,
    where: `${file} env ${rule.key}`,
    verdict: rule.verdict,
    why: rule.why,
  }));
  return [...gatewayWiringLeftover(file, environment), ...telemetryLeftover(file, environment), ...single];
}

function hookCommandsOf(settings) {
  return Object.values(recordOf(settings.hooks))
    .flatMap((groups) => (Array.isArray(groups) ? groups : []))
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => String(hook?.command ?? ""));
}

function gatewayHookLeftover(file, settings) {
  const count = hookCommandsOf(settings).filter((command) => GATEWAY_HOOK_COMMAND.test(command)).length;
  if (count === 0) return [];
  const why = "the gateway's readiness hooks; its env --remove takes them out, switching the plugin off does not";
  return [{ kind: "gateway-hooks", file, where: `${file} hooks (${count})`, verdict: ASK, why, followsHomeAnswer: true }];
}

function permissionLeftover(file, settings) {
  const allowed = recordOf(settings.permissions).allow;
  const older = (Array.isArray(allowed) ? allowed : []).filter((entry) => olderNamesIn(String(entry)).length > 0);
  if (older.length === 0) return [];
  return [{ kind: "older-permissions", file, where: `${file} permissions.allow: ${older.join(", ")}`, verdict: REMOVE, why: "they allow tools that no longer exist" }];
}

function autoApproveLeftover(file, settings) {
  if (!("autoApprovePermissions" in recordOf(settings.quartermaster))) return [];
  return [{ kind: "auto-approve-switch", file, where: `${file} quartermaster.autoApprovePermissions`, verdict: REMOVE, why: "v2 does not read it" }];
}

function marketplaceLeftover(file, settings) {
  if (!(OLDER_MARKETPLACE in recordOf(settings.extraKnownMarketplaces))) return [];
  const why = `declares the older marketplace; goes with its plugin keys (declare ${CURRENT_MARKETPLACE} from Eigenwise/eigenwise-toolshed with ref v2 in the same change when the plugins move here)`;
  return [{ kind: "older-marketplace", file, where: `${file} extraKnownMarketplaces ${OLDER_MARKETPLACE}`, verdict: REMOVE, why }];
}

export function settingsLeftovers(file, settings, local, heldSources = []) {
  return [
    ...pluginKeyLeftovers(file, settings, local, heldSources),
    ...marketplaceLeftover(file, settings),
    ...environmentLeftovers(file, settings),
    ...gatewayHookLeftover(file, settings),
    ...permissionLeftover(file, settings),
    ...autoApproveLeftover(file, settings),
  ];
}

const TRACKED_SETTINGS_WHY = {
  [COMMITTED_SETTINGS]:
    "the committed file is tracked by git: switch the person over in local settings now, and put this in the committed change only when they say so",
  [LOCAL_SETTINGS]: "git tracks this local settings file, so it is committed work: it stays as it is until the committed change, and no deletion in this run touches it",
};

export const trackedSettingsFiles = (facts) => [
  ...(facts.isSettingsCommitted ? [COMMITTED_SETTINGS] : []),
  ...(facts.isLocalSettingsTracked ? [LOCAL_SETTINGS] : []),
];

// A tracked settings file never changes on the plain run, whoever the authors are: what the run would do to it waits for the committed-change answer.
export function handCommittedFileToCommittedChange(leftover, trackedFiles) {
  const isTrackedFile = trackedFiles.includes(leftover.file) && leftover.verdict !== KEEP;
  const why = `${TRACKED_SETTINGS_WHY[leftover.file]}`;
  return isTrackedFile ? { ...leftover, verdict: ASK, why, isCommittedChange: true } : leftover;
}

const SWITCH_WRITES_INTO_TRACKED_FILE_WHY =
  "git tracks this file and the plugin switch has to write into it (there is no other personal place for it here): the switch shows as a change in git status and nothing is committed";

function trackedLocalSettingsNote(facts) {
  if (!facts.isLocalSettingsTracked || olderPluginsOnHere(facts).length === 0) return [];
  return [{ kind: "tracked-local-settings", file: LOCAL_SETTINGS, where: LOCAL_SETTINGS, verdict: KEEP, why: SWITCH_WRITES_INTO_TRACKED_FILE_WHY }];
}

const reviewRefsCount = (facts) =>
  `${facts.reviewRefs.total} refs under ${OLDER_REVIEW_REF_NAMESPACES.join(", ")}: ${facts.reviewRefs.merged} merged into the checked-out branch`;

// Converting the old map means checking every claim in it against the code, so the work grows with its lines of text.
// A map this long took three read-only agents of about 95 thousand tokens each in one real run; up to this many lines
// one agent reads it in a pass. The figure is chosen, not measured.
export const LARGE_OLD_MAP_LINES = 400;

const TRACKED_OLDER_MAP_WHY =
  "git tracks it, so it is the repository's map: it moves for everyone with the committed change (converted to .claude/rules/, this folder removed and the committed settings switched in one commit), never as one person's copy, and no deletion in this run touches it";

const TWO_MAPS_WHY =
  "; a v2 map is here beside it, so this checkout has two maps that drift apart until the committed change takes the v2 one into the repository and removes this one";

const lengthNote = (facts) =>
  facts.paths.olderMapLines > LARGE_OLD_MAP_LINES ? `; ${facts.paths.olderMapLines} lines, so converting it is the long part of that change` : "";

const trackedOlderMapWhy = (facts) => `${TRACKED_OLDER_MAP_WHY}${lengthNote(facts)}${facts.paths.currentMap ? TWO_MAPS_WHY : ""}`;

const TRACKED_OLDER_RULES_WHY =
  "git tracks it, so these are the repository's rules: they move for everyone with the committed change (converted to .claude/rules/ and .claude/skills/, the old ones removed and the committed settings switched in one commit), never as one person's copy, and no deletion in this run touches it";

// Only where a personal copy would otherwise be made: a copy drifts from the rules the team keeps editing.
const trackedOlderRulesWhy = (facts) =>
  facts.paths.convertedRules || !facts.pluginsNamedInSettings.includes(RULES_PLUGIN) ? undefined : TRACKED_OLDER_RULES_WHY;

// What the older plugins left in the project folder. `plugin` is the one whose step converts it; a path without one
// has nothing to convert and goes once the person says yes.
const OLDER_PATHS = [
  {
    kind: "rules-folder",
    where: ".claude/live-rules/",
    fact: "rulesFolder",
    plugin: RULES_PLUGIN,
    isConverted: (facts) => facts.paths.convertedRules,
    trackedWhy: trackedOlderRulesWhy,
    converter: "references/older-rules.md converts it, writing .claude/rules/ and .claude/skills/ beside it",
    afterConversion: "converted already (.claude/rules/ has rules); the old folder only fed the older rules hook",
  },
  {
    kind: "rules-page",
    where: ".claude/live-rules.md",
    fact: "rulesPage",
    plugin: RULES_PLUGIN,
    isConverted: (facts) => facts.paths.convertedRules,
    trackedWhy: trackedOlderRulesWhy,
    converter: "references/older-rules.md converts the single page too",
    afterConversion: "converted already (.claude/rules/ has rules); the old page only fed the older rules hook",
  },
  {
    kind: "older-map",
    where: ".claude/.codebase-info/",
    fact: "olderMap",
    plugin: "codebase-mapper",
    isConverted: (facts) => facts.paths.currentMap,
    isLarge: (facts) => facts.paths.olderMapLines > LARGE_OLD_MAP_LINES,
    trackedWhy: trackedOlderMapWhy,
    laterCommand: "codebase-mapper:map",
    converter: "codebase-mapper:map reads it as leads and writes .claude/rules/codebase-map.md",
    afterConversion: "the v2 map already exists; the old folder only feeds the older map hook",
  },
  {
    kind: "quality-gate-records",
    where: ".claude/quality-gate/receipts/ or crap.json",
    fact: "qualityGateRecords",
    isConverted: () => true,
    afterConversion: "v2 keeps no receipts",
  },
];

const TRACKED_WHY =
  "git tracks it, so it is committed work: it stays as it is until the committed change, and no deletion in this run touches it";

const NEVER_ON_WHY = (plugin) =>
  `${plugin} was never on in this project, older or v2, so nothing reads it and there is nothing to convert; it stays as it is`;

const leftoverAt = (olderPath, verdict, why, extra = {}) => ({ kind: olderPath.kind, where: olderPath.where, verdict, why, ...extra });

const isTrackedPath = (facts, olderPath) => facts.tracked[olderPath.fact] === true;

const wasEverOnHere = (facts, olderPath) => olderPath.plugin === undefined || facts.pluginsNamedInSettings.includes(olderPath.plugin);

const laterStepWhy = (facts, olderPath) =>
  `later step: ${facts.paths.olderMapLines} lines, more than the ${LARGE_OLD_MAP_LINES} the upgrade converts in one run. Run ${olderPath.laterCommand} in this project when you next work here; it reads the old folder as leads; the old folder stays as it is until then`;

const isLargeToConvert = (facts, olderPath) => olderPath.isLarge?.(facts) === true;

function conversionLeftover(facts, olderPath, converterWhy, extra) {
  if (isLargeToConvert(facts, olderPath)) return [leftoverAt(olderPath, KEEP, laterStepWhy(facts, olderPath), { isLaterStep: true })];
  return [leftoverAt(olderPath, CONVERT, converterWhy, extra)];
}

function personalPath(facts, olderPath) {
  if (!wasEverOnHere(facts, olderPath)) return [leftoverAt(olderPath, KEEP, NEVER_ON_WHY(olderPath.plugin))];
  if (olderPath.isConverted(facts)) return [leftoverAt(olderPath, REMOVE, olderPath.afterConversion)];
  return conversionLeftover(facts, olderPath, olderPath.converter, { endsInADeletion: true });
}

// A tracked path is committed work whatever the author count and its state, so the run never deletes it, converted or not.
function olderPathLeftovers(facts, olderPath) {
  if (!isTrackedPath(facts, olderPath)) return personalPath(facts, olderPath);
  return [leftoverAt(olderPath, KEEP, olderPath.trackedWhy?.(facts) ?? TRACKED_WHY, { isCommittedChange: true })];
}

const MEMORY_NOTES_KEEP_COMMAND = 'upgrade-kept.mjs --keep memory-notes --reason "<why what is left is still true here>"';

export const WORKTREE_COUNT_COVERS = "the count covers this project's folder under the older worktree root, so tidy run on the whole root counts more";

const keptFolderLine =(folder) => `${folder.name}: ${folder.keepReasons.join(", ")}`;

const safeOlderWorktrees = (facts) => facts.olderWorktreeFolder.folders.filter((folder) => folder.keepReasons.length === 0);

const keptOlderWorktrees = (facts) => facts.olderWorktreeFolder.folders.filter((folder) => folder.keepReasons.length > 0);

const PROJECT_FILE_RULES = [
  {
    kind: "board-not-excluded",
    applies: (facts) => facts.paths.boardFolder && !facts.isBoardKeptOutOfGit,
    where: () => ".git/info/exclude",
    verdict: CONVERT,
    why: () => "add the line .sidequest/ so the v2 board stays personal",
  },
  {
    kind: "older-exclude-lines",
    applies: (facts) => facts.staleExcludeLines.length > 0,
    where: (facts) => `.git/info/exclude: ${facts.staleExcludeLines.join(", ")}`,
    verdict: REMOVE,
    why: () => "the older version's lines for folders that are gone",
  },
  {
    kind: "agent-branches",
    applies: (facts) => facts.agentBranches.merged > 0,
    where: (facts) => `${facts.agentBranches.merged} worktree-agent-* branches merged into the checked-out branch, in no worktree`,
    verdict: CONVERT,
    endsInADeletion: true,
    why: () => "sidequest:tidy deletes them with git branch -d, in the one deletions yes",
  },
  {
    kind: "agent-branches",
    applies: (facts) => facts.agentBranches.unmerged > 0,
    where: (facts) => `${facts.agentBranches.unmerged} worktree-agent-* branches with commits the checked-out branch lacks, in no worktree`,
    verdict: KEEP,
    why: () => "they hold work that is nowhere else, so tidy keeps them; what to do with them is the person's call, outside the upgrade",
  },
  {
    kind: "older-review-refs",
    applies: (facts) => facts.reviewRefs.merged > 0,
    where: reviewRefsCount,
    verdict: REMOVE,
    why: () => "candidates the older board's review passes left; only the merged ones go, with git update-ref -d, in the one deletions yes. The others stay and are named",
  },
  {
    kind: "older-review-refs",
    applies: (facts) => facts.reviewRefs.total > 0 && facts.reviewRefs.merged === 0,
    where: reviewRefsCount,
    verdict: KEEP,
    why: () => "each holds commits the checked-out branch lacks; what to do with them is the person's call, outside the upgrade",
  },
  {
    kind: "older-worktrees",
    applies: (facts) => safeOlderWorktrees(facts).length > 0,
    where: (facts) => `${facts.olderWorktreeFolder.path}: ${safeOlderWorktrees(facts).length} folder(s) tidy calls safe`,
    verdict: CONVERT,
    endsInADeletion: true,
    why: () => `sidequest:tidy with this folder as its argument removes them, in the one deletions yes; ${WORKTREE_COUNT_COVERS}`,
  },
  {
    kind: "older-worktrees",
    applies: (facts) => keptOlderWorktrees(facts).length > 0,
    where: (facts) => `${facts.olderWorktreeFolder.path}: ${keptOlderWorktrees(facts).length} folder(s) tidy keeps`,
    verdict: KEEP,
    why: (facts) => `they may hold work that is nowhere else; ${WORKTREE_COUNT_COVERS}. ${keptOlderWorktrees(facts).map(keptFolderLine).join("; ")}`,
  },
  {
    kind: "memory-notes",
    applies: (facts) => facts.memoryNotes.length > 0,
    where: (facts) => `personal memory notes that name older tools: ${facts.memoryNotes.join(", ")}`,
    verdict: CONVERT,
    why: () =>
      `edit the notes that name an older tool with a v2 equivalent (copy each file first, show the edit as a diff), then record what is left as kept with your reason: ${MEMORY_NOTES_KEEP_COMMAND}`,
  },
];

export function projectFileLeftovers(facts) {
  const fromPaths = OLDER_PATHS.filter((olderPath) => facts.paths[olderPath.fact]).flatMap((olderPath) => olderPathLeftovers(facts, olderPath));
  const fromRules = PROJECT_FILE_RULES.filter((rule) => rule.applies(facts)).map((rule) => ({
    kind: rule.kind,
    where: rule.where(facts),
    verdict: rule.verdict,
    why: rule.why(facts),
    endsInADeletion: rule.endsInADeletion === true,
  }));
  return [...fromPaths, ...fromRules];
}

export function instructionLeftovers(instructionFiles) {
  return instructionFiles.map((file) => {
    const isCommittedChange = file.isTracked === true;
    const why = isCommittedChange ? "tracked by git: the edit goes into the committed change" : "show the edit as a diff: older tool to its v2 tool, drop the rest";
    return { kind: "instruction-text", where: `${file.path} names ${file.names.join(", ")}`, verdict: isCommittedChange ? ASK : CONVERT, why, isCommittedChange };
  });
}

const sumOf = (counts) => Object.values(counts).reduce((total, count) => total + count, 0);

function openTicketLeftover(board) {
  const openCount = sumOf(board.openByStatus ?? {});
  if (openCount === 0) return [];
  const statuses = Object.entries(board.openByStatus).map(([status, count]) => `${count} ${status}`).join(", ");
  const why =
    "they stay in the old board, a read-only archive until the home cleanup (the recommended answer); the person may name some to redraft as v2 tickets. Doing rows are stale claims, never resume them. upgrade-scan.mjs --open-tickets lists them, one per line";
  return [{ kind: "open-tickets", where: `${openCount} open tickets on the old board (${statuses})`, verdict: KEEP, why }];
}

const isOtherProvider = (model) => typeof model === "string" && !CLAUDE_MODELS.includes(model.toLowerCase());

export function routeLine(route) {
  const fallback = route.fallback === undefined ? "" : `, fallback ${route.fallback.model} ${route.fallback.effort}`;
  return `${route.category}: ${route.model} ${route.effort}${fallback}`;
}

function otherProviderLeftover(routes) {
  const elsewhere = routes.filter((route) => isOtherProvider(route.model) || isOtherProvider(route.fallback?.model));
  if (elsewhere.length === 0) return [];
  const why = "models from other providers have no place in v2 yet: such a tier falls back to a Claude model with a named reason. The routes are under Old routes";
  return [{ kind: "other-provider-routes", where: elsewhere.map((route) => route.category).join(", "), verdict: KEEP, why }];
}

// The older categories that have a row in references/routing.md: v2's default categories already route them.
export const OLDER_CATEGORIES_WITH_A_V2_DEFAULT = [
  "codebase-exploration",
  "implementation-explanation",
  "source-lookup",
  "evidence-research",
  "spike-investigation",
  "research.evidence",
  "debugging",
  "coding.easy",
  "coding.normal",
  "behavior-verification",
  "interaction-design-implementation",
  "coding.hard",
  "review-audit",
  "visual-evaluation",
  "general",
];

const categoriesWithNoV2Default = (board) =>
  (board.projectCategories ?? []).filter((category) => !OLDER_CATEGORIES_WITH_A_V2_DEFAULT.includes(category));

const TIER_OF_CLAUDE_MODEL = { haiku: "light", sonnet: "standard", opus: "deep", fable: "top" };
const TIER_WITHOUT_A_CLAUDE_ROUTE = "standard";

const tierOfClaudeModel = (model) => TIER_OF_CLAUDE_MODEL[String(model).toLowerCase()];

const NO_OLD_ROUTE = {};

const tierOfRoute = (route) => tierOfClaudeModel(route.model) ?? tierOfClaudeModel(route.fallback?.model) ?? TIER_WITHOUT_A_CLAUDE_ROUTE;

function fallbackTierNote(route) {
  const model = route.fallback?.model;
  return tierOfClaudeModel(model) === undefined ? `${TIER_WITHOUT_A_CLAUDE_ROUTE} tier` : `${model} tier`;
}

function descriptionOfCategory(name, route) {
  if (route.model === undefined) return `Was ${name}; no old route found, ${TIER_WITHOUT_A_CLAUDE_ROUTE} tier assumed.`;
  if (tierOfClaudeModel(route.model) !== undefined) return `Was ${name}.`;
  return `Was ${name}, on ${route.model}, a model from another provider; ${fallbackTierNote(route)} instead.`;
}

const roleOfCategory = (board, name) => (board.projectCategoryRoles?.[name] === "scout" ? "scout" : "worker");

// One line the run can put under `categories` in .sidequest/board.json, by the mapping in references/routing.md.
export function readyCategoryLine(board, name) {
  const route = (board.profile?.routes ?? []).find((candidate) => candidate.category === name) ?? NO_OLD_ROUTE;
  const fields = `"tier": ${JSON.stringify(tierOfRoute(route))}, "role": ${JSON.stringify(roleOfCategory(board, name))}, "description": ${JSON.stringify(descriptionOfCategory(name, route))}`;
  return `${JSON.stringify(name)}: { ${fields} }`;
}

// A category counts as written only when the project's v2 board file has one of that name.
function routingStillToWrite(board, currentCategories) {
  return categoriesWithNoV2Default(board).filter((category) => !currentCategories.includes(category));
}

function customRoutingLeftover(board, currentCategories) {
  const names = categoriesWithNoV2Default(board);
  if (names.length === 0) return [];
  const missing = routingStillToWrite(board, currentCategories);
  if (missing.length === 0) {
    return [{ kind: "custom-routing", where: names.join(", "), verdict: KEEP, why: "written into .sidequest/board.json already" }];
  }
  const why = "write each line under categories in .sidequest/board.json, exactly as printed";
  return [{ kind: "custom-routing", where: missing.join(", "), verdict: CONVERT, why, readyLines: missing.map((name) => readyCategoryLine(board, name)) }];
}

// The older board wrote false; a row an earlier version of it wrote may hold 0.
const ISOLATION_OFF_VALUES = [false, 0];

function sharedCheckoutLeftover(board, currentWorktrees) {
  if (!ISOLATION_OFF_VALUES.includes(board.worktreeIsolation)) return [];
  const where = "the older board ran every agent in the main checkout here (worktree isolation off)";
  if (currentWorktrees === false) return [{ kind: "shared-checkout", where, verdict: KEEP, why: "written into .sidequest/board.json already" }];
  const why = "write the line below under settings in .sidequest/board.json, exactly as printed; then write under settings.checks what the checks need that a worktree lacks";
  return [{ kind: "shared-checkout", where, verdict: CONVERT, why, readyLines: ['"worktrees": false'] }];
}

export function boardLeftovers(board, currentCategories = [], currentWorktrees = undefined) {
  if (!board.isPresent || board.unreadable !== undefined) return [];
  return [
    ...openTicketLeftover(board),
    ...customRoutingLeftover(board, currentCategories),
    ...sharedCheckoutLeftover(board, currentWorktrees),
    ...otherProviderLeftover(board.profile?.routes ?? []),
  ];
}

export const needsAction = (leftover) => leftover.verdict !== KEEP;

export function isHalfMoved(local) {
  return olderPluginKeys(local).some((plugin) => isSwitchedOverLocally(local, plugin.name));
}

// What the committed change decides and what the gateway answer settles do not hold up a person's own move.
export const isThisPersonsWork = (leftover) => needsAction(leftover) && leftover.isCommittedChange !== true && leftover.followsHomeAnswer !== true;

export function heldOlderPlugins(facts) {
  const olderPluginsOn = olderPluginsOnHere(facts);
  return heldSourcesHere(facts).map((held) => held.plugin).filter((name) => olderPluginsOn.includes(name));
}

function olderPluginsTheRunCouldSwitchOff(facts) {
  const held = heldOlderPlugins(facts);
  return olderPluginsOnHere(facts).filter((name) => name !== GATEWAY_PLUGIN && !held.includes(name));
}

export function shapeOf(facts, leftovers) {
  if (!leftovers.some(isThisPersonsWork) && olderPluginsTheRunCouldSwitchOff(facts).length === 0) return "moved";
  if (isHalfMoved(facts.local)) return "half-moved";
  return facts.isTeam ? "team" : "solo";
}

// Converting some things leaves an old folder or a branch behind, and that removal waits for the same one yes.
export const isOnDeletionList = (leftover) => leftover.verdict === REMOVE || (needsAction(leftover) && leftover.endsInADeletion === true);

const isOpenTicketsUnanswered = (leftover) => leftover.kind === "open-tickets" && leftover.keptOnAnswer === undefined;

const QUESTION_RULES = [
  { id: "open-tickets", applies: (leftovers) => leftovers.some(isOpenTicketsUnanswered) },
  { id: "deletions", applies: (leftovers) => leftovers.some(isOnDeletionList) },
  { id: "committed-change", applies: (leftovers) => leftovers.some((leftover) => leftover.isCommittedChange === true) },
];

export function questionsFor(shape, leftovers) {
  if (shape === "moved") return [];
  return QUESTION_RULES.filter((rule) => rule.applies(leftovers)).map((rule) => rule.id);
}

// What the person can settle by keeping it, so a later scan lists it as kept instead of asking again.
export const KEPT_ON_ANSWER_SUBJECTS = ["gateway", "memory-notes", "open-tickets"];

const answerSubjectOf = (leftover) => (leftover.followsHomeAnswer === true ? "gateway" : leftover.kind);

// The run keeps these on its own stated reason, since editing personal notes is reversible and needs no person.
const KEPT_ON_THE_RUNS_REASON_SUBJECTS = ["memory-notes"];

const keptWhy = (subject, answer) => {
  const byWhom = KEPT_ON_THE_RUNS_REASON_SUBJECTS.includes(subject) ? "" : " on the person's answer";
  return `kept on ${answer.date}${byWhom}: ${answer.reason}`;
};

export function keptOnAnswer(leftover, keptAnswers) {
  const subject = answerSubjectOf(leftover);
  const answer = KEPT_ON_ANSWER_SUBJECTS.includes(subject) ? keptAnswers[subject] : undefined;
  if (answer === undefined) return leftover;
  return { ...leftover, verdict: KEEP, why: keptWhy(subject, answer), keptOnAnswer: answer };
}

export function projectLeftovers(facts) {
  const heldSources = heldSourcesHere(facts);
  const fromSettings = [
    ...settingsLeftovers(COMMITTED_SETTINGS, facts.committed, facts.local, heldSources),
    ...settingsLeftovers(LOCAL_SETTINGS, facts.local, facts.local, heldSources),
    ...userScopeLeftovers(facts, heldSources),
  ].map((leftover) => handCommittedFileToCommittedChange(leftover, trackedSettingsFiles(facts)));
  const all = [
    ...fromSettings,
    ...trackedLocalSettingsNote(facts),
    ...projectFileLeftovers(facts),
    ...instructionLeftovers(facts.instructionFiles),
    ...boardLeftovers(facts.board, facts.currentCategories ?? [], facts.currentWorktrees),
  ].map((leftover) => keptOnAnswer(leftover, facts.keptAnswers ?? {}));
  return all.map((leftover) => ({ ...leftover, isStillToDo: isThisPersonsWork(leftover), isOnDeletionList: isOnDeletionList(leftover) }));
}

export function oldRoutingOf(board) {
  const profile = board.profile;
  if (profile === undefined) return { profile: "", source: "", lines: [] };
  return { profile: profile.name, source: profile.source, lines: profile.routes.map(routeLine) };
}

const isOnlyGatewayOrHeldOn = (olderPluginsOn, olderPluginsHeld) =>
  olderPluginsOn.every((name) => name === GATEWAY_PLUGIN || olderPluginsHeld.includes(name));

// What is left to do all sits behind a yes, and no older plugin is on that the run could still switch off.
export function isEverythingLeftWaitingForThePerson(leftovers, olderPluginsOn, olderPluginsHeld = []) {
  const stillToDo = leftovers.filter((leftover) => leftover.isStillToDo);
  return stillToDo.length > 0 && stillToDo.every((leftover) => leftover.isOnDeletionList) && isOnlyGatewayOrHeldOn(olderPluginsOn, olderPluginsHeld);
}

export function classifyProject(facts) {
  const leftovers = projectLeftovers(facts);
  const shape = shapeOf(facts, leftovers);
  const olderPluginsOn = olderPluginsOnHere(facts);
  const olderPluginsHeld = heldOlderPlugins(facts);
  return {
    isWaitingForThePerson: isEverythingLeftWaitingForThePerson(leftovers, olderPluginsOn, olderPluginsHeld),
    path: facts.path,
    shape,
    isTeam: facts.isTeam,
    authorCount: facts.authorCount,
    isSettingsCommitted: facts.isSettingsCommitted,
    olderPluginsOn,
    olderPluginsHeld,
    leftovers,
    routing: oldRoutingOf(facts.board),
    openTickets: facts.board.openTickets ?? [],
    boardProblem: facts.board.unreadable === undefined ? "" : `the old board could not be read: ${facts.board.unreadable}`,
    questions: questionsFor(shape, leftovers),
  };
}

export const OLDER_BOARD_FOLDER = "sidequest";
export const WORKTREE_GROUP = "worktree-folders";

// What a person recognises in the older board folder, and what saying yes to each costs them.
export const HOME_GROUPS = [
  {
    id: "board-database",
    name: "the board database and its backups",
    loses: "every project's old tickets, stories and routes. Say no to keep it as a read-only archive",
  },
  {
    id: WORKTREE_GROUP,
    name: "the worktree folders the older board made, one folder per project",
    loses: "only folders whose worktree verdict is safe, so nothing their repository lacks. Every keep stays, named with its reason, and so do agent branches git refuses to delete",
  },
  {
    id: "quarantine",
    name: "the worktree quarantine and worktree backups",
    loses: "copies of agent work the older sweep set aside instead of deleting. Some may hold work found nowhere else: look before saying yes",
  },
  {
    id: "ticket-evidence",
    name: "what old tickets left behind, one folder per project: attachments, verification output, captures and integration data",
    loses: "the old board's record of what each ticket attached and how it was checked. Usually by far the largest part, and no work lives here: say yes once that history is no longer wanted",
  },
  {
    id: "records",
    name: "the records: dispatch, briefings, sweep reports and hook state",
    loses: "history only. Nothing in v2 reads it",
  },
  {
    id: "other-plugins",
    name: "the other older plugins' state: map and rules hook state, Quartermaster records, caches, gateway breadcrumbs, generated agents",
    loses: "nothing v2 reads. Not quartermaster/events or toolshed/ itself, which are v2's",
  },
];

export const HOME_GROUP_IDS = HOME_GROUPS.map((group) => group.id);

const QUARANTINE_ENTRIES = ["worktree-quarantine", "worktree-backups"];

// On a real machine this one folder was 58 of 68 GB. It is a different yes from a worktree that may hold unmerged work.
const TICKET_EVIDENCE_ENTRY = "projects";

// The database, its -wal and -shm files, a copy taken before a migration, and the backup folders.
const isBoardDatabaseEntry = (name) => name.includes(".db") || name.startsWith("backup");

export function olderBoardGroupOf(name) {
  if (name === "worktrees") return WORKTREE_GROUP;
  if (QUARANTINE_ENTRIES.includes(name)) return "quarantine";
  if (name === TICKET_EVIDENCE_ENTRY) return "ticket-evidence";
  return isBoardDatabaseEntry(name) ? "board-database" : "records";
}

const heldProjectCount = (home, held) => home.heldProjectCounts?.[held.plugin] ?? 0;

const heldStillLoading = (home) => OLDER_PLUGINS_HELD_BY_TRACKED_SOURCES.filter((held) => heldProjectCount(home, held) > 0);

const isHeldPluginState = (home) => (path) => heldStillLoading(home).some((held) => held.stateEntries.includes(path));

const OTHER_PLUGIN_FOLDERS = [`${MAPPER_PLUGIN}-state`, `${RULES_PLUGIN}-state`, "quartermaster-state", OLDER_MARKETPLACE, "toolshed/registry", "codex-gateway"];

function entriesByGroup(home) {
  const byGroup = Object.fromEntries(HOME_GROUP_IDS.map((id) => [id, []]));
  for (const name of home.olderBoardEntries) byGroup[olderBoardGroupOf(name)].push(`${OLDER_BOARD_FOLDER}/${name}`);
  const otherFolders = OTHER_PLUGIN_FOLDERS.filter((path) => home.existingPaths.includes(path));
  const removable = [...otherFolders, ...home.olderAgentFiles, ...home.olderPluginData].filter((path) => !isHeldPluginState(home)(path));
  byGroup["other-plugins"].push(...removable);
  return byGroup;
}

// A group's count is what a person would count: worktree folders one by one, everything else by its top-level entries.
export function homeGroups(home) {
  const byGroup = entriesByGroup(home);
  return HOME_GROUPS.map((group) => {
    const entries = byGroup[group.id];
    return { ...group, entries, count: group.id === WORKTREE_GROUP ? home.olderWorktreeFolderCount : entries.length };
  }).filter((group) => group.count > 0);
}

const HOME_FOLDER_RULES = [
  { path: "model-gateway", verdict: ASK, why: "the gateway: kept for non-Claude models in the main session, or stopped with its own stop and removed" },
  { path: `plugins/cache/${OLDER_MARKETPLACE}`, verdict: KEEP, why: "the host manages its plugin cache" },
];

export function homeFolderLeftovers(existingPaths) {
  return HOME_FOLDER_RULES.filter((rule) => existingPaths.includes(rule.path)).map((rule) => ({
    kind: "home-folder",
    where: rule.path,
    verdict: rule.verdict,
    why: rule.why,
  }));
}

function namedListLeftover(kind, names, why) {
  return names.length === 0 ? [] : [{ kind, where: names.join(", "), verdict: REMOVE, why }];
}

const keptMarketplaceRecordWhy = (count) =>
  `${count} project(s) still have a plugin of it switched on, or a map or rules git tracks that load only through its plugins: removing the marketplace deletes those plugins. It goes once none does; a kept gateway, or a mapper or rules plugin that holds what git tracks, keeps it here on purpose`;

const MARKETPLACE_REMOVAL_WHY = `claude plugin marketplace remove ${OLDER_MARKETPLACE}, last, run from the config folder and never inside a repository (there it rewrites the committed settings). It deletes the older plugins' data, so it needs its own yes`;

function marketplaceRecordLeftover(home, projectsWithAnOlderPluginOn) {
  if (!home.hasOlderMarketplaceRecord) return [];
  const where = `plugins/known_marketplaces.json ${OLDER_MARKETPLACE}`;
  if (projectsWithAnOlderPluginOn > 0) return [{ kind: "older-marketplace-record", where, verdict: KEEP, why: keptMarketplaceRecordWhy(projectsWithAnOlderPluginOn) }];
  return namedListLeftover("older-marketplace-record", [where], MARKETPLACE_REMOVAL_WHY);
}

function heldPluginStateLeftovers(home) {
  return heldStillLoading(home).flatMap((held) => {
    const entries = [...home.existingPaths, ...home.olderPluginData].filter((path) => held.stateEntries.includes(path));
    if (entries.length === 0) return [];
    return [{ kind: held.stateKind, where: entries.join(", "), verdict: KEEP, why: held.stateWhy(heldProjectCount(home, held)) }];
  });
}

export function homeLeftovers(home, projectsWithAnOlderPluginOn = 0) {
  return [
    ...homeFolderLeftovers(home.existingPaths),
    ...heldPluginStateLeftovers(home),
    ...telemetryLeftover("settings.json", recordOf(home.userSettings.env)),
    ...marketplaceRecordLeftover(home, projectsWithAnOlderPluginOn),
  ];
}

const isKeptOnPurpose = (project) => (name) =>
  (name === GATEWAY_PLUGIN && project.isGatewayKept === true) || (project.olderPluginsHeld ?? []).includes(name);

// The person answered "keep" for the gateway there, or git tracks what only that older plugin loads, and nothing else of the older version is on: nothing is left to wait for.
const isOnlyKeptOnPurpose = (project) => project.olderPluginsOn.every(isKeptOnPurpose(project));

export function projectsStillOnOlderVersion(installedProjects) {
  return installedProjects.filter((project) => project.olderPluginsOn.length > 0 && !isOnlyKeptOnPurpose(project));
}

const hasKeptReason = (project) => project.olderPluginsOn.length > 0 || (project.olderPluginsNeededByTrackedSources ?? []).length > 0;

const projectsWithTheGatewayOn = (installedProjects) =>
  installedProjects.filter((project) => project.olderPluginsOn.includes(GATEWAY_PLUGIN) && project.isGatewayKept !== true).map((project) => project.path);

const verbFor = (names) => (names.length === 1 ? "is" : "are");

export const olderPluginsOnAtUserScope = (installedProjects) => installedProjects.find((project) => project.path === USER_SCOPE)?.olderPluginsOn ?? [];

// Only the person's own command reaches the user settings file: no project's run and no step of the upgrade writes it.
export function userScopeWaitLine(names) {
  if (names.length === 0) return "";
  return `${names.join(", ")} ${verbFor(names)} on for every project at user scope: claude plugin disable <name>@${OLDER_MARKETPLACE} --scope user switches each off everywhere, once no project needs it`;
}

export function classifyHome(home, installedProjects) {
  const stillOn = projectsStillOnOlderVersion(installedProjects);
  const leftovers = homeLeftovers(home, installedProjects.filter(hasKeptReason).length);
  const groups = homeGroups(home);
  const hasSomethingToRemove = groups.length > 0 || leftovers.some(needsAction);
  return {
    isReadyForCleanup: stillOn.length === 0,
    projectsStillOn: stillOn.length,
    projectsKeptOnPurpose: installedProjects.filter((project) => project.olderPluginsOn.length > 0).length - stillOn.length,
    userScopeOlderPluginsOn: olderPluginsOnAtUserScope(installedProjects),
    gatewayProjects: projectsWithTheGatewayOn(installedProjects),
    groups,
    leftovers,
    questions: stillOn.length === 0 && hasSomethingToRemove ? ["home-deletions"] : [],
  };
}
