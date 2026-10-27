'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { integrationProgressPath, readIntegrationProgress } from '../integration-tests.js';

export type CompletionStage =
  | 'proposed' | 'blocked' | 'ready' | 'running' | 'submitted' | 'integrating'
  | 'rejected' | 'integrated' | 'released' | 'closed' | 'abandoned';
export type EvidenceKind =
  | 'captured-command' | 'mocked-test' | 'real-flow' | 'visual' | 'source-review'
  | 'agent-reported' | 'waived' | 'unavailable';
export type QualityStatus = 'measured-pass' | 'measured-fail' | 'unverified' | 'not-measured' | 'none';
export type BlockerActor = 'executor' | 'orchestrator' | 'user' | 'board' | 'dependency';
export interface CompletionBlocker { reason: string; actor: BlockerActor; nextAction: string; refs?: string[] }
type VerifyStatus = 'passed' | 'failed' | 'skipped' | 'waived' | 'manual' | 'unavailable';
type DeliveryMethod = 'merge' | 'apply' | 'replay' | 'manual';
type ControlEvidence = 'captured' | 'agent-reported' | 'waived' | 'missing';
export interface CompletionFacts {
  submission: { commit: string; at: string; by: string } | null;
  delivery: { commit: string; branch: string; head: string; at: string; method: DeliveryMethod } | null;
  verify: { status: VerifyStatus; command: string | null; logPath: string | null; kinds: EvidenceKind[] } | null;
  quality: { status: QualityStatus; detail: string | null };
  negativeControl: { kind: string; evidence: ControlEvidence };
  review: { bound: boolean; verdict: string | null; by: string | null } | null;
  release: { version: string | null; evidence: 'release-record' | 'none' };
  candidateChanged: boolean;
}
export interface CompletionSummary { version: 1; result: string; checked: string; uncertain: string; action: string; by: string; at: string; candidate: string | null; stale: boolean }
export interface CompletionEvidence { kind: EvidenceKind; path: string; label: string }
export type AcceptanceKind = 'main' | 'boundary';
export interface AcceptanceExample { scenario: string; expected: string; kind: AcceptanceKind }
export type DemonstrationStatus = 'demonstrated' | 'failed' | 'stale' | 'not demonstrated';
type DemonstrationEvidence = 'real-flow' | 'visual';
interface DemonstrationOutcome { status: DemonstrationStatus; detail: string; observed: string | null; evidence: DemonstrationEvidence | null }
export interface AcceptanceResult extends AcceptanceExample, DemonstrationOutcome {}
export interface DemonstrationRecord { directory: string; entries: unknown[]; presentArtifacts: string[]; error: string | null }
export interface CompletionView {
  ref: string;
  title: string;
  stage: CompletionStage;
  blocker: CompletionBlocker | null;
  facts: CompletionFacts;
  summary: CompletionSummary | null;
  evidence: CompletionEvidence[];
  acceptance: AcceptanceResult[];
  text: string;
}

interface VerifyRecord {
  status?: string;
  command?: string | null;
  logPath?: string | null;
  waiver?: unknown;
  quality?: QualityRecord[];
}
interface QualityRecord { status?: string; enforced?: number; captureGap?: string; debtTicketNote?: string }
interface IntegrationRecord {
  mode?: string;
  outcome?: string;
  deliveryCommit?: string;
  pinnedCommit?: string;
  resultingHead?: string;
  targetBranch?: string;
  sourceRevision?: { value?: string };
  deliveredAt?: string;
  recordedAt?: string;
  verify?: VerifyRecord;
}
interface SubmissionRecord {
  by?: string;
  at?: string;
  commit?: string;
  sourceRevision?: { value?: string };
  verify?: string;
  verificationResult?: VerifyRecord;
  changedPaths?: string[];
  review?: { ref?: string; outcome?: string };
  integration?: IntegrationRecord;
  integratedAt?: string | null;
  supersedesRejectedSubmission?: string;
}
interface CaptureRecord { command?: string; status?: string; logPath?: string | null; candidate?: { value?: string }; completedAt?: string; control?: boolean; controlOutcome?: string }
interface RejectedRecord { commit?: string; rejectedAt?: string; reason?: string; supersededAt?: string }
export interface CompletionTicket {
  id?: string;
  ref: string;
  title?: string;
  status?: string;
  claim?: { by?: string } | null;
  submission?: SubmissionRecord | null;
  rejectedSubmissions?: RejectedRecord[];
  verificationCaptures?: CaptureRecord[];
  completion?: { by?: string; at?: string; delivery?: { commit?: string; targetBranch?: string } } | null;
  oracle?: { ask?: string } | null;
  dispatch?: { workProvenance?: { kind?: string }; evidenceDirectory?: string } | null;
  comments?: { body?: string }[];
  completionSummary?: Partial<CompletionSummary> | null;
  acceptance?: AcceptanceExample[] | null;
}
export interface CompletionContext {
  demonstrations?: DemonstrationRecord | null;
  openBlockers?: string[];
  integrationProgress?: { state?: string; writerAlive?: boolean } | null;
  negativeControl?: { kind?: string; evidence?: string; captureId?: string } | null;
  releaseRecord?: { version?: string; deliveryCommit?: string } | null;
  roots?: { project?: string | null; verification?: string | null; evidence?: string | null };
}

const NOT_REQUIRED_CONTROL_KINDS = new Set(['behavior-preserving-refactor', 'inherited-read-only', 'docs', 'type-annotation-only', 'fixture-only']);
const DELIVERED_OUTCOMES = new Set(['delivered', 'verified']);
const VERIFY_STATUS: Record<string, VerifyStatus> = {
  passed: 'passed',
  failed_suite: 'failed',
  failed_check: 'failed',
  timeout: 'failed',
  skipped: 'skipped',
  manual: 'manual',
  attestation: 'manual',
};
const DELIVERY_METHOD: Record<string, DeliveryMethod> = { merge: 'merge', apply: 'apply', replay: 'replay', 'cherry-pick': 'replay', rebase: 'replay' };
const QUALITY_STATUS: Record<string, QualityStatus> = { measured: 'measured-pass', failed: 'measured-fail', unverified: 'unverified', none: 'none' };
const QUALITY_PRECEDENCE: QualityStatus[] = ['measured-fail', 'unverified', 'none', 'measured-pass'];
const QUALITY_WORDING: Record<QualityStatus, string> = {
  'measured-pass': 'measured, passed',
  'measured-fail': 'measured, FAILED',
  unverified: 'UNVERIFIED',
  'not-measured': 'not measured (no quality record)',
  none: 'not measured (no quality gate configured)',
};
const TERMINAL_STAGES = new Set<CompletionStage>(['integrated', 'released', 'closed']);
const SECTION_WORDS = { header: 14, result: 40, checked: 62, uncertain: 42, action: 30 };
export const COMPLETION_TEXT_MAX_WORDS = 200;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(...values: unknown[]): string {
  return values.map(text).find(Boolean) ?? '';
}

