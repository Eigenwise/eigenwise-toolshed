import { gatewayHookLines, gatewayHooksOf, isWiredToTheGateway, sortEnvironmentEntriesByWhoWroteThem } from "./gateway-wiring.mjs";
import {
  EARLIER_NAME,
  EARLIER_NAME_OF_THIS_VERSION,
  OLDER_ONLY_PLUGINS,
  TOOLSHED_MARKETPLACE,
  TOOLSHED_SOURCE,
  installWords,
  installWordsWithId,
  isEarlierNameCopyThatRuns,
  isNoCopyRunning,
  isOlderVersionOfThisVersionsPlugin,
  doubledCopiesIn,
  doubledWords,
  splitPluginId,
} from "./toolshed-installs.mjs";

export const GATEWAY_PLUGIN = "model-gateway";
export const MAPPER_PLUGIN = "codebase-mapper";
export const RULES_PLUGIN = "live-rules";

const KEEP = "keep";
const CONVERT = "convert";
const REMOVE = "remove";
const ASK = "ask";

export const USER_SCOPE = "(user)";

export const COMMITTED_SETTINGS = ".claude/settings.json";
export const LOCAL_SETTINGS = ".claude/settings.local.json";

const TELEMETRY_SWITCHES = ["CLAUDE_CODE_ENABLE_TELEMETRY", "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"];
const LOOPBACK_ADDRESS = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

// Names only the older version had: its board's MCP tools, its executor agents and the skills this version does not ship.
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

export function olderPluginKeys(settings) {
  return Object.entries(recordOf(settings.enabledPlugins))
    .map(([key, value]) => ({ ...splitPluginId(key), key, isOn: value === true }))
    .filter((plugin) => plugin.marketplace === TOOLSHED_MARKETPLACE && OLDER_ONLY_PLUGINS.includes(plugin.name));
}

const isOursMarketplace = (marketplace) => marketplace === TOOLSHED_MARKETPLACE || marketplace === EARLIER_NAME_OF_THIS_VERSION;

// A key for one of ours, true or false, means that plugin was on here at some point: switching off keeps the key.
export function pluginNamesInSettings(...settingsFiles) {
  const keys = settingsFiles.flatMap((settings) => Object.keys(recordOf(settings.enabledPlugins)));
  return [...new Set(keys.map(splitPluginId).filter((plugin) => isOursMarketplace(plugin.marketplace)).map((plugin) => plugin.name))];
}

const isOnIn = (settings, name) => recordOf(settings.enabledPlugins)[`${name}@${TOOLSHED_MARKETPLACE}`] === true;

const isNamedIn = (settings, key) => key in recordOf(settings.enabledPlugins);

export function olderPluginsOnOnlyAtUserScope(committed, local, user) {
  return olderPluginKeys(user)
    .filter((plugin) => plugin.isOn)
    .filter((plugin) => !isNamedIn(committed, plugin.key) && !isNamedIn(local, plugin.key))
    .map((plugin) => plugin.name);
}

// Only the plugins this version does not have: a key of a shared name is this version's own once it is updated.
// The local file wins over the committed one, and the committed one over the user settings, key by key, as the host reads them.
export function olderPluginsStillOn(committed, local, user = {}) {
  const names = new Set([...olderPluginKeys(committed), ...olderPluginKeys(local)].map((plugin) => plugin.name));
  const onInTheProjectFiles = [...names].filter((name) => {
    const localValue = recordOf(local.enabledPlugins)[`${name}@${TOOLSHED_MARKETPLACE}`];
    return localValue === undefined ? isOnIn(committed, name) : localValue === true;
  });
  return [...onInTheProjectFiles, ...olderPluginsOnOnlyAtUserScope(committed, local, user)];
}

const olderPluginsOnHere = (facts) => olderPluginsStillOn(facts.committed, facts.local, facts.user ?? {});

const SCOPE_OF_FILE = { [COMMITTED_SETTINGS]: "project", [LOCAL_SETTINGS]: "local" };

const scopeOfKey = (plugin) => (plugin.isUserScope ? "user" : SCOPE_OF_FILE[plugin.file] ?? "local");

