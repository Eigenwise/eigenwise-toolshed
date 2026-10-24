import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { VerificationResult } from './kernel/verification.js';
import { runProcessVerification } from './ports/process.js';

interface GateInstall {
  scope?: string;
  projectPath?: string;
  installPath: string;
}

interface QualityRow {
  relativePath?: string;
  line?: number;
  name?: string;
  complexity?: number;
  crap?: number;
  classification?: string;
  unverified?: string;
  branches?: unknown[];
}

interface NativeReport {
  changedMetrics?: QualityRow[];
  failures: unknown[];
  unverified: QualityRow[];
}

export interface IntegrationQuality {
  status: 'none' | 'measured' | 'failed' | 'unverified';
  receipt?: string;
  baseline?: string;
  enforced: number;
  failures: unknown[];
  unverified: QualityRow[];
  worstBody?: QualityRow;
  branches: { file?: string; name?: string; conditions: unknown[] }[];
}

export interface QualityInput {
  project: string;
  registeredProject: string;
  directory: string;
  base: string;
  changedPaths: string[];
  timeoutMilliseconds: number;
}

function sameProject(left: string, right: string): boolean {
  return path.resolve(left).replaceAll('\\', '/').toLowerCase() === path.resolve(right).replaceAll('\\', '/').toLowerCase();
}

function applicableInstall(install: GateInstall, project: string): boolean {
  if (install.scope === 'user') return true;
  return typeof install.projectPath === 'string' && sameProject(install.projectPath, project);
}

export function configuredIntegrationGate(project: string): string | undefined {
  const home = process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const registryPath = path.join(home, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(registryPath)) return undefined;
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { plugins?: Record<string, GateInstall[]> };
  const installs = registry.plugins?.['quality-gate@eigenwise-toolshed'] ?? [];
  return installs.find((install) => applicableInstall(install, project))?.installPath;
}

