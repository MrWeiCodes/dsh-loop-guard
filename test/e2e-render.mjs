// 端到端：把插件产出的 chunk 序列喂给 dsh 真实的 BlockAssembler，
// 证明 blocks() 非空（客户端拿得到可渲染内容）、且 finish 是合法的 stop。
import { readFileSync } from 'node:fs'
import { BlockAssembler, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures-reasoning-bleed.json', import.meta.url), 'utf8'))
const BLEED = FIXTURE.loops.find((l) => l.minPeriod > 0).text.repeat(3)

const CONFIG = {
  maxThinkingSteps: 3, minReasoningChars: 2048, similarityThreshold: 0.8,
  escalate: 'steer', maxFires: 4, cancelCause: 'thinking-loop',
  maxRepeatedText: 0, maxRepeatedCycleChars: 0, minRepeatedCycleChars: 512,
  maxRepeatedReasoningCycleChars: 512, minRepeatedReasoningCycleChars: 512,
  breakCode: 'REPETITIVE_OUTPUT', breakCorrection: true, resumeAfterBreak: false,
}

const agent = { steer: () => {}, inject: () => {}, cancel: () => {} }
let listener = null
const ctx = {
  on: (n, fn) => { if (n === 'llm/stream') listener = fn },
  logger: { warn: () => {}, debug: () => {} },
  agents: { get: () => agent },
  get: () => undefined,
}
plugin.apply(ctx, CONFIG)

async function* source() {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  for (const t of BLEED.match(/[\s\S]{1,32}/g)) yield { type: 'reasoning-delta', index: 0, text: t }
}

const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
const out = []
for await (const c of listener(options, source)) out.push(c)

console.log('chunks emitted:', out.length)
console.log('last chunk    :', JSON.stringify(out.at(-1)))

// 真实 BlockAssembler → 客户端会拿到的 blocks
const asm = new BlockAssembler()
for (const c of out) asm.push(c)
const blocks = asm.blocks()
console.log('\nassembled blocks:', JSON.stringify(blocks.map((b) => ({ type: b.type, len: (b.text ?? '').length }))))
console.log('finish reason   :', JSON.stringify(asm.finish))
console.log('\n可渲染（blocks 非空）:', blocks.length > 0 && blocks.every((b) => (b.text ?? '').length > 0))
