// Checks every internal link and anchor in the built site. Run after `npm run build`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const htmlFilesIn = (folder) =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return htmlFilesIn(path);
    return name.endsWith('.html') ? [path] : [];
  });

const builtFileFor = (urlPath) => {
  const clean = decodeURIComponent(urlPath);
  const candidates = [join(siteFolder, clean), join(siteFolder, clean, 'index.html'), join(siteFolder, `${clean}.html`)];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
};

const idsByFile = new Map();
const idsIn = (path) => {
  if (!idsByFile.has(path)) idsByFile.set(path, new Set([...readFileSync(path, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])));
  return idsByFile.get(path);
};

const internalLinksIn = (html) =>
  [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((match) => match[1]).filter((href) => href.startsWith('/') && !href.startsWith('//'));

const base = '/eigenwise-toolshed';

const problemWith = (href) => {
  const [urlPath, anchor] = href.split('#');
  if (!urlPath.startsWith(`${base}/`)) return `link without ${base}`;
  const target = builtFileFor(urlPath.slice(base.length));
  if (!target) return 'no such page';
  if (anchor && target.endsWith('.html') && !idsIn(target).has(decodeURIComponent(anchor))) return `no such anchor #${anchor}`;
  return undefined;
};

const pages = htmlFilesIn(siteFolder);
const broken = pages.flatMap((page) =>
  [...new Set(internalLinksIn(readFileSync(page, 'utf8')))]
    .map((href) => ({ page: page.slice(siteFolder.length), href, problem: problemWith(href) }))
    .filter((link) => link.problem),
);

for (const link of broken) console.error(`${link.page}: ${link.href} (${link.problem})`);
console.log(`links: ${pages.length} pages checked, ${broken.length} broken`);
process.exit(broken.length > 0 ? 1 : 0);
