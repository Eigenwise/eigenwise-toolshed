'use strict';

// List-price equivalents: Anthropic pricing is from https://platform.claude.com/docs/en/pricing;
// GPT-5.6 pricing is from https://openai.com/api/pricing/ (accessed 2026-07-25).
// GPT-6 Astra pricing is from https://developers.openai.com/api/docs/models/gpt-6-astra
// (accessed 2026-09-07). OpenAI applies its long-context rate to the full request.
const ANTHROPIC_PRICES_PER_MILLION = {
  'claude-opus-4-6': { input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  'claude-opus-4-7': { input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  'claude-opus-4-8': { input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  'claude-sonnet-5': { input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  'claude-fable-5': { input: 10, cacheRead: 1, cacheCreation: 12.5, output: 50 },
  'claude-fable-5-1': { input: 10, cacheRead: 1, cacheCreation: 12.5, output: 50 },
  'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheCreation: 1.25, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, cacheRead: 0.1, cacheCreation: 1.25, output: 5 },
};

const CODEX_PRICES_PER_MILLION = {
  // OpenAI publishes fresh input, cached input, and output prices, but no cache-write price.
  // Claude Code can report cacheCreation for these routes, so price it as fresh input.
  'claude-gpt-5.6-sol': { input: 5, cacheRead: 0.5, cacheCreation: 5, output: 30 },
  'claude-gpt-5.6-terra': { input: 2.5, cacheRead: 0.25, cacheCreation: 2.5, output: 15 },
  'claude-gpt-5.6-luna': { input: 1, cacheRead: 0.1, cacheCreation: 1, output: 6 },
};

const ASTRA_INPUT_TOKEN_THRESHOLD = 272_000;
const ASTRA_STANDARD_PRICES_PER_MILLION = {
  short: { input: 10, cacheRead: 1, cacheCreation: 12.5, output: 50 },
  long: { input: 20, cacheRead: 2, cacheCreation: 25, output: 75 },
};
const ASTRA_FAST_PRICES_PER_MILLION = {
  short: { input: 20, cacheRead: 2, cacheCreation: 25, output: 100 },
  long: { input: 40, cacheRead: 4, cacheCreation: 50, output: 150 },
};

function astraPrices(short, long) {
  return { inputTokenThreshold: ASTRA_INPUT_TOKEN_THRESHOLD, short, long };
}

const CODEX_ASTRA_PRICES_PER_MILLION = {
  'claude-gpt-6-astra': astraPrices(ASTRA_STANDARD_PRICES_PER_MILLION.short, ASTRA_STANDARD_PRICES_PER_MILLION.long),
  'claude-gpt-6-astra[1m]': astraPrices(ASTRA_STANDARD_PRICES_PER_MILLION.short, ASTRA_STANDARD_PRICES_PER_MILLION.long),
  'claude-gpt-6-astra-fast': astraPrices(ASTRA_FAST_PRICES_PER_MILLION.short, ASTRA_FAST_PRICES_PER_MILLION.long),
  'claude-gpt-6-astra-fast[1m]': astraPrices(ASTRA_FAST_PRICES_PER_MILLION.short, ASTRA_FAST_PRICES_PER_MILLION.long),
};

// SQ-1004 renamed the advertised ids. Roughly half a million telemetry rows
// carry the old labels, so they stay priced instead of falling into the
// unpriced-models panel.
const LEGACY_CODEX_PRICES_PER_MILLION = {
  'claude-codex-gpt-5.6-sol': CODEX_PRICES_PER_MILLION['claude-gpt-5.6-sol'],
  'claude-codex-gpt-5.6-terra': CODEX_PRICES_PER_MILLION['claude-gpt-5.6-terra'],
  'claude-codex-gpt-5.6-luna': CODEX_PRICES_PER_MILLION['claude-gpt-5.6-luna'],
};

const GATEWAY_RESOLVED_MODEL_ALIASES = {
  'gpt-5.6-sol': CODEX_PRICES_PER_MILLION['claude-gpt-5.6-sol'],
  'gpt-5.6-terra': CODEX_PRICES_PER_MILLION['claude-gpt-5.6-terra'],
  'gpt-5.6-luna': CODEX_PRICES_PER_MILLION['claude-gpt-5.6-luna'],
  'gpt-6-astra': CODEX_ASTRA_PRICES_PER_MILLION['claude-gpt-6-astra'],
  'gpt-6-astra-fast': CODEX_ASTRA_PRICES_PER_MILLION['claude-gpt-6-astra-fast'],
};

const MODEL_PRICES_PER_MILLION = {
  ...ANTHROPIC_PRICES_PER_MILLION,
  'claude-opus-4-8[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-opus-4-8'],
  'claude-opus-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-opus-5'],
  'claude-sonnet-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-sonnet-5'],
  'claude-fable-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-fable-5'],
  'claude-fable-5-1[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-fable-5-1'],
  ...CODEX_PRICES_PER_MILLION,
  ...CODEX_ASTRA_PRICES_PER_MILLION,
  ...LEGACY_CODEX_PRICES_PER_MILLION,
  ...GATEWAY_RESOLVED_MODEL_ALIASES,
};

