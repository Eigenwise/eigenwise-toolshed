// The plugins' view code returns a tree of the host's elements (Box, Text, Button, Input, Markdown, Code). The
// host draws that tree in a terminal. This file draws the same tree as HTML in a terminal's grid, so a browser can
// take its picture. Only the drawing of each element is ours; what is in the tree is the plugin's.
import type { Elements } from 'claude-code'

export type DrawnElement = { type: string; props: ElementProps; children: readonly unknown[] }
type ElementProps = Record<string, unknown>

const FRAGMENT = 'Fragment'

type ElementName = 'Box' | 'Text' | 'Button' | 'Input' | 'Markdown' | 'Code'
export type HostElements = Pick<Elements['terminal'], ElementName>

const elementNameOf = new Map<unknown, ElementName>()

// The views write `<Box>`, which the compiler turns into a call of the JSX factory below with this function as the
// element's type: the function is only a name the factory knows, and is never called itself.
const elementNamed = (name: ElementName): (() => never) => {
  const constructor = (): never => {
    throw new Error(`${name} was called directly; it is drawn through the JSX factory`)
  }
  elementNameOf.set(constructor, name)

  return constructor
}

export const HOST_ELEMENTS: HostElements = {
  Box: elementNamed('Box'),
  Text: elementNamed('Text'),
  Button: elementNamed('Button'),
  Input: elementNamed('Input'),
  Markdown: elementNamed('Markdown'),
  Code: elementNamed('Code'),
}

const isDrawnElement = (value: unknown): value is DrawnElement =>
  typeof value === 'object' && value !== null && 'type' in value && 'children' in value

const createElement = (type: unknown, props: ElementProps | null, ...children: unknown[]): DrawnElement => {
  const name = type === FRAGMENT ? FRAGMENT : elementNameOf.get(type)
  if (name === undefined) throw new Error(`the view drew a ${typeof type}, not one of the host's elements`)
  return { type: name, props: props ?? {}, children }
}

// The plugins' .tsx files are compiled to whichever factory the compiler was told; both names point here.
export const installElementFactory = (): void => {
  Object.assign(globalThis, { React: { createElement, Fragment: FRAGMENT }, h: createElement, Fragment: FRAGMENT })
}

const escaped = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Claude Code's dark theme keys, as near as plain CSS colours get.
const THEME_COLORS: Record<string, string> = {
  text: 'var(--strong)',
  inverseText: 'var(--bg)',
  inactive: 'var(--dim)',
  subtle: 'var(--rail)',
  suggestion: '#b1b9f9',
  remember: '#b1b9f9',
  success: '#4eba65',
  error: '#ff6b80',
  warning: '#ffc107',
  merged: '#af87ff',
  claude: '#d77757',
  permission: '#b1b9f9',
  planMode: '#48968c',
  autoAccept: '#af87ff',
  promptBorder: 'var(--rail)',
  bashBorder: '#fd5db1',
  ide: '#4782c8',
  diffAdded: '#225c2b',
  diffRemoved: '#7a2936',
}

const colorOf = (name: unknown): string | undefined => (typeof name === 'string' ? (THEME_COLORS[name] ?? name) : undefined)

const cells = (value: unknown, unit: 'ch' | 'row'): string | undefined => {
  if (typeof value === 'string') return value
  if (typeof value !== 'number') return undefined
  return unit === 'ch' ? `${value}ch` : `calc(${value} * var(--row))`
}

type StyleRule = [cssName: string, value: string | undefined]

const styleText = (rules: readonly StyleRule[]): string =>
  rules.flatMap(([name, value]) => (value === undefined ? [] : [`${name}:${value}`])).join(';')

// The most specific prop given wins, as `paddingTop` over `paddingY` over `padding`.
const mostSpecific = (props: ElementProps, names: readonly string[]): unknown =>
  names.map(name => props[name]).find(value => value !== undefined)

const spacingRules = (props: ElementProps, kind: 'margin' | 'padding'): StyleRule[] => {
  const down = (side: string) => cells(mostSpecific(props, [`${kind}${side}`, `${kind}Y`, kind]), 'row')
  const across = (side: string) => cells(mostSpecific(props, [`${kind}${side}`, `${kind}X`, kind]), 'ch')

  return [
    [`${kind}-top`, down('Top')],
    [`${kind}-bottom`, down('Bottom')],
    [`${kind}-left`, across('Left')],
    [`${kind}-right`, across('Right')],
  ]
}

const gapRules = (props: ElementProps): StyleRule[] => [
  ['row-gap', cells(mostSpecific(props, ['rowGap', 'gap']), 'row')],
  ['column-gap', cells(mostSpecific(props, ['columnGap', 'gap']), 'ch')],
]

