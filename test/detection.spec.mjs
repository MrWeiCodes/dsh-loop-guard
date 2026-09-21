/**
 * Detection regressions for the issue #1 re-test.
 *
 * Issue #1 (jilian-dsh, dsh 0.1.2-rc.1) reported that after the `inject` fix the
 * plugin loaded and fired, but the reasoning loop RECURRED. The v0.1.3 detector
 * had two blind spots that together miss that shape, and these tests pin both:
 *
 *  1. it required CONSECUTIVE reasoning-only calls and reset on any text output;
 *  2. its only content signal was intra-call verbatim n-gram repetition, so a
 *     model that restates the same stalled conclusion in new words scored ~0.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LoopDetector, containment, grams, repeatRatio } from '../lib/index.js'

const CONFIG = {
  maxThinkingSteps: 3,
  minReasoningChars: 64,
  repeatRatio: 0.5,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  cancelCause: 'thinking-loop',
}

function detector(overrides = {}) {
  return new LoopDetector({ ...CONFIG, ...overrides })
}

/**
 * Deterministic long reasoning text derived from a seed.
 *
 * Pseudo-random letters on purpose: real reasoning is high-entropy, so the
 * fixture must be too. A repeated template would make the guard's intra-call
 * `repeatRatio` fire on what is supposed to be a coherent step, which would test
 * the fixture rather than the detector. Two different seeds share essentially no
 * 4-grams, so "distinct steps" and "restated steps" are exactly expressible.
 */
