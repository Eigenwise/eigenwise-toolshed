'use strict';

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
export interface CompletionView {
  ref: string;
  title: string;
  stage: CompletionStage;
  blocker: CompletionBlocker | null;
  facts: CompletionFacts;
  summary: CompletionSummary | null;
  evidence: CompletionEvidence[];
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
}
export interface CompletionContext {
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
  const view: CompletionView = {
    ref: ticket.ref,
    title: text(ticket.title),
    stage,
    blocker: completionBlocker(stage, ticket, context),
    facts: completionFacts(ticket, context, summary),
    summary,
    evidence: evidenceEntries(ticket, approvedRoots(context)),
    text: '',
  };
  view.text = completionText(view);
  return view;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeCompletionText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
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
    `Quality: ${QUALITY_WORDING[facts.quality.status]}.`,
    controlClause(facts.negativeControl),
    reviewClause(facts.review),
  ].join(' ') + agent;
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
  qualityDoubt,
  controlDoubt,
  (view) => (view.stage === 'integrated' ? 'No release record; shipping is unconfirmed.' : null),
  (view) => (view.summary?.uncertain ? `Agent says: ${view.summary.uncertain}` : null),
];

function uncertainSection(view: CompletionView): string {
  const doubts = DOUBTS.map((doubt) => doubt(view)).filter(Boolean);
  return doubts.length ? doubts.join(' ') : 'Nothing flagged by the records.';
}

function actionSection(view: CompletionView): string {
  const blocker = view.blocker;
  if (blocker?.actor === 'user') return blocker.nextAction;
  const noAction = TERMINAL_STAGES.has(view.stage) || Boolean(blocker);
  const next = blocker ? ` Next (${blocker.actor}): ${blocker.nextAction}` : '';
  return noAction ? `No action needed.${next}` : 'Check the ticket; the records name no next step.';
}

export function completionText(view: CompletionView): string {
  const sections: [string, string, number][] = [
    ['', `${view.ref} ${view.title} [${view.stage}]`, SECTION_WORDS.header],
    ['Result: ', resultSection(view), SECTION_WORDS.result],
    ['Checked: ', checkedSection(view), SECTION_WORDS.checked],
    ['Still uncertain: ', uncertainSection(view), SECTION_WORDS.uncertain],
    ['Your action: ', actionSection(view), SECTION_WORDS.action],
  ];
  return sections.map(([label, body, limit]) => label + escapeCompletionText(clampWords(body, limit))).join('\n');
}

interface CompletionDependencies {
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
    return {
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

  return { completionPayload };
}