// SQ-982: this virtual dispatch id is client-side only, so its tier cannot be
// recovered or priced there; gateway.token.usage records the resolved model.
const UNPRICEABLE_VIRTUAL_DISPATCH_MODELS = ['claude-codex-auto'];
const GATEWAY_USAGE_SELECTOR = '{service_name="workbench-observer"} |= "gateway.token.usage" | workbench_session_id !~ "(probe|session-gateway).*"';
const GATEWAY_MEASUREMENT_BY_PRICE_TYPE = {
  input: 'input_tokens',
  cacheRead: 'cache_read_tokens',
  cacheCreation: 'cache_creation_tokens',
  output: 'output_tokens',
};

function isInputTieredPrice(prices) {
  return Object.hasOwn(prices, 'inputTokenThreshold');
}

function requestInputTokens(tokenUsage) {
  return ['input', 'cacheRead', 'cacheCreation'].reduce(
    (total, type) => total + (Number.isFinite(tokenUsage[type]) ? tokenUsage[type] : 0),
    0,
  );
}

function pricesForRequest(prices, tokenUsage) {
  if (!isInputTieredPrice(prices)) return prices;
  return requestInputTokens(tokenUsage) > prices.inputTokenThreshold ? prices.long : prices.short;
}

function modelRequestCost(model, tokenUsage) {
  const prices = MODEL_PRICES_PER_MILLION[model];
  if (!prices) return null;
  const requestPrices = pricesForRequest(prices, tokenUsage);
  return Object.entries(GATEWAY_MEASUREMENT_BY_PRICE_TYPE).reduce(
    (total, [type]) => total + ((Number.isFinite(tokenUsage[type]) ? tokenUsage[type] : 0) * requestPrices[type] / 1_000_000),
    0,
  );
}

function escapePromqlRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\\\$&');
}

function modelCostExpression(model, prices, bucket = '$bucket') {
  if (isInputTieredPrice(prices)) {
    throw new Error(`${model} requires per-request pricing from gateway.token.usage`);
  }
  return Object.entries(prices).map(([type, price]) =>
    `sum(increase(claude_code_token_usage_tokens_total{model="${model}",type="${type}",project_id=~"$project"}[${bucket}])) * ${price / 1_000_000}`,
  ).join(' + ');
}

function clientModelPriceEntries() {
  return Object.entries(MODEL_PRICES_PER_MILLION).filter(([model, prices]) =>
    !Object.hasOwn(GATEWAY_RESOLVED_MODEL_ALIASES, model) && !isInputTieredPrice(prices));
}

