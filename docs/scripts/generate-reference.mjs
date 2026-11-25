// Writes the reference pages from the repository itself: the marketplace file, each plugin's
// manifest, skill and agent frontmatter, the tool specs the mods register and the default
// routing table. Run through `tsx`, because the tool specs are TypeScript.
//
// The pages are not committed. Every npm script that builds or serves the site runs this
// first, so the reference always matches the plugins in this checkout.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(docsRoot, '..');
const pluginsRoot = join(repositoryRoot, 'plugins');
const outputFolder = join(docsRoot, 'src', 'content', 'docs', 'reference');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const foldersIn = (path) => (existsSync(path) ? readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory()) : []);
const filesIn = (path) => (existsSync(path) ? readdirSync(path).filter((name) => statSync(join(path, name)).isFile()) : []);

const unquoted = (value) => value.replace(/^(["'])(.*)\1$/, '$2');

const frontmatterOf = (text) => {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const entries = block
    .split('\n')
    .map((line) => /^([\w-]+):\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, key, value]) => [key, unquoted(value.trim())]);
  return Object.fromEntries(entries);
};

const marketplace = readJson(join(repositoryRoot, '.claude-plugin', 'marketplace.json'));
const notes = readJson(join(docsRoot, 'scripts', 'reference-notes.json'));

const skillsOf = (pluginFolder) =>
  foldersIn(join(pluginFolder, 'skills'))
    .map((name) => join(pluginFolder, 'skills', name, 'SKILL.md'))
    .filter(existsSync)
    .map((path) => frontmatterOf(readText(path)))
    .sort((left, right) => left.name.localeCompare(right.name));

const agentsOf = (pluginFolder) =>
  filesIn(join(pluginFolder, 'agents'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => frontmatterOf(readText(join(pluginFolder, 'agents', name))))
    .sort((left, right) => left.name.localeCompare(right.name));

const sourceTextOf = (pluginFolder) => {
  const texts = [];
  const visit = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(md|mjs|ts|tsx|json|js)$/.test(name)) texts.push(readText(path));
    }
  };
  visit(pluginFolder);
  return texts.join('\n');
};

const commandsOf = (sourceText) =>
  [...sourceText.matchAll(/\$\.command\.register\(\{([\s\S]*?)\}\)/g)].map(([, body]) => ({
    name: /name:\s*'([^']+)'/.exec(body)?.[1] ?? '',
    description: /description:\s*(?:'([^']+)'|"([^"]+)")/.exec(body)?.slice(1).find(Boolean) ?? '',
    argumentHint: /argumentHint:\s*'([^']+)'/.exec(body)?.[1] ?? '',
  }));

const plugins = marketplace.plugins.map((entry) => {
  const folder = join(repositoryRoot, entry.source);
  const sourceText = sourceTextOf(folder);
  return {
    folder,
    sourceText,
    manifest: readJson(join(folder, '.claude-plugin', 'plugin.json')),
    skills: skillsOf(folder),
    agents: agentsOf(folder),
    commands: commandsOf(sourceText),
    hasMod: existsSync(join(folder, 'hooks', 'hooks.json')),
    workflows: filesIn(join(folder, 'workflows')),
  };
});

const pluginNamed = (name) => plugins.find((plugin) => plugin.manifest.name === name);

const problems = [];

const checkedFiles = (plugin) =>
  (notes.files[plugin.manifest.name] ?? []).map((file) => {
    if (!plugin.sourceText.includes(file.proof)) {
      problems.push(`${plugin.manifest.name}: "${file.path}" is documented, but its proof "${file.proof}" is no longer in the plugin's files.`);
    }
    return file;
  });

const isCommandLineScript = (path) => /process\.argv/.test(readText(path)) && !/\.test\./.test(path);

const checkedScripts = (plugin) => {
  const described = notes.scripts[plugin.manifest.name] ?? [];
  const onDisk = filesIn(join(plugin.folder, 'scripts'))
    .map((name) => `scripts/${name}`)
    .filter((file) => isCommandLineScript(join(plugin.folder, file)));
  for (const script of described) {
    if (!onDisk.includes(script.file)) problems.push(`${plugin.manifest.name}: ${script.file} is documented but is not a command line script in the plugin.`);
  }
  for (const file of onDisk) {
    if (!described.some((script) => script.file === file)) problems.push(`${plugin.manifest.name}: ${file} takes command line arguments and has no line in reference-notes.json.`);
  }
  return described;
};

const toolModule = async (pluginName) => import(pathToFileURL(join(pluginsRoot, pluginName, 'hooks', 'tool-specs.ts')).href);

