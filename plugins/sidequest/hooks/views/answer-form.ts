import type { PlanForm, TicketForm } from '../../types'

export const NO_TICKET_FORM: TicketForm = { id: '', picked: '', ticked: [], showsWhole: false, typed: '', remarkSent: '' }
export const NO_PLAN_FORM: PlanForm = { id: '', otherAnswers: [], typed: '', remarkSent: '' }

// A form left from another ticket or plan starts over, so a pick never carries to the wrong question.
export const ticketFormFor = (form: TicketForm, id: string): TicketForm => (form.id === id ? form : { ...NO_TICKET_FORM, id })

export const planFormFor = (form: PlanForm, id: string): PlanForm => (form.id === id ? form : { ...NO_PLAN_FORM, id })

const toggled = (indexes: readonly number[], index: number): number[] =>
  indexes.includes(index) ? indexes.filter(one => one !== index) : [...indexes, index].sort((left, right) => left - right)

export const withAnswerPicked = (form: TicketForm, id: string, label: string): TicketForm => ({ ...ticketFormFor(form, id), picked: label })

export const withItemTicked = (form: TicketForm, id: string, index: number): TicketForm => {
  const current = ticketFormFor(form, id)

  return { ...current, ticked: toggled(current.ticked, index) }
}

export const withWholeTicketShown = (form: TicketForm, id: string): TicketForm => ({ ...ticketFormFor(form, id), showsWhole: true })

export const withOtherAnswerToggled = (form: PlanForm, id: string, index: number): PlanForm => {
  const current = planFormFor(form, id)

  return { ...current, otherAnswers: toggled(current.otherAnswers, index) }
}

export const withTicketWordsTyped = (form: TicketForm, id: string, typed: string): TicketForm => ({ ...ticketFormFor(form, id), typed, remarkSent: '' })

export const withPlanWordsTyped = (form: PlanForm, id: string, typed: string): PlanForm => ({ ...planFormFor(form, id), typed, remarkSent: '' })

// After a say field's Send the field starts empty, and this one line says where the words went.
export const remarkSentLine = (words: string, isToItsAgent: boolean): string =>
  `Sent to ${isToItsAgent ? 'the agent building it' : 'the session'}, and kept on file: "${words}"`

export const tickedItems = (form: TicketForm, alsoYours: readonly string[]): string[] => form.ticked.flatMap(index => alsoYours[index] ?? [])
