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

function isSchemaObject(schema) {
  return Boolean(schema) && typeof schema === 'object' && !Array.isArray(schema);
}

function localReferenceTarget(reference, rootSchema) {
  if (reference === '#') return rootSchema;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return undefined;

  let target = rootSchema;
  for (const encodedSegment of reference.slice(2).split('/')) {
    let segment;
    try {
      segment = decodeURIComponent(encodedSegment).replaceAll('~1', '/').replaceAll('~0', '~');
    } catch {
      return undefined;
    }
    if (!isSchemaObject(target) || !Object.hasOwn(target, segment)) return undefined;
    target = target[segment];
  }
  return target;
}

function hasUnsupportedConstraint(schema, rootSchema, inspectedSchemas = new Set()) {
  if (!isSchemaObject(schema) || inspectedSchemas.has(schema)) return false;
  inspectedSchemas.add(schema);

  if (typeof schema.pattern === 'string' && hasUnsupportedUnicodePropertyEscape(schema.pattern)) return true;
  if (isSchemaObject(schema.patternProperties)
    && Object.keys(schema.patternProperties).some(hasUnsupportedUnicodePropertyEscape)) return true;

  const referenceTarget = localReferenceTarget(schema.$ref, rootSchema);
  if (hasUnsupportedConstraint(referenceTarget, rootSchema, inspectedSchemas)) return true;

  return schemaMapHasUnsupportedConstraint(schema.properties, rootSchema, inspectedSchemas)
    || schemaMapHasUnsupportedConstraint(schema.patternProperties, rootSchema, inspectedSchemas)
    || schemaMapHasUnsupportedConstraint(schema.definitions, rootSchema, inspectedSchemas)
    || schemaMapHasUnsupportedConstraint(schema.$defs, rootSchema, inspectedSchemas)
    || schemaMapHasUnsupportedConstraint(schema.dependentSchemas, rootSchema, inspectedSchemas)
    || schemaMapHasUnsupportedConstraint(schema.dependencies, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.additionalProperties, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.unevaluatedProperties, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.unevaluatedItems, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.additionalItems, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.contains, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.contentSchema, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.if, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.then, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.else, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.not, rootSchema, inspectedSchemas)
    || hasUnsupportedConstraint(schema.propertyNames, rootSchema, inspectedSchemas)
    || schemaOrSchemasHaveUnsupportedConstraint(schema.items, rootSchema, inspectedSchemas)
    || schemaArrayHasUnsupportedConstraint(schema.prefixItems, rootSchema, inspectedSchemas)
    || schemaArrayHasUnsupportedConstraint(schema.allOf, rootSchema, inspectedSchemas)
    || schemaArrayHasUnsupportedConstraint(schema.anyOf, rootSchema, inspectedSchemas)
    || schemaArrayHasUnsupportedConstraint(schema.oneOf, rootSchema, inspectedSchemas);
}

function schemaMapHasUnsupportedConstraint(schemas, rootSchema, inspectedSchemas) {
  return isSchemaObject(schemas)
    && Object.values(schemas).some((schema) => hasUnsupportedConstraint(schema, rootSchema, inspectedSchemas));
}

function schemaOrSchemasHaveUnsupportedConstraint(schema, rootSchema, inspectedSchemas) {
  return Array.isArray(schema)
    ? schemaArrayHasUnsupportedConstraint(schema, rootSchema, inspectedSchemas)
    : hasUnsupportedConstraint(schema, rootSchema, inspectedSchemas);
}

function schemaArrayHasUnsupportedConstraint(schemas, rootSchema, inspectedSchemas) {
  return Array.isArray(schemas)
    && schemas.some((schema) => hasUnsupportedConstraint(schema, rootSchema, inspectedSchemas));
}

