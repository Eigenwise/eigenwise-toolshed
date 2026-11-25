const present = (value) => (typeof value === "string" && value !== "" ? value : undefined);

const withoutTrailingSlash = (folder) => folder.replace(/[\\/]+$/, "");

export function homeDirectoryOf(environment, fallbackHome) {
  return present(environment.USERPROFILE) ?? present(environment.HOME) ?? present(fallbackHome);
}

export function configDirectoryOf(environment, fallbackHome) {
  const configured = present(environment.CLAUDE_CONFIG_DIR);
  if (configured !== undefined) return withoutTrailingSlash(configured);
  const home = homeDirectoryOf(environment, fallbackHome);
  return home === undefined ? undefined : `${withoutTrailingSlash(home)}/.claude`;
}
