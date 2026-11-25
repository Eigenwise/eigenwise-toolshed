export type FrontmatterValue = string | string[]
export type Frontmatter = Record<string, FrontmatterValue>

// The three extra fields are left out when they do not apply, so a clean file parses to just its fields and body.
// `isDamaged` means the file opens a frontmatter block and never closes it: nothing in it was read, and a write would lose it.
export type FrontmatterDocument = {
  fields: Frontmatter
  body: string
  isDamaged?: true
  hasByteOrderMark?: true
  duplicatedKeys?: string[]
}

const FENCE = '---'
const BYTE_ORDER_MARK = '﻿'
const FIELD_LINE = /^([A-Za-z][\w-]*):\s?(.*)$/
const LIST_ITEM_LINE = /^[ \t]*-[ \t]+(.*)$/
const ARRAY_ITEM = /"(?:[^"\\]|\\.)*"|[^,\s][^,]*/g
const NEEDS_QUOTES = /^$|^[\s"'[\]{}#&*!|>%@`-]|[:#]\s|[:\s]$|[,"\n]/

export const parseFrontmatter = (text: string): FrontmatterDocument => {
  const hasByteOrderMark = text.startsWith(BYTE_ORDER_MARK)
  const content = hasByteOrderMark ? text.slice(BYTE_ORDER_MARK.length) : text
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const end = lines.indexOf(FENCE, 1)
  const mark: Pick<FrontmatterDocument, 'hasByteOrderMark'> = hasByteOrderMark ? { hasByteOrderMark: true } : {}
  if (lines[0] !== FENCE) return { fields: {}, body: content, ...mark }
  if (end === -1) return { fields: {}, body: content, isDamaged: true, ...mark }

  return { ...parseFieldLines(lines.slice(1, end)), body: lines.slice(end + 1).join('\n'), ...mark }
}

const parseFieldLines = (lines: string[]): Pick<FrontmatterDocument, 'fields' | 'duplicatedKeys'> => {
  const fields: Frontmatter = {}
  const duplicatedKeys = new Set<string>()
  lines.forEach((line, index) => {
    const [, key, raw] = FIELD_LINE.exec(line) ?? []
    if (key === undefined) return
    if (Object.hasOwn(fields, key)) duplicatedKeys.add(key)
    fields[key] = parseValue((raw ?? '').trim(), lines.slice(index + 1))
  })

  return duplicatedKeys.size === 0 ? { fields } : { fields, duplicatedKeys: [...duplicatedKeys] }
}

const listBelow = (followingLines: string[]): string[] | undefined => {
  const items: string[] = []
  for (const line of followingLines) {
    const item = LIST_ITEM_LINE.exec(line)?.[1]
    if (item === undefined) break
    items.push(parseScalar(item.trim()))
  }

  return items.length > 0 ? items : undefined
}

const parseValue = (raw: string, followingLines: string[]): FrontmatterValue => {
  if (raw === '') return listBelow(followingLines) ?? ''

  return raw.startsWith('[') && raw.endsWith(']') ? parseInlineArray(raw.slice(1, -1)) : parseScalar(raw)
}

const parseInlineArray = (inner: string): string[] =>
  [...inner.matchAll(ARRAY_ITEM)].map(match => parseScalar(match[0].trim()))

const isWrappedIn = (raw: string, quote: string): boolean =>
  raw.length > 1 && raw.startsWith(quote) && raw.endsWith(quote)

const parseScalar = (raw: string): string => {
  if (isWrappedIn(raw, '"')) return parseQuoted(raw)
  if (isWrappedIn(raw, "'")) return raw.slice(1, -1).replace(/''/g, "'")

  return raw
}

const parseQuoted = (raw: string): string => {
  try {
    const value: unknown = JSON.parse(raw)

    return typeof value === 'string' ? value : raw
  } catch {
    return raw.slice(1, -1)
  }
}

export const serializeFrontmatter = (fields: Frontmatter, body: string, hasByteOrderMark = false): string => {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${formatValue(value)}`)

  return `${hasByteOrderMark ? BYTE_ORDER_MARK : ''}${FENCE}\n${lines.join('\n')}\n${FENCE}\n${body}`
}

const formatValue = (value: FrontmatterValue): string =>
  Array.isArray(value) ? `[${value.map(formatScalar).join(', ')}]` : formatScalar(value)

const formatScalar = (value: string): string => (NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value)
