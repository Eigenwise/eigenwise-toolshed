export type SettingsFile = { label: string; text: string; isUserWide: boolean }

export type GatewayWiring = { file: string; isUserWide: boolean }

const LOOPBACK_ADDRESS = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i

const READINESS_GATE_HOOK = /model-gateway\.js.{0,20}readiness-gate/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

function parsedSettings(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)

    return recordOf(parsed)
  } catch {
    return {}
  }
}

// A local address alone is not the gateway: a person may run a proxy of their own. The gateway's own hook or its model discovery switch is.
export function isGatewayWiredIn(settingsText: string): boolean {
  const environment = recordOf(parsedSettings(settingsText).env)
  if (!LOOPBACK_ADDRESS.test(String(environment.ANTHROPIC_BASE_URL ?? ''))) return false

  return 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in environment || READINESS_GATE_HOOK.test(settingsText)
}

export function gatewayWiringIn(files: readonly SettingsFile[]): GatewayWiring | undefined {
  const wired = files.find(file => isGatewayWiredIn(file.text))

  return wired === undefined ? undefined : { file: wired.label, isUserWide: wired.isUserWide }
}