function adaptSchema(schema, rootSchema) {
  if (!isSchemaObject(schema)) return false;

  let changed = hasUnsupportedConstraint(localReferenceTarget(schema.$ref, rootSchema), rootSchema);
  if (typeof schema.pattern === 'string' && hasUnsupportedUnicodePropertyEscape(schema.pattern)) {
    delete schema.pattern;
    changed = true;
  }

  const patternPropertiesResult = adaptPatternProperties(schema.patternProperties, rootSchema);
  changed = patternPropertiesResult.changed || changed;
  if (patternPropertiesResult.removedPattern) {
    delete schema.additionalProperties;
    delete schema.unevaluatedProperties;
  }

  changed = adaptSchemaMap(schema.properties, rootSchema) || changed;
  changed = adaptSchemaMap(schema.definitions, rootSchema) || changed;
  changed = adaptSchemaMap(schema.$defs, rootSchema) || changed;
  changed = adaptSchemaMap(schema.dependentSchemas, rootSchema) || changed;
  changed = adaptSchemaMap(schema.dependencies, rootSchema) || changed;

  if (hasUnsupportedConstraint(schema.not, rootSchema)) {
    delete schema.not;
    changed = true;
  } else {
    changed = adaptSchema(schema.not, rootSchema) || changed;
  }

  if (hasUnsupportedConstraint(schema.if, rootSchema)) {
    delete schema.if;
    delete schema.then;
    delete schema.else;
    changed = true;
  } else {
    changed = adaptSchema(schema.if, rootSchema) || changed;
    changed = adaptSchema(schema.then, rootSchema) || changed;
    changed = adaptSchema(schema.else, rootSchema) || changed;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.some((branch) => hasUnsupportedConstraint(branch, rootSchema))) {
    const widenedBranches = schema.oneOf;
    delete schema.oneOf;
    if (Array.isArray(schema.allOf)) {
      schema.allOf.push({ anyOf: widenedBranches });
    } else {
      schema.allOf = [{ anyOf: widenedBranches }];
    }
    changed = true;
    changed = adaptSchemaArray(widenedBranches, rootSchema) || changed;
  } else {
    changed = adaptSchemaArray(schema.oneOf, rootSchema) || changed;
  }

  changed = adaptSchema(schema.additionalProperties, rootSchema) || changed;
  changed = adaptSchema(schema.unevaluatedProperties, rootSchema) || changed;
  changed = adaptSchema(schema.unevaluatedItems, rootSchema) || changed;
  changed = adaptSchema(schema.additionalItems, rootSchema) || changed;

  const containsChanged = adaptSchema(schema.contains, rootSchema);
  changed = containsChanged || changed;
  if (containsChanged) delete schema.maxContains;

  changed = adaptSchema(schema.contentSchema, rootSchema) || changed;
  changed = adaptSchema(schema.propertyNames, rootSchema) || changed;
  changed = adaptSchemaOrSchemas(schema.items, rootSchema) || changed;
  changed = adaptSchemaArray(schema.prefixItems, rootSchema) || changed;
  changed = adaptSchemaArray(schema.allOf, rootSchema) || changed;
  changed = adaptSchemaArray(schema.anyOf, rootSchema) || changed;

  return changed;
}

function adaptPatternProperties(patternProperties, rootSchema) {
  if (!isSchemaObject(patternProperties)) return { changed: false, removedPattern: false };

  let changed = false;
  let removedPattern = false;
  for (const [pattern, schema] of Object.entries(patternProperties)) {
    if (hasUnsupportedUnicodePropertyEscape(pattern)) {
      delete patternProperties[pattern];
      changed = true;
      removedPattern = true;
    } else {
      changed = adaptSchema(schema, rootSchema) || changed;
    }
  }
  return { changed, removedPattern };
}

function adaptSchemaMap(schemas, rootSchema) {
  if (!isSchemaObject(schemas)) return false;
  let changed = false;
  for (const schema of Object.values(schemas)) changed = adaptSchema(schema, rootSchema) || changed;
  return changed;
}

function adaptSchemaOrSchemas(schema, rootSchema) {
  return Array.isArray(schema)
    ? adaptSchemaArray(schema, rootSchema)
    : adaptSchema(schema, rootSchema);
}

function adaptSchemaArray(schemas, rootSchema) {
  if (!Array.isArray(schemas)) return false;
  let changed = false;
  for (const schema of schemas) changed = adaptSchema(schema, rootSchema) || changed;
  return changed;
}

function adaptCodexInputSchema(inputSchema) {
  const adaptedSchema = structuredClone(inputSchema);
  const originalSchema = structuredClone(inputSchema);
  adaptSchema(adaptedSchema, originalSchema);
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