const uninstallCommand = (plugin) => `claude plugin uninstall ${plugin.name}@${TOOLSHED_MARKETPLACE} --scope ${scopeOfKey(plugin)}`;

const wiredPlacesWords = (places) => places.join(", ");

const userScopeWhy = (plugin) => {
  const afterUnwiring = plugin.name === GATEWAY_PLUGIN ? ", once no project is wired to the gateway" : "";
  return `on for every project at user scope: ${uninstallCommand(plugin)} takes it out everywhere${afterUnwiring}. The home part names it; a project's run never writes the user settings file`;
};

const HOW_TO_CHECK_A_PROJECT = "a project is wired when its .claude/settings.local.json has ANTHROPIC_BASE_URL under env, or a hook there whose command runs model-gateway.js with readiness-gate";

const isGateway = (plugin) => plugin.name === GATEWAY_PLUGIN;

// The launcher the wiring runs finds the gateway's code through its install: uninstalled while a project is still wired, every prompt there is blocked.
// The scan sees only the projects the gateway's own list and the install record name, so "wired nowhere" needs that list read whole.
const PLUGIN_KEY_RULES = [
  { applies: (plugin) => plugin.isUserScope === true, verdict: KEEP, why: userScopeWhy },
  {
    applies: (plugin) => isGateway(plugin) && plugin.gateway.wiredPlaces.length > 0,
    verdict: ASK,
    followsHomeAnswer: true,
    why: (plugin) =>
      `the gateway is not in this version and must stay installed and switched on until it is unwired. Unwire every place wired to it first (its env --remove, from each project's folder; the lines in your user settings by hand), and only then ${uninstallCommand(plugin)}: uninstalled while a place is still wired, every prompt there is blocked. Still wired: ${wiredPlacesWords(plugin.gateway.wiredPlaces)}`,
  },
  {
    applies: (plugin) => isGateway(plugin) && !plugin.gateway.canSeeEveryPlace,
    verdict: ASK,
    followsHomeAnswer: true,
    why: (plugin) =>
      `the gateway is not in this version, and the scan cannot see every project wired to it: its own list (model-gateway/wired-projects.json) is missing or cannot be read. Nothing it can see is wired, but check each project that used the gateway (${HOW_TO_CHECK_A_PROJECT}) and unwire it first; only then ${uninstallCommand(plugin)}, on the person's word`,
  },
  {
    applies: isGateway,
    verdict: REMOVE,
    why: (plugin) =>
      `the gateway, wired nowhere the scan can see: ${uninstallCommand(plugin)} takes it out with this key. The scan sees only what the older gateway recorded and the projects the install record names, so a project it missed that is still wired would have every prompt blocked (${HOW_TO_CHECK_A_PROJECT}). To keep it on purpose, record --keep gateway instead (it can no longer be updated or installed again from this marketplace)`,
  },
  {
    applies: () => true,
    verdict: REMOVE,
    why: (plugin) => `not in this version, so it no longer loads: ${uninstallCommand(plugin)} takes it out with this key. It cannot be installed again from the marketplace`,
  },
];

function firstMatchingRule(rules, subject) {
  return rules.find((rule) => rule.applies(subject));
}

const GATEWAY_UNSEEN = { wiredPlaces: [], canSeeEveryPlace: false };

export function pluginKeyLeftovers(file, settings, gateway = GATEWAY_UNSEEN, isUserScope = false) {
  return olderPluginKeys(settings).map((plugin) => {
    const subject = { ...plugin, file, gateway, isUserScope };
    const rule = firstMatchingRule(PLUGIN_KEY_RULES, subject);
    const answerSubject = plugin.name === GATEWAY_PLUGIN ? { answerSubject: "gateway" } : {};
    return { kind: "older-plugin", file, where: `${file} enabledPlugins ${plugin.key}`, verdict: rule.verdict, why: rule.why(subject), followsHomeAnswer: rule.followsHomeAnswer === true, ...answerSubject };
  });
}