function shortCommit(value: string): string {
  return /^[0-9a-f]{13,}$/i.test(value) ? value.slice(0, 12) : value;
}

function candidateOf(ticket: CompletionTicket): string | null {
  const submission = ticket.submission;
  return text(submission?.commit) || text(submission?.sourceRevision?.value) || null;
}

function pendingSubmission(ticket: CompletionTicket): boolean {
  return Boolean(candidateOf(ticket)) && !ticket.submission?.integratedAt;
}

function deliveredIntegration(ticket: CompletionTicket): IntegrationRecord | null {
  const integration = ticket.submission?.integration;
  return integration && DELIVERED_OUTCOMES.has(String(integration.outcome)) ? integration : null;
}

function openRejection(ticket: CompletionTicket): RejectedRecord | null {
  const history = Array.isArray(ticket.rejectedSubmissions) ? ticket.rejectedSubmissions.filter(Boolean) : [];
  const latest = history[history.length - 1];
  return latest && !latest.supersededAt && !pendingSubmission(ticket) ? latest : null;
}

function integrationRunning(context: CompletionContext): boolean {
  const progress = context.integrationProgress;
  return progress?.state === 'running' && progress.writerAlive !== false;
}

function submissionFacts(ticket: CompletionTicket): CompletionFacts['submission'] {
  const commit = candidateOf(ticket);
  if (!commit) return null;
  return { commit, at: text(ticket.submission?.at), by: text(ticket.submission?.by) };
}

function integrationDelivery(integration: IntegrationRecord, ticket: CompletionTicket): NonNullable<CompletionFacts['delivery']> {
  const commit = firstText(integration.deliveryCommit, integration.pinnedCommit, candidateOf(ticket));
  return {
    commit,
    branch: text(integration.targetBranch),
    head: firstText(integration.resultingHead, integration.sourceRevision?.value, commit),
    at: firstText(integration.deliveredAt, integration.recordedAt, ticket.submission?.integratedAt),
    method: DELIVERY_METHOD[String(integration.mode)] ?? 'manual',
  };
}

function closureDelivery(ticket: CompletionTicket): CompletionFacts['delivery'] {
  const delivery = ticket.completion?.delivery;
  const commit = text(delivery?.commit);
  if (!commit) return null;
  return { commit, branch: text(delivery?.targetBranch), head: commit, at: text(ticket.completion?.at), method: 'manual' };
}

function deliveryFacts(ticket: CompletionTicket): CompletionFacts['delivery'] {
  const integration = deliveredIntegration(ticket);
  return integration ? integrationDelivery(integration, ticket) : closureDelivery(ticket);
}

function candidateCapture(ticket: CompletionTicket): CaptureRecord | null {
  const candidate = candidateOf(ticket);
  const captures = Array.isArray(ticket.verificationCaptures) ? ticket.verificationCaptures : [];
  return captures.slice().reverse().find((capture) => capture?.candidate?.value === candidate && capture?.control !== true) ?? null;
}

function verifyRecord(ticket: CompletionTicket): VerifyRecord | null {
  return ticket.submission?.integration?.verify ?? ticket.submission?.verificationResult ?? candidateCapture(ticket) ?? null;
}

function verifyStatus(record: VerifyRecord): VerifyStatus {
  if (record.waiver) return 'waived';
  return VERIFY_STATUS[String(record.status)] ?? 'unavailable';
}

function isTestPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(normalized) || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(normalized);
}

function changedTestPaths(ticket: CompletionTicket): string[] {
  const changed = Array.isArray(ticket.submission?.changedPaths) ? ticket.submission.changedPaths : [];
  return changed.map(String).filter(isTestPath);
}

function capturedCommand(ticket: CompletionTicket, record: VerifyRecord): boolean {
  return Boolean(candidateCapture(ticket)) || Boolean(text(record.command) && text(record.logPath));
}

function verifyKinds(ticket: CompletionTicket, record: VerifyRecord, status: VerifyStatus, control: CompletionFacts['negativeControl']): EvidenceKind[] {
  const reviewed = ['accepted', 'rejected'].includes(String(ticket.submission?.review?.outcome));
  const candidates: [boolean, EvidenceKind][] = [
    [capturedCommand(ticket, record), 'captured-command'],
    [changedTestPaths(ticket).length > 0, 'mocked-test'],
    [reviewed, 'source-review'],
    [control.evidence === 'agent-reported', 'agent-reported'],
    [status === 'waived', 'waived'],
    [status === 'unavailable', 'unavailable'],
  ];
  return candidates.filter(([present]) => present).map(([, kind]) => kind);
}

function verifyFacts(ticket: CompletionTicket, control: CompletionFacts['negativeControl'], roots: string[]): CompletionFacts['verify'] {
  const record = verifyRecord(ticket);
  if (!record) return null;
  const status = verifyStatus(record);
  const logPath = approvedPath(text(record.logPath), roots);
  return { status, command: text(record.command) || text(ticket.submission?.verify) || null, logPath, kinds: verifyKinds(ticket, record, status, control) };
}

function qualityRows(ticket: CompletionTicket): QualityRecord[] {
  const rows = ticket.submission?.integration?.verify?.quality ?? ticket.submission?.verificationResult?.quality;
  return Array.isArray(rows) ? rows.filter(Boolean) : [];
}

function qualityDetail(rows: QualityRecord[]): string | null {
  const notes = rows.map((row) => text(row.captureGap) || text(row.debtTicketNote)).filter(Boolean);
  const enforced = rows.reduce((total, row) => total + (Number(row.enforced) || 0), 0);
  return notes[0] || (enforced ? `${enforced} bodies enforced` : null);
}

function qualityFacts(ticket: CompletionTicket): CompletionFacts['quality'] {
  const rows = qualityRows(ticket);
  if (!rows.length) return { status: 'not-measured', detail: null };
  const statuses = new Set(rows.map((row) => QUALITY_STATUS[String(row.status)] ?? 'unverified'));
  const status = QUALITY_PRECEDENCE.find((candidate) => statuses.has(candidate)) ?? 'unverified';
  return { status, detail: qualityDetail(rows) };
}

function notRequiredControl(ticket: CompletionTicket): string | null {
  const declared = text(ticket.dispatch?.workProvenance?.kind);
  if (NOT_REQUIRED_CONTROL_KINDS.has(declared)) return `not_required(${declared})`;
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const recorded = comments.map((comment) => /negativeControl: (not_required\([^)\n]*\))/.exec(String(comment?.body || ''))?.[1]).filter(Boolean);
  return recorded[recorded.length - 1] ?? null;
}