const sidequestSpecs = await toolModule('sidequest');
const quartermasterSpecs = await toolModule('quartermaster');
const { DEFAULT_BOARD_CONFIG } = await import(pathToFileURL(join(pluginsRoot, 'sidequest', 'hooks', 'board-config.ts')).href);

const tools = [
  ...sidequestSpecs.SIDEQUEST_TOOLS.map((tool) => ({ plugin: 'sidequest', ...tool })),
  ...[quartermasterSpecs.EVIDENCE_TOOL, quartermasterSpecs.PROPOSAL_TOOL].map((tool) => ({ plugin: 'quartermaster', ...tool })),
];

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
const code = (text) => `\`${text}\``;
const table = (headers, rows) =>
  [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const inWords = (count) => NUMBER_WORDS[count] ?? String(count);
const agentCount = plugins.reduce((total, plugin) => total + plugin.agents.length, 0);

const GENERATED = '<!-- Generated by docs/scripts/generate-reference.mjs. Do not edit: change the plugin, then run the script. -->';

const page = (title, description, body) =>
  `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n${GENERATED}\n\n${body.trim()}\n`;

const versionLine = plugins.map((plugin) => `${plugin.manifest.name} ${plugin.manifest.version}`).join(', ');

const runtimeOf = (plugin) =>
  [
    plugin.hasMod ? 'mod' : '',
    plugin.skills.length > 0 ? `${plugin.skills.length} skill${plugin.skills.length === 1 ? '' : 's'}` : '',
    plugin.agents.length > 0 ? `${plugin.agents.length} agent${plugin.agents.length === 1 ? '' : 's'}` : '',
    plugin.workflows.length > 0 ? `${plugin.workflows.length} workflow${plugin.workflows.length === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(', ');

const overviewPage = () =>
  page(
    'Reference',
    'Exact names of every skill, tool, agent, command and file in the Toolshed, generated from the repository.',
    `
These pages are written by a script from the plugin manifests, the skill and agent frontmatter, the tool specs and the default routing table. They are rebuilt every time the site is built or served, so they match the plugins in this checkout.

Built from: ${versionLine}.

${table(
  ['Page', 'What is on it'],
  [
    ['[Plugins](/reference/plugins/)', 'Name, version, what each one ships and the install command.'],
    ['[Skills](/reference/skills/)', 'Every skill, how to call it and who may start it.'],
    ['[Tools](/reference/tools/)', `The ${inWords(tools.length)} tools the model gets, with every parameter.`],
    ['[Agents](/reference/agents/)', `The ${inWords(agentCount)} agent roles and what each one may not do.`],
    ['[Commands and scripts](/reference/commands/)', 'Slash commands that answer with no model turn, and the scripts you can run by hand.'],
    ['[Files each plugin writes](/reference/files/)', 'Every path, what it holds and whether it is personal or shared.'],
    ['[Routing defaults](/reference/routing-defaults/)', 'The tiers and categories a fresh install routes with.'],
  ],
)}

For a machine: \`/llms.txt\` is the way in, and \`/llms-full.txt\` holds the whole site as one file.
`,
  );

const pluginsPage = () =>
  page(
    'Plugins',
    `The ${inWords(plugins.length)} Toolshed plugins: versions, what each ships and how to install it.`,
    `
The marketplace is \`${marketplace.name}\`. Add it once, then install the plugins you want.

\`\`\`bash
claude plugin marketplace add Eigenwise/eigenwise-toolshed
\`\`\`

The marketplace does not list \`model-gateway\`. A project still wired to it needs it installed and switched on until the upgrade has unwired it. The [upgrade guide](/guides/upgrading/) says how.

${table(
  ['Plugin', 'Version', 'Ships', 'Needs Claude Code', 'What it is'],
  plugins.map((plugin) => [
    code(plugin.manifest.name),
    plugin.manifest.version,
    runtimeOf(plugin),
    plugin.manifest.engines?.['claude-code'] ?? 'any',
    plugin.manifest.description,
  ]),
)}

A mod is a hooks module that runs inside Claude Code. It draws panes and reacts to events without starting a process.

## Install commands

${plugins.map((plugin) => `\`\`\`bash\nclaude plugin install ${plugin.manifest.name}@${marketplace.name}\n\`\`\``).join('\n\n')}

Add \`--scope project\` to share a plugin with everyone who clones the repository, or \`--scope local\` to keep it to yourself in this one project. With no flag it is installed for you in every project.
`,
  );

const whoStarts = (skill) => (skill['disable-model-invocation'] === 'true' ? 'You only' : 'You or Claude');

