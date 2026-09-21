#!/usr/bin/env node
/**
 * End-to-end verification against the REAL bleeding text of a session.
 *
 * The unit tests reproduce the 172-character period synthetically. This drives
 * the actual 44 387-character message out of a session file through `apply()`'s
 * `llm/stream` wrapper — the same path the harness uses — and reports what the
 * shipped configuration does to it: where the stream is cut, what the committed
 * text becomes, and what the model is told.
 *
 * Run it against a session and a seq to check a real reproduction, or with
 * `--all` to run every long text in the session and list any fire.
 *
 * Usage: node tools/verify-e2e.mjs <session.jsonl> <seq>
 *        node tools/verify-e2e.mjs <session.jsonl> --all [--min-chars N]
 */
import { readFileSync } from 'node:fs'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../lib/index.js'

const [, , file, target, ...rest] = process.argv
if (file === undefined || target === undefined) {
  throw new Error('usage: node tools/verify-e2e.mjs <session.jsonl> <seq|--all> [--min-chars N]')
}
let minChars = 1500
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--min-chars') minChars = Number(rest[++i])
}

const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

function textOf(event) {
  const content = event?.data?.message?.content ?? event?.message?.content ?? []
  if (typeof content === 'string') return content
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
}

/** A Cordis-shaped context capturing the `llm/stream` listener. */
function fakeContext(agent) {
  const listeners = []
  return {
    on(name, listener) { if (name === 'llm/stream') listeners.push(listener) },
    logger: { warn() {}, debug() {} },
    agents: { get: () => agent },
    fire(options, next) { return listeners[0](options, next) },
  }
}

function fakeAgent() {
  const steered = []
  return { steered, steer: (m) => steered.push(m), inject: () => {}, cancel: () => {} }
}

/**
 * Drive one text through the plugin as a stream of `chunkSize` deltas.
 * @returns the outcome: how much was emitted, and whether the stream was cut.
 */
async function runOne(text, config, chunkSize = 16) {
  const agent = fakeAgent()
  const ctx = fakeContext(agent)
  apply(ctx, config)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })

  async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let i = 0; i < text.length; i += chunkSize) {
      yield { type: 'text-delta', index: 0, text: text.slice(i, i + chunkSize) }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const out = []
  for await (const chunk of ctx.fire(options, () => stream())) out.push(chunk)

  const emitted = out.filter((c) => c.type === 'text-delta').reduce((n, c) => n + c.text.length, 0)
  const blockEnd = out.filter((c) => c.type === 'block-end')
  const committed = blockEnd.length > 0 ? (blockEnd.at(-1).block?.text ?? '') : ''
  return {
    emitted,
    total: text.length,
    cut: out.some((c) => c.type === 'finish' && c.reason?.kind === 'stop') && emitted < text.length,
    committedLen: committed.length,
    committed,
    steered: agent.steered.length,
    steerText: agent.steered[0]?.content?.[0]?.text ?? '',
    steerSummary: agent.steered[0]?.source?.summary ?? '',
    lastChunk: out.at(-1)?.type,
  }
}

const shipped = Config({})
console.log(`shipped config: maxRepeatedCycleChars=${shipped.maxRepeatedCycleChars} minRepeatedCycleChars=${shipped.minRepeatedCycleChars} maxRepeatedText=${shipped.maxRepeatedText}\n`)

if (target === '--all') {
  let examined = 0
  const fires = []
  for (const [i, e] of events.entries()) {
    if (e.type !== 'assistant/message') continue
    const text = textOf(e)
    if (text.length < minChars) continue
    examined++
    const r = await runOne(text, shipped)
    if (r.cut) fires.push({ seq: i, ...r })
  }
  console.log(`examined ${examined} texts, ${fires.length} cut`)
  for (const f of fires.sort((a, b) => b.total - a.total)) {
    console.log(`  seq ${f.seq}  total ${f.total}  emitted ${f.emitted} (${(f.emitted / f.total * 100).toFixed(1)}%)  committed ${f.committedLen}  steered ${f.steered}`)
  }
} else {
  const seq = Number(target)
  const text = textOf(events[seq])
  if (text.length === 0) throw new Error(`seq ${seq} has no text`)
  const r = await runOne(text, shipped)
  console.log(`seq ${seq}: ${r.total} text chars`)
  console.log(`  emitted before the cut : ${r.emitted} (${(r.emitted / r.total * 100).toFixed(1)}% of the text)`)
  console.log(`  stream cut             : ${r.cut}`)
  console.log(`  last chunk             : ${r.lastChunk}`)
  console.log(`  committed text length  : ${r.committedLen}`)
  console.log(`  correction steered     : ${r.steered}`)
  if (r.steered > 0) {
    console.log(`  steer summary          : ${r.steerSummary}`)
    console.log(`  steer text             : ${r.steerText}`)
  }
  console.log('\n--- committed text (last 300 chars) ---')
  console.log(r.committed.slice(-300))
  console.log('\n--- what was DROPPED (first 300 chars of the discarded tail) ---')
  console.log(text.slice(r.committedLen, r.committedLen + 300))
}