const wordProp = (props: ElementProps, name: string): string | undefined => {
  const value = props[name]
  return typeof value === 'string' ? value : undefined
}

const numberProp = (props: ElementProps, name: string): string | undefined => {
  const value = props[name]
  return typeof value === 'number' ? String(value) : undefined
}

const flexRules = (props: ElementProps): StyleRule[] => [
  ['flex-direction', wordProp(props, 'flexDirection') ?? 'row'],
  ['flex-wrap', wordProp(props, 'flexWrap')],
  ['flex-grow', numberProp(props, 'flexGrow')],
  ['flex-shrink', numberProp(props, 'flexShrink')],
  ['align-items', wordProp(props, 'alignItems')],
  ['align-self', wordProp(props, 'alignSelf')],
  ['justify-content', wordProp(props, 'justifyContent')],
]

const sizeRules = (props: ElementProps): StyleRule[] => [
  ['width', cells(props.width, 'ch')],
  ['min-width', cells(props.minWidth, 'ch')],
  ['height', cells(props.height, 'row')],
]

const borderRules = (props: ElementProps): StyleRule[] =>
  typeof props.borderStyle === 'string'
    ? [
        ['border', `1px solid ${colorOf(props.borderColor) ?? 'var(--rail)'}`],
        ['border-radius', props.borderStyle === 'round' ? '6px' : '0'],
        ['padding', '0 calc(1ch - 1px)'],
      ]
    : []

const boxHtml = (element: DrawnElement): string => {
  const props = element.props
  const style = styleText([
    ...flexRules(props),
    ...gapRules(props),
    ...spacingRules(props, 'margin'),
    ...borderRules(props),
    ...spacingRules(props, 'padding'),
    ...sizeRules(props),
    ['background', colorOf(props.backgroundColor)],
  ])

  return `<div class="box" style="${style}">${childrenHtml(element.children)}</div>`
}

const whenSet = (props: ElementProps, name: string, css: string): string | undefined => (props[name] === true ? css : undefined)

const textStyle = (props: ElementProps): string =>
  styleText([
    ['color', whenSet(props, 'dimColor', 'var(--dim)') ?? colorOf(props.color)],
    ['background', colorOf(props.backgroundColor)],
    ['font-weight', whenSet(props, 'bold', '700')],
    ['font-style', whenSet(props, 'italic', 'italic')],
    ['text-decoration', whenSet(props, 'underline', 'underline') ?? whenSet(props, 'strikethrough', 'line-through')],
  ])

const TRUNCATING = ['truncate', 'truncate-end', 'end']

const textHtml = (element: DrawnElement): string => {
  const wrapping = TRUNCATING.includes(String(element.props.wrap)) ? 'text truncate' : 'text'

  return `<span class="${wrapping}" style="${textStyle(element.props)}">${childrenHtml(element.children)}</span>`
}

const isWords = (child: unknown): child is string | number => typeof child === 'string' || typeof child === 'number'

const plainTextOfOne = (child: unknown): string => {
  if (isWords(child)) return String(child)
  return isDrawnElement(child) ? plainTextOf(child.children) : ''
}

const plainTextOf = (children: readonly unknown[]): string => children.map(plainTextOfOne).join('')

const hotkeyHtml = (props: ElementProps): string => {
  const hotkey = wordProp(props, 'hotkey')
  return hotkey === undefined ? '' : `<span class="accent">${escaped(hotkey)}</span>: `
}

const buttonClasses = (props: ElementProps, kind: string): string =>
  ['button', kind, whenSet(props, 'dimColor', 'dim'), props.variant === 'primary' ? 'primary' : undefined].filter(name => name !== undefined && name !== '').join(' ')

// A Button with a label and no children is its label; with children, the children are its words.
const plainButtonHtml = (element: DrawnElement): string => {
  const label = wordProp(element.props, 'label')
  const words = label !== undefined && element.children.length === 0 ? escaped(label) : childrenHtml(element.children)

  return `<span class="${buttonClasses(element.props, 'plain')}">${hotkeyHtml(element.props)}${words}</span>`
}

const bracketedButtonHtml = (element: DrawnElement): string => {
  const label = wordProp(element.props, 'label') ?? plainTextOf(element.children)

  return `<span class="${buttonClasses(element.props, '')}">[ ${escaped(label)} ]</span>`
}

// The terminal draws a plain Button as its words, a hotkey in the accent colour before them, and any other as
// "[ label ]", a primary one in the accent colour.
const buttonHtml = (element: DrawnElement): string => (element.props.plain === true ? plainButtonHtml(element) : bracketedButtonHtml(element))

const fieldWords = (props: ElementProps): string => {
  const value = wordProp(props, 'value') ?? ''
  if (value !== '') return escaped(value)
  const placeholder = wordProp(props, 'placeholder')

  return placeholder === undefined ? '' : `<span class="dim">${escaped(placeholder)}</span>`
}

