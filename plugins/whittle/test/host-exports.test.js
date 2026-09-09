'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const generator = require(path.join(root, 'scripts', 'generate-host-exports'));
const { instructions } = require(path.join(root, 'hooks', 'lib', 'runtime'));

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test('generated static exports contain the one canonical policy', () => {
  const output = temporaryDirectory('whittle-exports-');
  const policy = instructions();
  try {
    generator.generate(output);
    for (const [directory, target] of generator.staticHosts) {
      const contents = fs.readFileSync(path.join(output, directory, target), 'utf8');
      assert.equal(contents.split(policy).length - 1, 1, directory);
    }
    assert.equal(fs.readFileSync(path.join(output, 'gemini', 'GEMINI.md'), 'utf8').includes(policy), true);
    assert.match(fs.readFileSync(path.join(output, 'cursor', '.cursor', 'rules', 'whittle.mdc'), 'utf8'), /^---\nalwaysApply: true\n---\n/);
    assert.match(fs.readFileSync(path.join(output, 'openclaw', 'skills', 'whittle', 'SKILL.md'), 'utf8'), /persistence:none/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('native adapters preserve their host callback seams without commands or mode state', async () => {
  const openCode = await import(pathToFileURL(path.join(root, 'adapters', 'opencode', 'whittle.mjs')).href + '?opencode');
  const piAdapter = await import(pathToFileURL(path.join(root, 'adapters', 'pi', 'whittle.mjs')).href + '?pi');
  const policy = instructions();
  const output = { system: ['base'] };

  assert.equal(openCode.injectNextMessage({}, output), policy);
  assert.equal(openCode.injectNextMessage({}, output), '');
  assert.equal(output.system[0].split(policy).length - 1, 1);
  assert.equal(piAdapter.injectBeforeAgent({ systemPrompt: 'base' }).systemPrompt.includes(policy), true);
  assert.equal(piAdapter.injectBeforeAgent({ systemPrompt: policy }), undefined);
});

test('Hermes reads the same policy through its pre-LLM callback', () => {
  const hermes = path.join(root, 'adapters', 'hermes', '__init__.py');
  const script = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("whittle", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'assert "Understand the flow before changing it" in module.pre_llm_call()["context"]',
  ].join('; ');

  childProcess.execFileSync('python', ['-c', script, hermes], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
});
