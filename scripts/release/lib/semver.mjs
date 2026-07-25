const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const LEVELS = ['patch', 'minor', 'major'];

const LEVEL_RANK = { patch: 1, minor: 2, major: 3 };

export function isLevel(value) {
  return typeof value === 'string' && Object.hasOwn(LEVEL_RANK, value);
}

export function parseVersion(value, label = 'version') {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string, got ${typeof value}`);
  }
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`${label} "${value}" is not a plain x.y.z semver (this repo does not use pre-release or build metadata)`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function formatVersion(parts) {
  return parts.join('.');
}

export function bumpVersion(value, level, label = 'version') {
  const [major, minor, patch] = parseVersion(value, label);
  switch (level) {
    case 'major':
      return formatVersion([major + 1, 0, 0]);
    case 'minor':
      return formatVersion([major, minor + 1, 0]);
    case 'patch':
      return formatVersion([major, minor, patch + 1]);
    default:
      throw new Error(`unknown bump level "${level}" (expected ${LEVELS.join(', ')})`);
  }
}

export function maxLevel(levels) {
  let best = null;
  for (const level of levels) {
    if (!isLevel(level)) throw new Error(`unknown bump level "${level}" (expected ${LEVELS.join(', ')})`);
    if (best === null || LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  }
  if (best === null) throw new Error('maxLevel needs at least one level');
  return best;
}

export function compareLevels(a, b) {
  return LEVEL_RANK[a] - LEVEL_RANK[b];
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}