function userScopeLeftovers(facts) {
  const names = olderPluginsOnOnlyAtUserScope(facts.committed, facts.local, facts.user ?? {});
  const onlyThoseKeys = { enabledPlugins: Object.fromEntries(names.map((name) => [`${name}@${TOOLSHED_MARKETPLACE}`, true])) };
  return pluginKeyLeftovers(facts.userSettingsFile, onlyThoseKeys, GATEWAY_UNSEEN, true);
}

const GATEWAY_WIRING_WHY = "the gateway wrote these; follows the home question. Unwire with the gateway's own env --remove BEFORE the gateway is uninstalled";
const GATEWAY_LEFTOVER_WHY = "the gateway left these and nothing here routes to it any more, so they do not hold its uninstall; take them out of the file";
const KEPT_OWN_ENTRY_WHY = "set by you, not a value the gateway writes, so it stays and the gateway's own unwiring leaves it too";
const KEPT_OWN_PIN_WHY = `${KEPT_OWN_ENTRY_WHY}. If it names a model your provider does not have, change it yourself`;

const linesOf = (entries) => entries.map((entry) => entry.line);
const keysOf = (entries) => entries.map((entry) => entry.key).join(", ");

function ownEntryLeftovers(file, own) {
  const groups = [
    { entries: own.filter((entry) => entry.isPin), why: KEPT_OWN_PIN_WHY },
    { entries: own.filter((entry) => !entry.isPin), why: KEPT_OWN_ENTRY_WHY },
  ];
  return groups
    .filter((group) => group.entries.length > 0)
    .map((group) => ({ kind: "gateway-kept-entries", file, where: `${file} env ${keysOf(group.entries)}`, verdict: KEEP, why: group.why, readyLines: linesOf(group.entries) }));
}

function gatewayWiringLeftover(file, settings, gatewayWasOnThisMachine) {
  const { gateway, own } = sortEnvironmentEntriesByWhoWroteThem(settings, gatewayWasOnThisMachine);
  const isRouted = isWiredToTheGateway(settings);
  const leftover = isRouted
    ? { verdict: ASK, why: GATEWAY_WIRING_WHY, followsHomeAnswer: true }
    : { verdict: REMOVE, why: GATEWAY_LEFTOVER_WHY };
  const wiring = gateway.length === 0 ? [] : [{ kind: "gateway-wiring", file, where: `${file} env ${keysOf(gateway)}`, ...leftover }];
  return [...wiring, ...ownEntryLeftovers(file, own)];
}

const USERS_OWN_FILE_WHY = "yours to change: the scan never edits your user settings file. Copy it, then delete these lines";
const USERS_ROUTED_FILE_WHY = `${USERS_OWN_FILE_WHY}; the gateway's uninstall waits until they are gone`;

// The home settings file is never written by a scan, so what the gateway left there is shown with its exact lines and left to the person.
function userSettingsGatewayLeftovers(facts) {
  const settings = facts.user ?? {};
  const file = facts.userSettingsFile;
  const { gateway, own } = sortEnvironmentEntriesByWhoWroteThem(settings, facts.gatewayWasOnThisMachine === true);
  const lines = [...linesOf(gateway), ...gatewayHookLines(settings)];
  const why = isWiredToTheGateway(settings) ? USERS_ROUTED_FILE_WHY : USERS_OWN_FILE_WHY;
  const wiring = lines.length === 0 ? [] : [{ kind: "gateway-wiring-user", file, where: `${file} (user settings)`, verdict: KEEP, why, readyLines: lines }];
  return [...wiring, ...ownEntryLeftovers(file, own)];
}

function telemetryLeftover(file, environment) {
  const endpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined) return [];
  const keys = Object.keys(environment).filter((key) => key.startsWith("OTEL_") || TELEMETRY_SWITCHES.includes(key));
  const where = `${file} env ${keys.join(", ")}`;
  if (!LOOPBACK_ADDRESS.test(String(endpoint))) {
    return [{ kind: "telemetry-export", file, where, verdict: KEEP, why: `not the older Toolshed's: it points at ${endpoint}, so it stays` }];
  }
  const why = `this version's telemetry does not use them; copy the file first. Ask instead when something listens on ${endpoint}`;
  return [{ kind: "telemetry-export", file, where, verdict: REMOVE, why }];
}

