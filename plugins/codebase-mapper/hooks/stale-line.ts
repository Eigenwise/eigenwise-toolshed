type MapStatus = { stale: number; line: string }

function isMapStatus(value: unknown): value is MapStatus {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>

  return typeof candidate.stale === 'number' && typeof candidate.line === 'string'
}

export function staleLine(statusOutput: string): string | undefined {
  try {
    const status: unknown = JSON.parse(statusOutput)

    return isMapStatus(status) && status.stale > 0 ? status.line : undefined
  } catch {
    return undefined
  }
}
