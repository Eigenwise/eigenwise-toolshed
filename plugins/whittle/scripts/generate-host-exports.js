'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { instructions } = require(path.join(root, 'hooks', 'lib', 'runtime'));

const staticHosts = [
  ['agents', 'AGENTS.md', 'AGENTS.md'],
  ['codex', 'AGENTS.md', 'Codex'],
  ['grok', 'AGENTS.md', 'Grok'],
  ['gemini', 'GEMINI.md', 'Gemini'],
  ['cursor', '.cursor/rules/whittle.mdc', 'Cursor'],
  ['windsurf', '.windsurf/rules/whittle.md', 'Windsurf'],
  ['cline', '.clinerules/whittle.md', 'Cline'],
  ['copilot', '.github/copilot-instructions.md', 'Copilot'],
  ['antigravity', 'AGENTS.md', 'Antigravity'],
  ['codewhale', 'AGENTS.md', 'CodeWhale'],
  ['swival', 'AGENTS.md', 'Swival'],
  ['vscode-codex', 'AGENTS.md', 'VSCode-Codex'],
  ['junie', 'AGENTS.md', 'Junie'],
  ['amp', 'AGENTS.md', 'Amp'],
  ['jules', 'AGENTS.md', 'Jules'],
  ['kiro', '.kiro/steering/whittle.md', 'Kiro'],
  ['qoder', '.qoder/rules/whittle.md', 'Qoder'],
  ['zed', 'AGENTS.md', 'Zed'],
  ['generic', 'AGENTS.md', 'generic agents'],
];

function staticInstructions(host, target) {
  const frontmatter = target.endsWith('.mdc') ? '---\nalwaysApply: true\n---\n\n' : '';
  return frontmatter + '# Whittle instructions for ' + host + '\n\n' + instructions() + '\n';
}

function openClawSkill() {
  return [
    '---',
    'name: whittle',
    'description: One practical clean-code policy with persistence:none.',
    '---',
    '',
    instructions(),
    '',
  ].join('\n');
}

function writeFile(destination, relativePath, content) {
  const file = path.join(destination, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readme() {
  const rows = staticHosts.map(([directory, target, host]) => '| ' + host + ' | `' + directory + '/' + target + '` | `' + target + '` |');
  rows.push('| OpenClaw | `openclaw/skills/whittle/SKILL.md` | `skills/whittle/SKILL.md` |');
  return [
    '# Whittle host exports',
    '',
    'Each directory is a self-contained policy export. Choose one directory and copy its contents to the listed destination yourself. The generator never writes consumer directories automatically.',
    '',
    '| Host | Export path | Consumer destination |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '## Native adapters',
    '',
    '| Host | Adapter | Delivery | Verification |',
    '| --- | --- | --- |',
    '| OpenCode | `adapters/opencode/whittle.mjs` | System transform | Callback shape checked; host not run. |',
    '| Pi | `adapters/pi/whittle.mjs` | Before-agent callback | Callback shape checked; host not run. |',
    '| Hermes | `adapters/hermes/` | Pre-LLM callback | Callback shape checked; host not run. |',
    '| MCP | `mcp/` | Read-only instruction prompt/tool | SDK stdio checked with an isolated dependency install. |',
    '',
    'The static paths are host-format equivalents, not evidence that each consumer binary loaded them. Gemini uses `GEMINI.md`; Cursor uses an always-applied rule.',
    '',
  ].join('\n');
}

function generate(destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  const notice = fs.readFileSync(path.join(root, 'NOTICE'), 'utf8');
  writeFile(destination, 'README.md', readme());
  for (const [directory, target, host] of staticHosts) {
    writeFile(destination, path.join(directory, target), staticInstructions(host, target));
    writeFile(destination, path.join(directory, 'NOTICE'), notice);
  }
  writeFile(destination, path.join('openclaw', 'skills', 'whittle', 'SKILL.md'), openClawSkill());
  writeFile(destination, path.join('openclaw', 'NOTICE'), notice);
}

function outputDirectory(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== '--out') {
    throw new Error('usage: generate-host-exports.js --out directory');
  }
  return path.resolve(argumentsList[1]);
}

if (require.main === module) generate(outputDirectory(process.argv.slice(2)));

module.exports = { generate, openClawSkill, outputDirectory, staticHosts, staticInstructions };
