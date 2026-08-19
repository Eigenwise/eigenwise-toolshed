export function normalizeScope(scope: unknown): string {
  return String(scope || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/\*\*$/, '')
    .replace(/\/+$/, '');
}

export function scopeKey(scope: unknown): string {
  const normalized = normalizeScope(scope);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function scopedPaths(files: unknown): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const file of Array.isArray(files) ? files : []) {
    const scope = normalizeScope(file);
    const key = scopeKey(scope);
    if (scope && !seen.has(key)) {
      seen.add(key);
      paths.push(scope);
    }
  }
  return paths;
}

export function isInScope(file: unknown, files: unknown): boolean {
  const filePath = scopeKey(file);
  return scopedPaths(files).some((scope) => {
    const key = scopeKey(scope);
    return filePath === key || filePath.startsWith(`${key}/`);
  });
}
