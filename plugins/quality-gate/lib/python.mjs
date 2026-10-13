import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import policies from './python/policies.json' with { type: 'json' };

export const PYTHON_POLICIES = Object.freeze(policies);
export const DEFAULT_PYTHON_POLICY = PYTHON_POLICIES[0];

export function pythonPolicy(value = DEFAULT_PYTHON_POLICY) {
  if (!PYTHON_POLICIES.includes(value)) throw new Error(`Unknown Python measurement policy. Choose ${PYTHON_POLICIES.join(', ')}.`);
  return value;
}

export function pythonOracles(entries, policy) {
  if (entries === undefined) return entries;
  if (policy === DEFAULT_PYTHON_POLICY) throw new Error('pythonOracles requires the native Python policy; remove the collection or explicitly select the native policy.');
  if (!Array.isArray(entries)) throw new Error('pythonOracles must be an array of exact {file, name, reason} selectors.');
  entries.forEach(validateOracleSelector);
  const identities = entries.map((entry) => JSON.stringify([entry.file, entry.name]));
  if (new Set(identities).size !== identities.length) throw new Error('pythonOracles contains duplicate or conflicting file/name selectors.');
  return entries;
}

function validateOracleSelector(entry) {
  if (Object.prototype.toString.call(entry) !== '[object Object]') throw new Error('Each pythonOracles selector must be {file, name, reason}.');
  if (Object.keys(entry).sort().join(',') !== 'file,name,reason') throw new Error('Each pythonOracles selector must contain exactly file, name and reason.');
  if (!Object.values(entry).every((value) => typeof value === 'string' && value.trim().length)) throw new Error('pythonOracles file, name and reason must be nonempty strings.');
  validateOracleIdentity(entry);
}

function validateOracleIdentity({ file, name }) {
  const segments = file.split('/');
  const validSegments = segments.every((segment) => !['', '.', '..'].includes(segment));
  const valid = [file.endsWith('.py'), validSegments, !/[\\:*?\[\]{}]/.test(file), !/[*?\[\]{}]/.test(name), name.trim() === name];
  if (!valid.every(Boolean)) throw new Error('pythonOracles requires an exact project-relative POSIX .py file and source-qualified body name, without patterns.');
}

export function verifyOracleOwnership(metrics, entries = []) {
  for (const entry of entries) {
    const matches = metrics.filter((metric) => metric.relativePath === entry.file && metric.name === entry.name);
    if (matches.length !== 1) throw new Error('pythonOracles selector must match exactly one independently owned body in the selected source scope: ' + entry.file + ':' + entry.name);
    if (matches[0].oracleClassification !== 'oracle') throw new Error('pythonOracles cannot override fixture/setup qualification: ' + entry.file + ':' + entry.name);
  }
}

const adapter = fileURLToPath(new URL('./python/crap_adapter.py', import.meta.url));

export function pythonRuntime(root) {
  for (const [command, argumentsList] of [['python3', []], ['py', ['-3']]]) {
    const result = spawnSync(command, [...argumentsList, '--version'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status === 0 && /Python 3\./.test(result.stdout)) return { command, argumentsList };
  }
  throw new Error('Python 3 is unavailable. Put the project Python 3 on PATH as python3 or py -3, then rerun the gate. Radon is not required.');
}

export function pythonDescriptors(text, file, root, policy = DEFAULT_PYTHON_POLICY, oracles) {
  pythonPolicy(policy);
  pythonOracles(oracles, policy);
  const { command, argumentsList } = pythonRuntime(root);
  const result = spawnSync(command, [...argumentsList, '-I', adapter], { cwd: root, input: JSON.stringify({ text, file, policy, oracles }), encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Python source adapter failed for ${file}: ${result.stderr || result.error?.message}. Fix the source or Python runtime, then rerun the gate.`);
  return JSON.parse(result.stdout).rows;
}