function controlFacts(ticket: CompletionTicket, context: CompletionContext): CompletionFacts['negativeControl'] {
  const notRequired = notRequiredControl(ticket);
  if (notRequired) return { kind: notRequired, evidence: 'waived' };
  const kind = text(context.negativeControl?.kind) || 'missing';
  if (kind === 'failed') return failedControlFacts(context.negativeControl);
  return kind === 'waived' ? { kind, evidence: 'waived' } : { kind, evidence: 'missing' };
}

// Only a marker whose named control capture was verified reads as captured; every other failing
// control is the claim holder's own account.
function failedControlFacts(control: CompletionContext['negativeControl']): CompletionFacts['negativeControl'] {
  return control?.evidence === 'captured'
    ? { kind: `capture(${text(control.captureId)})`, evidence: 'captured' }
    : { kind: 'marker', evidence: 'agent-reported' };
}

function reviewFacts(ticket: CompletionTicket): CompletionFacts['review'] {
  const review = ticket.submission?.review;
  if (!review?.ref) return null;
  return { bound: true, verdict: text(review.outcome) || null, by: text(review.ref) };
}

function releaseFacts(delivery: CompletionFacts['delivery'], context: CompletionContext): CompletionFacts['release'] {
  const record = context.releaseRecord;
  const names = Boolean(delivery && record?.version && record.deliveryCommit === delivery.commit);
  return names ? { version: text(record?.version), evidence: 'release-record' } : { version: null, evidence: 'none' };
}

function summaryRecord(ticket: CompletionTicket): CompletionSummary | null {
  const recorded = ticket.completionSummary;
  if (!recorded || recorded.version !== 1 || !text(recorded.result)) return null;
  const candidate = text(recorded.candidate) || null;
  return {
    version: 1,
    result: text(recorded.result),
    checked: text(recorded.checked),
    uncertain: text(recorded.uncertain),
    action: text(recorded.action),
    by: text(recorded.by),
    at: text(recorded.at),
    candidate,
    stale: candidate !== candidateOf(ticket),
  };
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function insideRoot(candidate: string, root: string): boolean {
  const base = comparablePath(root);
  return candidate === base || candidate.startsWith(base + '/');
}

function approvedPath(value: string, roots: string[]): string | null {
  if (!value || !roots.length) return null;
  const absolute = path.isAbsolute(value) ? value : path.join(roots[0]!, value);
  const candidate = comparablePath(absolute);
  return roots.some((root) => insideRoot(candidate, root)) ? absolute : null;
}

function approvedRoots(context: CompletionContext): string[] {
  const roots = context.roots ?? {};
  return [roots.project, roots.verification, roots.evidence].map(text).filter(Boolean);
}

function captureLabel(capture: CaptureRecord): string {
  return capture.control === true
    ? `negative-control capture ${text(capture.controlOutcome)}: ${text(capture.command)}`
    : `verify capture ${text(capture.status)}: ${text(capture.command)}`;
}

function evidenceEntries(ticket: CompletionTicket, roots: string[]): CompletionEvidence[] {
  const captures = (Array.isArray(ticket.verificationCaptures) ? ticket.verificationCaptures : [])
    .filter((capture) => capture?.candidate?.value === candidateOf(ticket))
    .map((capture): CompletionEvidence => ({ kind: 'captured-command', path: text(capture.logPath), label: captureLabel(capture) }));
  const gateLog = text(ticket.submission?.integration?.verify?.logPath);
  const gate: CompletionEvidence[] = gateLog ? [{ kind: 'captured-command', path: gateLog, label: 'delivery gate log' }] : [];
  const tests = changedTestPaths(ticket).map((file): CompletionEvidence => ({ kind: 'mocked-test', path: file, label: 'changed test (no real-flow record)' }));
  return [...captures, ...gate, ...tests]
    .map((entry) => ({ ...entry, path: approvedPath(entry.path, roots) ?? '' }))
    .filter((entry) => entry.path);
}

export const DEMONSTRATIONS_FILE = 'demonstrations.json';
const SCREENSHOT_ARTIFACT = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
const REQUIRED_DEMONSTRATION_FIELDS = ['expected', 'observed', 'environment', 'candidate', 'fixture', 'artifact'] as const;
interface DemonstrationEntry {
  scenario: string;
  expected: string;
  observed: string;
  environment: string;
  candidate: string;
  fixture: string;
  artifact: string;
  matches: boolean | null;
  kind: DemonstrationEvidence;
}
interface AssessedDemonstration extends DemonstrationOutcome { entry: DemonstrationEntry; artifact: string | null }

function recordFields(value: unknown): Map<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? new Map<string, unknown>(Object.entries(value)) : null;
}

function demonstrationKind(declared: unknown, artifact: string): DemonstrationEvidence {
  return declared === 'visual' || SCREENSHOT_ARTIFACT.test(artifact) ? 'visual' : 'real-flow';
}

function demonstrationEntry(value: unknown): DemonstrationEntry | null {
  const record = recordFields(value);
  if (!record) return null;
  const field = (name: string) => text(record.get(name));
  const matches = record.get('matches');
  return {
    scenario: field('scenario'),
    expected: field('expected'),
    observed: field('observed'),
    environment: field('environment'),
    candidate: field('candidate'),
    fixture: field('fixture'),
    artifact: field('artifact'),
    matches: typeof matches === 'boolean' ? matches : null,
    kind: demonstrationKind(record.get('kind'), field('artifact')),
  };
}

function missingDemonstrationFields(entry: DemonstrationEntry): string[] {
  const missing: string[] = REQUIRED_DEMONSTRATION_FIELDS.filter((field) => !entry[field]);
  return entry.matches === null ? [...missing, 'matches'] : missing;
}

function sameCommit(recorded: string, current: string): boolean {
  const left = recorded.toLowerCase();
  const right = current.toLowerCase();
  return Math.min(left.length, right.length) >= 7 && (left.startsWith(right) || right.startsWith(left));
}

function boardEvidenceRoots(context: CompletionContext): string[] {
  const roots = context.roots ?? {};
  return [roots.verification, roots.evidence].map(text).filter(Boolean);
}

function demonstrationArtifact(entry: DemonstrationEntry, directory: string, roots: string[]): string | null {
  if (!entry.artifact) return null;
  const absolute = path.resolve(directory, entry.artifact);
  const candidate = comparablePath(absolute);
  return roots.some((root) => insideRoot(candidate, root)) ? absolute : null;
}

function demonstrationProblem(entry: DemonstrationEntry, artifact: string | null, present: Set<string>): string | null {
  const missing = missingDemonstrationFields(entry);
  if (missing.length) return `partial record, missing ${missing.join(', ')}`;
  if (!artifact) return 'artifact outside the board evidence directory';
  return present.has(comparablePath(artifact)) ? null : 'artifact file not found';
}

function settledDemonstration(entry: DemonstrationEntry, candidate: string | null): [DemonstrationStatus, string] {
  if (candidate && !sameCommit(entry.candidate, candidate)) {
    return ['stale', `recorded for ${shortCommit(entry.candidate)}, candidate is now ${shortCommit(candidate)}`];
  }
  return entry.matches ? ['demonstrated', `${entry.kind} in ${entry.environment}`] : ['failed', 'observed differs from expected'];
}

