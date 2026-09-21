#!/usr/bin/env node
/**
 * Decompress a dsh `session.v3.jsonl.zstd` file to plain jsonl.
 *
 * The file is NOT one zstd stream: it is a concatenation of independent zstd
 * frames, one per session event (313 frames in a real 558 KB session). A single
 * `zstdDecompressSync` call returns only the first frame — 187 bytes, the
 * `session` header — and looks like success, which is why this needs its own
 * tool instead of a one-liner. Node's stream decompressor also rejects the
 * second frame ("Unknown frame descriptor"), so the frames are split on the
 * zstd magic number and inflated one by one.
 *
 * Usage: node tools/decompress-session.mjs <session.v3.jsonl.zstd> <out.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const [, , input, output] = process.argv
if (input === undefined || output === undefined) {
  throw new Error('usage: node tools/decompress-session.mjs <session.v3.jsonl.zstd> <out.jsonl>')
}

const buf = readFileSync(input)
const offsets = []
for (let i = 0; ;) {
  const at = buf.indexOf(MAGIC, i)
  if (at < 0) break
  offsets.push(at)
  i = at + 1
}
if (offsets.length === 0) throw new Error(`${input}: no zstd frame found`)

const lines = []
let failed = 0
for (let n = 0; n < offsets.length; n++) {
  const start = offsets[n]
  const end = n + 1 < offsets.length ? offsets[n + 1] : buf.length
  try {
    lines.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8').replace(/\n$/, ''))
  } catch (error) {
    failed++
    if (failed <= 3) console.error(`frame ${n} at ${start}: ${String(error)}`)
  }
}

writeFileSync(output, lines.join('\n') + '\n')
console.log(`decompressed ${lines.length} frames (${failed} failed) -> ${output}`)
