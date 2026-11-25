export type Rejection = { fingerprint: string; reason: string; date: string }

const REJECTION_LINE = /^- `([^`]+)` (\d{4}-\d{2}-\d{2}): (.*)$/

const HEADER = '# Rejected\n\nQuartermaster never offers these again. Delete a line to allow it back.\n\n'

export const parseRejections = (text: string): Rejection[] =>
  text.split(/\r?\n/).flatMap(line => {
    const match = REJECTION_LINE.exec(line)

    return match === null ? [] : [{ fingerprint: match[1] ?? '', date: match[2] ?? '', reason: match[3] ?? '' }]
  })

const rejectionLine = (rejection: Rejection): string =>
  `- \`${rejection.fingerprint}\` ${rejection.date}: ${rejection.reason.replace(/\s+/g, ' ').trim()}\n`

export const serializeRejections = (rejections: readonly Rejection[]): string =>
  HEADER + rejections.map(rejectionLine).join('')

export const withRejections = (existing: readonly Rejection[], added: readonly Rejection[]): Rejection[] => {
  const known = new Set(existing.map(rejection => rejection.fingerprint))

  return [...existing, ...added.filter(rejection => !known.has(rejection.fingerprint))]
}

export const rejectedFingerprints = (rejections: readonly Rejection[]): Set<string> =>
  new Set(rejections.map(rejection => rejection.fingerprint))