const skillsPage = () =>
  page(
    'Skills',
    'Every skill in the Toolshed, how to call it and who may start it.',
    `
A skill is a page of instructions Claude loads when the work calls for it. Type its name after a slash to start one yourself.

"You only" means Claude never starts that skill by itself. It changes your setup or drafts something only you should send, so it waits for you.

${plugins
  .filter((plugin) => plugin.skills.length > 0)
  .map(
    (plugin) => `## ${plugin.manifest.name}

${table(
  ['Skill', 'Started by', 'Argument', 'What it does'],
  plugin.skills.map((skill) => [
    code(`/${plugin.manifest.name}:${skill.name}`),
    whoStarts(skill),
    skill['argument-hint'] ? code(skill['argument-hint']) : '',
    [skill.description, skill.when_to_use].filter(Boolean).join(' '),
  ]),
)}`,
  )
  .join('\n\n')}
`,
  );

const typeOf = (schema) => {
  if (schema.enum) return schema.enum.map((value) => code(value)).join(', ');
  if (schema.type === 'array') return `list of ${schema.items?.type ?? 'values'}`;
  return schema.type ?? '';
};

const parameterRows = (tool) => {
  const required = new Set(tool.inputSchema?.required ?? []);
  return Object.entries(tool.inputSchema?.properties ?? {}).map(([name, schema]) => [
    code(name),
    required.has(name) ? 'yes' : '',
    typeOf(schema),
    schema.description ?? '',
  ]);
};

const toolSection = (tool) => `### ${code(`mcp__${tool.plugin}__${tool.name}`)}

> ${tool.description}

${table(['Parameter', 'Required', 'Type or values', 'Meaning'], parameterRows(tool))}`;

const toolsPage = () =>
  page(
    'Tools',
    `The ${inWords(tools.length)} tools the Toolshed gives the model, with every parameter, taken from the specs the plugins register.`,
    `
The whole marketplace gives the model ${tools.length} tools. Only the main session writes with them. An agent started by the session returns a result and never touches the board or the proposals.

The text below is the description the model reads. Sidequest shows its examples with your own board's id prefix; here they use \`SQ-\` and \`ST-\`, the ids of a board made before prefixes.

${['sidequest', 'quartermaster']
  .map((name) => `## ${name}\n\n${tools.filter((tool) => tool.plugin === name).map(toolSection).join('\n\n')}`)
  .join('\n\n')}
`,
  );

const agentLimits = (agent) => {
  if (agent.tools) return `May only use: ${agent.tools}`;
  if (agent.disallowedTools) return `May not use: ${agent.disallowedTools}`;
  return 'No limits';
};

const agentsPage = () =>
  page(
    'Agents',
    'The agent roles Sidequest ships and the tool limits on each.',
    `
An agent is a helper session the main session starts for one piece of work. Sidequest ships ${inWords(agentCount)} roles. None of them names a model: the [routing table](/reference/routing-defaults/) picks it per category of work.

${plugins
  .filter((plugin) => plugin.agents.length > 0)
  .map((plugin) =>
    table(
      ['Agent', 'Limits', 'What it is for'],
      plugin.agents.map((agent) => [code(`${plugin.manifest.name}:${agent.name}`), agentLimits(agent), agent.description]),
    ),
  )
  .join('\n\n')}

No agent can call the tools that write the board. That is on purpose: only the main session records what happened.
`,
  );

const commandsPage = () =>
  page(
    'Commands and scripts',
    'Slash commands that answer with no model turn, and the scripts each plugin ships.',
    `
## Slash commands

These are registered by a plugin's mod, the part of a plugin that runs inside Claude Code. They answer at once and cost no model turn.

${table(
  ['Command', 'Plugin', 'What it does'],
  plugins.flatMap((plugin) =>
    plugin.commands.map((command) => [
      code(`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`),
      plugin.manifest.name,
      command.description,
    ]),
  ),
)}

Every skill is also a slash command, like \`/sidequest:run\`. Those are on the [skills page](/reference/skills/).

## Scripts

Plain Node scripts with no dependencies. The skills run them for you.

To run one by hand, use its full path. An installed plugin lives in Claude Code's plugin cache, and \`claude plugin list --json\` prints each plugin's \`installPath\`. The paths below start from that folder.

${plugins
  .map((plugin) => ({ plugin, scripts: checkedScripts(plugin) }))
  .filter(({ scripts }) => scripts.length > 0)
  .map(
    ({ plugin, scripts }) => `### ${plugin.manifest.name}

${table(['Script', 'What it does'], scripts.map((script) => [code(script.file), script.what]))}`,
  )
  .join('\n\n')}
`,
  );