// The host's types say only that a label is drawn before the field and a placeholder dim in an empty one, so that is
// all that is drawn: no border or box the app may or may not give it.
const inputHtml = (element: DrawnElement): string => {
  const label = wordProp(element.props, 'label')
  const labelHtml = label === undefined ? '' : `<span class="input-label">${escaped(label)}</span> `

  return `<div class="input">${labelHtml}<span class="field">${fieldWords(element.props)}</span></div>`
}

const inlineMarkdown = (text: string): string =>
  escaped(text)
    .replace(/`([^`]+)`/g, '<span class="code-span">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')

type MarkdownBlock = { kind: 'heading' | 'item' | 'paragraph' | 'code'; text: string }

const blockOfLine = (line: string): MarkdownBlock => {
  const heading = /^#{1,6}\s+(.*)$/.exec(line)
  if (heading) return { kind: 'heading', text: heading[1] ?? '' }
  const item = /^\s*(?:[-*]|\d+\.)\s+/.test(line)
  return { kind: item ? 'item' : 'paragraph', text: line }
}

const lineBlock = (line: string): MarkdownBlock => (line.trim() === '' ? { kind: 'paragraph', text: '' } : blockOfLine(line))

// The newline that ends the line before a fence and the one that ends the fence belong to the fence lines.
const withoutFenceNewlines = (part: string): string => part.replace(/^\n/, '').replace(/\n$/, '')

const proseBlocks = (prose: string): MarkdownBlock[] => (prose === '' ? [] : prose.split('\n').map(lineBlock))

// Split on the fence lines, the parts alternate: prose, code, prose, and so on.
const markdownBlocks = (text: string): MarkdownBlock[] =>
  text
    .split(/^```.*$/m)
    .map(withoutFenceNewlines)
    .flatMap((part, index): MarkdownBlock[] => (index % 2 === 1 ? [{ kind: 'code', text: part }] : proseBlocks(part)))

const blockHtml = (block: MarkdownBlock): string => {
  if (block.kind === 'code') return `<pre class="code">${escaped(block.text)}</pre>`
  if (block.kind === 'heading') return `<div class="md-heading">${inlineMarkdown(block.text)}</div>`
  if (block.text === '') return '<div class="md-gap"></div>'

  return `<div class="md-${block.kind}">${inlineMarkdown(block.text)}</div>`
}

const markdownHtml = (element: DrawnElement): string =>
  `<div class="markdown">${markdownBlocks(String(element.props.text ?? '')).map(blockHtml).join('')}</div>`

const DIFF_LINE_CLASSES: readonly [prefix: string, className: string][] = [
  ['+++', 'diff-file'],
  ['---', 'diff-file'],
  ['@@', 'diff-hunk'],
  ['+', 'diff-added'],
  ['-', 'diff-removed'],
]

const diffClassOf = (line: string): string => DIFF_LINE_CLASSES.find(([prefix]) => line.startsWith(prefix))?.[1] ?? ''

const codeLineHtml = (line: string, index: number, props: ElementProps): string => {
  const number = typeof props.startLine === 'number' ? `<span class="line-number">${props.startLine + index}</span>` : ''
  const lineClass = props.format === 'diff' ? diffClassOf(line) : ''

  return `<div class="code-line ${lineClass}">${number}${escaped(line) || '&nbsp;'}</div>`
}

const codeHtml = (element: DrawnElement): string => {
  const lines = String(element.props.source ?? '').split('\n')

  return `<div class="code">${lines.map((line, index) => codeLineHtml(line, index, element.props)).join('')}</div>`
}

const ELEMENT_DRAWINGS: Record<string, (element: DrawnElement) => string> = {
  Box: boxHtml,
  Text: textHtml,
  Button: buttonHtml,
  Input: inputHtml,
  Markdown: markdownHtml,
  Code: codeHtml,
  [FRAGMENT]: element => childrenHtml(element.children),
}

const childrenHtml = (children: readonly unknown[]): string => children.map(elementHtml).join('')

const drawnElementHtml = (node: unknown): string => {
  if (!isDrawnElement(node)) throw new Error(`the view drew something that is not an element: ${JSON.stringify(node)}`)
  const draw = ELEMENT_DRAWINGS[node.type]
  if (draw === undefined) throw new Error(`no drawing for the host element ${node.type}`)

  return draw(node)
}

// JSX leaves `false`, `null` and `undefined` where a condition drew nothing.
const isNothing = (node: unknown): boolean => node === null || node === undefined || typeof node === 'boolean'

export function elementHtml(node: unknown): string {
  if (isNothing(node)) return ''
  if (isWords(node)) return escaped(String(node))

  return Array.isArray(node) ? childrenHtml(node) : drawnElementHtml(node)
}
