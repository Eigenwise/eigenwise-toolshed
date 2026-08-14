'use strict';

type SubmissionFailure = Readonly<{ reason: string; message: string }>;
type SubmissionRefusal = Readonly<{ ok: false; ticket: SubmissionTicket; reason: string; message: string }>;
type SubmissionAdmission = readonly SubmissionFailure[] | SubmissionRefusal;
type SubmissionTicket = Readonly<{ ref: string }>;
type SubmissionInput = Readonly<{ slug: string; ticket: SubmissionTicket; by: string; verify: string; base?: string; commit: string; force?: boolean }>;

export type SubmissionPolicyPorts = Readonly<{
  ownershipFailure(ticket: SubmissionTicket, by: string, force: boolean): SubmissionRefusal | null;
  completionCheck(slug: string, ticket: SubmissionTicket, explicitNoOp: boolean): Readonly<{ ok: boolean; reason: string; message: string }>;
  verifyErrors(ticket: SubmissionTicket, verify: string): readonly string[];
  declaredVerify(ticket: SubmissionTicket): string;
}>;

export function validateSubmissionAdmission(ports: SubmissionPolicyPorts, input: SubmissionInput): SubmissionAdmission {
  const ownership = ports.ownershipFailure(input.ticket, input.by, input.force === true);
  if (ownership) return ownership;
  const failures: Array<{ reason: string; message: string }> = [];
  const completion = ports.completionCheck(input.slug, input.ticket, String(input.base || '').trim() === input.commit);
  if (!completion.ok) failures.push({ reason: completion.reason, message: completion.message });
  for (const message of ports.verifyErrors(input.ticket, input.verify)) failures.push({ reason: 'invalid_verify', message });
  const declared = ports.declaredVerify(input.ticket);
  if (declared && input.verify !== declared) failures.push({ reason: 'executor_verify_mismatch', message: `submit: refused ${input.ticket.ref}; verification must match the declared executor verify command.` });
  return failures;
}
