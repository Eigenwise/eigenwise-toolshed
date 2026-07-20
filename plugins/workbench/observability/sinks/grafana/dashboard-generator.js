'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  const matcher = `project_id${projectMatchers(projects, 'project_id')}`;
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

function filterDashboard(dashboard, projects) {
  for (const panel of dashboard.panels) {
    for (const target of panel.targets || []) {
      if (typeof target.expr !== 'string') continue;
      target.expr = filterPrometheus(target.expr, projects);
      target.expr = filterLoki(target.expr, projects);
    }
  }
  dashboard.templating = { list: [] };
  return dashboard;
}

function unattributedPanel(projects) {
  const allowed = projects.map((project) => escapeRegex(project.project_name)).join('|') || '$^';
  const selector = `{service_name="workbench-observer"} |= "gateway.token.usage" | workbench_session_id !~ "(probe|session-gateway).*" | workbench_attribute_project_name !~ ${quoted(allowed)}`;
  return {
    id: 108,
    title: 'Unattributed sessions',
    description: 'Sessions and context-token volume excluded from opted-in project dashboards.',
    type: 'stat',
    datasource: { type: 'loki', uid: 'loki' },
    gridPos: { x: 20, y: 1, w: 4, h: 4 },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '' }, orientation: 'auto', textMode: 'auto', colorMode: 'value', graphMode: 'none', justifyMode: 'auto' },
    fieldConfig: { defaults: { noValue: '0' }, overrides: [] },
    targets: [
      {
        refId: 'Sessions',
        expr: `count(sum by (workbench_session_id) (count_over_time(${selector} [$__range])))`,
        legendFormat: 'sessions',
        instant: true,
      },
      {
        refId: 'Context',
        expr: `sum(sum_over_time(${selector} | unwrap workbench_measurement_context_tokens_value [$__range]))`,
        legendFormat: 'context tokens',
        instant: true,
      },
    ],
  };
}

function globalDashboard(template, projects) {
  if (projects.length === 0) {
    return {
      ...template,
      title: 'Claude Code Usage',
      uid: 'claude-code-usage',
      panels: [unattributedPanel(projects)],
      templating: { list: [] },
    };
  }
  const dashboard = filterDashboard(template, projects);
  const topStats = dashboard.panels.filter((panel) => panel.gridPos?.y === 1 && panel.gridPos?.h === 4).slice(0, 4);
  for (const [index, panel] of topStats.entries()) {
    panel.gridPos = { ...panel.gridPos, x: index * 5, w: 5 };
  }
  dashboard.panels.push(unattributedPanel(projects));
  return dashboard;
}

function perProjectDashboard(template, project) {
  const dashboard = filterDashboard(template, [project]);
  dashboard.title = `Claude Code — ${project.project_name}`;
  dashboard.uid = `claude-code-${project.project_id.slice(0, 16)}`;
  return dashboard;
}

function generatedDashboards(projects, template = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'))) {
  const registered = registeredProjects(projects);
  return [
    { fileName: 'claude-code-usage.json', dashboard: globalDashboard(structuredClone(template), registered) },
    ...registered.map((project) => ({
      fileName: `claude-code-${project.project_id.slice(0, 16)}.json`,
      dashboard: perProjectDashboard(structuredClone(template), project),
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
  GENERATED_DIRECTORY,
  generatedDashboards,
  provisionDashboards,
  registeredProjects,
};
