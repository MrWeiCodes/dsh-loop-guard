#!/usr/bin/env node
/**
 * Offline replay of the thinking-loop guard over a real dsh session file.
 *
 * Issue #1 (jilian-dsh) needs two answers that only their machine has:
 * "did the recurring calls emit text?" and "how similar were the reasoning
 * texts?". Both are answerable from a session jsonl without re-running the
 * model — and the answer is trustworthy only if it is produced by the SAME
 * decision rule the plugin runs, so this script reuses `LoopDetector` from the
 * plugin rather than re-implementing the heuristic (a re-implementation would
 * be a second source of truth, and the whole point is to report what the
 * installed guard would have decided).
 *
 * Usage:
 *   node tools/analyze-session.mjs <session.jsonl> [--similarity 0.8] [--threshold 3]
 *                                [--min-chars 2048] [--max-fires 4] [--json]
 *
 * Reads every durable form a settled model call takes:
 *   - `assistant/chunk` (session format v1: dsh <= 0.1.2-rc.1) — one event per
 *     stream chunk, grouped by (turn, step);
 *   - `assistant/attempt` (session format v2: dsh >= 0.1.5) — an attempt that
 *     settled with NO surface message: a failed, retried, cancelled or
 *     stream-error call;
 *   - `assistant/message` (session format v2: dsh >= 0.1.5) — the ORDINARY
 *     settled call, carrying the committed message plus the same compacted
 *     `stream` record array.
 *
 * ## Why `assistant/message` is not optional
 *
 * An earlier version read only `assistant/chunk` and `assistant/attempt`. That
 * looks like "both formats" but is actually "the v1 format, plus v2's EXCEPTION
 * path": a normal call commits an `assistant/message`, so the tool saw only the
 * minority of calls that had failed and been retried. Measured on a real
 * 8733-message session, the reader found 104 calls instead of 8837 — it reported
 * `steps: 0` on most sessions and silently under-reported on the rest, which for
 * a tool whose whole job is "would the guard have fired?" is worse than failing.
 *
 * A "step" is one model call. For the v1 format that is one (turn, step) group;
 * for v2 it is one event, because `agent-loop` re-enters its attempt loop on a
 * retry and settles each try separately — so a retried step legitimately yields
 * two or more rows, which is what the plugin saw at runtime (it wraps every
 * `llm/stream` call, retries included). For each call it reports whether
 * text/tool output was emitted and what the reasoning was, then feeds the same
 * `StepObservation` the plugin feeds at runtime.
 *
 * It also reports the **intra-call** shape (issue #2848): the trailing run of
 * identical visible-output chunks inside one call, which is the only measure
 * that describes a call repeating itself for minutes without ever ending. That
 * shape is invisible to every per-call verdict on purpose — the call never
 * completes — so it gets its own column. Two columns after it answer "would the
 * shipped breaker have cut this call?" for both rules the plugin ships:
 * `repeatedRun` (identical deltas, `--max-repeated-text`) and `cycleSpan` (the
 * exact verbatim period at the tail, `--max-repeated-cycle`).
 *
 * The cycle rule exists because of discussion #7043: a call bleeding `好。 / 发。 /
 * 好。 / 好。` for tens of lines has a run of identical deltas of 2, so the chunk
 * rule never fires — and the reporter's session file is exactly what this tool
 * is pointed at to answer whether the shipped plugin would have cut it.
 */
import { readFileSync } from 'node:fs'
import { LoopDetector, ReasoningLoopBreaker, TextRepetitionDetector, countRepeatedText, trailingCycle } from '../lib/index.js'

const DEFAULT_CONFIG = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  maxFires: 4,
  maxRepeatedText: 60,
  maxRepeatedCycleChars: 512,
  minRepeatedCycleChars: 256,
  maxRepeatedReasoningCycleChars: 512,
  minRepeatedReasoningCycleChars: 512,
  maxRepeatedReasoningLineChars: 2048,
  minRepeatedReasoningLineCoverage: 0.6,
  minRepeatedReasoningLineConcentration: 4,
  maxRepeatedTextLineChars: 2048,
  minRepeatedTextLineCoverage: 0.6,
  minRepeatedTextLineConcentration: 4,
}