// Gateway records carry the model the backend actually ran, so the client-side
// advertised ids are excluded by name. A prefix test can't do that any more:
// the advertised ids now start with plain `claude-`, same as the Anthropic ones.
function gatewayModelPriceEntries() {
  const clientOnly = new Set([
    ...Object.keys(CODEX_PRICES_PER_MILLION),
    ...Object.keys(CODEX_ASTRA_PRICES_PER_MILLION),
    ...Object.keys(LEGACY_CODEX_PRICES_PER_MILLION),
  ]);
  return Object.entries(MODEL_PRICES_PER_MILLION).filter(([model]) => !model.includes('[1m]') && !clientOnly.has(model));
}

function modelCostTargets() {
  return clientModelPriceEntries().map(([model, prices], index) => ({
    refId: `M${index + 1}`,
    datasource: { type: 'prometheus', uid: 'prometheus' },
    expr: modelCostExpression(model, prices),
    legendFormat: model,
  }));
}

function escapeLogqlRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

const GATEWAY_REQUEST_INPUT_TOKENS_TEMPLATE = '(add (add (default "0" .workbench_measurement_input_tokens_value) (default "0" .workbench_measurement_cache_read_tokens_value)) (default "0" .workbench_measurement_cache_creation_tokens_value))';

// One leg per token type instead of one per (model, token type). The price moves into a
// label so a single scan covers every model: 48 legs sharing one unnarrowed selector made
// Loki reread the whole stream 48 times, measured at 229MB to return one number, against
// a window holding ~5,500 entries (SQ-1521). Collapsed, the same window reads 18MB.
function gatewayPriceTemplate(entries, type) {
  const priceInCents = (price) => price * 100;
  const requestPriceTemplate = ([, prices]) => {
    if (!isInputTieredPrice(prices)) return priceInCents(prices[type]);
    return `{{ if gt ${GATEWAY_REQUEST_INPUT_TOKENS_TEMPLATE} ${prices.inputTokenThreshold} }}${priceInCents(prices.long[type])}{{ else }}${priceInCents(prices.short[type])}{{ end }}`;
  };
  const [first, ...rest] = entries;
  return `{{ if eq .workbench_attribute_model ${JSON.stringify(first[0])} }}${requestPriceTemplate(first)}${rest.map((entry) => `{{ else if eq .workbench_attribute_model ${JSON.stringify(entry[0])} }}${requestPriceTemplate(entry)}`).join('')}{{ else }}0{{ end }}`;
}

function gatewayUsageExpression(entries, type, bucket = '$bucket', extraFilter = '') {
  const measurement = GATEWAY_MEASUREMENT_BY_PRICE_TYPE[type];
  const priceTemplate = gatewayPriceTemplate(entries, type);
  return `sum by (workbench_attribute_model) (sum_over_time(${GATEWAY_USAGE_SELECTOR}${extraFilter} | label_format workbench_price=\`${priceTemplate}\` | workbench_price != "0" | label_format workbench_measurement_priced_value=\`{{ mul .workbench_measurement_${measurement}_value .workbench_price }}\` | unwrap workbench_measurement_priced_value [${bucket}])) / 100000000`;
}

// The gateway writes one resolved model per request. Requested aliases would count the
// same request again, so this view groups only that resolved label and sums each exact
// provider bucket once.
function gatewayUnpricedModelUsageExpression(bucket = '$bucket', extraFilter = '') {
  const pricedModels = gatewayModelPriceEntries()
    .map(([model]) => escapeLogqlRegex(model))
    .join('|');
  const unpricedFilter = ` | workbench_attribute_model !~ ${JSON.stringify(pricedModels)}`;
  const tokenMeasurements = Object.values(GATEWAY_MEASUREMENT_BY_PRICE_TYPE)
    .map((measurement) => `(default "0" .workbench_measurement_${measurement}_value)`)
    .join(' ');
  return `sum by (workbench_attribute_model) (sum_over_time(${GATEWAY_USAGE_SELECTOR}${extraFilter}${unpricedFilter} | label_format workbench_measurement_total_tokens=\`{{ add ${tokenMeasurements} }}\` | unwrap workbench_measurement_total_tokens [${bucket}]))`;
}

