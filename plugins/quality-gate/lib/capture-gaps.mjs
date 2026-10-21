import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

function missingCapture(environment) {
  const preload = '--import=' + new URL('./core.mjs', import.meta.url).href;
  return !environment.NODE_OPTIONS?.includes(preload);
}

function recordEnvironment(gaps, environment, command) {
  if (missingCapture(environment) || environment.QUALITY_GATE_V8_CAPTURE !== process.env.QUALITY_GATE_V8_CAPTURE) gaps.add(String(command));
}

export function observeCaptureGaps() {
  const gaps = new Set();
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function(options) {
    const environment = Object.fromEntries(options.envPairs.map((pair) => splitEnvironmentPair(pair)));
    recordEnvironment(gaps, environment, options.file);
    return originalSpawn.call(this, options);
  };
  for (const name of ['spawnSync', 'execSync', 'execFileSync']) observeSynchronousSpawn(name, gaps);
  syncBuiltinESMExports();
  return gaps;
}

function splitEnvironmentPair(pair) {
  const separator = pair.indexOf('=');
  return [pair.slice(0, separator), pair.slice(separator + 1)];
}

function observeSynchronousSpawn(name, gaps) {
  const original = childProcess[name];
  childProcess[name] = function(...argumentsList) {
    const options = argumentsList.find((argument) => argument?.env);
    recordEnvironment(gaps, options?.env ?? process.env, argumentsList[0]);
    return original.apply(this, argumentsList);
  };
}
