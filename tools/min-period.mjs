#!/usr/bin/env node
/**
 * Report the exact minimal period of a text's tail, using the KMP prefix
 * function, plus a picture of the text around the point the loop begins.
 *
 * `trailingCycle` answers "is the tail periodic under cap P"; this answers "what
 * IS the period", which is the number the cap has to sit above. Measuring it
 * directly is what turns "the cap is too low" from a guess into a figure.
 *
 * Usage: node tools/min-period.mjs <session.jsonl> <seq>
 */
import { readFileSync } from 'node:fs'

const [, , file, seqArg] = process.argv
if (file === undefined || seqArg === undefined) {
  throw new Error('usage: node tools/min-period.mjs <session.jsonl> <seq>')
}
const wantSeq = Number(seqArg)

const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

function textOf(event) {
  const content = event?.data?.message?.content ?? event?.message?.content ?? []
  if (typeof content === 'string') return content
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
}

const event = events[wantSeq]
if (event === undefined) throw new Error(`no event at seq ${wantSeq}`)
const text = textOf(event)
console.log(`seq ${wantSeq}: ${text.length} text chars\n`)

/**
 * The minimal period of `s` in the weak sense: the smallest `p` such that
 * `s[i] === s[i + p]` for every valid `i`. Computed from the KMP prefix
 * function, which is O(n) rather than O(n^2) for a 44 000-character text.
 */
function minimalPeriod(s) {
  const n = s.length
  if (n === 0) return 0
  const pi = new Int32Array(n)
  for (let i = 1; i < n; i++) {
    let k = pi[i - 1]
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1]
    if (s[i] === s[k]) k++
    pi[i] = k
  }
  return n - pi[n - 1]
}

/** The minimal period of the last `window` characters. */
function tailPeriod(s, window) {
  const tail = s.slice(Math.max(0, s.length - window))
  return minimalPeriod(tail)
}

console.log('tail window -> minimal period')
for (const w of [512, 1024, 2048, 4096, 8192, 16384, text.length]) {
  console.log(`  ${String(w).padStart(6)}  ->  ${tailPeriod(text, w)}`)
}

/** Where the text stops introducing new material, by first occurrence of lines. */
const lines = text.split('\n')
const seen = new Set()
let firstRepeatLine = -1
for (const [i, raw] of lines.entries()) {
  const line = raw.trim()
  if (line.length < 2) continue
  if (seen.has(line)) { firstRepeatLine = i; break }
  seen.add(line)
}
console.log(`\nfirst repeated line at index ${firstRepeatLine} of ${lines.length}`)
const headChars = lines.slice(0, Math.max(0, firstRepeatLine)).join('\n').length
console.log(`chars before that line: ${headChars} (${(headChars / text.length * 100).toFixed(1)}% of the text)`)

console.log('\n--- head (first 700 chars) ---')
console.log(text.slice(0, 700))
console.log('\n--- around the loop start ---')
const from = Math.max(0, headChars - 200)
console.log(text.slice(from, from + 900))
console.log('\n--- tail (last 400 chars) ---')
console.log(text.slice(-400))