function parseArgs(argv) {
  const config = { ...DEFAULT_CONFIG }
  let file
  let asJson = false
  const flags = { '--similarity': 'similarityThreshold', '--threshold': 'maxThinkingSteps', '--min-chars': 'minReasoningChars', '--max-fires': 'maxFires', '--max-repeated-text': 'maxRepeatedText', '--max-repeated-cycle': 'maxRepeatedCycleChars', '--min-repeated-cycle': 'minRepeatedCycleChars' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') { asJson = true; continue }
    if (flags[arg] !== undefined) {
      const value = Number(argv[++i])
      if (!Number.isFinite(value)) throw new Error(`${arg} expects a number`)
      config[flags[arg]] = value
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`)
    file = arg
  }
  if (file === undefined) throw new Error('usage: node tools/analyze-session.mjs <session.jsonl> [--json]')
  return { file, config, asJson }
}

/** True when a chunk is model-authored output (as opposed to reasoning). */
function isOutputChunk(type) {
  return type === 'text-delta' || type === 'tool-call-delta'
}

/** Pull the reasoning/text/tool deltas out of one raw chunk. */
function readChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return undefined
  const type = chunk.type
  if (typeof type !== 'string') return undefined
  if (type === 'reasoning-delta') return { type, text: String(chunk.text ?? '') }
  if (type === 'text-delta') return { type, text: String(chunk.text ?? '') }
  if (type === 'tool-call-delta') return { type, text: String(chunk.argumentsDelta ?? '') }
  return { type, text: '' }
}

/**
 * Flatten one v1 `assistant/chunk` event into chunk-like deltas.
 *
 * The durable event carries `data.chunk` with the plugin-facing `StreamChunk`
 * shape, so the mapping is direct.
 */
function deltasFromChunkEvent(event) {
  const chunk = event?.data?.chunk
  const delta = readChunk(chunk)
  return delta === undefined ? [] : [delta]
}

/**
 * Flatten one v2 event's compacted stream into deltas.
 *
 * Serves BOTH `assistant/attempt` and `assistant/message`: the two events carry
 * the same `data.stream` field with the same record shape, differing only in
 * whether a committed `message` accompanies it. Verified against real session
 * files — extracting from `assistant/message` yields the reasoning and text of
 * every ordinary call, which is the majority the tool used to miss.
 *
 * The durable stream is a compacted record array, not raw chunks:
 *   - `{ type: 'chunk', time, chunk }` — one chunk, unchanged;
 *   - `{ type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks', texts:
 *      Array<[time, string]> }` — a run-length-compacted delta group.
 * Unknown record types are ignored rather than guessed at, so a future format
 * addition degrades to "fewer steps observed" instead of a wrong verdict.
 */
function deltasFromStreamEvent(event) {
  const stream = event?.data?.stream
  if (!Array.isArray(stream)) return []
  const out = []
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      const delta = readChunk(record.chunk)
      if (delta !== undefined) out.push(delta)
      continue
    }
    const texts = record.texts
    if (!Array.isArray(texts)) continue
    const type = record.type === 'text-chunks'
      ? 'text-delta'
      : record.type === 'reasoning-chunks'
        ? 'reasoning-delta'
        : record.type === 'tool-call-chunks'
          ? 'tool-call-delta'
          : undefined
    if (type === undefined) continue
    for (const entry of texts) {
      const text = Array.isArray(entry) ? entry[1] : entry
      out.push({ type, text: String(text ?? '') })
    }
  }
  return out
}

/**
 * Group the file's events into per-model-call steps, in file order.
 *
 * The two durable generations need opposite treatment, because the same
 * coordinate means different things in each:
 *
 *  - **v1 `assistant/chunk`** writes one event per stream chunk, so a call is
 *    the *set* of events sharing a (turn, step) coordinate — they are grouped.
 *  - **v2** writes one event per settled attempt, so an event *is* a call and
 *    must NOT be merged by coordinate. `agent-loop` re-enters its attempt loop
 *    on a retry (`while (true)` around the stream) and settles each try
 *    separately: a retried step produces an `assistant/attempt` for the failed
 *    try followed by an `assistant/message` for the successful one, at the SAME
 *    (turn, step). The plugin wrapped every one of those `llm/stream` calls and
 *    judged each on its own, so merging them would concatenate the reasoning of
 *    two distinct calls and hand the detector an input it never saw.
 *
 * A call that settled with no content at all (a retry that failed before
 * emitting anything) is kept rather than dropped: the plugin observed it too,
 * and `LoopDetector.observe` ignores it on the `minReasoningChars` guard, so
 * dropping it here would be a second, divergent copy of that rule.
 */
function readSteps(lines) {
  const steps = []
  /** v1 chunk events sharing a coordinate, merged into one call. */
  const byCoordinate = new Map()
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const type = event?.type
    if (type !== 'assistant/chunk' && type !== 'assistant/attempt' && type !== 'assistant/message') continue
    const turn = event?.data?.turn
    const step = event?.data?.step
    if (type !== 'assistant/chunk') {
      const group = newGroup(turn, step, type)
      steps.push(accumulate(group, deltasFromStreamEvent(event)))
      continue
    }
    // v1: fold this chunk into the call its coordinate identifies.
    const key = `${turn}/${step}`
    let group = byCoordinate.get(key)
    if (group === undefined) {
      group = newGroup(turn, step, type)
      byCoordinate.set(key, group)
      steps.push(group)
    }
    accumulate(group, deltasFromChunkEvent(event))
  }
  return steps
}

/** One call's empty accumulator. */
function newGroup(turn, step, source) {
  return {
    turn,
    step,
    source,
    reasoning: '',
    // Reasoning deltas in stream order: the reasoning breaker is fed chunk by
    // chunk, so the joined string alone would lose the boundaries the rule sees.
    reasoningDeltas: [],
    text: '',
    texts: [],
    hasOutput: false,
  }
}

/** Fold one call's deltas into its running totals, returning the same object. */
function accumulate(group, deltas) {
  for (const delta of deltas) {
    if (delta.type === 'reasoning-delta') {
      group.reasoning += delta.text
      group.reasoningDeltas.push(delta.text)
    } else if (isOutputChunk(delta.type)) {
      group.hasOutput = true
      group.text += delta.text
      // Only text deltas participate in the intra-call breaker; tool-argument
      // deltas are chunked by the provider's own tokenizer.
      if (delta.type === 'text-delta') group.texts.push(delta.text)
    }
  }
  return group
}

const { file, config, asJson } = parseArgs(process.argv.slice(2))
const lines = readFileSync(file, 'utf8').split('\n')
const steps = readSteps(lines)

const detector = new LoopDetector({ pollMs: 0, graceMs: 0, escalate: 'steer', ...config })
const report = []
for (const [index, step] of steps.entries()) {
  const reason = detector.observe({ hasOutput: step.hasOutput, reasoning: step.reasoning })
  const fire = detector.takeFire()
  const repeatRun = countRepeatedText(step.texts)
  // Every rule runs on the SAME input the plugin's breaker sees: text deltas
  // only, in stream order. This tool exists to answer "would the shipped breaker
  // have cut this call?", so a rule the plugin has but the tool does not would
  // make the tool quietly wrong. That is why the decision comes from the real
  // `TextRepetitionDetector` rather than from a re-implementation: a hand-rolled
  // copy silently missed the phrase-pool rule the moment it was added.
  const breaker = new TextRepetitionDetector(config)
  let brokeAt = 0
  for (const chunk of step.texts) {
    if (breaker.push(chunk)) { brokeAt = breaker.emittedChars; break }
  }
  const textBreakBy = brokeAt > 0 ? (breaker.trippedBy ?? null) : null
  // The REASONING breaker is a separate rule with its own accumulator, and it is
  // the one that matters most: a reasoning-only call is the shape that never
  // settles the step, so nothing downstream can react to it. An earlier version
  // of this tool ran only the text breaker, so it reported `wouldBreak: false`
  // for a 183,760-character reasoning bleed that the shipped plugin cuts at
  // ~25,000 — the tool was blind to exactly the failure it exists to diagnose.
  const reasoningBreaker = new ReasoningLoopBreaker(config)
  let reasoningBrokeAt = 0
  for (const delta of step.reasoningDeltas) {
    if (reasoningBreaker.push(delta)) { reasoningBrokeAt = reasoningBreaker.emittedChars; break }
  }
  const reasoningBreakBy = reasoningBrokeAt > 0 ? (reasoningBreaker.trippedBy ?? null) : null
  const cycleSpan = trailingCycle(step.texts.join(''), config.maxRepeatedCycleChars, config.minRepeatedCycleChars)
  report.push({
    step: index + 1,
    turn: step.turn,
    call: step.step,
    reasoningChars: step.reasoning.length,
    textChars: step.text.length,
    textChunks: step.texts.length,
    hasOutput: step.hasOutput,
    verdict: reason ?? 'progress',
    fired: fire ?? null,
    // The intra-call shape (issue #2848). `repeatedRun` is the trailing run of
    // identical visible-output chunks; `wouldBreak` answers whether the shipped
    // breaker would have ended this call mid-stream.
    repeatedRun: repeatRun,
    cycleSpan,
    brokeAt,
    // The figure the notice would print — taken from the breaker itself so the
    // tool cannot misreport it.
    repeatedChars: breaker.repeatedChars,
    // Which side broke, and where. A call can carry both a reasoning bleed and
    // visible output, so the two are reported separately rather than collapsed
    // into one boolean: `wouldBreakBy` names the rule, `brokeIn` names the side.
    wouldBreak: textBreakBy !== null || reasoningBreakBy !== null,
    wouldBreakBy: textBreakBy ?? reasoningBreakBy,
    brokeIn: textBreakBy !== null ? 'text' : reasoningBreakBy !== null ? 'reasoning' : null,
    reasoningBrokeAt,
    reasoningRepeatedChars: reasoningBreaker.repeatedChars,
  })
}
const broken = report.filter(r => r.wouldBreak).length

if (asJson) {
  process.stdout.write(`${JSON.stringify({ file, config, steps: report }, null, 2)}\n`)
} else {
  console.log(`session: ${file}`)
  console.log(`config:  ${JSON.stringify(config)}`)
  console.log(`steps:   ${steps.length} model call(s)`)
  console.log('')
  console.log('  #   turn/step   reasonChars  textChars  chunks  verdict             fired  repeatedRun  cycleSpan  repeatedChars  break')
  for (const row of report) {
    console.log(
      `  ${String(row.step).padStart(2)}  ${String(row.turn)}/${String(row.call)}`.padEnd(20)
      + `${String(row.reasoningChars).padStart(9)}  ${String(row.textChars).padStart(9)}  `
      + `${String(row.textChunks).padStart(6)}  ${row.verdict.padEnd(18)}  ${String(row.fired ?? '').padEnd(5)}  `
      + `${String(row.repeatedRun).padStart(11)}  ${String(row.cycleSpan).padStart(9)}  `
      + `${String(row.brokeIn === 'reasoning' ? row.reasoningRepeatedChars : row.repeatedChars).padStart(13)}  `
      + `${row.wouldBreak ? `BREAK(${row.wouldBreakBy} in ${row.brokeIn})` : ''}`,
    )
  }
  const stalls = report.filter(r => r.verdict !== 'progress').length
  const fires = report.filter(r => r.fired !== null).length
  const withText = report.filter(r => r.hasOutput).length
  console.log('')
  console.log(`stalled steps: ${stalls}/${report.length}  |  reactions: ${fires}  |  steps that emitted text: ${withText}`)
  const byChunks = report.filter(r => r.wouldBreakBy === 'identical-chunks').length
  const byCycle = report.filter(r => r.wouldBreakBy === 'repeating-cycle').length
  const byTextLines = report.filter(r => r.wouldBreakBy === 'text-lines').length
  const byReasoning = report.filter(r => r.brokeIn === 'reasoning').length
  console.log(`intra-call repetition: ${broken} call(s) would be cut mid-stream `
    + `(${byChunks} by identical chunks, maxRepeatedText = ${config.maxRepeatedText}; `
    + `${byCycle} by a repeating cycle, maxRepeatedCycleChars = ${config.maxRepeatedCycleChars}, `
    + `minRepeatedCycleChars = ${config.minRepeatedCycleChars}; `
    + `${byTextLines} by a repeated phrase pool, maxRepeatedTextLineChars = ${config.maxRepeatedTextLineChars})`)
  console.log(`reasoning-side breaks: ${byReasoning} call(s) `
    + `(maxRepeatedReasoningCycleChars = ${config.maxRepeatedReasoningCycleChars}, `
    + `maxRepeatedReasoningLineChars = ${config.maxRepeatedReasoningLineChars})`)
  if (byCycle === 0 && byChunks === 0 && report.some(r => r.repeatedRun > 1)) {
    const worst = Math.max(...report.map(r => r.repeatedRun))
    console.log(`  (the longest identical-chunk run seen was ${worst}; lower --max-repeated-text to cut such calls)`)
  }
  if (report.length === 0) {
    console.log('(no assistant steps found — is this a v1 `assistant/chunk` or v2 `assistant/attempt` session?)')
  }
}