const SINGLE_KEY_ENVIRONMENT_RULES = [
  { key: "SIDEQUEST_COMPACTION_POLICY", kind: "older-board-setting", verdict: REMOVE, why: "only the older board read it" },
  { key: "PYTHONIOENCODING", kind: "python-encoding", verdict: KEEP, why: "harmless and still useful to Python on Windows" },
];

export function environmentLeftovers(file, settings, gatewayWasOnThisMachine = false) {
  const environment = recordOf(settings.env);
  const single = SINGLE_KEY_ENVIRONMENT_RULES.filter((rule) => rule.key in environment).map((rule) => ({
    kind: rule.kind,
    file,
    where: `${file} env ${rule.key}`,
    verdict: rule.verdict,
    why: rule.why,
  }));
  return [...gatewayWiringLeftover(file, settings, gatewayWasOnThisMachine), ...telemetryLeftover(file, environment), ...single];
}

function gatewayHookLeftover(file, settings) {
  const count = gatewayHooksOf(settings).length;
  if (count === 0) return [];
  const why = "the gateway's readiness hooks; its env --remove takes them out, uninstalling the plugin does not";
  return [{ kind: "gateway-hooks", file, where: `${file} hooks (${count})`, verdict: ASK, why, followsHomeAnswer: true, readyLines: gatewayHookLines(settings) }];
}

function permissionLeftover(file, settings) {
  const allowed = recordOf(settings.permissions).allow;
  const older = (Array.isArray(allowed) ? allowed : []).filter((entry) => olderNamesIn(String(entry)).length > 0);
  if (older.length === 0) return [];
  return [{ kind: "older-permissions", file, where: `${file} permissions.allow: ${older.join(", ")}`, verdict: REMOVE, why: "they allow tools that no longer exist" }];
}

function autoApproveLeftover(file, settings) {
  if (!("autoApprovePermissions" in recordOf(settings.quartermaster))) return [];
  return [{ kind: "auto-approve-switch", file, where: `${file} quartermaster.autoApprovePermissions`, verdict: REMOVE, why: "this version does not read it" }];
}

const earlierNameKeys = (settings) =>
  Object.entries(recordOf(settings.enabledPlugins))
    .map(([key, value]) => ({ ...splitPluginId(key), key, value }))
    .filter((plugin) => plugin.marketplace === EARLIER_NAME_OF_THIS_VERSION);

function earlierNameKeyLeftovers(file, settings) {
  return earlierNameKeys(settings).map((plugin) => ({
    kind: "earlier-name-key",
    file,
    where: `${file} enabledPlugins ${plugin.key}`,
    verdict: CONVERT,
    why: `this version under its earlier name: becomes "${plugin.name}@${TOOLSHED_MARKETPLACE}": ${JSON.stringify(plugin.value)} in this file, replacing any key of that name, shown as a diff first. The move's uninstall and install at this file's scope write it; a key with no install behind it is rewritten by hand`,
    isPartOfTheMove: true,
  }));
}

function earlierNameMarketplaceLeftover(file, settings) {
  if (!(EARLIER_NAME_OF_THIS_VERSION in recordOf(settings.extraKnownMarketplaces))) return [];
  const entry = JSON.stringify({ source: { source: "github", repo: TOOLSHED_SOURCE } });
  const why = `declares this version under its earlier name: becomes "${TOOLSHED_MARKETPLACE}": ${entry}, with no ref, shown as a diff first. Where a ${TOOLSHED_MARKETPLACE} entry is there already, this one only goes`;
  return [{ kind: "earlier-name-marketplace", file, where: `${file} extraKnownMarketplaces ${EARLIER_NAME_OF_THIS_VERSION}`, verdict: CONVERT, why, isPartOfTheMove: true }];
}

export function settingsLeftovers(file, settings, gateway = GATEWAY_UNSEEN) {
  return [
    ...pluginKeyLeftovers(file, settings, gateway),
    ...earlierNameKeyLeftovers(file, settings),
    ...earlierNameMarketplaceLeftover(file, settings),
    ...environmentLeftovers(file, settings, gateway.wasOnThisMachine === true),
    ...gatewayHookLeftover(file, settings),
    ...permissionLeftover(file, settings),
    ...autoApproveLeftover(file, settings),
  ];
}