function quoteArgument(value: string): string {
  if (process.platform === 'win32') return '"' + value.replaceAll('"', '""') + '"';
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function runNativeReport(gate: string, input: QualityInput, command: string[], name: string): NativeReport {
  const output = path.join(input.directory, name + '.json');
  const invocation = [process.execPath, path.join(gate, 'bin', 'quality-gate.js'), ...command].map(quoteArgument).join(' ');
  const result = runProcessVerification({ kind: 'command', command: invocation + ' > ' + quoteArgument(output), evidenceContract: 'Native quality-gate report' }, {
    cwd: input.project,
    timeoutMilliseconds: input.timeoutMilliseconds,
    logPath: path.join(input.directory, name + '.log'),
  });
  if (result.status !== 'passed' && result.status !== 'failed_suite') throw new Error(result.evidence);
  const report = JSON.parse(fs.readFileSync(output, 'utf8')) as NativeReport;
  if (!Array.isArray(report.failures) || !Array.isArray(report.unverified)) throw new Error('Native quality-gate report has no failures/unverified rows');
  return report;
}

function generatedCounterpart(file: string, files: string[]): boolean {
  const source = file.replace(/\/(lib|bin)\//, '/src/$1/').replace(/\.js$/, '.ts');
  return source !== file && files.includes(source);
}

function sourceFiles(input: QualityInput): string[] {
  return input.changedPaths.filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !generatedCounterpart(file, input.changedPaths))
    .filter((file) => fs.existsSync(path.resolve(input.project, file)));
}

function emptyQuality(status: IntegrationQuality['status']): IntegrationQuality {
  return { status, enforced: 0, failures: [], unverified: [], branches: [] };
}

function unverifiedQuality(error: unknown): IntegrationQuality {
  return { ...emptyQuality('unverified'), unverified: [{ name: 'integration measurement', unverified: String(error) }] };
}

function reportQuality(report: NativeReport, base: string): IntegrationQuality {
  const enforced = (report.changedMetrics ?? []).filter((row) => row.classification !== 'legacy-unchanged');
  const floorFailures = enforced.filter((row) => (row.complexity ?? 0) >= 6).map((row) => `${row.relativePath}:${row.line} ${row.name} cc=${row.complexity} (complexity floor)`);
  const failures = [...report.failures, ...floorFailures];
  const unverified = report.unverified;
  const measured = { ...emptyQuality('measured'), baseline: base, enforced: enforced.length, failures, unverified };
  return {
    ...measured,
    status: qualityStatus(failures, unverified),
    worstBody: enforced.slice().sort((left, right) => (right.crap ?? -1) - (left.crap ?? -1))[0],
    branches: enforced.map((row) => ({ file: row.relativePath, name: row.name, conditions: row.branches ?? [] })),
  };
}

function qualityStatus(failures: unknown[], unverified: QualityRow[]): IntegrationQuality['status'] {
  if (failures.length) return 'failed';
  return unverified.length ? 'unverified' : 'measured';
}

function measuredQuality(gate: string, input: QualityInput, captureDirectory: string): IntegrationQuality {
  const files = sourceFiles(input);
  if (!files.length) return emptyQuality('measured');
  const report = runNativeReport(gate, input, ['measure', '--json', '--project', input.project, '--base', input.base, '--coverage', captureDirectory, ...files], 'measure');
  return reportQuality(report, input.base);
}

function persistQuality(input: QualityInput, quality: IntegrationQuality): IntegrationQuality {
  const receipt = path.join(input.directory, 'receipt.json');
  const recorded = { ...quality, receipt };
  fs.writeFileSync(receipt, JSON.stringify(recorded, null, 2) + '\n');
  return recorded;
}

function captureEnvironment(gate: string, directory: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const preload = '--import=' + pathToFileURL(path.join(gate, 'lib', 'core.mjs')).href;
  return { ...environment, NODE_OPTIONS: [environment.NODE_OPTIONS, preload].filter(Boolean).join(' '), QUALITY_GATE_V8_CAPTURE: path.join(directory, 'coverage') };
}

function participantQuality(gate: string, input: QualityInput, captureDirectory: string): IntegrationQuality {
  fs.mkdirSync(input.directory, { recursive: true });
  let quality: IntegrationQuality;
  try {
    quality = measuredQuality(gate, input, captureDirectory);
  } catch (error) {
    quality = unverifiedQuality(error);
  }
  return persistQuality(input, quality);
}

function unavailableQuality(inputs: QualityInput[], verify: (environment: NodeJS.ProcessEnv) => VerificationResult, error: unknown, environment: NodeJS.ProcessEnv) {
  const quality = inputs.map((input) => {
    fs.mkdirSync(input.directory, { recursive: true });
    return persistQuality(input, unverifiedQuality(error));
  });
  return { ...verify(environment), quality };
}

export function runIntegrationQuality(inputs: QualityInput[], verify: (environment: NodeJS.ProcessEnv) => VerificationResult, environment: NodeJS.ProcessEnv = process.env): VerificationResult & { quality: IntegrationQuality[] } {
  const primary = inputs[0]!;
  let gate: string | undefined;
  try {
    gate = configuredIntegrationGate(primary.registeredProject);
  } catch (error) {
    return unavailableQuality(inputs, verify, error, environment);
  }
  if (!gate) return { ...verify(environment), quality: [emptyQuality('none')] };
  const captureDirectory = path.join(primary.directory, 'coverage');
  fs.mkdirSync(captureDirectory, { recursive: true });
  const verification = verify(captureEnvironment(gate, primary.directory, environment));
  const quality = inputs.map((input) => participantQuality(gate, input, captureDirectory));
  const failures = quality.flatMap((result) => result.failures);
  if (!failures.length) return { ...verification, quality };
  return { ...verification, quality, status: 'failed_check', evidence: 'Native quality gate refused delivery: ' + failures.map((row) => JSON.stringify(row)).join('; '), failureIdentities: ['quality:measured-failure'] };
}