const filesPage = () =>
  page(
    'Files each plugin writes',
    'Every file the Toolshed plugins write, what it holds and whether it is personal or shared.',
    `
Files are the truth. Every pane and status line only shows what is in these files, and you can open and edit any of them by hand.

${plugins
  .map((plugin) => ({ plugin, files: checkedFiles(plugin) }))
  .filter(({ files }) => files.length > 0)
  .map(
    ({ plugin, files }) => `## ${plugin.manifest.name}

${table(['Path', 'What it holds', 'Personal or shared'], files.map((file) => [code(file.path), file.what, file.shared]))}`,
  )
  .join('\n\n')}

## What no plugin writes

- \`CLAUDE.md\` is never touched.
- Nothing is written into your home folder unless the tables above say so.
- No database, no server and no port.
`,
  );

const categoriesOnTier = (tierName) =>
  Object.entries(DEFAULT_BOARD_CONFIG.categories)
    .filter(([, category]) => category.tier === tierName)
    .map(([name]) => name)
    .join(', ');

const routingPage = () =>
  page(
    'Routing defaults',
    'The tiers and categories Sidequest routes with when a project has no board.json of its own.',
    `
Sidequest routes with these defaults when a project has no \`.sidequest/board.json\`. The values come from the plugin's own default table.

## Tiers

A tier is a model and an effort level. A tier can also name a \`fallback\` model, which a spawn runs on when nobody provides the tier's model. No default tier sets one.

${table(
  ['Tier', 'Model', 'Effort', 'Categories on it'],
  Object.entries(DEFAULT_BOARD_CONFIG.tiers).map(([name, tier]) => [code(name), tier.model, tier.effort, categoriesOnTier(name) || '(none by default)']),
)}

## Categories

A category is a kind of work. Each one maps to a tier and to the agent role that does it.

${table(
  ['Category', 'Role', 'Tier', 'For'],
  Object.entries(DEFAULT_BOARD_CONFIG.categories).map(([name, category]) => [code(name), code(`sidequest:${category.role}`), code(category.tier), category.description]),
)}

## Settings

${table(
  ['Setting', 'Default', 'Meaning'],
  [
    [code('verify'), code(JSON.stringify(DEFAULT_BOARD_CONFIG.settings.verify)), 'The command that proves the landed work. Empty means the land skill looks for the project\'s own test command.'],
    [code('planReviewPasses'), DEFAULT_BOARD_CONFIG.settings.planReviewPasses, 'How many blind reviewers check the questions of a plan with more than one ticket before you see them.'],
    [code('worktrees'), DEFAULT_BOARD_CONFIG.settings.worktrees, 'Each worker gets its own git worktree. `false` runs workers one at a time in your main checkout.'],
    [code('unrouted'), code(DEFAULT_BOARD_CONFIG.settings.unrouted), 'The category an untagged agent runs on. `inherit` switches this off.'],
    [code('shared'), 'not set', 'Things only one ticket can use at a time, like a running app or a database. Each has a name, one line saying what it is, and how it picks up new code.'],
    [code('beforeBuilding'), 'not set', 'One step of your own between agreeing work and building it: a `label`, `how` to do it, and an optional `readBack`. The build waits until you say go. See [a written step before building](/guides/task-to-pull-request/#a-written-step-before-building).'],
    [code('pullRequestDiagram'), 'not set', 'Whether a pull request carries a diagram of the change. Land asks once and keeps your answer here.'],
    [code('prefix'), 'from the folder name', 'The letters ticket ids start with, set at the top of the file and not under `settings`. The first ticket picks it from the folder name, and you can change it while the board is young.'],
    [code('checks'), 'not set', 'A few lines of plain text on how checks run here: what they need, where they can run, the command that works. Every agent\'s brief carries it.'],
  ],
)}

How a spawn gets its route is explained in [How routing picks a model](/guides/routing/).
`,
  );

const pages = {
  'index.md': overviewPage(),
  'plugins.md': pluginsPage(),
  'skills.md': skillsPage(),
  'tools.md': toolsPage(),
  'agents.md': agentsPage(),
  'commands.md': commandsPage(),
  'files.md': filesPage(),
  'routing-defaults.md': routingPage(),
};

if (problems.length > 0) {
  console.error(`The reference notes no longer match the plugins:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

rmSync(outputFolder, { recursive: true, force: true });
mkdirSync(outputFolder, { recursive: true });
for (const [name, text] of Object.entries(pages)) writeFileSync(join(outputFolder, name), text);

console.log(`reference: wrote ${Object.keys(pages).length} pages to ${relative(docsRoot, outputFolder)} from ${versionLine}`);