const TRACKED_SETTINGS_WHY = {
  [COMMITTED_SETTINGS]:
    "the committed file is tracked by git: what changes for this person goes into local settings now, and this goes into the committed change only when they say so",
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

const UNINSTALL_WRITES_INTO_TRACKED_FILE_WHY =
  "git tracks this file and the uninstall at local scope writes into it (there is no other personal place for it here): it shows as a change in git status and nothing is committed";

function trackedLocalSettingsNote(facts) {
  if (!facts.isLocalSettingsTracked || olderPluginsOnHere(facts).length === 0) return [];
  return [{ kind: "tracked-local-settings", file: LOCAL_SETTINGS, where: LOCAL_SETTINGS, verdict: KEEP, why: UNINSTALL_WRITES_INTO_TRACKED_FILE_WHY }];
}

const OLDER_INSTALL_WHY =
  "the older version of a plugin this version has: update it first with the commands under Update first, then reload plugins and scan again. Nothing in this project moves before that";

const EARLIER_NAME_INSTALL_WHY = (entry) =>
  `this version under its earlier name: the move, on one yes, reinstalls it as ${entry.name}@${TOOLSHED_MARKETPLACE} at the same scope, with its commands in order under The earlier name`;

const DOUBLED_EARLIER_NAME_INSTALL_WHY = (entry) =>
  `this version under its earlier name, and ${entry.name}@${TOOLSHED_MARKETPLACE} is installed too: the move, on one yes, only uninstalls this copy`;

// The files in the order the host reads them for a key: local, then committed, then user.
const doubledCopiesOf = (facts) => doubledCopiesIn(facts.installs ?? [], [facts.local, facts.committed, facts.user ?? {}]);

function installLeftovers(facts) {
  const installs = facts.installs ?? [];
  const doubledNames = doubledCopiesOf(facts).map((doubled) => doubled.name);
  const older = installs.filter(isOlderVersionOfThisVersionsPlugin).map((entry) => ({ kind: "older-install", where: installWordsWithId(entry), verdict: CONVERT, why: OLDER_INSTALL_WHY }));
  const earlier = installs
    .filter((entry) => entry.state === EARLIER_NAME)
    .map((entry) => ({
      kind: "earlier-name-install",
      where: installWordsWithId(entry),
      verdict: ASK,
      why: doubledNames.includes(entry.name) ? DOUBLED_EARLIER_NAME_INSTALL_WHY(entry) : EARLIER_NAME_INSTALL_WHY(entry),
      isPartOfTheMove: true,
    }));
  return [...older, ...earlier];
}

const reviewRefsCount = (facts) =>
  `${facts.reviewRefs.total} refs under ${OLDER_REVIEW_REF_NAMESPACES.join(", ")}: ${facts.reviewRefs.merged} merged into the checked-out branch`;

// Converting the old map means checking every claim in it against the code, so the work grows with its lines of text.
// A map this long took three read-only agents of about 95 thousand tokens each in one real run; up to this many lines
// one agent reads it in a pass. The figure is chosen, not measured.
export const LARGE_OLD_MAP_LINES = 400;

const TRACKED_OLDER_MAP_WHY =
  "git tracks it, so it is the repository's map: it moves for everyone with the committed change (converted to .claude/rules/ and this folder removed, in one commit), never as one person's copy, and no deletion in this run touches it. Nothing has loaded it since the update";

const BUILDS_NEW_MAP_FROM_IT = "; codebase-mapper:map builds the new map from it";

const TWO_MAPS_WHY =
  "; a map of this version is here beside it, so this checkout has two maps that drift apart until the committed change takes the new one into the repository and removes this one";

const lengthNote = (facts) =>
  facts.paths.olderMapLines > LARGE_OLD_MAP_LINES ? `; ${facts.paths.olderMapLines} lines, so converting it is the long part of that change` : "";

const trackedOlderMapWhy = (facts) =>
  facts.paths.currentMap
    ? `${TRACKED_OLDER_MAP_WHY}${lengthNote(facts)}${TWO_MAPS_WHY}`
    : `${TRACKED_OLDER_MAP_WHY}${BUILDS_NEW_MAP_FROM_IT}${lengthNote(facts)}`;

const TRACKED_OLDER_RULES_WHY =
  "git tracks it, so these are the repository's rules: they move for everyone with the committed change (converted to .claude/rules/ and .claude/skills/ and the old ones removed, in one commit), never as one person's copy, and no deletion in this run touches it";

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
    afterConversion: "the new map already exists; nothing loads the old folder since the update",
  },
  {
    kind: "quality-gate-records",
    where: ".claude/quality-gate/receipts/ or crap.json",
    fact: "qualityGateRecords",
    isConverted: () => true,
    afterConversion: "this version keeps no receipts",
  },
];

