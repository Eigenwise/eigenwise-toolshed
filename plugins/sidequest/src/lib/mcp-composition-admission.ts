import type { CompositionAdmissionInput, CompositionExpected, CompositionSourceExpected, CompositionSourceInput } from './store/composition-admission';
import type { ReviewOutcome } from './kernel/review-binding';
const { store, resolveProject, runtimeSessionId } = require('./mcp-shared');

const REVIEW_OUTCOMES: Record<ReviewOutcome, true> = { planned: true, accepted: true, rejected: true, inconclusive: true };
const IMMUTABLE_COMMIT = { type: 'string', pattern: '^[a-f0-9]{40}$' };
const SOURCE_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ref', 'commit', 'submittedAt'],
  properties: { ref: { type: 'string', minLength: 1 }, commit: IMMUTABLE_COMMIT, submittedAt: { type: 'string', minLength: 1 } },
};
const SOURCE_EXPECTED_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ref', 'reviewTicketId', 'reviewOutcome', 'correctedAt', 'snapshot'],
  properties: { ref: { type: 'string', minLength: 1 }, reviewTicketId: { type: ['string', 'null'] },
    reviewOutcome: { enum: [...Object.keys(REVIEW_OUTCOMES), null] }, correctedAt: { type: ['string', 'null'] }, snapshot: { type: 'string', minLength: 1 } },
};
export const COMPOSITION_ADMISSION_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Main-thread current adoption of exact immutable candidate C for a genuinely released root. Historical checkout ownership stays unverified. Sources stay pending and unaccepted. Omit expected for a bounded write-free expected_required CAS snapshot, then retry with it. Original BASE remains the full range floor; only a new native isolated checkout starts at C. by/evidence are audit only. Run ordinary update.verify/verifyCwd separately for new holder-owned output; fresh controls, nonce/capture and post-submit independent exact-C review remain required.',
  required: ['authority', 'historicalCheckout', 'by', 'evidence', 'candidate', 'base', 'ownCommits', 'ownPaths', 'sources'],
  properties: { authority: { const: 'main-attestation' }, historicalCheckout: { const: false },
    by: { type: 'string', minLength: 1 }, evidence: { type: 'string', minLength: 1 }, candidate: IMMUTABLE_COMMIT, base: IMMUTABLE_COMMIT,
    ownCommits: { type: 'array', items: IMMUTABLE_COMMIT, uniqueItems: true },
    ownPaths: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    sources: { type: 'array', items: SOURCE_INPUT_SCHEMA, minItems: 1, maxItems: 20 },
    expected: { type: 'object', additionalProperties: false, required: ['attemptCount', 'releasedAt', 'preparedAt', 'sources'],
      properties: { attemptCount: { type: 'integer', minimum: 0 }, releasedAt: { type: 'string', minLength: 1 },
        preparedAt: { type: 'string', minLength: 1 }, sources: { type: 'array', items: SOURCE_EXPECTED_SCHEMA, minItems: 1, maxItems: 20 } } },
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function commit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}
function textArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonemptyText);
}
function commitArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(commit);
}
function nullableText(value: unknown): value is string | null {
  return value === null || nonemptyText(value);
}
function reviewOutcome(value: unknown): value is ReviewOutcome | null {
  return value === null || (typeof value === 'string' && Object.hasOwn(REVIEW_OUTCOMES, value));
}
function onlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(field => fields.includes(field));
}
function sourceInput(value: unknown): value is CompositionSourceInput {
  if (!record(value)) return false;
  return [onlyFields(value, ['ref', 'commit', 'submittedAt']), nonemptyText(value.ref), commit(value.commit), nonemptyText(value.submittedAt)].every(Boolean);
}
function sourceExpected(value: unknown): value is CompositionSourceExpected {
  if (!record(value)) return false;
  return [onlyFields(value, ['ref', 'reviewTicketId', 'reviewOutcome', 'correctedAt', 'snapshot']),
    nonemptyText(value.ref), nullableText(value.reviewTicketId), reviewOutcome(value.reviewOutcome),
    nullableText(value.correctedAt), nonemptyText(value.snapshot)].every(Boolean);
}
function boundedSources(value: unknown): value is CompositionSourceInput[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(sourceInput);
}
function boundedExpectedSources(value: unknown): value is CompositionSourceExpected[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(sourceExpected);
}
function expected(value: unknown): value is CompositionExpected | undefined {
  if (value === undefined) return true;
  if (!record(value)) return false;
  return [onlyFields(value, ['attemptCount', 'releasedAt', 'preparedAt', 'sources']), Number.isInteger(value.attemptCount), typeof value.attemptCount === 'number' && value.attemptCount >= 0,
    nonemptyText(value.releasedAt), nonemptyText(value.preparedAt), boundedExpectedSources(value.sources)].every(Boolean);
}
function admissionInput(value: unknown): value is CompositionAdmissionInput {
  if (!record(value)) return false;
  return [onlyFields(value, ['authority', 'historicalCheckout', 'by', 'evidence', 'candidate', 'base', 'ownCommits', 'ownPaths', 'sources', 'expected']),
    value.authority === 'main-attestation', value.historicalCheckout === false, nonemptyText(value.by), nonemptyText(value.evidence),
    commit(value.candidate), commit(value.base), commitArray(value.ownCommits), textArray(value.ownPaths),
    boundedSources(value.sources), expected(value.expected)].every(Boolean);
}

type UpdateDefinition = {
  description: string; inputSchema: { properties: Record<string, unknown> };
  handler: (input: Record<string, unknown>) => unknown;
};
function admitFromUpdate(input: Record<string, unknown>): unknown {
  if (!admissionInput(input.admitComposition)) return { ok: false, reason: 'invalid_admission', message: 'Use the update.admitComposition schema with exact immutable commits and bounded expected source identities.' };
  if (!nonemptyText(input.ref)) return { ok: false, reason: 'not_found', message: 'Composition root ref is required.' };
  if (Object.keys(input).some(field => !['ref', 'project', 'admitComposition'].includes(field))) return { ok: false, reason: 'invalid_admission', message: 'Run composition admission separately from ordinary field updates; refusal must leave all fields unchanged.' };
  const { slug } = resolveProject(input.project);
  return store.admitComposition(slug, input.ref, input.admitComposition, runtimeSessionId() ?? '', { allowCompositionAdmission: true });
}

export function installCompositionUpdate(tool: UpdateDefinition | undefined): void {
  if (!tool) throw new Error('Composition admission requires the existing update tool.');
  const ordinaryUpdate = tool.handler;
  tool.inputSchema.properties.admitComposition = COMPOSITION_ADMISSION_SCHEMA;
  tool.description += ' Main-only admitComposition adopts exact current C without claiming historical ownership. Omit expected for a bounded write-free CAS probe. It preserves original BASE, sources and old proofs, and requires a fresh native isolated checkout, nonce/capture and independent post-submit exact-C review. Use it separately from ordinary field updates.';
  tool.handler = input => Object.hasOwn(input, 'admitComposition') ? admitFromUpdate(input) : ordinaryUpdate(input);
}
