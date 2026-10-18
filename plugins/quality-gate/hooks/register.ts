import type { Register } from 'claude-code'
import { registerMeasurement } from './measure.ts'

export const register: Register = on => registerMeasurement(on)