function assessDemonstration(entry: DemonstrationEntry, artifact: string | null, present: Set<string>, candidate: string | null): DemonstrationOutcome {
  const problem = demonstrationProblem(entry, artifact, present);
  if (problem) return { status: 'not demonstrated', detail: problem, observed: entry.observed || null, evidence: null };
  const [status, detail] = settledDemonstration(entry, candidate);
  return { status, detail, observed: entry.observed, evidence: entry.kind };
}

function assessedDemonstrations(ticket: CompletionTicket, context: CompletionContext): AssessedDemonstration[] {
  const record = context.demonstrations;
  if (!record) return [];
  const roots = boardEvidenceRoots(context);
  const present = new Set(record.presentArtifacts.map(comparablePath));
  const candidate = candidateOf(ticket);
  return record.entries
    .map(demonstrationEntry)
    .filter((entry): entry is DemonstrationEntry => Boolean(entry))
    .map((entry) => {
      const artifact = demonstrationArtifact(entry, record.directory, roots);
      return { entry, artifact, ...assessDemonstration(entry, artifact, present, candidate) };
    });
}

function acceptanceExamples(ticket: CompletionTicket): AcceptanceExample[] {
  return Array.isArray(ticket.acceptance) ? ticket.acceptance.filter((example) => Boolean(text(example?.scenario))) : [];
}

function undemonstrated(record: DemonstrationRecord | null | undefined): DemonstrationOutcome {
  const detail = record?.error ? `${DEMONSTRATIONS_FILE} ${record.error}` : 'no record';
  return { status: 'not demonstrated', detail, observed: null, evidence: null };
}

function acceptanceResults(ticket: CompletionTicket, demonstrations: AssessedDemonstration[], record: DemonstrationRecord | null | undefined): AcceptanceResult[] {
  return acceptanceExamples(ticket).map((example): AcceptanceResult => {
    const latest = demonstrations.filter((demonstration) => demonstration.entry.scenario === text(example.scenario)).at(-1);
    const { status, detail, observed, evidence } = latest ?? undemonstrated(record);
    return { scenario: example.scenario, expected: example.expected, kind: example.kind, status, detail, observed, evidence };
  });
}

function demonstrationLabel(demonstration: AssessedDemonstration): string {
  const { scenario, expected, observed } = demonstration.entry;
  return sanitizeCompletionText(`${demonstration.status} demonstration "${scenario}": expected ${expected}; observed ${observed}`).slice(0, 400);
}

function demonstrationEvidence(demonstrations: AssessedDemonstration[]): CompletionEvidence[] {
  return demonstrations.flatMap((demonstration): CompletionEvidence[] => demonstration.artifact && demonstration.evidence
    ? [{ kind: demonstration.evidence, path: demonstration.artifact, label: demonstrationLabel(demonstration) }]
    : []);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsedDemonstrations(file: string): Pick<DemonstrationRecord, 'entries' | 'error'> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? { entries: parsed, error: null } : { entries: [], error: 'is not a JSON array' };
  } catch (error) {
    return { entries: [], error: `is unreadable: ${errorText(error)}` };
  }
}

function presentArtifacts(directory: string, entries: unknown[]): string[] {
  return entries
    .map((entry) => text(recordFields(entry)?.get('artifact')))
    .filter(Boolean)
    .map((artifact) => path.resolve(directory, artifact))
    .filter((absolute) => fs.existsSync(absolute));
}

export function readDemonstrations(directory: string): DemonstrationRecord | null {
  const file = path.join(directory, DEMONSTRATIONS_FILE);
  if (!fs.existsSync(file)) return null;
  const { entries, error } = parsedDemonstrations(file);
  return { directory, entries, error, presentArtifacts: presentArtifacts(directory, entries) };
}

type StageRule = [(ticket: CompletionTicket, context: CompletionContext) => boolean, CompletionStage];

const STAGE_RULES: StageRule[] = [
  [(ticket) => ticket.submission?.integration?.outcome === 'abandoned', 'abandoned'],
  [(ticket, context) => ticket.status === 'done' && releaseFacts(deliveryFacts(ticket), context).evidence === 'release-record', 'released'],
  [(ticket) => ticket.status === 'done' && Boolean(deliveryFacts(ticket)), 'integrated'],
  [(ticket) => ticket.status === 'done', 'closed'],
  [(ticket, context) => pendingSubmission(ticket) && integrationRunning(context), 'integrating'],
  [(ticket) => pendingSubmission(ticket), 'submitted'],
  [(ticket) => Boolean(openRejection(ticket)), 'rejected'],
  [(ticket) => Boolean(text(ticket.claim?.by)), 'running'],
  [(ticket, context) => Boolean(context.openBlockers?.length) || ticket.status === 'awaiting-oracle', 'blocked'],
];

export function completionStage(ticket: CompletionTicket, context: CompletionContext): CompletionStage {
  return STAGE_RULES.find(([applies]) => applies(ticket, context))?.[1] ?? 'ready';
}

function blockedBlocker(ticket: CompletionTicket, context: CompletionContext): CompletionBlocker {
  const refs = context.openBlockers ?? [];
  if (!refs.length) {
    const ask = text(ticket.oracle?.ask) || 'the recorded oracle question';
    return { reason: 'Waiting on a human verdict.', actor: 'user', nextAction: `Answer: ${ask}` };
  }
  return { reason: `Blocked by ${refs.join(', ')}.`, actor: 'dependency', nextAction: `Finish ${refs.join(', ')} first.`, refs: refs.slice() };
}

function rejectedBlocker(ticket: CompletionTicket): CompletionBlocker {
  const rejected = openRejection(ticket);
  const reason = text(rejected?.reason) || 'no reason recorded';
  return {
    reason: `Candidate ${shortCommit(text(rejected?.commit))} was rejected: ${reason}`,
    actor: 'executor',
    nextAction: 'Dispatch the ticket so an executor reworks the rejected candidate.',
  };
}

const BLOCKERS: Partial<Record<CompletionStage, (ticket: CompletionTicket, context: CompletionContext) => CompletionBlocker>> = {
  blocked: blockedBlocker,
  rejected: rejectedBlocker,
  ready: () => ({ reason: 'Not dispatched yet.', actor: 'orchestrator', nextAction: 'Dispatch the ticket.' }),
  proposed: () => ({ reason: 'Not planned yet.', actor: 'orchestrator', nextAction: 'Groom the ticket.' }),
  running: (ticket) => ({ reason: `Claimed by ${text(ticket.claim?.by)}.`, actor: 'executor', nextAction: 'Wait for the executor to submit.' }),
  submitted: (ticket) => ({ reason: `Candidate ${shortCommit(candidateOf(ticket) || '')} awaits integration.`, actor: 'orchestrator', nextAction: 'Integrate the submitted candidate.' }),
  integrating: () => ({ reason: 'The integration gate is running.', actor: 'board', nextAction: 'Wait for the integration gate to finish.' }),
  abandoned: () => ({ reason: 'The submission was abandoned without landing.', actor: 'orchestrator', nextAction: 'Redispatch or close the ticket.' }),
};

