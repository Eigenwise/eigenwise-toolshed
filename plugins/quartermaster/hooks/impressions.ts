import { jsonLines } from './events'
import { hasStringFields, isJsonObject } from './tool-input'

export type ImpressionKind = 'shown' | 'review' | 'not-now' | 'never' | 'ignored'

export type Impression = { at: string; fingerprint: string; kind: ImpressionKind }

export const FIRST_BACKOFF_DAYS = 3

const DAY_MS = 24 * 60 * 60 * 1000

const IMPRESSION_KINDS: readonly string[] = ['shown', 'review', 'not-now', 'never', 'ignored']

export type OfferTiming = { kind: 'now' } | { kind: 'after'; at: number } | { kind: 'never' }

const isPushback = (impression: Impression): boolean => impression.kind === 'not-now' || impression.kind === 'ignored'

/**
 * After an ignored or not-now offer wait three days, doubling with each one
 * since; a `never` answer ends offers for that fingerprint for good.
 */
export const nextOffer = (fingerprint: string, impressions: readonly Impression[]): OfferTiming => {
  const own = impressions.filter(impression => impression.fingerprint === fingerprint)
  if (own.some(impression => impression.kind === 'never')) return { kind: 'never' }
  const pushbacks = own.filter(isPushback).map(impression => Date.parse(impression.at))
  if (pushbacks.length === 0) return { kind: 'now' }
  const waitDays = FIRST_BACKOFF_DAYS * 2 ** (pushbacks.length - 1)

  return { kind: 'after', at: Math.max(...pushbacks) + waitDays * DAY_MS }
}

export const mayOfferNow = (fingerprint: string, impressions: readonly Impression[], now: number): boolean => {
  const timing = nextOffer(fingerprint, impressions)

  return timing.kind === 'now' || (timing.kind === 'after' && now >= timing.at)
}

/** Pressing Later takes the line out of sight until the wait it started is over, where an ignored toast only delays the next toast. */
export const isSetAsideForNow = (fingerprint: string, impressions: readonly Impression[], now: number): boolean =>
  impressions.some(impression => impression.fingerprint === fingerprint && impression.kind === 'not-now') &&
  !mayOfferNow(fingerprint, impressions, now)

const isImpression = (value: unknown): value is Impression =>
  isJsonObject(value) && hasStringFields(value, ['fingerprint', 'at']) && IMPRESSION_KINDS.includes(String(value.kind))

export const parseImpressions = (text: string): Impression[] => jsonLines(text).filter(isImpression)

export const impressionLine = (impression: Impression): string => `${JSON.stringify(impression)}\n`
