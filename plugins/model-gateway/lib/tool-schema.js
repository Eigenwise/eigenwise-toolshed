'use strict';

// Claude's Artifact name pattern requires Unicode-aware regex validation,
// which the Codex backend rejects before the model can answer.
const ARTIFACT_NAME_PATTERN = String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`;

function normalizeCodexArtifactSchema(tools) {
  if (!Array.isArray(tools)) return;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.pattern === ARTIFACT_NAME_PATTERN) delete node.pattern;
    for (const child of Object.values(node)) visit(child);
  };
  for (const tool of tools) {
    if (tool?.name === 'Artifact') visit(tool.input_schema);
  }
}

module.exports = { normalizeCodexArtifactSchema };