const TRACKED_WHY =
  "git tracks it, so it is committed work: it stays as it is until the committed change, and no deletion in this run touches it";

const NEVER_ON_WHY = (plugin) =>
  `${plugin} was never on in this project, older or this version, so nothing reads it and there is nothing to convert; it stays as it is`;

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
    why: () => "add the line .sidequest/ so the board stays personal",
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
      `edit the notes that name an older tool with an equivalent in this version (copy each file first, show the edit as a diff), then record what is left as kept with your reason: ${MEMORY_NOTES_KEEP_COMMAND}`,
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
    const why = isCommittedChange ? "tracked by git: the edit goes into the committed change" : "show the edit as a diff: older tool to its tool in this version, drop the rest";
    return { kind: "instruction-text", where: `${file.path} names ${file.names.join(", ")}`, verdict: isCommittedChange ? ASK : CONVERT, why, isCommittedChange };
  });
}

const sumOf = (counts) => Object.values(counts).reduce((total, count) => total + count, 0);

function openTicketLeftover(board) {
  const openCount = sumOf(board.openByStatus ?? {});
  if (openCount === 0) return [];
  const statuses = Object.entries(board.openByStatus).map(([status, count]) => `${count} ${status}`).join(", ");
  const why =
    "they stay in the old board, a read-only archive until the home cleanup (the recommended answer); the person may name some to redraft as tickets on this board. Doing rows are stale claims, never resume them. upgrade-scan.mjs --open-tickets lists them, one per line";
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
  const why = "models from other providers have no place in this version yet: such a tier falls back to a Claude model with a named reason. The routes are under Old routes";
  return [{ kind: "other-provider-routes", where: elsewhere.map((route) => route.category).join(", "), verdict: KEEP, why }];
}

// The older categories that have a row in references/routing.md: this version's default categories already route them.
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

// A category counts as written only when the project's board file has one of that name.
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

const isEarlierNameLeftover = (leftover) => leftover.isPartOfTheMove === true;

const isOlderInstallLeftover = (leftover) => leftover.kind === "older-install";

// What the committed change decides and what the gateway answer settles do not hold up a person's own move.
export const isThisPersonsWork = (leftover) => needsAction(leftover) && leftover.isCommittedChange !== true && leftover.followsHomeAnswer !== true;

export function shapeOf(facts, leftovers) {
  if (leftovers.some(isOlderInstallLeftover)) return "update-first";
  if (!leftovers.some(isThisPersonsWork)) return "moved";
  if (leftovers.some(isEarlierNameLeftover)) return "half-moved";
  return facts.isTeam ? "team" : "solo";
}

// Converting some things leaves an old folder or a branch behind, and that removal waits for the same one yes.
export const isOnDeletionList = (leftover) => leftover.verdict === REMOVE || (needsAction(leftover) && leftover.endsInADeletion === true);

const isOpenTicketsUnanswered = (leftover) => leftover.kind === "open-tickets" && leftover.keptOnAnswer === undefined;

const isTheMoveStillToDo = (leftover) => isEarlierNameLeftover(leftover) && isThisPersonsWork(leftover);

const QUESTION_RULES = [
  { id: "open-tickets", applies: (leftovers) => leftovers.some(isOpenTicketsUnanswered) },
  { id: "deletions", applies: (leftovers) => leftovers.some(isOnDeletionList) },
  { id: "the-move", applies: (leftovers) => leftovers.some(isTheMoveStillToDo) },
  { id: "committed-change", applies: (leftovers) => leftovers.some((leftover) => leftover.isCommittedChange === true) },
];

