#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { measureFiles } from '../lib/measure.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { project: { type: 'string', default: process.cwd() }, base: { type: 'string' }, coverage: { type: 'string' } } });
  const [command, ...files] = positionals;
  if (command !== 'measure' || !values.base || !values.coverage || !files.length) throw new Error('Usage: quality-gate measure --project <root> --base <revision> --coverage <V8-directory> <files...>');
  const report = await measureFiles(files, { projectRoot: path.resolve(values.project), base: values.base, coverageDirectory: path.resolve(values.coverage) });
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = Number(report.failures.length > 0 || report.unverified.length > 0);
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
