import { expect, test } from 'claude-code/testing'

import { parseFrontmatter, serializeFrontmatter } from './frontmatter'

test('scalars and inline arrays survive a round trip', () => {
  const fields = {
    id: 'SQ-12',
    title: 'Retry: failed uploads, again',
    empty: '',
    quoted: '"already quoted"',
    blockedBy: ['SQ-11', 'SQ-9'],
    tags: ['one, two', ''],
    none: [],
  }
  const text = serializeFrontmatter(fields, '\n## What\nIt works.\n')
  const parsed = parseFrontmatter(text)

  expect(parsed.fields).toEqual(fields)
  expect(parsed.body).toBe('\n## What\nIt works.\n')
})

test('a hand-written file with CRLF, single quotes and bare values parses', () => {
  const parsed = parseFrontmatter("---\r\nid: SQ-3\r\ntitle: 'It''s fine'\r\nblockedBy: [SQ-1, \"SQ-2\"]\r\n---\r\nbody")

  expect(parsed.fields).toEqual({ id: 'SQ-3', title: "It's fine", blockedBy: ['SQ-1', 'SQ-2'] })
  expect(parsed.body).toBe('body')
})

test('text without frontmatter is all body', () => {
  expect(parseFrontmatter('# Just notes')).toEqual({ fields: {}, body: '# Just notes' })
})
