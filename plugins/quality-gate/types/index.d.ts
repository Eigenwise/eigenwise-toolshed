export type MeasuredBody = {
  file: string
  name: string
  cc: number
  state: 'new' | 'modified-raised' | 'legacy-unchanged'
  verdict: string
}

export type ReuseSignal = {
  kind: 'duplicate' | 'open-callers'
  file: string
  name: string
  detail: string
}

export type TestRun = { status: 'pass' | 'fail' | 'none'; at: string; stale: boolean }
export type TurnReport = { bodies: MeasuredBody[]; signals: ReuseSignal[]; unverified: boolean }
export type TurnMeasurement = TurnReport & { at: string; tests: TestRun }

declare module 'claude-code' {
  interface PluginState {
    'quality-gate': {
      turn: Record<string, TurnMeasurement>
      coverageNoticeShown: boolean
      bandCoverageNoticeAt: string
    }
  }
}

export interface QualityGateStore {
  enabled: boolean
  markers: boolean
}