function gatewayModelCostExpression(entries, bucket = '$bucket', extraFilter = '') {
  return Object.keys(GATEWAY_MEASUREMENT_BY_PRICE_TYPE).map((type) =>
    gatewayUsageExpression(entries, type, bucket, extraFilter),
  ).join(' + ');
}

function gatewayModelCostTargets() {
  return [{
    refId: 'G1',
    datasource: { type: 'loki', uid: 'loki' },
    expr: gatewayModelCostExpression(gatewayModelPriceEntries()),
    legendFormat: '{{workbench_attribute_model}}',
  }];
}

function gatewayUnpricedModelUsageTargets() {
  return [{
    refId: 'U1',
    datasource: { type: 'loki', uid: 'loki' },
    expr: gatewayUnpricedModelUsageExpression(),
    legendFormat: '{{workbench_attribute_model}}',
  }];
}

function gatewayCostExpression(entries, bucket = '$bucket', extraFilter = '') {
  return `(sum(${gatewayModelCostExpression(entries, bucket, extraFilter)})) or vector(0)`;
}

function gatewayResolvedCodexCostExpression(bucket = '$bucket') {
  return gatewayCostExpression(Object.entries(GATEWAY_RESOLVED_MODEL_ALIASES), bucket);
}

function gatewayTotalCostExpression(bucket = '$bucket', extraFilter = '') {
  return gatewayCostExpression(gatewayModelPriceEntries(), bucket, extraFilter);
}

// No vector(0) fallback here: with it, a project with no priced usage in the window renders as
// a permanent $0.00 row in the legend and tooltip instead of dropping out. Stat panels keep the
// fallback so an idle range still reads $0 rather than "no data".
function gatewayProjectCostExpression(extraFilter) {
  return `sum(${gatewayModelCostExpression(gatewayModelPriceEntries(), '$bucket', extraFilter)})`;
}

function gatewayProjectCostTargets(projects) {
  const targets = projects.map(({ project_name: projectName }, index) => ({
    refId: `P${index + 1}`,
    datasource: { type: 'loki', uid: 'loki' },
    expr: gatewayProjectCostExpression(` | workbench_attribute_project_name = ${JSON.stringify(projectName)}`),
    legendFormat: projectName,
  }));
  const knownProjects = projects.map(({ project_name: projectName }) => escapeLogqlRegex(projectName)).join('|');
  const otherProjectsFilter = knownProjects
    ? ` | workbench_attribute_project_name !~ ${JSON.stringify(knownProjects)}`
    : '';
  targets.push({
    refId: `P${targets.length + 1}`,
    datasource: { type: 'loki', uid: 'loki' },
    expr: gatewayProjectCostExpression(otherProjectsFilter),
    legendFormat: 'Other / unattributed',
  });
  return targets;
}

function unpricedModelsExpression(bucket = '$bucket') {
  const models = [...Object.keys(MODEL_PRICES_PER_MILLION), ...UNPRICEABLE_VIRTUAL_DISPATCH_MODELS]
    .map(escapePromqlRegex)
    .join('|');
  return `sum by (model) (increase(claude_code_token_usage_tokens_total{model!~"${models}",project_id=~"$project"}[${bucket}]))`;
}

module.exports = {
  MODEL_PRICES_PER_MILLION,
  UNPRICEABLE_VIRTUAL_DISPATCH_MODELS,
  gatewayModelCostTargets,
  gatewayProjectCostTargets,
  gatewayResolvedCodexCostExpression,
  gatewayTotalCostExpression,
  gatewayUnpricedModelUsageExpression,
  gatewayUnpricedModelUsageTargets,
  modelCostExpression,
  modelCostTargets,
  modelRequestCost,
  requestInputTokens,
  unpricedModelsExpression,
};
