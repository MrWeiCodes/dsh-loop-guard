#!/usr/bin/env node
/**
 * Sweep every session under a directory and report, for each long visible-output
 * text, the measurements the two candidate TEXT-side rules would use:
 *
 *   - `cycle*`  — `trailingCycle` at several period caps (the shipped rule);
 *   - `repeatMass` / `coverage` — the reasoning-side line rule applied to text.
 *
 * The point is calibration: the text side ships a period cap of 64 while the
 * reasoning side ships 512, and this answers which texts each rule separates.
 *
 * Usage: node tools/sweep-sessions.mjs <sessions-dir> [--min-chars N] [--top N]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { trailingCycle } from '../lib/index.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const [, , dir, ...rest] = process.argv
if (dir === undefined) throw new Error('usage: node tools/sweep-sessions.mjs <sessions-dir>')
let minChars = 4000
let top = 40
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--min-chars') minChars = Number(rest[++i])
  if (rest[i] === '--top') top = Number(rest[++i])
}

/**
 * Read a multi-frame zstd session file into its jsonl event objects.
 *
 * A frame is a write batch, NOT one event: a real 558 KB session holds 313
 * frames but 583 events, so each frame's payload must be split into lines and
 * each line parsed on its own. Parsing a whole frame as one JSON document
 * silently drops every multi-event frame — which is how a first attempt at this
 * scan reported zero long texts on a session that contains a 44 387-character
 * one.
 */
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
    try {
      payload = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch { continue }
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

/**
 * Every visible-output text in one session, across both durable formats:
 *
 *  - `assistant/message` (v3, dsh >= 0.1.5) — one settled message per step;
 *  - `text-chunks` (v1/v2) — the raw text deltas of one step, which have to be
 *    joined to reconstruct what the breaker actually saw.
 *
 * @returns one `{ seq, text }` per step that produced visible text.
 */
function visibleTexts(events) {
  const out = []
  for (const [i, e] of events.entries()) {
    if (e.type === 'assistant/message') {
      const text = textOf(e)
      if (text.length > 0) out.push({ seq: i, text })
      continue
    }
    if (e.type === 'text-chunks') {
      const chunks = e.data?.chunks ?? e.chunks ?? []
      const text = chunks.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
      if (text.length > 0) out.push({ seq: i, text })
    }
  }
  return out
}

/** The reasoning-side line rule, applied to arbitrary text. */
function lineRule(text, minLine = 2) {
  const counts = new Map()
  let total = 0
  let repeat = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length < minLine) continue
    const prev = counts.get(line) ?? 0
    counts.set(line, prev + 1)
    total += line.length
    if (prev === 1) repeat += line.length * 2
    else if (prev > 1) repeat += line.length
  }
  return { total, repeat, coverage: total === 0 ? 0 : repeat / total, distinct: counts.size }
}

/** Every session file under `dir`, recursively. */
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

const rows = []
const files = sessionFiles(dir)
console.error(`scanning ${files.length} session files...`)
for (const file of files) {
  let events
  try { events = readSession(file) } catch (error) { console.error(`skip ${file}: ${String(error)}`); continue }
  const short = file.replace(dir, '').replace(/\\session\.v3\.jsonl\.zstd$/, '')
  for (const { seq, text } of visibleTexts(events)) {
    if (text.length < minChars) continue
    const lr = lineRule(text)
    rows.push({
      session: short,
      seq,
      len: text.length,
      c64: trailingCycle(text, 64, 256),
      c256: trailingCycle(text, 256, 256),
      c512: trailingCycle(text, 512, 512),
      c1024: trailingCycle(text, 1024, 512),
      c4096: trailingCycle(text, 4096, 512),
      repeat: lr.repeat,
      cov: Number(lr.coverage.toFixed(3)),
      distinct: lr.distinct,
    })
  }
}

rows.sort((a, b) => b.len - a.len)
console.log(`texts >= ${minChars} chars: ${rows.length}\n`)
console.log('session\tseq\tlen\tc64\tc256\tc512\tc1024\tc4096\trepeatMass\tcov\tdistinct')
for (const r of rows.slice(0, top)) {
  console.log([r.session, r.seq, r.len, r.c64, r.c256, r.c512, r.c1024, r.c4096, r.repeat, r.cov, r.distinct].join('\t'))
}