function completionBlocker(stage: CompletionStage, ticket: CompletionTicket, context: CompletionContext): CompletionBlocker | null {
  return BLOCKERS[stage]?.(ticket, context) ?? null;
}

function completionFacts(ticket: CompletionTicket, context: CompletionContext, summary: CompletionSummary | null): CompletionFacts {
  const roots = approvedRoots(context);
  const negativeControl = controlFacts(ticket, context);
  const delivery = deliveryFacts(ticket);
  return {
    submission: submissionFacts(ticket),
    delivery,
    verify: verifyFacts(ticket, negativeControl, roots),
    quality: qualityFacts(ticket),
    negativeControl,
    review: reviewFacts(ticket),
    release: releaseFacts(delivery, context),
    candidateChanged: Boolean(summary?.stale) || Boolean(ticket.submission?.supersedesRejectedSubmission),
  };
}

export function completionView(ticket: CompletionTicket, context: CompletionContext = {}): CompletionView {
  const summary = summaryRecord(ticket);
  const stage = completionStage(ticket, context);
  const demonstrations = assessedDemonstrations(ticket, context);
  const view: CompletionView = {
    ref: ticket.ref,
    title: text(ticket.title),
    stage,
    blocker: completionBlocker(stage, ticket, context),
    facts: completionFacts(ticket, context, summary),
    summary,
    evidence: [...evidenceEntries(ticket, approvedRoots(context)), ...demonstrationEvidence(demonstrations)],
    acceptance: acceptanceResults(ticket, demonstrations, context.demonstrations),
    text: '',
  };
  view.text = completionText(view);
  return view;
}

export function sanitizeCompletionText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function clampWords(value: string, limit: number): string {
  const all = words(value);
  return all.length <= limit ? all.join(' ') : all.slice(0, limit - 1).join(' ') + ' ...';
}

function deliveryLine(delivery: NonNullable<CompletionFacts['delivery']>): string {
  const branch = delivery.branch ? ` to ${delivery.branch}` : '';
  return `Delivered ${shortCommit(delivery.commit)}${branch} by ${delivery.method} at ${shortCommit(delivery.head)}.`;
}

const RESULT_LINES: Partial<Record<CompletionStage, (view: CompletionView) => string>> = {
  integrated: (view) => deliveryLine(view.facts.delivery!),
  released: (view) => `${deliveryLine(view.facts.delivery!)} Released in ${view.facts.release.version}.`,
  submitted: (view) => `Submitted ${shortCommit(view.facts.submission!.commit)} by ${view.facts.submission!.by || 'an unrecorded actor'}; not integrated yet.`,
  integrating: (view) => `Submitted ${shortCommit(view.facts.submission!.commit)}; integration is running.`,
  closed: () => 'Closed without a delivery record.',
  rejected: (view) => view.blocker!.reason,
  abandoned: () => 'The submission was abandoned without landing.',
  running: (view) => `In progress. ${view.blocker!.reason}`,
};

function resultSection(view: CompletionView): string {
  const factual = RESULT_LINES[view.stage]?.(view) ?? 'No candidate yet.';
  if (!view.summary) return factual;
  const staleNote = view.summary.stale ? ' (summary written for an older candidate)' : '';
  return `${view.summary.result}${staleNote} Record: ${factual}`;
}

function verifyClause(verify: CompletionFacts['verify']): string {
  if (!verify) return 'Verify: not recorded.';
  const kinds = verify.kinds.length ? verify.kinds.join(', ') : 'none recorded';
  return `Verify ${verify.status}${verify.command ? ` (${verify.command})` : ''}; evidence: ${kinds}.`;
}

function reviewClause(review: CompletionFacts['review']): string {
  return review ? `Review ${review.by}: ${review.verdict || 'no verdict yet'}.` : 'Review: none bound.';
}

function controlClause(control: CompletionFacts['negativeControl']): string {
  return control.kind === control.evidence ? `Negative control: ${control.kind}.` : `Negative control: ${control.kind} (${control.evidence}).`;
}

function checkedSection(view: CompletionView): string {
  const facts = view.facts;
  const agent = view.summary?.checked ? ` Agent says: ${view.summary.checked}` : '';
  return [
    verifyClause(facts.verify),
    demonstrationClause(view.acceptance),
    `Quality: ${QUALITY_WORDING[facts.quality.status]}.`,
    controlClause(facts.negativeControl),
    reviewClause(facts.review),
  ].filter(Boolean).join(' ') + agent;
}

function demonstrationClause(acceptance: AcceptanceResult[]): string {
  if (!acceptance.length) return '';
  const demonstrated = acceptance.filter((result) => result.status === 'demonstrated');
  const visual = demonstrated.filter((result) => result.evidence === 'visual').length;
  const visualNote = visual ? ` (${visual} by screenshot only)` : '';
  return `Demonstrated ${demonstrated.length} of ${acceptance.length} acceptance examples${visualNote}.`;
}

const OPEN_DEMONSTRATION_LABEL: Record<DemonstrationStatus, string> = {
  demonstrated: '',
  'not demonstrated': 'Not demonstrated',
  failed: 'Demonstration FAILED',
  stale: 'Demonstration stale',
};

function demonstrationDoubt(view: CompletionView): string | null {
  const open = view.acceptance.filter((result) => result.status !== 'demonstrated');
  if (!open.length) return null;
  return open.map((result) => `${OPEN_DEMONSTRATION_LABEL[result.status]}: ${clampWords(result.scenario, 8)} (${result.detail}).`).join(' ');
}

function demonstrationAction(view: CompletionView): string | null {
  const failed = view.acceptance.some((result) => result.status === 'failed');
  return failed && view.blocker?.actor !== 'user' ? 'Review the failed demonstration before accepting this candidate.' : null;
}

function hasCandidate(view: CompletionView): boolean {
  return Boolean(view.facts.submission || view.facts.delivery);
}

function verifyDoubt(view: CompletionView): string | null {
  const status = view.facts.verify?.status;
  if (!hasCandidate(view) || status === 'passed') return null;
  return status ? `Verification ${status}.` : 'No verification recorded.';
}

function qualityDoubt(view: CompletionView): string | null {
  const status = view.facts.quality.status;
  return hasCandidate(view) && status !== 'measured-pass' ? `Quality ${QUALITY_WORDING[status]}.` : null;
}

function controlDoubt(view: CompletionView): string | null {
  const evidence = view.facts.negativeControl.evidence;
  if (!hasCandidate(view) || ['captured', 'waived'].includes(evidence)) return null;
  return evidence === 'agent-reported' ? 'Negative control is agent-reported, not captured.' : 'No negative-control record.';
}

