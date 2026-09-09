'use strict';

function hasUnsupportedUnicodePropertyEscape(pattern) {
  for (let index = 0; index < pattern.length;) {
    if (pattern[index] !== '\\') {
      index += 1;
      continue;
    }

    const runStart = index;
    while (pattern[index] === '\\') index += 1;
    const hasPropertyName = pattern[index + 1] === '{' && pattern.indexOf('}', index + 2) !== -1;
    if ((index - runStart) % 2 === 1 && (pattern[index] === 'p' || pattern[index] === 'P') && hasPropertyName) {
      return true;
    }
  }
  return false;
}

function visitSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;

  if (typeof schema.pattern === 'string' && hasUnsupportedUnicodePropertyEscape(schema.pattern)) {
    delete schema.pattern;
  }

  visitSchemaMap(schema.properties);
  visitSchemaMap(schema.patternProperties);
  visitSchemaMap(schema.definitions);
  visitSchemaMap(schema.$defs);
  visitSchemaMap(schema.dependentSchemas);
  visitDependencySchemas(schema.dependencies);

  visitSchema(schema.additionalProperties);
  visitSchema(schema.unevaluatedProperties);
  visitSchema(schema.unevaluatedItems);
  visitSchema(schema.additionalItems);
  visitSchema(schema.contains);
  visitSchema(schema.contentSchema);
  visitSchema(schema.if);
  visitSchema(schema.then);
  visitSchema(schema.else);
  visitSchema(schema.not);
  visitSchema(schema.propertyNames);
  visitSchemaOrSchemas(schema.items);
  visitSchemaArray(schema.prefixItems);
  visitSchemaArray(schema.allOf);
  visitSchemaArray(schema.anyOf);
  visitSchemaArray(schema.oneOf);
}

function visitSchemaMap(schemas) {
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) return;
  for (const schema of Object.values(schemas)) visitSchema(schema);
}

function visitDependencySchemas(dependencies) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return;
  for (const dependency of Object.values(dependencies)) visitSchema(dependency);
}

function visitSchemaOrSchemas(schema) {
  if (Array.isArray(schema)) return visitSchemaArray(schema);
  visitSchema(schema);
}

function visitSchemaArray(schemas) {
  if (!Array.isArray(schemas)) return;
  for (const schema of schemas) visitSchema(schema);
}

function adaptCodexInputSchema(inputSchema) {
  const adaptedSchema = structuredClone(inputSchema);
  visitSchema(adaptedSchema);
  return adaptedSchema;
}

function adaptCodexToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || !Object.hasOwn(tool, 'input_schema')) return tool;
    return { ...tool, input_schema: adaptCodexInputSchema(tool.input_schema) };
  });
}

module.exports = {
  adaptCodexInputSchema,
  adaptCodexToolSchemas,
  hasUnsupportedUnicodePropertyEscape,
};
