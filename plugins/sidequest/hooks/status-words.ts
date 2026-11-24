const STATUS_WORDS: Readonly<Record<string, string>> = {
  inbox: 'not ready yet',
  ready: 'ready to start',
  doing: 'in progress',
  review: 'built, being checked',
  'needs-you': 'waiting on you',
  parked: 'set aside',
}

// What a person reads for a status. The files and what the model reads keep the status itself.
export const statusWords = (status: string): string => STATUS_WORDS[status] ?? status

// The status's own words hold a comma, which reads as one more item inside a comma-separated count.
export const REVIEW_WORDS_IN_A_COUNT = 'being checked'

type StatusCounts = { needsYou: number; ready: number; doing: number; review: number }

// The summary view may be pasted to the person, so it counts in the words the pane and the band use.
export const statusCountsInWords = (counts: StatusCounts): string =>
  `${counts.needsYou} ${statusWords('needs-you')}, ${counts.ready} ${statusWords('ready')}, ${counts.doing} ${statusWords('doing')}, ${counts.review} ${REVIEW_WORDS_IN_A_COUNT}`