const DOUBTS: ((view: CompletionView) => string | null)[] = [
  (view) => (view.summary?.stale ? 'Summary describes an older candidate.' : null),
  (view) => (view.facts.candidateChanged && !view.summary?.stale ? 'Candidate changed after a rejection.' : null),
  verifyDoubt,
  demonstrationDoubt,
  qualityDoubt,
  controlDoubt,
  (view) => (view.stage === 'integrated' ? 'No release record; shipping is unconfirmed.' : null),
  (view) => (view.summary?.uncertain ? `Agent says: ${view.summary.uncertain}` : null),
];

function uncertainSection(view: CompletionView): string {
  const doubts = DOUBTS.map((doubt) => doubt(view)).filter(Boolean);
  return doubts.length ? doubts.join(' ') : 'Nothing flagged by the records.';
}

function factualAction(view: CompletionView): string {
  const blocker = view.blocker;
  if (blocker?.actor === 'user') return blocker.nextAction;
  const noAction = TERMINAL_STAGES.has(view.stage) || Boolean(blocker);
  const next = blocker ? ` Next (${blocker.actor}): ${blocker.nextAction}` : '';
  return noAction ? `No action needed.${next}` : 'Check the ticket; the records name no next step.';
}

function actionSection(view: CompletionView): string {
  return (demonstrationAction(view) ?? factualAction(view)) + summaryAction(view);
}

function summaryAction(view: CompletionView): string {
  return view.summary?.action ? ` Agent said: ${view.summary.action}` : '';
}

export function completionText(view: CompletionView): string {
  const sections: [string, string, number][] = [
    ['', `${view.ref} ${view.title} [${view.stage}]`, SECTION_WORDS.header],
    ['Result: ', resultSection(view), SECTION_WORDS.result],
    ['Checked: ', checkedSection(view), SECTION_WORDS.checked],
    ['Still uncertain: ', uncertainSection(view), SECTION_WORDS.uncertain],
    ['Your action: ', actionSection(view), SECTION_WORDS.action],
  ];
  return sections.map(([label, body, limit]) => label + sanitizeCompletionText(clampWords(body, limit))).join('\n');
}


export interface CompletionStory {
  id: string;
  ref: string;
  title: string;
  decisionLog?: StoryDecision[];
  archivedDecisionLog?: StoryDecision[];
}
interface StoryDecision { kind: string; text: string; ref?: string | null; seq: number }
export interface StoryCompletionView {
  ref: string;
  title: string;
  stage: CompletionStage | 'partial';
  blocker: CompletionBlocker | null;
  children: CompletionView[];
  integrated: string[];
  notYet: Array<{ ref: string; stage: CompletionStage }>;
  uncertainties: string[];
  decisions: { count: number; latest: string | null };
  text: string;
}

function childDelivered(child: CompletionView): boolean {
  return ['integrated', 'released'].includes(child.stage);
}

function storyStage(children: CompletionView[]): StoryCompletionView['stage'] {
  if (!children.length) return 'proposed';
  if (children.every((child) => child.stage === 'released')) return 'released';
  if (children.every(childDelivered)) return 'integrated';
  return activeStoryStage(children);
}

function activeStoryStage(children: CompletionView[]): StoryCompletionView['stage'] {
  if (children.some((child) => child.stage === 'running')) return 'running';
  if (children.some(childDelivered)) return 'partial';
  if (children.some((child) => child.stage === 'rejected')) return 'partial';
  return pendingStoryStage(children);
}

function pendingStoryStage(children: CompletionView[]): StoryCompletionView['stage'] {
  if (children.some((child) => child.stage === 'blocked')) return 'blocked';
  if (children.some((child) => ['submitted', 'integrating'].includes(child.stage))) return 'running';
  return 'proposed';
}

function storyDecisions(story: CompletionStory): StoryCompletionView['decisions'] {
  const entries = [...(story.archivedDecisionLog ?? []), ...(story.decisionLog ?? [])];
  const decisions = entries.filter((entry) => entry.kind === 'DECISION' && Boolean(entry.ref || /\bSQ-\d+\b/.test(entry.text)));
  decisions.sort((first, second) => first.seq - second.seq);
  const latest = decisions.at(-1);
  return { count: decisions.length, latest: latest ? firstSentence(latest.text) : null };
}

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s/)[0] ?? '';
}

function storyChecked(children: CompletionView[]): string {
  const captured = children.filter((child) => child.facts.verify?.status === 'passed' && child.facts.verify.kinds.includes('captured-command')).length;
  const qualities = new Map<QualityStatus, number>();
  for (const child of children) qualities.set(child.facts.quality.status, (qualities.get(child.facts.quality.status) ?? 0) + 1);
  const labels = [...qualities].map(([status, count]) => count + ' quality ' + QUALITY_WORDING[status]);
  return captured + ' of ' + children.length + ' verified by captured command; ' + labels.join('; ') + '.';
}

function storyAction(view: StoryCompletionView): string {
  const userBlocker = view.children.find((child) => child.blocker?.actor === 'user')?.blocker;
  if (userBlocker) return userBlocker.nextAction;
  if (!view.children.length) return 'Define the story scope before starting.';
  if (view.children.every((child) => Boolean(child.blocker) || TERMINAL_STAGES.has(child.stage))) return 'No action needed.';
  return 'Check completion <ref> for children whose next step is not recorded.';
}

function childResult(child: CompletionView): string {
  const result = child.summary?.stale ? '' : child.summary?.result;
  return child.ref + ': ' + firstSentence(result || deliveryLine(child.facts.delivery!));
}

function storyCompletionText(view: StoryCompletionView): string {
  const results = view.children.filter(childDelivered).map(childResult).join(' ');
  const pending = view.notYet.map((child) => child.ref + ' (' + child.stage + ')').join(', ');
  const sections = [
    'Result: ' + clampWords(view.title + '. ' + results, 55),
    'Not yet: ' + clampWords(pending || 'none.', 35),
    'Checked: ' + clampWords(storyChecked(view.children), 45),
    'Still uncertain: ' + clampWords(view.uncertainties.join('\n') || 'Nothing flagged by the records.', 50),
    'Your action: ' + clampWords(storyAction(view), 30),
    'Decisions: ' + clampWords(view.decisions.count + '; ' + (view.decisions.latest ?? 'none recorded.'), 18),
    'Details: completion <ref>',
  ];
  return sections.map(sanitizeCompletionText).join('\n');
}

function storyBlocker(children: CompletionView[]): CompletionBlocker | null {
  const user = children.find((child) => child.blocker?.actor === 'user');
  const blocked = user ?? children.find((child) => child.blocker);
  return blocked?.blocker ?? null;
}