const SHAPES_WITH_NO_QUESTIONS = ["moved", "update-first"];

export function questionsFor(shape, leftovers) {
  if (SHAPES_WITH_NO_QUESTIONS.includes(shape)) return [];
  return QUESTION_RULES.filter((rule) => rule.applies(leftovers)).map((rule) => rule.id);
}

// What the person can settle by keeping it, so a later scan lists it as kept instead of asking again.
export const KEPT_ON_ANSWER_SUBJECTS = ["gateway", "memory-notes", "open-tickets"];

const answerSubjectOf = (leftover) => leftover.answerSubject ?? (leftover.followsHomeAnswer === true ? "gateway" : leftover.kind);

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

const THIS_PROJECT = "this project";

export const gatewayWiredPlaces = (facts) => [
  ...([facts.committed, facts.local].some(isWiredToTheGateway) ? [THIS_PROJECT] : []),
  ...(facts.gatewayWiredElsewhere ?? []),
];

const gatewayViewOf = (facts) => ({
  wiredPlaces: gatewayWiredPlaces(facts),
  canSeeEveryPlace: facts.gatewayWiringList === "read",
  wasOnThisMachine: facts.gatewayWasOnThisMachine === true,
});

export function projectLeftovers(facts) {
  const gateway = gatewayViewOf(facts);
  const fromSettings = [
    ...settingsLeftovers(COMMITTED_SETTINGS, facts.committed, gateway),
    ...settingsLeftovers(LOCAL_SETTINGS, facts.local, gateway),
    ...userScopeLeftovers(facts),
    ...userSettingsGatewayLeftovers(facts),
  ].map((leftover) => handCommittedFileToCommittedChange(leftover, trackedSettingsFiles(facts)));
  const all = [
    ...installLeftovers(facts),
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

const waitsForAYes = (leftover) => leftover.isOnDeletionList || isEarlierNameLeftover(leftover);

// What is left to do all sits behind a yes: the deletion list or the move.
export function isEverythingLeftWaitingForThePerson(leftovers) {
  const stillToDo = leftovers.filter((leftover) => leftover.isStillToDo);
  return stillToDo.length > 0 && stillToDo.every(waitsForAYes);
}

function runsUnderEarlierName(facts) {
  const earlierNameCopies = (facts.installs ?? []).filter((entry) => entry.state === EARLIER_NAME);
  const doubledList = doubledCopiesOf(facts);
  return earlierNameCopies.length === 0 || earlierNameCopies.some((entry) => isEarlierNameCopyThatRuns(entry, doubledList));
}

export function classifyProject(facts) {
  const leftovers = projectLeftovers(facts);
  const installs = facts.installs ?? [];
  const shape = shapeOf(facts, leftovers);
  return {
    isWaitingForThePerson: shape !== "update-first" && isEverythingLeftWaitingForThePerson(leftovers),
    path: facts.path,
    shape,
    isTeam: facts.isTeam,
    authorCount: facts.authorCount,
    isSettingsCommitted: facts.isSettingsCommitted,
    olderPluginsOn: olderPluginsOnHere(facts),
    olderInstalls: installs.filter(isOlderVersionOfThisVersionsPlugin).map(installWords),
    installedUnderBothNames: doubledCopiesOf(facts).map(doubledWords),
    runsUnderEarlierName: runsUnderEarlierName(facts),
    isNoCopyRunning: isNoCopyRunning(doubledCopiesOf(facts)),
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
    loses: "history only. Nothing in this version reads it",
  },
  {
    id: "other-plugins",
    name: "the other older plugins' state: map and rules hook state, Quartermaster records, caches, gateway breadcrumbs, generated agents",
    loses: "nothing this version reads. Not quartermaster/events or toolshed/ itself, which are this version's, and never the data folder of a plugin this version has",
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

const OTHER_PLUGIN_FOLDERS = [`${MAPPER_PLUGIN}-state`, `${RULES_PLUGIN}-state`, "quartermaster-state", TOOLSHED_MARKETPLACE, "toolshed/registry", "codex-gateway"];

function entriesByGroup(home) {
  const byGroup = Object.fromEntries(HOME_GROUP_IDS.map((id) => [id, []]));
  for (const name of home.olderBoardEntries) byGroup[olderBoardGroupOf(name)].push(`${OLDER_BOARD_FOLDER}/${name}`);
  const otherFolders = OTHER_PLUGIN_FOLDERS.filter((path) => home.existingPaths.includes(path));
  byGroup["other-plugins"].push(...otherFolders, ...home.olderAgentFiles, ...home.olderPluginData);
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

// This version installs under the same marketplace name, so its cache folder is this version's own.
const HOME_FOLDER_RULES = [
  {
    path: "model-gateway",
    verdict: ASK,
    why: "the gateway: kept for non-Claude models in the main session (it can no longer be updated or installed again from this marketplace), or, once no project is wired to it, stopped with its own stop and removed",
  },
  { path: `plugins/cache/${TOOLSHED_MARKETPLACE}`, verdict: KEEP, why: "this version's own plugin cache under the same marketplace name: the host manages it and nothing here removes it" },
];

export function homeFolderLeftovers(existingPaths) {
  return HOME_FOLDER_RULES.filter((rule) => existingPaths.includes(rule.path)).map((rule) => ({
    kind: "home-folder",
    where: rule.path,
    verdict: rule.verdict,
    why: rule.why,
  }));
}

export function homeLeftovers(home) {
  return [...homeFolderLeftovers(home.existingPaths), ...telemetryLeftover("settings.json", recordOf(home.userSettings.env))];
}

const isKeptOnPurpose = (project) => (name) => name === GATEWAY_PLUGIN && project.isGatewayKept === true;

const hasOlderInstalls = (project) => (project.olderInstalls ?? []).length > 0;

// The person answered "keep" for the gateway there and nothing else of the older version is on or installed: nothing is left to wait for.
const isOnlyKeptOnPurpose = (project) => !hasOlderInstalls(project) && project.olderPluginsOn.every(isKeptOnPurpose(project));

// An older version still installed reads the older state, so it holds the cleanup as much as a plugin switched on does.
export function projectsStillOnOlderVersion(installedProjects) {
  return installedProjects.filter((project) => (project.olderPluginsOn.length > 0 || hasOlderInstalls(project)) && !isOnlyKeptOnPurpose(project));
}

const projectsWithTheGatewayOn = (installedProjects) =>
  installedProjects.filter((project) => project.olderPluginsOn.includes(GATEWAY_PLUGIN) && project.isGatewayKept !== true).map((project) => project.path);

const verbFor = (names) => (names.length === 1 ? "is" : "are");

export const olderPluginsOnAtUserScope = (installedProjects) => installedProjects.find((project) => project.path === USER_SCOPE)?.olderPluginsOn ?? [];

// Only the person's own command reaches the user settings file: no project's run and no step of the upgrade writes it.
export function userScopeWaitLine(names) {
  if (names.length === 0) return "";
  return `${names.join(", ")} ${verbFor(names)} on for every project at user scope: claude plugin uninstall <name>@${TOOLSHED_MARKETPLACE} --scope user takes each out everywhere, the gateway only once no project is wired to it`;
}

export function classifyHome(home, installedProjects) {
  const stillOn = projectsStillOnOlderVersion(installedProjects);
  const leftovers = homeLeftovers(home);
  const groups = homeGroups(home);
  const hasSomethingToRemove = groups.length > 0 || leftovers.some(needsAction);
  return {
    isReadyForCleanup: stillOn.length === 0,
    projectsStillOn: stillOn.length,
    projectsKeptOnPurpose: installedProjects.filter((project) => project.olderPluginsOn.length > 0 && isOnlyKeptOnPurpose(project)).length,
    userScopeOlderPluginsOn: olderPluginsOnAtUserScope(installedProjects),
    gatewayProjects: projectsWithTheGatewayOn(installedProjects),
    groups,
    leftovers,
    questions: stillOn.length === 0 && hasSomethingToRemove ? ["home-deletions"] : [],
  };
}
