const LOOPBACK_ADDRESS = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const COMPATIBILITY_ADDRESS = /^http:\/\/api\.anthropic\.com(:80)?(\/|$)/i;
const GATEWAY_LAUNCHER = /model-gateway\.js/;
const READINESS_COMMAND = /readiness-gate/;

const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
const DISCOVERY_KEY = "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY";
const CUSTOM_OPTION_KEY = "ANTHROPIC_CUSTOM_MODEL_OPTION";
const CUSTOM_OPTION_NAME_KEY = "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME";
const CUSTOM_OPTION_DESCRIPTION_KEY = "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION";

// Common settings on their own, so only the exact value the gateway wrote counts as its.
const VALUES_THE_GATEWAY_WRITES = {
  [DISCOVERY_KEY]: "1",
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  ENABLE_TOOL_SEARCH: "true",
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "950000",
};

// The oldest pin the gateway ever shipped for each family; it writes that one or a newer one.
const OLDEST_SHIPPED_PIN_VERSION = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: { family: "opus", major: 4, minor: 8 },
  ANTHROPIC_DEFAULT_SONNET_MODEL: { family: "sonnet", major: 5, minor: 0 },
  ANTHROPIC_DEFAULT_FABLE_MODEL: { family: "fable", major: 5, minor: 1 },
};

const OTHER_PROVIDER_MODEL = /^claude-(codex|grok|gpt)-/i;
const GATEWAY_OPTION_DESCRIPTION = /, through the gateway$/;
const PINNED_CLAUDE_MODEL = /^claude-([a-z0-9]+)-(\d+)(?:-(\d{1,2}))?(?:-[a-z0-9._-]+)?\[1m\]$/i;

const recordOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

export const isGatewayAddress = (environment) => {
  const address = String(environment[BASE_URL_KEY] ?? "");
  return LOOPBACK_ADDRESS.test(address) || COMPATIBILITY_ADDRESS.test(address);
};

const isAtOrAbove = (found, oldest) => found.major > oldest.major || (found.major === oldest.major && found.minor >= oldest.minor);

function isPinAtOrAboveTheOldestShipped(model, oldest) {
  const parts = PINNED_CLAUDE_MODEL.exec(model);
  if (parts === null || parts[1].toLowerCase() !== oldest.family) return false;
  return isAtOrAbove({ major: Number(parts[2]), minor: Number(parts[3] ?? 0) }, oldest);
}

const isPinTheGatewayWrites = (key, value) => OTHER_PROVIDER_MODEL.test(String(value)) || isPinAtOrAboveTheOldestShipped(String(value), OLDEST_SHIPPED_PIN_VERSION[key]);

const isCustomOptionTheGatewayWrites = (environment) =>
  isPinTheGatewayWrites("ANTHROPIC_DEFAULT_FABLE_MODEL", environment[CUSTOM_OPTION_KEY] ?? "") || GATEWAY_OPTION_DESCRIPTION.test(String(environment[CUSTOM_OPTION_DESCRIPTION_KEY] ?? ""));

const isEntryTheGatewayWrites = (environment, key) => {
  const value = environment[key];
  if (key === BASE_URL_KEY) return isGatewayAddress(environment);
  if (key in OLDEST_SHIPPED_PIN_VERSION) return isPinTheGatewayWrites(key, value);
  if (key in VALUES_THE_GATEWAY_WRITES) return String(value) === VALUES_THE_GATEWAY_WRITES[key];
  return isCustomOptionTheGatewayWrites(environment);
};

const GATEWAY_ENVIRONMENT_KEYS = [
  BASE_URL_KEY,
  ...Object.keys(VALUES_THE_GATEWAY_WRITES),
  ...Object.keys(OLDEST_SHIPPED_PIN_VERSION),
  CUSTOM_OPTION_KEY,
  CUSTOM_OPTION_NAME_KEY,
  CUSTOM_OPTION_DESCRIPTION_KEY,
];

// Without the address, only these say the gateway was here; ENABLE_TOOL_SEARCH and its like are the person's own on their own.
const KEYS_THAT_SAY_THE_GATEWAY_WAS_HERE = [BASE_URL_KEY, DISCOVERY_KEY, ...Object.keys(OLDEST_SHIPPED_PIN_VERSION), CUSTOM_OPTION_KEY, CUSTOM_OPTION_DESCRIPTION_KEY];

const isReadinessHook = (command) => GATEWAY_LAUNCHER.test(command) && READINESS_COMMAND.test(command);

export function gatewayHooksOf(settings) {
  return Object.entries(recordOf(settings.hooks))
    .flatMap(([event, groups]) => (Array.isArray(groups) ? groups.map((group) => ({ event, group })) : []))
    .flatMap(({ event, group }) => (Array.isArray(group?.hooks) ? group.hooks.map((hook) => ({ event, command: String(hook?.command ?? "") })) : []))
    .filter(({ command }) => isReadinessHook(command));
}

const presentKeys = (environment, keys) => keys.filter((key) => key in environment);

// What still runs or routes: the address sends requests to the gateway, the readiness hooks run its launcher. Only these hold its uninstall.
export const isWiredToTheGateway = (settings) => isGatewayAddress(recordOf(settings.env)) || gatewayHooksOf(settings).length > 0;

const GATEWAY_PLUGIN_KEY = /^model-gateway@/;

const hasGatewayPluginKey = (settings) => Object.keys(recordOf(settings.enabledPlugins)).some((key) => GATEWAY_PLUGIN_KEY.test(key));

/** Whether a settings file shows by itself that the gateway was on this machine: it is wired, or it names the gateway plugin. */
export const showsTheGateway = (settings) => isWiredToTheGateway(settings) || hasGatewayPluginKey(settings);

// A current model pin or the discovery switch is also what a person sets themselves. With no address and no hooks
// in the file they are the gateway's only on a machine that shows the gateway some other way.
export function hasGatewayLeftovers(settings, gatewayWasOnThisMachine = false) {
  const environment = recordOf(settings.env);
  const keysThatSayIt = presentKeys(environment, KEYS_THAT_SAY_THE_GATEWAY_WAS_HERE);
  const leftSomething = keysThatSayIt.some((key) => isEntryTheGatewayWrites(environment, key));
  return isWiredToTheGateway(settings) || (gatewayWasOnThisMachine && leftSomething);
}

const exactLine = (key, value) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`;

// With no sign the gateway was here, the common keys are the person's own, so both lists come back empty.
export function sortEnvironmentEntriesByWhoWroteThem(settings, gatewayWasOnThisMachine = false) {
  const environment = recordOf(settings.env);
  if (!hasGatewayLeftovers(settings, gatewayWasOnThisMachine)) return { gateway: [], own: [] };
  const present = presentKeys(environment, GATEWAY_ENVIRONMENT_KEYS);
  const entry = (key) => ({ key, line: exactLine(key, environment[key]), isPin: key in OLDEST_SHIPPED_PIN_VERSION });
  return {
    gateway: present.filter((key) => isEntryTheGatewayWrites(environment, key)).map(entry),
    own: present.filter((key) => !isEntryTheGatewayWrites(environment, key)).map(entry),
  };
}

export const gatewayHookLines = (settings) => gatewayHooksOf(settings).map(({ event, command }) => `hooks ${event}: ${command}`);
