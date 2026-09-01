export function normalizeScope(scope: unknown): string {
  return String(scope || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
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

export function hasGlob(scope: string): boolean {
  return scope.includes('*');
}

function globExpression(scope: string): RegExp {
  let expression = '^';
  for (let index = 0; index < scope.length; index += 1) {
    const character = scope[index]!;
    if (character !== '*') {
      expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    if (scope[index + 1] === '*') {
      if (scope[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
      continue;
    }
    expression += '[^/]*';
  }
  return new RegExp(`${expression}$`, process.platform === 'win32' ? 'i' : '');
}

export function isInScope(file: unknown, files: unknown): boolean {
  const filePath = scopeKey(file);
  return scopedPaths(files).some((scope) => {
    const key = scopeKey(scope);
    return hasGlob(key)
      ? globExpression(key).test(filePath)
      : filePath === key || filePath.startsWith(`${key}/`);
  });
}