function reasoning(seed, length = 400) {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  let out = ''
  while (out.length < length) {
    hash = (hash * 1103515245 + 12345) >>> 0
    out += String.fromCharCode(97 + (hash % 26))
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* primitives                                                                 */
/* -------------------------------------------------------------------------- */

test('grams returns the distinct fixed-length windows of a text', () => {
  // A sliding window over `abcdabcd` yields four distinct 4-grams, not one.
  assert.deepEqual([...grams('abcdabcd', 4)].sort(), ['abcd', 'bcda', 'cdab', 'dabc'])
  assert.equal(grams('abc', 4).size, 0)
})

test('containment reports how much of the smaller set the larger covers', () => {
  assert.equal(containment(grams('abcdefghij', 4), grams('abcdefghij', 4)), 1)
  assert.equal(containment(grams('abcdefghij', 4), grams('zzzzzzzzzz', 4)), 0)
  assert.equal(containment(new Set(), grams('abcdefghij', 4)), 0)
})

test('containment is asymmetric-free: it measures the smaller set, not the union', () => {
  // The previous step's material is fully restated; the new step only adds text.
  const previous = grams('abcdefghij', 4)
  const current = grams('abcdefghij ONLY-NEW-MATERIAL-HERE-ENTIRELY', 4)
  assert.ok(containment(previous, current) >= 0.99, 'a restated step must read as repetition')
})

test('repeatRatio is near 1 for a degenerate CJK loop and low for coherent text', () => {
  assert.ok(repeatRatio('好。执行。'.repeat(40)) > 0.9)
  assert.ok(repeatRatio(reasoning('a unique subject')) < 0.1)
})

/* -------------------------------------------------------------------------- */
/* blind spot 1: the loop emits text, so nothing accumulates                   */
/* -------------------------------------------------------------------------- */

test('a loop whose steps each emit boilerplate text still trips the guard', () => {
  const d = detector()
  // Same reasoning material every step, plus a short line of text each time —
  // the exact shape that reset the v0.1.3 counter on every step. The first call
  // has no predecessor to compare against, so the first stall is the second call.
  assert.equal(d.observe({ hasOutput: true, reasoning: reasoning('the same subject') }), undefined)
  for (let step = 0; step < 3; step++) {
    assert.equal(d.observe({ hasOutput: true, reasoning: reasoning('the same subject') }), 'repeated-material')
  }
  assert.equal(d.takeFire(), 'repeated-material')
})

test('genuine progress resets the run and never fires', () => {
  const d = detector()
  d.observe({ hasOutput: true, reasoning: reasoning('first angle') })
  d.observe({ hasOutput: true, reasoning: reasoning('second angle') })
  d.observe({ hasOutput: true, reasoning: reasoning('third angle') })
  assert.equal(d.takeFire(), undefined, 'distinct reasoning is not a loop')
})

test('a run is broken by one substantively new step', () => {
  const d = detector()
  d.observe({ hasOutput: true, reasoning: reasoning('stuck subject') })
  d.observe({ hasOutput: true, reasoning: reasoning('stuck subject') })
  d.observe({ hasOutput: true, reasoning: reasoning('a completely different line of enquiry entirely') })
  assert.equal(d.takeFire(), undefined)
})

/* -------------------------------------------------------------------------- */
/* blind spot 2: reasoning-only calls with no verbatim repetition              */
/* -------------------------------------------------------------------------- */

test('reasoning-only calls count even when their wording changes every step', () => {
  const d = detector()
  assert.equal(d.observe({ hasOutput: false, reasoning: reasoning('angle one') }), 'reasoning-only')
  assert.equal(d.observe({ hasOutput: false, reasoning: reasoning('angle two') }), 'reasoning-only')
  assert.equal(d.observe({ hasOutput: false, reasoning: reasoning('angle three') }), 'reasoning-only')
  assert.equal(d.takeFire(), 'reasoning-only')
})

test('an intra-call degenerate repetition is detected on its own', () => {
  const d = detector()
  const stalled = d.observe({ hasOutput: true, reasoning: `Wait. ${'好。执行。'.repeat(40)}` })
  assert.equal(stalled, 'low-entropy')
})

/* -------------------------------------------------------------------------- */
/* short bursts                                                               */
/* -------------------------------------------------------------------------- */

test('a short burst neither counts nor clears an accumulated run', () => {
  const d = detector()
  // base call, then two stalls (the third stall comes after the short burst).
  for (let step = 0; step < 3; step++) d.observe({ hasOutput: true, reasoning: reasoning('stuck subject') })
  // A brief step is below minReasoningChars: it must not be read as progress,
  // so it neither counts nor clears the run already accumulated.
  assert.equal(d.observe({ hasOutput: true, reasoning: 'ok, continuing' }), undefined)
  assert.equal(d.takeFire(), undefined, 'the short burst must not have cleared the run')
  assert.equal(d.observe({ hasOutput: true, reasoning: reasoning('stuck subject') }), 'repeated-material')
  assert.equal(d.takeFire(), 'repeated-material')
})

/* -------------------------------------------------------------------------- */
/* re-firing: one intervention often does not break the loop                   */
/* -------------------------------------------------------------------------- */

test('the guard re-fires after another full run instead of latching', () => {
  const d = detector()
  // The first call establishes the material; the next three are stalls.
  for (let step = 0; step < 4; step++) d.observe({ hasOutput: true, reasoning: reasoning('stuck') })
  assert.equal(d.takeFire(), 'repeated-material')
  assert.equal(d.fired, 1)
  // The steer did not stop it (issue #1's observation): another run fires again.
  for (let step = 0; step < 3; step++) d.observe({ hasOutput: true, reasoning: reasoning('stuck') })
  assert.equal(d.takeFire(), 'repeated-material')
  assert.equal(d.fired, 2)
})

test('re-firing is capped by maxFires', () => {
  const d = detector({ maxFires: 2 })
  for (let fire = 0; fire < 4; fire++) {
    for (let step = 0; step < 3; step++) d.observe({ hasOutput: true, reasoning: reasoning('stuck') })
    d.takeFire()
  }
  assert.equal(d.fired, 2, 'the guard must not intervene forever')
})

test('takeFire is silent below the threshold', () => {
  const d = detector()
  d.observe({ hasOutput: true, reasoning: reasoning('stuck') })
  d.observe({ hasOutput: true, reasoning: reasoning('stuck') })
  assert.equal(d.takeFire(), undefined)
  assert.equal(d.threshold, 3)
})

test('reset clears the accumulated run', () => {
  const d = detector()
  d.observe({ hasOutput: true, reasoning: reasoning('stuck') })
  d.observe({ hasOutput: true, reasoning: reasoning('stuck') })
  d.reset()
  d.observe({ hasOutput: true, reasoning: reasoning('stuck') })
  assert.equal(d.takeFire(), undefined)
})

/* -------------------------------------------------------------------------- */
/* the similarity signal can be disabled                                      */
/* -------------------------------------------------------------------------- */

test('similarityThreshold 0 disables the cross-call signal but not the others', () => {
  const d = detector({ similarityThreshold: 0 })
  for (let step = 0; step < 3; step++) {
    assert.equal(d.observe({ hasOutput: true, reasoning: reasoning('same text each time') }), undefined)
  }
  assert.equal(d.takeFire(), undefined)
  // Reasoning-only calls are still caught.
  for (let step = 0; step < 3; step++) d.observe({ hasOutput: false, reasoning: reasoning('x') })
  assert.equal(d.takeFire(), 'reasoning-only')
})
