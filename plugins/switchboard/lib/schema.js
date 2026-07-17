'use strict';

const ROUTING_CONTRACT_VERSION = 1;
const CONFIG_SCHEMA_VERSION = 1;
const PROVIDER_NEUTRAL_DISPATCH_KINDS = ['native', 'gateway-marker'];
const ROUTE_SOURCES = ['primary', 'category-fallback', 'global-fallback', 'hard-default'];

const routeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'effort'],
  properties: {
    model: { type: 'string', minLength: 1 },
    effort: { type: ['string', 'null'] },
  },
};

const categoryConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'description', 'contract', 'route', 'fallback', 'enabled'],
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    contract: { type: 'string' },
    route: routeSchema,
    fallback: { anyOf: [routeSchema, { type: 'null' }] },
    enabled: { type: 'boolean' },
  },
};

const routingRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['contractVersion', 'categoryId'],
  properties: {
    contractVersion: { const: ROUTING_CONTRACT_VERSION },
    categoryId: { type: 'string', minLength: 1 },
    projectPath: { type: 'string', minLength: 1 },
    consumer: { type: 'string', minLength: 1 },
  },
};

const dispatchSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'spawnModel'],
      properties: {
        kind: { const: 'native' },
        spawnModel: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'spawnModel', 'dispatchModel', 'marker'],
      properties: {
        kind: { const: 'gateway-marker' },
        spawnModel: { type: 'string', minLength: 1 },
        dispatchModel: { type: 'string', minLength: 1 },
        marker: { type: 'string', pattern: '^\\[switchboard-route model=.+ effort=.+\\]$' },
      },
    },
  ],
};

const routingAttemptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'route', 'reason'],
  properties: {
    source: { enum: ROUTE_SOURCES },
    route: routeSchema,
    reason: { type: 'string', minLength: 1 },
  },
};

const routingResultSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'status', 'category', 'route', 'dispatch', 'attempts', 'warnings'],
      properties: {
        contractVersion: { const: ROUTING_CONTRACT_VERSION },
        status: { const: 'routed' },
        category: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'contract'],
          properties: {
            id: { type: 'string', minLength: 1 },
            contract: { type: 'string' },
          },
        },
        route: {
          type: 'object',
          additionalProperties: false,
          required: ['model', 'effort', 'source'],
          properties: Object.assign({}, routeSchema.properties, { source: { enum: ROUTE_SOURCES } }),
        },
        dispatch: dispatchSchema,
        attempts: { type: 'array', items: routingAttemptSchema },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'status', 'category', 'attempts', 'warnings'],
      properties: {
        contractVersion: { const: ROUTING_CONTRACT_VERSION },
        status: { const: 'unrouted' },
        category: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['id', 'contract'], properties: { id: { type: 'string', minLength: 1 }, contract: { type: 'string' } } }] },
        attempts: { type: 'array', items: routingAttemptSchema },
        warnings: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    },
  ],
};

const registryBreadcrumbSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'name', 'version', 'root', 'capabilities', 'routing'],
  properties: {
    schemaVersion: { const: CONFIG_SCHEMA_VERSION },
    name: { const: 'switchboard' },
    version: { type: 'string', minLength: 1 },
    root: { type: 'string', minLength: 1 },
    capabilities: { type: 'array', uniqueItems: true, contains: { const: 'routing' } },
    routing: {
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'command', 'adapter'],
      properties: {
        contractVersion: { const: ROUTING_CONTRACT_VERSION },
        command: { const: 'bin/switchboard.js routing resolve --request <json>' },
        adapter: { const: 'lib/contract.js' },
      },
    },
    ui: {
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'panels'],
      properties: {
        contractVersion: { const: ROUTING_CONTRACT_VERSION },
        panels: { type: 'array', items: { type: 'object' } },
      },
    },
  },
};

const routingPanelSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['contractVersion', 'categories', 'globalFallback', 'availableModels', 'warnings'],
  properties: {
    contractVersion: { const: ROUTING_CONTRACT_VERSION },
    categories: { type: 'array', items: categoryConfigSchema },
    globalFallback: { anyOf: [routeSchema, { type: 'null' }] },
    availableModels: { type: 'array', items: { type: 'object', required: ['model'], properties: { model: { type: 'string', minLength: 1 } } } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

module.exports = {
  ROUTING_CONTRACT_VERSION,
  CONFIG_SCHEMA_VERSION,
  PROVIDER_NEUTRAL_DISPATCH_KINDS,
  ROUTE_SOURCES,
  routeSchema,
  categoryConfigSchema,
  routingRequestSchema,
  dispatchSchema,
  routingAttemptSchema,
  routingResultSchema,
  registryBreadcrumbSchema,
  routingPanelSchema,
};
