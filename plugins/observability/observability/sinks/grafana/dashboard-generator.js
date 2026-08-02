'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  gatewayModelCostTargets,
  gatewayResolvedCodexCostExpression,
  gatewayTotalCostExpression,
  modelCostTargets,
  unpricedModelsExpression,
} = require('./model-prices');

const TEMPLATE_FILE = path.join(__dirname, 'dashboards', 'claude-code-usage.json');
const GENERATED_DIRECTORY = 'grafana-dashboards';
const PROJECT_ID = /^[a-f0-9]{64}$/;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;

function registeredProjects(projects) {
  const unique = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || !PROJECT_ID.test(project.project_id) || !PROJECT_NAME.test(project.project_name)) continue;
    unique.set(project.project_id, { project_id: project.project_id, project_name: project.project_name });
  }
  return [...unique.values()].sort((left, right) => left.project_name.localeCompare(right.project_name));
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function quoted(value) {
  return JSON.stringify(value);
}

function projectMatchers(projects, kind) {
  const values = projects.map((project) => project[kind]);
  if (values.length === 1) return `=${quoted(values[0])}`;
  if (values.length === 0) return '=~"$^"';
  return `=~${quoted(values.map(escapeRegex).join('|'))}`;
}

function filterPrometheus(expression, projects) {
  // The claude_code metrics carry the sanitized project BASENAME in their
  // project_id label (OTEL_RESOURCE_ATTRIBUTES project.id), not the registry's
  // sha256 project_id — matching on the hash starves every panel.
  const matcher = `project_id${projectMatchers(projects, 'project_name')}`;
  const filtered = expression.replace(/project_id=~"\$project"/g, matcher);
  if (filtered.includes('claude_code_') && !filtered.includes(matcher)) {
    throw new Error(`Dashboard query is missing its project filter: ${expression}`);
  }
  return filtered;
}

function filterLoki(expression, projects) {
  const matcher = `workbench_attribute_project_name${projectMatchers(projects, 'project_name')}`;
  return expression.replaceAll('{service_name="workbench-observer"}', `{service_name="workbench-observer"} | ${matcher}`);
}

// MCP events have no project attribution; offload share measures board-wide routing.
const PROJECT_UNSCOPED_PANELS = new Set(['MCP connection activity', 'Work moved off the Anthropic limit']);

// The project selector is baked into every query, so its variable is dropped.
// Every other declared variable has to survive generation.
const BAKED_IN_VARIABLES = new Set(['project']);

const VARIABLE_REFERENCE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

function referencedVariables(dashboard) {
  const referenced = new Set();
  for (const panel of dashboard.panels) {
    const sources = [panel.interval, ...(panel.targets || []).map(({ expr }) => expr)];
    for (const source of sources) {
      if (typeof source !== 'string') continue;
      for (const [, name] of source.matchAll(VARIABLE_REFERENCE)) {
        if (!name.startsWith('__')) referenced.add(name);
      }
    }
  }
  return referenced;
}

// A panel that survives generation while its variable does not reaches Grafana
// with a literal "$bucket" range selector, which fails the whole panel with
// "Invalid interval string" instead of degrading.
function assertVariablesResolve(dashboard) {
  const declared = new Set(dashboard.templating.list.map(({ name }) => name));
  const undeclared = [...referencedVariables(dashboard)].filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new Error(`Dashboard references undeclared variables: ${undeclared.sort().join(', ')}`);
  }
  return dashboard;
}

const GRID_WIDTH = 24;

// The template lays panels out in bands: every panel in a band shares its y and
// the band spans the full grid width. Dropping a panel would leave a hole its
// neighbours never fill — Grafana keeps the surviving coordinates and shows
// dead space — so survivors stretch back across the band and the bands restack.
function relayout(panels) {
  const bands = [];
  for (const panel of [...panels].sort((left, right) => left.gridPos.y - right.gridPos.y || left.gridPos.x - right.gridPos.x)) {
    const band = bands.at(-1);
    if (band && band.y === panel.gridPos.y) band.members.push(panel);
    else bands.push({ y: panel.gridPos.y, members: [panel] });
  }
  let y = 0;
  for (const { members } of bands) {
    const span = members.reduce((total, { gridPos }) => total + gridPos.w, 0);
    if (span > GRID_WIDTH) {
      throw new Error(`Dashboard band at y=${members[0].gridPos.y} is ${span} columns wide, so its panels overlap`);
    }
    let x = 0;
    members.forEach((panel, index) => {
      const width = index === members.length - 1 ? GRID_WIDTH - x : Math.round((panel.gridPos.w / span) * GRID_WIDTH);
      panel.gridPos = { x, y, w: width, h: panel.gridPos.h };
      x += width;
    });
    y += Math.max(...members.map(({ gridPos }) => gridPos.h));
  }
  return bands.flatMap(({ members }) => members);
}

function filterDashboard(dashboard, projects, dropped = new Set()) {
  for (const panel of dashboard.panels) {
    for (const target of panel.targets || []) {
      if (typeof target.expr !== 'string') continue;
      if (PROJECT_UNSCOPED_PANELS.has(panel.title)) {
        if (target.expr.includes('$project')) {
          throw new Error(`Project-unscoped panel cannot use $project: ${panel.title}`);
        }
        continue;
      }
      target.expr = filterPrometheus(target.expr, projects);
      target.expr = filterLoki(target.expr, projects);
    }
  }
  dashboard.panels = relayout(dashboard.panels.filter(({ title }) => !dropped.has(title)));
  dashboard.templating = {
    list: dashboard.templating.list.filter(({ name }) => !BAKED_IN_VARIABLES.has(name)),
  };
  return assertVariablesResolve(dashboard);
}

