import { expect, test } from 'claude-code/testing'

import { gatewayWiringIn } from './older-gateway'

const file = (env: Record<string, string>, extra: Record<string, unknown> = {}, isUserWide = false) => ({
  label: 'settings',
  text: JSON.stringify({ env, ...extra }),
  isUserWide,
})

const GATEWAY_HOOK = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/p/model-gateway.js" readiness-gate' }] }] } }

test('a local proxy that also sets a common key is not the gateway', () => {
  const proxy = file({ ANTHROPIC_BASE_URL: 'http://localhost:4000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' })

  expect(gatewayWiringIn([proxy])).toBeUndefined()
})

test('a local address alone, or a remote one with the gateway keys, is not the gateway', () => {
  expect(gatewayWiringIn([file({ ANTHROPIC_BASE_URL: 'http://localhost:9000' })])).toBeUndefined()
  expect(gatewayWiringIn([file({ ANTHROPIC_BASE_URL: 'https://api.example.com', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' })])).toBeUndefined()
})

test('a local address with the model discovery switch is the gateway', () => {
  const wired = file({ ANTHROPIC_BASE_URL: 'http://localhost:9000', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' })

  expect(gatewayWiringIn([wired])).toEqual({ file: 'settings', isUserWide: false })
})

test('a local address with the readiness gate hook is the gateway, and a user settings file is marked as user wide', () => {
  const wired = file({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764' }, GATEWAY_HOOK, true)

  expect(gatewayWiringIn([wired])).toEqual({ file: 'settings', isUserWide: true })
})
