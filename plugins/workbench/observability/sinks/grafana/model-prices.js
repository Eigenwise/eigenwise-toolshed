'use strict';

// List-price equivalents: Anthropic pricing is from https://platform.claude.com/docs/en/pricing;
// GPT-5.6 pricing is from https://openai.com/api/pricing/ (accessed 2026-07-25).
const ANTHROPIC_PRICES_PER_MILLION = {
  'claude-opus-4-6': { input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  'claude-opus-4-7': { input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  'claude-opus-4-8': { input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  'claude-sonnet-5': { input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  'claude-fable-5': { input: 10, cacheRead: 1, cacheCreation: 12.5, output: 50 },
  'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheCreation: 1.25, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, cacheRead: 0.1, cacheCreation: 1.25, output: 5 },
};

const CODEX_PRICES_PER_MILLION = {
  // OpenAI publishes fresh input, cached input, and output prices, but no cache-write price.
  // Claude Code can report cacheCreation for these routes, so price it as fresh input.
  'claude-codex-gpt-5.6-sol': { input: 5, cacheRead: 0.5, cacheCreation: 5, output: 30 },
  'claude-codex-gpt-5.6-terra': { input: 2.5, cacheRead: 0.25, cacheCreation: 2.5, output: 15 },
  'claude-codex-gpt-5.6-luna': { input: 1, cacheRead: 0.1, cacheCreation: 1, output: 6 },
};

const GATEWAY_RESOLVED_MODEL_ALIASES = {
  'gpt-5.6-sol': CODEX_PRICES_PER_MILLION['claude-codex-gpt-5.6-sol'],
  'gpt-5.6-terra': CODEX_PRICES_PER_MILLION['claude-codex-gpt-5.6-terra'],
  'gpt-5.6-luna': CODEX_PRICES_PER_MILLION['claude-codex-gpt-5.6-luna'],
};

const MODEL_PRICES_PER_MILLION = {
  ...ANTHROPIC_PRICES_PER_MILLION,
  'claude-opus-4-8[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-opus-4-8'],
  'claude-opus-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-opus-5'],
  'claude-sonnet-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-sonnet-5'],
  'claude-fable-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-fable-5'],
  ...CODEX_PRICES_PER_MILLION,
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

function escapePromqlRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\\\$&');
}

function modelCostExpression(model, prices, bucket = '$bucket') {
  return Object.entries(prices).map(([type, price]) =>
    `sum(increase(claude_code_token_usage_tokens_total{model="${model}",type="${type}",project_id=~"$project"}[${bucket}])) * ${price / 1_000_000}`,
  ).join(' + ');
}

function clientModelPriceEntries() {
  return Object.entries(MODEL_PRICES_PER_MILLION).filter(([model]) => !Object.hasOwn(GATEWAY_RESOLVED_MODEL_ALIASES, model));
}

function gatewayModelPriceEntries() {
  return Object.entries(MODEL_PRICES_PER_MILLION).filter(([model]) => !model.includes('[1m]') && !model.startsWith('claude-codex-'));
}

function modelCostTargets() {
  return clientModelPriceEntries().map(([model, prices], index) => ({
    refId: `M${index + 1}`,
    datasource: { type: 'prometheus', uid: 'prometheus' },
    expr: modelCostExpression(model, prices),
    legendFormat: model,
  }));
}

function gatewayModelCostExpression(model, prices, bucket = '$bucket') {
  const selector = `${GATEWAY_USAGE_SELECTOR} | workbench_attribute_model = "${model}"`;
  return Object.entries(prices).map(([type, price]) =>
    `sum(sum_over_time(${selector} | unwrap workbench_measurement_${GATEWAY_MEASUREMENT_BY_PRICE_TYPE[type]}_value [${bucket}])) * ${price / 1_000_000}`,
  ).join(' + ');
}

function gatewayModelCostTargets() {
  return gatewayModelPriceEntries().map(([model, prices], index) => ({
    refId: `G${index + 1}`,
    datasource: { type: 'loki', uid: 'loki' },
    expr: gatewayModelCostExpression(model, prices),
    legendFormat: model,
  }));
}

function gatewayCostExpression(entries, bucket = '$bucket') {
  return entries.map(([model, prices]) => `(${gatewayModelCostExpression(model, prices, bucket)})`).join(' + ');
}

function gatewayResolvedCodexCostExpression(bucket = '$bucket') {
  return gatewayCostExpression(Object.entries(GATEWAY_RESOLVED_MODEL_ALIASES), bucket);
}

function gatewayTotalCostExpression(bucket = '$bucket') {
  return gatewayCostExpression(gatewayModelPriceEntries(), bucket);
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
  gatewayResolvedCodexCostExpression,
  gatewayTotalCostExpression,
  modelCostExpression,
  modelCostTargets,
  unpricedModelsExpression,
};
