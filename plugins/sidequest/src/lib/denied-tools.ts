// Dependency-free: the guard-denied-tools hook bundles it, and board config and category
// validation share it so a pattern the board accepts is the pattern the hook matches.
const BOARD_TOOL_PREFIX = 'mcp__plugin_sidequest_board';

function deniedToolPattern(entry: unknown, label: string): string {
  const pattern = String(entry ?? '').trim();
  if (!/^[A-Za-z][\w.:-]*$/.test(pattern)) throw new Error(`${label} entries must be tool names or MCP prefixes: ${String(entry)}`);
  if (pattern.startsWith(BOARD_TOOL_PREFIX)) throw new Error(`${label} cannot deny the Sidequest board tools executors need to claim and close: ${pattern}`);
  return pattern;
}

export function normalizeDeniedTools(value: unknown, label = 'deniedTools'): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of tool names.`);
  return [...new Set(value.map((entry) => deniedToolPattern(entry, label)))];
}

// A bare MCP server prefix such as mcp__claude-in-chrome denies every tool on that server, the same
// way the executor frontmatter's disallowedTools reads it.
function toolDeniedBy(toolName: string, pattern: string): boolean {
  return toolName === pattern || toolName.startsWith(`${pattern}__`);
}

export function deniedToolMatch(toolName: string, patterns: readonly string[]): string | null {
  return patterns.find((pattern) => toolDeniedBy(toolName, pattern)) ?? null;
}
