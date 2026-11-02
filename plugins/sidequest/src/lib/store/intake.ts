'use strict';

export type IntakeStamp = { by: string; at: string };
export type IntakeOption = { label: string; recommended?: true; reason: string };
export type StoryIntake = {
  status: 'drafting' | 'reviewing' | 'awaiting-human' | 'approved' | 'reopened';
  requester: IntakeStamp;
  delegates: (IntakeStamp & { namedBy: string })[];
  sizing: (IntakeStamp & { size: 'one-ticket' | 'one-wave' | 'multi-wave'; reason: string }) | null;
  playback: (IntakeStamp & { text: string }) | null;
  cycles: (IntakeStamp & { n: number; reviewRef: string; findingsSummary: string; researchRefs: string[] })[];
  questions: (IntakeStamp & { id: string; text: string; options: IntakeOption[]; answer: string | null; answeredBy: string | null; answeredAt: string | null; assumption?: true })[];
  optionsConsidered: { label: string; chosen: boolean; reason: string }[];
  approval: (IntakeStamp & { contractRevision: number }) | null;
  reopened: (IntakeStamp & { reason: string })[];
};
export type IntakeStory = { id: string; ref: string; contractRevision: number; intake?: StoryIntake; updatedAt: string };
export type IntakeTicket = { storyId?: string | null; category?: string | { id?: string; readonly?: boolean } | null; categoryId?: string; intakeExempt?: { reason: string } | null };
export type IntakeInput = {
  action: string; story?: string; ref?: string; by: string; namedBy?: string;
  text?: string; size?: string; reason?: string; options?: IntakeOption[];
  id?: string; answer?: string; assumption?: boolean; review?: string;
  findings?: string; research?: string[];
};
type IntakeDependencies = {
  boardConfig(slug: string): { intake: { mode: string } };
  getStory(slug: string, reference: string): IntakeStory | null;
  getCategory(reference: string, options: { project: string }): { readonly?: boolean } | null;
  putStory(slug: string, story: IntakeStory): void;
  transaction<Result>(operation: () => Result): Result;
  updateTicket(slug: string, reference: string, patch: { intakeExempt: { reason: string }; by: string }): unknown;
};

export function requiredIntakeText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`story_intake: ${name} is required.`);
  return value.trim();
}

export function normalizeIntakeExempt(value: unknown): { reason: string } | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new Error('intakeExempt must be { reason } or null.');
  const reason = requiredIntakeText(Reflect.get(value, 'reason'), 'reason');
  if (reason.length < 20) throw new Error('intakeExempt reason must be at least 20 characters and name size, reversibility and stakes.');
  return { reason };
}

export function newStoryIntake(by: string = 'orchestrator', at: string): StoryIntake {
  return { status: 'drafting', requester: { by, at }, delegates: [], sizing: null, playback: null, cycles: [], questions: [], optionsConsidered: [], approval: null, reopened: [] };
}

function requireRequester(intake: StoryIntake, by: string): void {
  if (intake.requester.by !== by) throw new Error('story_intake: only the requester may name a delegate.');
}

function approveIntake(story: IntakeStory, intake: StoryIntake, stamp: IntakeStamp): void {
  const authorized = new Set([intake.requester.by, ...intake.delegates.map(delegate => delegate.by)]);
  if (!authorized.has(stamp.by)) throw new Error('story_intake approve: by must be the requester or a requester-named delegate.');
  intake.approval = { ...stamp, contractRevision: story.contractRevision };
  intake.status = 'approved';
}

function intakeSizing(input: IntakeInput, stamp: IntakeStamp): NonNullable<StoryIntake['sizing']> {
  const size = input.size;
  if (size !== 'one-ticket' && size !== 'one-wave' && size !== 'multi-wave') throw new Error('story_intake: size must be one-ticket, one-wave or multi-wave.');
  return { ...stamp, size, reason: requiredIntakeText(input.reason, 'reason') };
}

function validateIntakeOption(option: IntakeOption): IntakeOption {
  return { label: requiredIntakeText(option.label, 'option label'), reason: requiredIntakeText(option.reason, 'option reason'), ...(option.recommended === true ? { recommended: true as const } : {}) };
}

function addIntakeQuestion(intake: StoryIntake, input: IntakeInput, stamp: IntakeStamp): void {
  if (!Array.isArray(input.options) || !input.options.length) throw new Error('story_intake: options must be a non-empty array.');
  intake.questions.push({ ...stamp, id: `q${intake.questions.length + 1}`, text: requiredIntakeText(input.text, 'text'), options: input.options.map(validateIntakeOption), answer: null, answeredBy: null, answeredAt: null });
  intake.status = 'awaiting-human';
}

