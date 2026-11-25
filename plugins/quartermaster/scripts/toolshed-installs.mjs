// Both versions share one marketplace name, so the install record's version is what tells them apart.
export const TOOLSHED_MARKETPLACE = "eigenwise-toolshed";
export const EARLIER_NAME_OF_THIS_VERSION = "toolshed-next";
export const TOOLSHED_SOURCE = "Eigenwise/eigenwise-toolshed";

export const FIRST_MAJOR_OF_THIS_VERSION = { sidequest: 7, quartermaster: 2, "codebase-mapper": 3, "live-rules": 3, observability: 2 };
export const PLUGINS_OF_THIS_VERSION = Object.keys(FIRST_MAJOR_OF_THIS_VERSION);
export const OLDER_ONLY_PLUGINS = ["quality-gate", "model-gateway"];

export const OLDER = "older";
export const THIS_VERSION = "this-version";
export const EARLIER_NAME = "earlier-name";

export function splitPluginId(id) {
  const at = id.lastIndexOf("@");
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

const majorOf = (version) => Number(/^(\d+)\./.exec(String(version ?? ""))?.[1]);

// A version that does not read as a number is not taken for this version: the worst that follows is an update offered for nothing.
const isAtLeastFirstMajor = (name, version) => majorOf(version) >= FIRST_MAJOR_OF_THIS_VERSION[name];

function stateUnderToolshedName(name, version) {
  if (OLDER_ONLY_PLUGINS.includes(name)) return OLDER;
  if (!PLUGINS_OF_THIS_VERSION.includes(name)) return undefined;
  return isAtLeastFirstMajor(name, version) ? THIS_VERSION : OLDER;
}

export function installStateOf(id, version) {
  const { name, marketplace } = splitPluginId(id);
  if (marketplace === TOOLSHED_MARKETPLACE) return stateUnderToolshedName(name, version);
  if (marketplace === EARLIER_NAME_OF_THIS_VERSION && PLUGINS_OF_THIS_VERSION.includes(name)) return EARLIER_NAME;
  return undefined;
}

const recordOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

function entryOf(id) {
  return (entry) => {
    const fields = recordOf(entry);
    return {
      id,
      ...splitPluginId(id),
      scope: fields.scope,
      projectPath: fields.projectPath,
      installPath: fields.installPath,
      version: fields.version,
      state: installStateOf(id, fields.version),
    };
  };
}

export function toolshedInstallsOf(record) {
  return Object.entries(recordOf(recordOf(record).plugins))
    .filter(([, entries]) => Array.isArray(entries))
    .flatMap(([id, entries]) => entries.map(entryOf(id)))
    .filter((entry) => entry.state !== undefined);
}

export const isOlderVersionOfThisVersionsPlugin = (entry) => entry.state === OLDER && PLUGINS_OF_THIS_VERSION.includes(entry.name);

const hasItsOwnFolder = (entry) => entry.scope !== "user" && Boolean(entry.projectPath);

const fromItsFolder = (entry) => (hasItsOwnFolder(entry) ? `  (from ${entry.projectPath})` : "");

const versionAndScopeWords = (entry) => `${entry.version ?? "with no version"} at ${entry.scope} scope${fromItsFolder(entry)}`;

export const installWords = (entry) => `${entry.name} ${versionAndScopeWords(entry)}`;

export const installWordsWithId = (entry) => `${entry.id} ${versionAndScopeWords(entry)}`;

const sameCommand = (first, second) => first.name === second.name && first.scope === second.scope && first.projectPath === second.projectPath;

const withoutRepeats = (entries) => entries.filter((entry, index) => entries.findIndex((other) => sameCommand(entry, other)) === index);

// Where a command runs goes on a line of its own, so every command line can be pasted into a shell as it is.
const inItsFolder = (entry, command) => (hasItsOwnFolder(entry) ? [`from ${entry.projectPath}:`, `  ${command}`] : [command]);

export function updateCommands(olderEntries) {
  return [
    `claude plugin marketplace update ${TOOLSHED_MARKETPLACE}`,
    ...withoutRepeats(olderEntries).flatMap((entry) => inItsFolder(entry, `claude plugin update ${entry.name}@${TOOLSHED_MARKETPLACE} --scope ${entry.scope}`)),
  ];
}

// Adding the marketplace while the earlier name is still registered answers "already on disk", and every install after it fails.
export function moveCommands(earlierNameEntries, isToolshedMarketplaceKnown) {
  const entries = withoutRepeats(earlierNameEntries);
  const register = isToolshedMarketplaceKnown ? `claude plugin marketplace update ${TOOLSHED_MARKETPLACE}` : `claude plugin marketplace add ${TOOLSHED_SOURCE}`;
  return [
    ...entries.flatMap((entry) => inItsFolder(entry, `claude plugin uninstall ${entry.name}@${EARLIER_NAME_OF_THIS_VERSION} --scope ${entry.scope}`)),
    "from the config folder, never inside a repository:",
    `  claude plugin marketplace remove ${EARLIER_NAME_OF_THIS_VERSION}`,
    register,
    ...entries.flatMap((entry) => inItsFolder(entry, `claude plugin install ${entry.name}@${TOOLSHED_MARKETPLACE} --scope ${entry.scope}`)),
  ];
}
