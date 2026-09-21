#!/usr/bin/env node
/**
 * Streaming false-positive check for ONE period cap, over a whole session store.
 *
 * `sweep-sessions.mjs` measures `trailingCycle` on each *settled* message, which
 * is a proxy. The breaker never sees settled messages: it sees deltas, and it
 * decides on the tail of what has accumulated so far. A text whose final form is
 * period-free can still have had a periodic prefix tail, and vice versa. This
 * replays every real text through the shipped `TextRepetitionDetector` exactly as
 * the stream wrapper drives it, so the false-positive count is measured on the
 * real decision path.
 *
 * One cap per run rather than a sweep: the full store is large enough that a
 * multi-cap sweep does not finish in reasonable time, and the question after a
 * default changes is always "what does the SHIPPED cap do".
 *
 * Usage: node tools/verify-cap.mjs <sessions-dir> <cap> [--min-chars N]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { TextRepetitionDetector } from '../lib/index.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const [, , dir, capArg, ...rest] = process.argv
if (dir === undefined || capArg === undefined) {
  throw new Error('usage: node tools/verify-cap.mjs <sessions-dir> <cap> [--min-chars N]')
}
const cap = Number(capArg)
let minChars = 1500
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--min-chars') minChars = Number(rest[++i])
}

function readSession(path) {
  const buf = readFileSync(path)
  const offsets = []
  for (let i = 0; ;) {
    const at = buf.indexOf(MAGIC, i)
    if (at < 0) break
    offsets.push(at)
    i = at + 1
  }
  const events = []
  for (let n = 0; n < offsets.length; n++) {
    const start = offsets[n]
    const end = n + 1 < offsets.length ? offsets[n + 1] : buf.length
    let payload
    try { payload = zstdDecompressSync(buf.subarray(start, end)).toString('utf8') } catch { continue }
    for (const line of payload.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try { events.push(JSON.parse(trimmed)) } catch { /* not a whole event */ }
    }
  }
  return events
}

function textOf(event) {
  const content = event?.data?.message?.content ?? event?.message?.content ?? []
  if (typeof content === 'string') return content
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
}

function visibleTexts(events) {
  const out = []
  for (const [i, e] of events.entries()) {
    if (e.type === 'assistant/message') {
      const text = textOf(e)
      if (text.length > 0) out.push({ seq: i, text })
    } else if (e.type === 'text-chunks') {
      const chunks = e.data?.chunks ?? e.chunks ?? []
      const text = chunks.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
      if (text.length > 0) out.push({ seq: i, text })
    }
  }
  return out
}

function sessionFiles(root) {
  const out = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...sessionFiles(full))
    else if (entry.endsWith('.zstd')) out.push(full)
  }
  return out
}

const config = { maxRepeatedText: 60, maxRepeatedCycleChars: cap, minRepeatedCycleChars: 256 }
const files = sessionFiles(dir)
console.error(`cap ${cap}: scanning ${files.length} session files, texts >= ${minChars} chars...`)

let examined = 0
const fires = []
for (const file of files) {
  let events
  try { events = readSession(file) } catch { continue }
  const short = file.replace(dir, '')
  for (const { seq, text } of visibleTexts(events)) {
    if (text.length < minChars) continue
    examined++
    const detector = new TextRepetitionDetector(config)
    for (let i = 0; i < text.length; i += 32) {
      if (detector.push(text.slice(i, i + 32))) {
        fires.push({ label: `${short}#${seq}`, len: text.length, at: detector.emittedChars, rule: detector.trippedBy })
        break
      }
    }
  }
}

console.log(`cap ${cap}: examined ${examined} texts, ${fires.length} fires`)
for (const f of fires.sort((a, b) => b.len - a.len)) {
  console.log(`  ${f.label}  len ${f.len}  at ${f.at} (${(f.at / f.len * 100).toFixed(1)}%)  rule=${f.rule}`)
}