function answerIntakeQuestion(intake: StoryIntake, input: IntakeInput, stamp: IntakeStamp): void {
  const question = intake.questions.find(question => question.id === input.id);
  if (!question) throw new Error('story_intake: unknown question id.');
  Object.assign(question, { answer: requiredIntakeText(input.answer, 'answer'), answeredBy: stamp.by, answeredAt: stamp.at });
  delete question.assumption;
  if (input.assumption === true) question.assumption = true;
}

function intakeTicketReference(value: unknown): string {
  const reference = requiredIntakeText(value, 'ticket ref').toUpperCase();
  if (!/^SQ-\d+$/.test(reference)) throw new Error('story_intake: ticket refs must use SQ-n.');
  return reference;
}

function recordIntakeCycle(intake: StoryIntake, input: IntakeInput, stamp: IntakeStamp): void {
  intake.cycles.push({ ...stamp, n: intake.cycles.length + 1, reviewRef: intakeTicketReference(input.review), findingsSummary: requiredIntakeText(input.findings, 'findings'), researchRefs: (input.research || []).map(intakeTicketReference) });
  if (intake.status === 'drafting') intake.status = 'reviewing';
}

function reopenIntake(intake: StoryIntake, input: IntakeInput, stamp: IntakeStamp): void {
  intake.reopened.push({ ...stamp, reason: requiredIntakeText(input.reason, 'reason') });
  intake.approval = null;
  intake.status = 'reopened';
}

function mutateIntake(story: IntakeStory, intake: StoryIntake, input: IntakeInput, stamp: IntakeStamp): void {
  const actions: Record<string, () => void> = {
    playback: () => { intake.playback = { ...stamp, text: requiredIntakeText(input.text, 'text') }; },
    sizing: () => { intake.sizing = intakeSizing(input, stamp); },
    question: () => addIntakeQuestion(intake, input, stamp),
    answer: () => answerIntakeQuestion(intake, input, stamp),
    cycle: () => recordIntakeCycle(intake, input, stamp),
    approve: () => approveIntake(story, intake, stamp),
    delegate: () => { requireRequester(intake, requiredIntakeText(input.namedBy, 'namedBy')); intake.delegates.push({ ...stamp, namedBy: input.namedBy! }); },
    reopen: () => reopenIntake(intake, input, stamp),
  };
  if (!Object.hasOwn(actions, input.action)) throw new Error('story_intake: unknown action.');
  actions[input.action]!();
}

function categoryReference(ticket: IntakeTicket): string {
  const category = typeof ticket.category === 'string' ? ticket.category : ticket.category?.id;
  return ticket.categoryId || category || '';
}

export function createIntake(dependencies: IntakeDependencies) {
  function readOnlyCategory(slug: string, ticket: IntakeTicket): boolean {
    if (typeof ticket.category === 'object' && ticket.category?.readonly === true) return true;
    return dependencies.getCategory(categoryReference(ticket), { project: slug })?.readonly === true;
  }

  function intakeDispatchRefusal(slug: string, ticket: IntakeTicket): { reason: 'intake_not_approved'; message: string } | null {
    if (dependencies.boardConfig(slug).intake.mode === 'off') return null;
    if (readOnlyCategory(slug, ticket)) return null;
    if (ticket.intakeExempt) return null;
    if (!ticket.storyId) return null;
    return storyApprovalRefusal(slug, ticket.storyId);
  }

  function storyApprovalRefusal(slug: string, storyId: string): { reason: 'intake_not_approved'; message: string } | null {
    const story = dependencies.getStory(slug, storyId);
    if (story?.intake?.approval?.contractRevision === story?.contractRevision && story?.intake?.approval) return null;
    return { reason: 'intake_not_approved', message: `${story?.ref || storyId} intake is ${story?.intake?.status || 'drafting'}. Run the intake round and approve through story_intake approve, or set intakeExempt with a reason naming size, reversibility and stakes.` };
  }

  function storyIntake(slug: string, input: IntakeInput): unknown {
    const by = requiredIntakeText(input.by, 'by');
    if (input.action === 'exempt') return exemptTicket(slug, input, by);
    return dependencies.transaction(() => {
      const story = dependencies.getStory(slug, requiredIntakeText(input.story, 'story'));
      if (!story) throw new Error('story_intake: story not found.');
      const at = new Date().toISOString();
      const intake = structuredClone(story.intake || newStoryIntake('orchestrator', at));
      mutateIntake(story, intake, input, { by, at });
      dependencies.putStory(slug, { ...story, intake, updatedAt: at });
      return { ...story, intake, updatedAt: at };
    });
  }

  function exemptTicket(slug: string, input: IntakeInput, by: string): unknown {
    const intakeExempt = normalizeIntakeExempt({ reason: input.reason })!;
    const ticket = dependencies.updateTicket(slug, intakeTicketReference(input.ref), { intakeExempt, by });
    if (!ticket) throw new Error('story_intake: ticket not found.');
    return ticket;
  }

  return { intakeDispatchRefusal, storyIntake };
}
