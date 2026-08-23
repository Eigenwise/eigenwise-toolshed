import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';

const docsRoot = path.resolve(import.meta.dirname, '..');
const contentRoot = path.join(docsRoot, 'src/content/docs');
const repositoryRoot = path.resolve(docsRoot, '..');

const markdownFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const entryPath = path.join(directory, entry.name);
  if (entry.isDirectory()) return markdownFiles(entryPath);
  return entry.name.endsWith('.md') ? [entryPath] : [];
});

const pageRoute = (file) => {
  const relativePath = path.relative(contentRoot, file).replaceAll(path.sep, '/');
  const routePath = relativePath === 'index.md'
    ? ''
    : relativePath.replace(/\/index\.md$/, '').replace(/\.md$/, '');
  return routePath ? `/${routePath}/` : '/';
};

const localLinkTargets = (text) => [...text.matchAll(/\]\(([^)]+)\)|href=["']([^"']+)["']/g)]
  .map((match) => match[1] ?? match[2])
  .filter((target) => !/^(?:#|https?:|mailto:)/i.test(target));

const redirectRoutes = () => {
  const configuration = fs.readFileSync(path.join(docsRoot, 'astro.config.mjs'), 'utf8');
  return [...configuration.matchAll(/^\s*'(\/[^']+)':/gm)].map((match) => match[1]);
};

const isAssetTarget = (resolvedPath) => resolvedPath.includes('/assets/')
  || /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i.test(resolvedPath);

before(() => {
  const result = spawnSync(process.execPath, ['scripts/generate-reference.mjs'], { cwd: docsRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('prose links use route-relative paths instead of root-absolute internal targets', () => {
  const invalidLinks = [];
  for (const file of markdownFiles(contentRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const target of localLinkTargets(text).filter((target) => target.startsWith('/') && !target.startsWith('//'))) {
      invalidLinks.push(`${path.relative(repositoryRoot, file)}: ${target}`);
    }
  }
  assert.deepEqual(invalidLinks, [], 'Use a route-relative link instead of a root-absolute internal link');
});

test('prose page links resolve to known routes', () => {
  const files = markdownFiles(contentRoot);
  const knownRoutes = new Set([...files.map(pageRoute), ...redirectRoutes()]);
  const invalidLinks = [];
  for (const file of files) {
    const route = pageRoute(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const target of localLinkTargets(text)) {
      const resolvedPath = new URL(target, `https://docs.test${route}`).pathname;
      if (!isAssetTarget(resolvedPath) && !knownRoutes.has(resolvedPath)) {
        invalidLinks.push(`${path.relative(repositoryRoot, file)}: ${target} -> ${resolvedPath}`);
      }
    }
  }
  assert.deepEqual(invalidLinks, [], 'Use a page route-relative link that resolves to a known docs route');
});

test('generated references include scoped skills and current marketplace descriptions', () => {
  const modelGatewayReference = fs.readFileSync(path.join(contentRoot, 'reference/model-gateway.md'), 'utf8');
  assert.match(modelGatewayReference, /`verify`: Verify model-gateway through its CLI and HTTP shim surface\./);
  assert.equal((modelGatewayReference.match(/`verify`:/g) ?? []).length, 1);

  const marketplace = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '.claude-plugin/marketplace.json'), 'utf8'));
  const sidequestDescription = marketplace.plugins.find((plugin) => plugin.name === 'sidequest').description;
  const marketplaceReference = fs.readFileSync(path.join(contentRoot, 'reference/marketplace.md'), 'utf8');
  assert.ok(marketplaceReference.includes(sidequestDescription));
});

test('generated references and homepage avoid duplicate visible headings', () => {
  const modelGatewayReference = fs.readFileSync(path.join(contentRoot, 'reference/model-gateway.md'), 'utf8');
  const marketplaceReference = fs.readFileSync(path.join(contentRoot, 'reference/marketplace.md'), 'utf8');
  const homepage = fs.readFileSync(path.join(contentRoot, 'index.md'), 'utf8');
  assert.doesNotMatch(modelGatewayReference, /^# /m);
  assert.doesNotMatch(marketplaceReference, /^# /m);
  assert.doesNotMatch(homepage, /<h1\b/);
});

test('legacy Model Gateway redirects preserve the docs base path', () => {
  const configuration = fs.readFileSync(path.join(docsRoot, 'astro.config.mjs'), 'utf8');
  assert.match(configuration, /'\/getting-started\/codex-gateway': '\/eigenwise-toolshed\/getting-started\/model-gateway'/);
  assert.match(configuration, /'\/reference\/codex-gateway': '\/eigenwise-toolshed\/reference\/model-gateway'/);
});