export function storyCompletionView(story: CompletionStory, children: CompletionView[]): StoryCompletionView {
  const doubts = children.flatMap((child) => DOUBTS.map((doubt) => doubt(child))).filter((value): value is string => Boolean(value));
  const uncertainties = [...new Set(doubts)].slice(0, 6);
  const view: StoryCompletionView = {
    ref: story.ref, title: story.title, stage: storyStage(children),
    blocker: storyBlocker(children),
    children, integrated: children.filter(childDelivered).map((child) => child.ref),
    notYet: children.filter((child) => !childDelivered(child)).map((child) => ({ ref: child.ref, stage: child.stage })),
    uncertainties, decisions: storyDecisions(story), text: '',
  };
  view.text = storyCompletionText(view);
  return view;
}

interface ChangesDelta { since: string; serverTime: string; tickets: { ref: string }[] }
interface CatchupStore {
  completionPayload: (slug: string, ref: string) => CompletionView;
  getTicket: (slug: string, ref: string) => CompletionTicket | null;
}

function catchupField(value: string): string {
  return sanitizeCompletionText(value.replace(/\s+/g, ' ').trim().slice(0, 180));
}

function catchupAction(slug: string, view: CompletionView, store: CatchupStore): string {
  const refs = view.blocker?.refs ?? [];
  const scheduled = refs.length > 0 && refs.every((ref) => Boolean(store.getTicket(slug, ref)?.claim?.by));
  if (scheduled) return 'The agent will continue when they finish.';
  return view.blocker?.nextAction ?? 'no action';
}

function catchupRow(slug: string, ref: string, store: CatchupStore) {
  const view = store.completionPayload(slug, ref);
  const blocker = view.blocker;
  const actor = blocker?.actor ?? null;
  const nextAction = catchupAction(slug, view, store);
  const detail = blocker?.reason ?? view.title;
  const line = [ref, view.stage, catchupField(detail), catchupField(nextAction)].join(' · ');
  return { ref, stage: view.stage, actor, blocker, nextAction, line };
}

export function changesCatchupPayload(slug: string, delta: ChangesDelta, store: CatchupStore) {
  const tickets = delta.tickets.slice(0, 40).map(({ ref }) => catchupRow(slug, ref, store));
  const omitted = delta.tickets.length - tickets.length;
  const lines = tickets.map((ticket) => ticket.line);
  if (omitted) lines.push('+' + omitted + ' more, narrow since');
  if (!lines.length) lines.push('nothing changed since ' + delta.since);
  return { since: delta.since, serverTime: delta.serverTime, tickets, omitted, text: lines.join('\n') };
}

interface CompletionDependencies {
  getStory: (slug: string, idOrRef: string) => CompletionStory | null;
  listTickets: (slug: string) => Array<CompletionTicket & { storyId?: string; archived?: boolean }>;
  getTicket: (slug: string, idOrRef: string) => CompletionTicket | null;
  openBlockers: (slug: string, ticket: CompletionTicket) => string[];
  negativeControlResult: (ticket: CompletionTicket, expectedTestNames: string[], candidate: string | null) => { kind?: string; evidence?: string; captureId?: string };
  projectDir: (slug: string) => string;
  readMeta: (slug: string) => { path?: string } | null;
}

export function createCompletion(dependencies: CompletionDependencies) {
  const { getTicket, openBlockers, negativeControlResult, projectDir, readMeta } = dependencies;

  function controlHolder(ticket: CompletionTicket): CompletionTicket {
    const holder = text(ticket.claim?.by) || text(ticket.submission?.by);
    return { ...ticket, claim: holder ? { by: holder } : null };
  }

  function completionContext(slug: string, ticket: CompletionTicket): CompletionContext {
    const boardDirectory = projectDir(slug);
    const evidenceDirectory = text(ticket.dispatch?.evidenceDirectory) || path.join(boardDirectory, 'verification', ticket.ref);
    return {
      demonstrations: readDemonstrations(evidenceDirectory),
      openBlockers: openBlockers(slug, ticket),
      integrationProgress: readIntegrationProgress(integrationProgressPath(boardDirectory, ticket.ref)),
      negativeControl: negativeControlResult(controlHolder(ticket), [], candidateOf(ticket)),
      releaseRecord: null,
      roots: {
        project: readMeta(slug)?.path ?? null,
        verification: path.join(boardDirectory, 'verification'),
        evidence: ticket.dispatch?.evidenceDirectory ?? null,
      },
    };
  }

  function completionPayload(slug: string, idOrRef: string): CompletionView | null {
    const ticket = getTicket(slug, idOrRef);
    return ticket ? completionView(ticket, completionContext(slug, ticket)) : null;
  }

  function storyCompletionPayload(slug: string, idOrRef: string): StoryCompletionView | null {
    const story = dependencies.getStory(slug, idOrRef);
    if (!story) return null;
    const children = dependencies.listTickets(slug).filter((ticket) => ticket.storyId === story.id && !ticket.archived);
    return storyCompletionView(story, children.map((ticket) => completionView(ticket, completionContext(slug, ticket))));
  }

  return { completionPayload, storyCompletionPayload };
}

export type CompletionSummaryInput = Pick<CompletionSummary, 'result' | 'checked' | 'uncertain' | 'action'>;
const SUMMARY_FIELDS = ['result', 'checked', 'uncertain', 'action'] as const;
export const COMPLETION_SUMMARY_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(SUMMARY_FIELDS.map(field => [field, { type: 'string', maxLength: 600 }])),
  required: [...SUMMARY_FIELDS],
  additionalProperties: false,
};

function validateSummaryField(value: unknown): string {
  if (typeof value !== 'string' || value.length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new Error('summary fields must be plain text of at most 600 characters');
  }
  return value;
}

function summaryDescriptors(value: unknown): PropertyDescriptorMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('summary must contain result, checked, uncertain and action');
  return Object.getOwnPropertyDescriptors(value);
}

export function completionSummaryInput(value: unknown): CompletionSummaryInput | undefined {
  if (value === undefined) return undefined;
  const fields = summaryDescriptors(value);
  if (Object.keys(fields).some(field => !SUMMARY_FIELDS.some(allowed => allowed === field))) throw new Error('summary contains an unknown field');
  return {
    result: validateSummaryField(fields.result?.value),
    checked: validateSummaryField(fields.checked?.value),
    uncertain: validateSummaryField(fields.uncertain?.value),
    action: validateSummaryField(fields.action?.value),
  };
}

export const ACCEPTANCE_MAX_EXAMPLES = 8;
export const ACCEPTANCE_TEXT_MAX = 300;
const ACCEPTANCE_KINDS: readonly AcceptanceKind[] = ['main', 'boundary'];
const ACCEPTANCE_FIELDS = ['scenario', 'expected', 'kind'];
const ACCEPTANCE_TEXT_SCHEMA = { type: 'string', maxLength: ACCEPTANCE_TEXT_MAX };
export const ACCEPTANCE_SCHEMA = {
  type: 'array',
  maxItems: ACCEPTANCE_MAX_EXAMPLES,
  items: {
    type: 'object',
    properties: { scenario: ACCEPTANCE_TEXT_SCHEMA, expected: ACCEPTANCE_TEXT_SCHEMA, kind: { type: 'string', enum: ACCEPTANCE_KINDS } },
    required: ACCEPTANCE_FIELDS,
    additionalProperties: false,
  },
  description: 'Examples the executor demonstrates on the real surface; [] clears.',
};

