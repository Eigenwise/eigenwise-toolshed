export type ToolInput = Readonly<Record<string, unknown>>

export const stringField = (input: ToolInput, name: string): string | undefined => {
  const value = input[name]

  return typeof value === 'string' ? value : undefined
}

export const numberField = (input: ToolInput, name: string): number | undefined => {
  const value = input[name]

  return typeof value === 'number' ? value : undefined
}

export const stringListField = (input: ToolInput, name: string): string[] | undefined => {
  const value = input[name]

  return Array.isArray(value) && value.every((item: unknown): item is string => typeof item === 'string')
    ? value
    : undefined
}

export const stringOr = (input: ToolInput, name: string, fallback: string): string =>
  stringField(input, name) ?? fallback

export const numberOr = (input: ToolInput, name: string, fallback: number): number =>
  numberField(input, name) ?? fallback

export const stringListOr = (input: ToolInput, name: string, fallback: string[]): string[] =>
  stringListField(input, name) ?? fallback

export const isJsonObject = (value: unknown): value is ToolInput => typeof value === 'object' && value !== null

export const hasStringFields = (value: ToolInput, names: readonly string[]): boolean =>
  names.every(name => stringField(value, name) !== undefined)
