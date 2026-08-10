import assert from 'node:assert/strict';
import test from 'node:test';
import { PyrightCompatibilityError } from '../src/lib/extractors/python/pyright-adapter.ts';

test('Pyright compatibility failures stay explicit', () => {
  const error = new PyrightCompatibilityError('module 8779 does not export AnalyzerServiceExecutor');
  assert.match(error.message, /Pyright 1\.1\.411 compatibility error/);
});
