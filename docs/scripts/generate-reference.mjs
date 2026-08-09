import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(import.meta.dirname, '../src/content/docs/reference');
const header = '<!-- AUTO-GENERATED — do not edit; run npm run generate -->\n';
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const frontmatter = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  const values = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const item = line.match(/^(name|description|summary):\s*(.*)$/);
    if (item && !item[2].startsWith('>')) {
      values[item[1] === 'summary' ? 'description' : item[1]] = item[2].replace(/^['"]|['"]$/g, '');
    }
  }
  if (!values.description && match) values.description = (match[1].match(/description:\s*>-\n([\s\S]*?)(?=\n\w+:|$)/)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  return values;
};
const collectSkills = (pluginDir) => {
  const skills = [];
  const seenSlugs = new Set();
  for (const skillsDir of [path.join(pluginDir, 'skills'), path.join(pluginDir, '.claude/skills')]) {
    if (!fs.existsSync(skillsDir)) continue;
    for (const slug of fs.readdirSync(skillsDir).sort()) {
      const skillFile = path.join(skillsDir, slug, 'SKILL.md');
      if (seenSlugs.has(slug) || !fs.existsSync(skillFile)) continue;
      seenSlugs.add(slug);
      skills.push({ slug, ...frontmatter(skillFile) });
    }
  }
  return skills;
};
const pluginsDir = path.join(root, 'plugins');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const plugins = fs.readdirSync(pluginsDir).filter((name) => fs.existsSync(path.join(pluginsDir, name, '.claude-plugin/plugin.json'))).sort();
const bullets = (items) => items.length ? items.map((x) => `- ${x}`).join('\n') : '- None';
for (const name of plugins) {
  const dir = path.join(pluginsDir, name);
  const manifest = readJson(path.join(dir, '.claude-plugin/plugin.json'));
  const skills = collectSkills(dir);
  const hooksFile = path.join(dir, 'hooks/hooks.json');
  const hooks = fs.existsSync(hooksFile) ? readJson(hooksFile).hooks ?? {} : {};
  const hookLines = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group) => (group.hooks ?? []).map((hook) => `**${event}**${group.matcher ? ` (${group.matcher})` : ''}: \`${hook.command}\``)));
  const binDir = path.join(dir, 'bin');
  const bins = fs.existsSync(binDir) ? fs.readdirSync(binDir).filter((x) => x.endsWith('.js')).sort() : [];
  const skillLines = skills.map((skill) => `\`${skill.slug}\`: ${skill.description || 'No description provided.'}`);
  const content = `---\ntitle: ${manifest.name}\ndescription: ${JSON.stringify(manifest.description)}\n---\n\n${header}${manifest.description}\n\n**Version:** \`${manifest.version}\`\n\n## Skills\n\n${bullets(skillLines)}\n\n## Hooks\n\n${bullets(hookLines)}\n\n## Bin entrypoints\n\n${bullets(bins.map((x) => `\`${x}\``))}\n\n[Source on GitHub](${manifest.homepage})\n`;
  fs.writeFileSync(path.join(out, `${name}.md`), content);
}
const marketplace = readJson(path.join(root, '.claude-plugin/marketplace.json'));
const rows = marketplace.plugins.map((p) => `| [${p.name}](./${p.name}/) | ${p.version} | ${p.description.replace(/\|/g, '\\|')} |`).join('\n');
fs.writeFileSync(path.join(out, 'marketplace.md'), `---\ntitle: Marketplace versions\ndescription: Generated versions and descriptions from the Toolshed marketplace.\n---\n\n${header}**Marketplace:** \`${marketplace.name}\`  \n**Version:** \`${marketplace.version}\`\n\n| Plugin | Version | Description |\n| --- | --- | --- |\n${rows}\n`);