function globalDashboard(template, projects) {
  return filterDashboard(template, projects);
}

// By-project breakdowns can only ever show the board's own project — global-only.
const GLOBAL_ONLY_PANELS = new Set(['Usage by project', 'Cost over time, by project']);

const EMPTY_STATE_TITLE = 'Telemetry in the selected range';
const EMPTY_STATE_MESSAGE = 'No Claude Code metrics in this range. Sessions may be running in directories that never got the telemetry env: run /workbench:enable-project-telemetry in this repository, then restart Claude Code there.';

// A project with no samples rendered exactly like an idle one, so a half-wired repository
// read as "quiet" instead of broken. The empty state has to be said out loud on the one
// dashboard that can tell the difference (SQ-883).
function emptyStatePanel() {
  const datasource = { type: 'prometheus', uid: 'prometheus' };
  return {
    id: 900,
    title: EMPTY_STATE_TITLE,
    description: EMPTY_STATE_MESSAGE,
    type: 'stat',
    datasource,
    gridPos: { x: 0, y: -1, w: 24, h: 3 },
    options: {
      reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '' },
      orientation: 'horizontal',
      colorMode: 'value',
      graphMode: 'none',
      textMode: 'value',
      justifyMode: 'auto',
    },
    fieldConfig: {
      defaults: {
        noValue: EMPTY_STATE_MESSAGE,
        mappings: [{
          type: 'range',
          options: { from: 1, to: null, result: { text: 'Receiving telemetry', color: 'green', index: 0 } },
        }],
      },
      overrides: [],
    },
    targets: [{
      refId: 'A',
      datasource,
      expr: 'count(count_over_time(claude_code_token_usage_tokens_total{project_id=~"$project"}[$__range]))',
      instant: true,
    }],
  };
}

function perProjectDashboard(template, project) {
  template.panels = [emptyStatePanel(), ...template.panels];
  const dashboard = filterDashboard(template, [project], new Set([...GLOBAL_ONLY_PANELS, ...PROJECT_UNSCOPED_PANELS]));
  dashboard.title = `Claude Code — ${project.project_name}`;
  dashboard.uid = `claude-code-${project.project_id.slice(0, 16)}`;
  return dashboard;
}

function applyModelPricing(dashboard) {
  const costPanel = dashboard.panels.find(({ title }) => title === 'Cost over time, by model');
  if (costPanel) costPanel.targets = modelCostTargets();
  const gatewayCostPanel = dashboard.panels.find(({ title }) => title === 'Cost over time, by resolved model (gateway)');
  if (gatewayCostPanel) gatewayCostPanel.targets = gatewayModelCostTargets();
  const unpricedPanel = dashboard.panels.find(({ title }) => title === 'Unpriced model usage');
  if (unpricedPanel) unpricedPanel.targets[0].expr = unpricedModelsExpression();
  const offloadPanel = dashboard.panels.find(({ title }) => title === 'Work moved off the Anthropic limit');
  if (offloadPanel) {
    const codexCost = gatewayResolvedCodexCostExpression('$__range');
    const totalCost = gatewayTotalCostExpression('$__range');
    offloadPanel.datasource = { type: 'loki', uid: 'loki' };
    offloadPanel.targets = [
      {
        refId: 'A',
        datasource: offloadPanel.datasource,
        expr: `(100 * (${codexCost}) / (${totalCost})) and ((${totalCost}) > 0)`,
        legendFormat: 'Share routed to Codex',
        instant: true,
      },
      {
        refId: 'B',
        datasource: offloadPanel.datasource,
        expr: codexCost,
        legendFormat: 'Codex list-price equivalent',
        instant: true,
      },
      {
        refId: 'C',
        datasource: offloadPanel.datasource,
        expr: totalCost,
        legendFormat: 'Total list-price equivalent',
        instant: true,
      },
    ];
  }
  return dashboard;
}

function generatedDashboards(projects, template = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'))) {
  const pricedTemplate = applyModelPricing(template);
  const registered = registeredProjects(projects);
  return [
    { fileName: 'claude-code-usage.json', dashboard: globalDashboard(structuredClone(pricedTemplate), registered) },
    ...registered.map((project) => ({
      fileName: `claude-code-${project.project_id.slice(0, 16)}.json`,
      dashboard: perProjectDashboard(structuredClone(pricedTemplate), project),
    })),
  ];
}

function provisionDashboards(dataDir, projects) {
  const directory = path.join(dataDir, GENERATED_DIRECTORY);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { fileName, dashboard } of generatedDashboards(projects)) {
    fs.writeFileSync(path.join(directory, fileName), `${JSON.stringify(dashboard, null, 2)}\n`, { mode: 0o600 });
  }
  return directory;
}

module.exports = {
  EMPTY_STATE_TITLE,
  GENERATED_DIRECTORY,
  generatedDashboards,
  provisionDashboards,
  registeredProjects,
};
