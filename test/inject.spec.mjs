import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

// Regression for the v0.1.1 activation crash.
// v0.1.1 read `ctx.agents` with no `inject` declaration, so Cordis's context
// proxy threw `cannot get property "agents" without inject` on the first
// `llm/stream` event and every session in that deployment failed to run.
// TypeScript cannot catch this; the guard is runtime-only.
test('declares the agents service injection', () => {
  assert.ok(Array.isArray(plugin.inject), 'plugin must export an inject array')
  assert.ok(
    plugin.inject.includes('agents'),
    'plugin reads ctx.agents and therefore must declare inject = ["agents"]',
  )
})

test('exposes the documented plugin surface', () => {
  assert.equal(plugin.name, 'loop-guard')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
})
