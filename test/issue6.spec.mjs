/**
 * Regression for issue #6, part 1 — `escalate: 'cancel'` crashed the host.
 *
 * `AgentCancelCause` is a discriminated union of objects:
 * `{ kind: 'user' } | { kind: 'parent' } | { kind: 'hook', reason } |
 * { kind: 'disposed' }`. The plugin passed the bare `cancelCause` string
 * through an `as unknown as` cast, so the host's `abortedCancelCause` switched
 * on an `undefined` `kind` and hit `assertNever` -> `unreachable variant:
 * "thinking-loop"`. The guard took the session down instead of breaking a loop.
 *
 * The path had no test coverage at all, which is why it shipped.
 *
 * Issue #6's second claim — that a delta-only stream lets the break commit a
 * truncated tool call — does **not** hold. `@deepseek-ai/dsh-llm/invariant`
 * requires every delta to address an open block:
 *
 *   text delta at index 0 requires an open text block, got undefined
 *
 * so a delta-only stream is a protocol violation before the guard ever sees it,
 * and both shipped adapters emit `block-start`. Nothing to fix, no assertion
 * added for it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

const CONFIG = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  cancelCause: 'thinking-loop',
  maxRepeatedText: 0,
  maxRepeatedCycleChars: 0,
  minRepeatedCycleChars: 512,
  maxRepeatedReasoningCycleChars: 512,
  minRepeatedReasoningCycleChars: 512,
  maxRepeatedReasoningLineChars: 0,
  minRepeatedReasoningLineCoverage: 0.6,
  minRepeatedReasoningLineConcentration: 4,
  maxRepeatedTextLineChars: 0,
  minRepeatedTextLineCoverage: 0.6,
  minRepeatedTextLineConcentration: 4,
  breakCode: 'REPETITIVE_OUTPUT',
  breakCorrection: true,
  resumeAfterBreak: false,
}

/**
 * Mirror of the host's `abortedCancelCause` (`dsh-agent-loop`), reduced to the
 * part that matters: it switches on `cause.kind` and its `default` arm calls
 * `assertNever`. Reproduced rather than imported because the real one is an
 * internal function of a bundle, and the property under test is exactly "does
 * the host's switch find a known `kind`".
 */
function hostCancelCause(cause) {
  switch (cause?.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    default:
      throw new Error(`unreachable variant: ${JSON.stringify(cause)}`)
  }
}

/** A host that records what the plugin does to a live stream. */
function host(overrides = {}) {
  const config = { ...CONFIG, ...overrides }
  const cancelled = []
  const agent = {
    inject: () => {},
    steer: () => {},
    cancel: (cause) => cancelled.push(cause),
  }
  let stream = null
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
    agents: { get: () => agent },
    on: (event, listener) => { if (event === 'llm/stream') stream = listener },
  }
  plugin.apply(ctx, config)
  assert.equal(typeof stream, 'function')
  return { stream, cancelled }
}

/** A reasoning-only call long enough to count toward `maxThinkingSteps`. */
function reasoningOnlyCall(reasoning) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...(reasoning.match(/[\s\S]{1,64}/g) || []).map((t) => ({ type: 'reasoning-delta', index: 0, text: t })),
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Drive the wrapper once and discard the output. */
async function drive(stream, chunks) {
  const options = markAgentLoopRequest({ sessionId: 's1' })
  for await (const _ of stream(options, async function* source() { for (const c of chunks) yield c })) void _
}

/* -------------------------------------------------------------------------- */
/* issue #6, part 1                                                           */
/* -------------------------------------------------------------------------- */

test('escalate: cancel passes an object cause the host can switch on', async () => {
  // Three reasoning-only calls of >= minReasoningChars each, with no output,
  // trips `maxThinkingSteps` and fires the configured escalation.
  const { stream, cancelled } = host({ escalate: 'cancel' })
  const call = reasoningOnlyCall('x'.repeat(4096))
  for (let i = 0; i < 4; i++) await drive(stream, call)

  assert.equal(cancelled.length, 1, 'the escalation must reach agent.cancel')
  const cause = cancelled[0]
  // The regression was a bare string, and the host's switch is what turns that
  // into a crash. Asserting on the switch rather than on `typeof` keeps the
  // failure message pointing at the real error (`unreachable variant: ...`).
  assert.doesNotThrow(
    () => hostCancelCause(cause),
    `agent.cancel must receive a cause the host can switch on, got ${typeof cause}: ${JSON.stringify(cause)}`,
  )
})

test('the configured cancelCause survives into the host-visible reason', async () => {
  // `hook` is the only variant carrying a free-form reason, so the user's
  // setting must ride there rather than being dropped on the floor. Asserting
  // the reason alone also pins the variant: `user`/`parent`/`disposed` carry no
  // `reason` at all, so any other choice reads back `undefined` and fails here.
  const { stream, cancelled } = host({ escalate: 'cancel', cancelCause: 'my-custom-cause' })
  const call = reasoningOnlyCall('x'.repeat(4096))
  for (let i = 0; i < 4; i++) await drive(stream, call)

  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].reason, 'my-custom-cause')
})
