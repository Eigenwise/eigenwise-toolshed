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

test('current observability privacy claims match storage, consent, and signal-path authorities', () => {
  const modelGatewayReference = fs.readFileSync(path.join(contentRoot, 'reference/model-gateway.md'), 'utf8');
  assert.match(modelGatewayReference, /`verify`: Verify model-gateway through its CLI and HTTP shim surface\./);
  assert.equal((modelGatewayReference.match(/`verify`:/g) ?? []).length, 1);

  const marketplace = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '.claude-plugin/marketplace.json'), 'utf8'));
  const sidequestDescription = marketplace.plugins.find((plugin) => plugin.name === 'sidequest').description;
  const marketplaceDescription = marketplace.plugins.find((plugin) => plugin.name === 'observability').description;
  const observabilityManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/.claude-plugin/plugin.json'), 'utf8'));
  const privacyClaims = [
    {
      surface: 'Marketplace description',
      content: marketplaceDescription,
      required: [/Telemetry payloads exclude[\s\S]*credentials[\s\S]*environment values\./, /observability\.json/, /Logs reach configured sinks[\s\S]*observer's consent-filtered outbox/, /traces and metrics use separate Collector sink pipelines/, /including PostHog/],
      forbidden: [/\bprotected\b/i, /Collector can forward redacted signals to Grafana, generic OTLP, or PostHog/],
    },
    {
      surface: 'Observability manifest description',
      content: observabilityManifest.description,
      required: [/Telemetry payloads exclude[\s\S]*credentials[\s\S]*environment values\./, /observability\.json/, /Logs reach configured sinks[\s\S]*observer's consent-filtered outbox/, /traces and metrics use separate Collector sink pipelines/, /including PostHog/],
      forbidden: [/\bprotected\b/i, /Collector can forward redacted signals to Grafana, generic OTLP, or PostHog/],
    },
    {
      surface: 'Quartermaster setup skill',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/quartermaster/skills/setup/SKILL.md'), 'utf8'),
      required: [/Telemetry\s+payloads exclude[\s\S]*credentials[\s\S]*environment\s+values\./, /observability\.json/, /Logs reach configured sinks[\s\S]*observer's consent-filtered outbox/, /traces and metrics use separate Collector sink pipelines/, /including PostHog/],
      forbidden: [/credentials are never stored/i, /Collector can forward redacted signals to Grafana or another sink/],
    },
    {
      surface: 'Observability public guide',
      content: fs.readFileSync(path.join(contentRoot, 'observability.md'), 'utf8'),
      required: [/Sink configuration and supplied exporter credentials are stored in[\s\S]*observability\.json/, /observer's outbox is the only route[\s\S]*log record reaches a configured sink/, /Traces and metrics still reach a configured sink through the Collector/],
      forbidden: [/private local observability config/],
    },
    {
      surface: 'Observability setup guide',
      content: fs.readFileSync(path.join(contentRoot, 'observability/setup.md'), 'utf8'),
      required: [/Sink configuration and supplied exporter credentials are stored in[\s\S]*observability\.json/, /observer's outbox is the only route[\s\S]*log record reaches a configured sink/, /Traces and metrics still reach a configured sink through the Collector/],
      forbidden: [/private local observability config/],
    },
    {
      surface: 'Observability plugin README',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/README.md'), 'utf8'),
      required: [/Exporter settings you provide, including OTLP headers or tokens, are stored locally/, /User scope makes the plugin available in every project/, /No install scope opts a repository into telemetry/, /observer's outbox is the only route[\s\S]*log record reaches a configured sink/, /Traces and metrics still reach a configured sink through the Collector/],
      forbidden: [/user scope to cover every project/i],
    },
    {
      surface: 'Observability setup skill',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/skills/enable-project-telemetry/SKILL.md'), 'utf8'),
      required: [/Exporter settings the user provides, including OTLP headers or tokens, are stored locally/, /Telemetry capture and log export are gated on the canonical repository ID in the local opt-in registry/, /Installing this plugin at user, project, or local scope does not itself choose every repository/, /Collector traces and metrics are not covered by this gate/],
      forbidden: [/\bprotected\b/i],
    },
    {
      surface: 'Observability setup reference',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/skills/enable-project-telemetry/setup-reference.md'), 'utf8'),
      required: [/Install this plugin at any scope[\s\S]*repository opt-in are separate choices/, /observability\.json/, /Repository consent gates hook-spool admission, observer ingest, and log export through the observer outbox/, /Collector's trace and metric sink paths remain outside that repository gate/],
      forbidden: [/credentials are never stored/i],
    },
    {
      surface: 'Generic OTLP sink README',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/observability/sinks/otlp/README.md'), 'utf8'),
      required: [/Logs enter the observer[\s\S]*consent-filtered outbox/, /Separate Collector sink pipelines send traces and metrics/, /observability\.json/],
      forbidden: [/current-user-only/, /same redacted logs, traces, and metrics/],
    },
    {
      surface: 'PostHog sink README',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/observability/sinks/posthog/README.md'), 'utf8'),
      required: [/same observer and durable outbox path/, /observability\.json/, /HTTPS batch body/],
      forbidden: [/private current-user/, /\bCollector\b/],
    },
    {
      surface: 'Grafana sink README',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/observability/sinks/grafana/README.md'), 'utf8'),
      required: [/bundled loopback-only LGTM backend/, /Logs reach LGTM through the observer's consent-filtered outbox/, /traces and metrics use the direct Collector sink pipeline/],
      forbidden: [/same redacted telemetry to the canonical observer and LGTM/],
    },
    {
      surface: 'Collector README',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/observability/otel-collector/README.md'), 'utf8'),
      required: [/logs -> observer's consent-filtered outbox -> optional configured sink/, /traces, metrics -> optional otlphttp\/sink/, /Logs can reach a configured sink only through its consent-filtered outbox/, /separate Collector sink pipelines send traces and metrics/],
      forbidden: [/original redacted signal/, /same redacted logs, traces, and metrics/, /otlphttp\/observer -> 127\.0\.0\.1:14319\n\s*-> optional otlphttp\/sink/],
    },
    {
      surface: 'No sink README',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/observability/sinks/none/README.md'), 'utf8'),
      required: [/without a downstream hop/, /does not create or flush outbox rows/],
      forbidden: [],
    },
    {
      surface: 'Architecture guide',
      content: fs.readFileSync(path.join(contentRoot, 'architecture.md'), 'utf8'),
      required: [/listeners stay on loopback[\s\S]*optional opt-in remote sink[\s\S]*observer outbox[\s\S]*Collector path/],
      forbidden: [/listeners stay on loopback.*no remote egress/i],
    },
    {
      surface: 'Modular architecture guide',
      content: fs.readFileSync(path.join(contentRoot, 'architecture/modular-architecture.md'), 'utf8'),
      required: [/listeners stay on loopback[\s\S]*optional opt-in remote sink[\s\S]*observer outbox[\s\S]*Collector path/],
      forbidden: [/listeners stay on loopback.*no remote egress/i],
    },
    {
      surface: 'Sink config test title',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/test/observability-sinks.test.js'), 'utf8'),
      required: [/persists sink config with a POSIX-only mode assertion/, /process\.platform !== 'win32'/],
      forbidden: [/private dedicated file/],
    },
    {
      surface: 'Sink setup test title',
      content: fs.readFileSync(path.join(repositoryRoot, 'plugins/observability/test/observability-setup.test.js'), 'utf8'),
      required: [/configures generic OTLP from stored local sink config/],
      forbidden: [/private sink config/],
    },
  ];

  for (const { surface, content, required, forbidden } of privacyClaims) {
    for (const pattern of required) assert.match(content, pattern, `${surface} is missing ${pattern}`);
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${surface} retains ${pattern}`);
  }
  assert.equal(marketplaceDescription, observabilityManifest.description, 'Marketplace and Observability manifest descriptions must match');

  const marketplaceReference = fs.readFileSync(path.join(contentRoot, 'reference/marketplace.md'), 'utf8');
  const observabilityReference = fs.readFileSync(path.join(contentRoot, 'reference/observability.md'), 'utf8');
  assert.ok(marketplaceReference.includes(sidequestDescription));
  assert.ok(marketplaceReference.includes(marketplaceDescription));
  assert.ok(observabilityReference.includes(observabilityManifest.description));
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
