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
};

const MODEL_PRICES_PER_MILLION = {
  ...ANTHROPIC_PRICES_PER_MILLION,
  'claude-opus-4-8[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-opus-4-8'],
  'claude-opus-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-opus-5'],
  'claude-sonnet-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-sonnet-5'],
  'claude-fable-5[1m]': ANTHROPIC_PRICES_PER_MILLION['claude-fable-5'],
  // OpenAI publishes fresh input, cached input, and output prices, but no cache-write price.
  // Claude Code can report cacheCreation for these routes, so price it as fresh input.
  'claude-codex-gpt-5.6-sol': { input: 5, cacheRead: 0.5, cacheCreation: 5, output: 30 },
  'claude-codex-gpt-5.6-terra': { input: 2.5, cacheRead: 0.25, cacheCreation: 2.5, output: 15 },
  'claude-codex-gpt-5.6-luna': { input: 1, cacheRead: 0.1, cacheCreation: 1, output: 6 },
};

function escapePromqlRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\\\$&');
}

function modelCostExpression(model, prices, bucket = '$bucket') {
  return Object.entries(prices).map(([type, price]) =>
    `sum(increase(claude_code_token_usage_tokens_total{model="${model}",type="${type}",project_id=~"$project"}[${bucket}])) * ${price / 1_000_000}`,
  ).join(' + ');
}

function modelCostTargets() {
  return Object.entries(MODEL_PRICES_PER_MILLION).map(([model, prices], index) => ({
    refId: `M${index + 1}`,
    datasource: { type: 'prometheus', uid: 'prometheus' },
    expr: modelCostExpression(model, prices),
    legendFormat: model,
  }));
}

function unpricedModelsExpression(bucket = '$bucket') {
  const models = Object.keys(MODEL_PRICES_PER_MILLION).map(escapePromqlRegex).join('|');
  return `sum by (model) (increase(claude_code_token_usage_tokens_total{model!~"${models}",project_id=~"$project"}[${bucket}]))`;
}

module.exports = { MODEL_PRICES_PER_MILLION, modelCostExpression, modelCostTargets, unpricedModelsExpression };