function acceptanceRecord(value: unknown, index: number): Map<string, unknown> {
  const record = recordFields(value);
  if (!record) throw new Error(`acceptance[${index}] must be an object with scenario, expected and kind`);
  const unknownField = [...record.keys()].find((field) => !ACCEPTANCE_FIELDS.includes(field));
  if (unknownField) throw new Error(`acceptance[${index}] has unknown field ${unknownField}`);
  return record;
}

function acceptanceText(value: unknown, field: string, index: number): string {
  const trimmed = text(value);
  const plain = Boolean(trimmed) && trimmed.length <= ACCEPTANCE_TEXT_MAX && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(trimmed);
  if (!plain) throw new Error(`acceptance[${index}].${field} must be plain text of 1 to ${ACCEPTANCE_TEXT_MAX} characters`);
  return trimmed;
}

function acceptanceKind(value: unknown, index: number): AcceptanceKind {
  const kind = ACCEPTANCE_KINDS.find((candidate) => candidate === value);
  if (!kind) throw new Error(`acceptance[${index}].kind must be main or boundary`);
  return kind;
}

function acceptanceExample(value: unknown, index: number): AcceptanceExample {
  const record = acceptanceRecord(value, index);
  return {
    scenario: acceptanceText(record.get('scenario'), 'scenario', index),
    expected: acceptanceText(record.get('expected'), 'expected', index),
    kind: acceptanceKind(record.get('kind'), index),
  };
}

export function acceptanceExamplesInput(value: unknown): AcceptanceExample[] {
  if (!Array.isArray(value)) throw new Error('acceptance must be an array of { scenario, expected, kind }');
  if (value.length > ACCEPTANCE_MAX_EXAMPLES) throw new Error(`acceptance holds at most ${ACCEPTANCE_MAX_EXAMPLES} examples`);
  const examples = value.map(acceptanceExample);
  if (new Set(examples.map((example) => example.scenario)).size !== examples.length) throw new Error('acceptance scenarios must be distinct');
  return examples;
}

function matchesCandidateSummary(recorded: Partial<CompletionSummary> | null | undefined, summary: CompletionSummaryInput, candidate: string | null): boolean {
  return recorded?.candidate === candidate && identicalSummary(recorded, summary);
}

function identicalSummary(recorded: Partial<CompletionSummary> | null | undefined, summary: CompletionSummaryInput): boolean {
  return SUMMARY_FIELDS.every(field => recorded?.[field] === summary[field]);
}

interface SummaryCloseoutResult { ok: boolean; ticket?: CompletionTicket; summaryError?: string }
interface SummaryCloseoutOptions { summary?: unknown; commit?: string; sourceRevision?: { value: string } }
interface SummaryCloseoutDependencies {
  getTicket: (slug: string, ref: string) => CompletionTicket | null;
  putTicket: (slug: string, ticket: CompletionTicket) => void;
  addComment: (slug: string, ref: string, comment: { by: string; body: string; source: string }) => unknown;
  withTicketLock: (slug: string, ref: string, callback: () => void) => unknown;
}

function summaryCloseoutRecorded(ticket: CompletionTicket, kind: string, by: string): boolean {
  if (kind === 'done') return ticket.status === 'done' && ticket.completion?.by === by;
  return ticket.submission?.by === by && !ticket.submission.integratedAt;
}

function summaryCandidate(ticket: CompletionTicket | null, options: SummaryCloseoutOptions, kind: string): string | null {
  if (kind === 'submit') return options.commit?.toLowerCase() || options.sourceRevision?.value || null;
  return candidateOf(ticket || { ref: '' });
}

function repeatSummaryCloseout(ticket: CompletionTicket | null, by: string, candidate: string | null, kind: string, summary: CompletionSummaryInput): boolean {
  if (!ticket || ticket.claim || ticket.completionSummary?.by !== by) return false;
  const terminal = summaryCloseoutRecorded(ticket, kind, by);
  return terminal && matchesCandidateSummary(ticket.completionSummary, summary, candidate);
}

function persistCompletionSummary(dependencies: SummaryCloseoutDependencies, slug: string, ref: string, by: string, summary: CompletionSummaryInput, candidate: string | null): CompletionTicket {
  const ticket = dependencies.getTicket(slug, ref);
  if (!ticket) throw new Error('summary ticket disappeared after closeout');
  if (matchesCandidateSummary(ticket.completionSummary, summary, candidate)) return ticket;
  ticket.completionSummary = { version: 1, ...summary, by, at: new Date().toISOString(), candidate };
  dependencies.putTicket(slug, ticket);
  return ticket;
}

function recordSummaryError(dependencies: SummaryCloseoutDependencies, slug: string, ref: string, by: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    dependencies.addComment(slug, ref, { by, body: `Completion summary could not be saved: ${message}`, source: 'summary' });
  } catch {
    return `${message} (summary error comment also could not be saved)`;
  }
  return message;
}

export function createSummaryCloseout(dependencies: SummaryCloseoutDependencies) {
  return function summaryCloseout(slug: string, ref: string, by: string, options: SummaryCloseoutOptions, kind: 'submit' | 'done', close: () => SummaryCloseoutResult): SummaryCloseoutResult {
    const summary = completionSummaryInput(options.summary);
    if (!summary) return close();
    const ticket = dependencies.getTicket(slug, ref);
    const candidate = summaryCandidate(ticket, options, kind);
    if (ticket && repeatSummaryCloseout(ticket, by, candidate, kind, summary)) return { ok: true, ticket };
    const result = close();
    if (!result.ok) return result;
    return saveSummaryAfterCloseout(dependencies, slug, ref, by, summary, result);
  };
}

function saveSummaryAfterCloseout(dependencies: SummaryCloseoutDependencies, slug: string, ref: string, by: string, summary: CompletionSummaryInput, result: SummaryCloseoutResult): SummaryCloseoutResult {
  try {
    const candidate = candidateOf(result.ticket || { ref });
    let saved = false;
    const ticket = dependencies.getTicket(slug, ref);
    dependencies.withTicketLock(slug, ticket?.id || ref, () => {
      result.ticket = persistCompletionSummary(dependencies, slug, ref, by, summary, candidate);
      saved = true;
    });
    if (!saved) throw new Error('summary ticket lock unavailable');
    return result;
  } catch (error) {
    return { ...result, summaryError: recordSummaryError(dependencies, slug, ref, by, error) };
  }
}
