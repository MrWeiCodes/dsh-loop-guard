/**
 * Thinking-loop guard for the dsh harness.
 *
 * Closes a guard-layer gap the in-tree `guard/` family does not cover.
 * `guard/timeout-policy` is a per-tool `tools/execute` deadline and
 * `guard/repeat-tool-reminder` is a same-tool-call chain detector — only a tool
 * *call* arms either. When a model degrades into a pure-thinking loop
 * (`deepseek-v4.1-flash-expires-on-0910` under `max`/`high` reasoning effort and
 * a long context), it emits only `reasoning-delta` chunks — zero `text-delta`,
 * zero `tool-call-delta` — so neither fires, `turn()` never sets `turnEnds`, and
 * the agent-loop `while (true)` never breaks until the user manually aborts.
 *
 * This plugin observes the public `llm/stream` waterfall (present on dsh
 * **0.1.2-rc.1 and 0.1.5-alpha.1**), tallies the `StreamChunk` composition of
 * each loop-built model call, and escalates through a configured reaction.
 *
 * Why `llm/stream` and not `agent/assistant-stream`: the latter (scoped emit
 * with `start`/`chunk`/`end` frames) only exists from dsh 0.1.5-alpha.1; the
 * widely-installed 0.1.2-rc.1 has neither it nor `AssistantStreamFrame`, so a
 * plugin pinned to that seam silently no-ops on the common release. `llm/stream`
 * is a Cordis waterfall around every streaming model call in both versions and
 * carries the same `StreamChunk` delta types, and its `GenerateOptions` carries
 * `sessionId`, from which the live Agent is reachable via `ctx.agents.get(...)`.
 *
 * ## Detection (two per-call shapes, plus two in-call breakers)
 *
 * Issue #1's re-test on dsh 0.1.2-rc.1 showed the v0.1.2 detector did not fire on
 * the reproduction: the loop recurred with the plugin loaded and working. The
 * v0.1.2 detector had two blind spots that together miss the reported shape:
 *
 *  1. It required **consecutive** reasoning-only calls and reset the counter on
 *     *any* text output. A loop whose steps each emit some (boilerplate) text
 *     after their reasoning never accumulates, because every step looks like
 *     progress.
 *  2. Its only content signal was `repeatRatio` — verbatim n-gram repetition
 *     *within one call*. A model that re-derives the same stalled conclusion with
 *     different wording every step scores near zero on that measure, so it also
 *     slipped through.
 *
 * The fix for (2) is a **cross-call** measure: the **containment** of the
 * previous call's distinct n-grams in this call's. A step is "stalled" when it
 * either produced no output at all (shape 1) *or* it repeats most of the previous
 * step's distinct reasoning material (shape 2 — the same conclusion reworded,
 * which is what a stuck model actually does). Anything else is genuine progress
 * and resets the run.
 *
 * The intra-call ratio itself turned out not to be salvageable as a signal and is
 * no longer wired in; {@link LoopDetector.observe} carries the measurement.
 *
 * ## Mid-stream repetition (issue #2848, v0.1.6)
 *
 * The three shapes above are judged **after** a model call ends, which is
 * structurally too late for the failure in issue #2848: a ~10-minute, 420,000
 * character bleed where the model repeated one sentence across ~2825 text chunks
 * — all inside a **single** call. No per-call detector can help, because there is
 * no call boundary to react at; the harness must intervene mid-stream.
 *
 * `maxRepeatedText` therefore adds an intra-call breaker: count consecutive
 * identical normalized `text-delta` payloads and, on the Nth, **end the stream
 * from inside the `llm/stream` wrapper** by yielding a terminal `finish` chunk
 * and returning. Two facts make that expressible and safe, both verified on
 * 0.1.5-alpha.1 and re-checked against the 0.1.2-rc.1 typings:
 *
 *  - The agent loop consumes the waterfall's iterable (`for await (const chunk
 *    of stream) live.push(chunk)`), so a listener's own chunk reaches the same
 *    assembler as an adapter's.
 *  - `packages/llm/llm/src/invariant.ts` requires a terminal finish chunk and
 *    explicitly permits an `error`/`aborted` finish with blocks still open — so
 *    a mid-call cut is a sanctioned protocol outcome, not a violation. A stream
 *    that simply ends is an invariant failure, which is why the breaker emits a
 *    finish rather than merely returning.
 *
 * The break is always an `error` finish carrying `REPETITIVE_OUTPUT`: it fails
 * the step through the loop's normal error path (and the `agent/request-error`
 * waterfall, where a retry policy may act on the code). A quiet `stop` is not
 * offered, because the breaker fires with the call's text block still open and
 * the invariant admits only `error`/`aborted` finishes in that state — measured,
 * not assumed. `breakCorrection` steers the agent so the resumed turn is told
 * what happened. Deliberately **no model fallback and no automatic retry**: a
 * degenerate model must not be silently re-billed.
 *
 * ## Cycled repetition (discussion #7043, v0.1.8)
 *
 * `maxRepeatedText` compares *deltas*, so it only covers the period-1 case: the
 * same payload emitted over and over. The #7043 report is a **cycle** — a few
 * short lines rotating ("好。 / 发。 / 好。 / 好。", and a mixed-language variant
 * with "Emitting." in front) for tens of lines, and the same signature in a long
 * session where the model bleeds instead of calling the tool it obviously means
 * to call. Measured against the shipped v0.1.7 detector, that shape **never
 * fires under any of four chunkings** (one delta per line, per cycle, per four
 * characters, per character) within 40 repeats: the longest run of identical
 * consecutive deltas is 3, against a threshold of 60.
 *
 * `maxRepeatedCycleChars` / `minRepeatedCycleChars` add the missing rule at the
 * character level: when the tail of the call's visible output is an exact
 * repetition of one period no longer than `maxRepeatedCycleChars` and spanning
 * at least `minRepeatedCycleChars`, the stream is cut by the same terminal
 * `error` finish. Character-level because the shape does not depend on line
 * breaks — a provider that streams the same bleed with no newline at all is
 * caught identically — and because the reported period is short (12 and 26
 * characters for the two reported shapes).
 *
 * Why exactness and not a low-entropy ratio, when `repeatRatio` was already in
 * the file: measured on the same texts, a *coverage* measure reads 0.92-0.99 for
 * the two reported shapes at a 512-character tail but 0.72 for a 40-row
 * markdown table, 0.76 for a log listing, 0.82 for generated CSS rows and 0.84
 * for a JSON dump. Separating "degenerate" from "legitimately repetitive" by
 * 0.06 is not a margin worth truncating a user's call over; verbatim
 * periodicity is 0 for every one of those samples.
 *
 * ## Reaction
 *
 * On a threshold crossing it applies `escalate`. Unlike v0.1.2 it does **not**
 * latch after one reaction: a single steer often does not break a strong loop
 * (which is exactly what issue #1's re-test observed), so the run counter resets
 * and re-fires after another `maxThinkingSteps`, up to `maxFires` times.
 *
 * Mechanism notes (verified against packages/core/agent-loop/src/agent.ts,
 * packages/llm/llm/src/index.ts, and packages/core/agent/src/runtime-types.ts on
 * dsh 0.1.5-alpha.1; the `llm/stream` / `StreamChunk` / `ctx.agents.get` trio is
 * present unchanged on 0.1.2-rc.1):
 *  - `llm/stream` is a waterfall; a listener wraps `next()` and sees each chunk.
 *  - `chunk: StreamChunk` distinguishes `reasoning-delta` / `text-delta` /
 *    `tool-call-delta` (packages/llm/llm/src/types.ts).
 *  - Loop-built requests carry `markAgentLoopRequest`; `isAgentLoopRequest`
 *    filters out arbitrary non-agent streaming (tool streams, etc.).
 *  - `options.sessionId` → `ctx.agents.get(sessionId)` yields the live `Agent`.
 *  - `agent.steer(message)`, `agent.inject(message)`, and `agent.cancel(cause)`
 *    are public methods; a listener can react but not veto an in-flight step.
 *
 * ## Reasoning bleed (issue #5976, v0.1.9)
 *
 * The three per-call shapes above all assume the call eventually **ends**. #5976
 * is the case where it does not: the model degrades into a pure reasoning bleed
 * — no `text-delta`, no `tool-call-delta` — and keeps generating indefinitely.
 * The harness derives `StepEndReason` from the finished message
 * (`packages/core/agent-loop`, `step()` returns `completed` only once a message
 * exists), so a stream that never finishes never settles the step, `turnEnds`
 * stays null, and the `while (true)` turn loop never breaks. The reporter's
 * experience — "只能手动中止" — is that loop.
 *
 * Every detector above is therefore blind to it by construction:
 *
 *  - {@link LoopDetector} judges a call after it ends, and this one does not end;
 *  - {@link TextRepetitionDetector} watches visible output, and this failure
 *    emits none — deliberately, since reasoning is where the bleed lives and
 *    reasoning legitimately revisits itself far more often.
 *
 * {@link ReasoningLoopBreaker} closes it with the only mechanism that can: it
 * watches `reasoning-delta`, and on a verbatim cycle it ends the stream from
 * inside the `llm/stream` wrapper with a terminal `error` finish. That failure
 * is what makes the turn end at all — `agent-loop`'s `step()` turns a non-retried
 * `error` finish into a thrown `LlmError`, `turn()` catches it into
 * `turnEnds = { kind: 'error' }`, and the `finally` appends `turn/end`.
 *
 * The rule is exact periodicity, not a ratio, and the thresholds are measured
 * rather than guessed — see {@link ReasoningLoopBreaker} for the calibration
 * against a real reproduction.
 *
 * @module dsh-loop-guard
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentCancelCause } from '@deepseek-ai/dsh-agent'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { BreakRule, ResolvedConfig, StallReason } from './detector.js'
import type { Config as ConfigShape } from './detector.js'
import {
  GRAM_SIZE,
  LoopDetector,
  ReasoningLoopBreaker,
  TextRepetitionDetector,
  containment,
  countRepeatedText,
  grams,
  repeatRatio,
  trailingCycle,
} from './detector.js'

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The detector surface is re-exported so the package entry keeps the same API
 * it had before the split. `Config` is both a type (here, from the detector) and
 * a value (the schema below) — TypeScript merges those, and the explicit value
 * export wins over the star re-export.
 */
export * from './detector.js'

type UserMessage = ReturnType<typeof createUserMessage>
type GuardableAgent = Pick<Agent, 'inject' | 'steer' | 'cancel'>
  & Partial<Pick<Agent, 'whenIdle' | 'followup' | 'status'>>

export const Config: z<ConfigShape> = z.object({
  maxThinkingSteps: z.number().min(2).default(3),
  minReasoningChars: z.number().min(256).default(2048),
  similarityThreshold: z.number().min(0).max(1).default(0.8),
  escalate: z.union(['warn', 'steer', 'cancel']).default('steer'),
  maxFires: z.number().min(1).default(4),
  cancelCause: z.string().default('thinking-loop'),
  maxRepeatedText: z.number().step(1).min(0).default(60),
  maxRepeatedCycleChars: z.number().step(1).min(0).default(512),
  minRepeatedCycleChars: z.number().step(1).min(2).default(256),
  maxRepeatedReasoningCycleChars: z.number().step(1).min(0).default(512),
  minRepeatedReasoningCycleChars: z.number().step(1).min(2).default(512),
  maxRepeatedReasoningLineChars: z.number().step(1).min(0).default(2048),
  minRepeatedReasoningLineCoverage: z.number().min(0).max(1).default(0.6),
  minRepeatedReasoningLineConcentration: z.number().min(0).default(4),
  maxRepeatedTextLineChars: z.number().step(1).min(0).default(2048),
  minRepeatedTextLineCoverage: z.number().min(0).max(1).default(0.6),
  minRepeatedTextLineConcentration: z.number().min(0).default(4),
  breakCode: z.string().default('REPETITIVE_OUTPUT'),
  breakCorrection: z.boolean().default(true),
  resumeAfterBreak: z.boolean().default(false),
})

export const name = 'loop-guard'

/**
 * Cordis services this plugin resolves off the Context.
 *
 * Declaring `agents` is REQUIRED, not documentation: Cordis's context proxy
 * throws `cannot get property "agents" without inject` for any service read
 * that the fiber did not declare (vendor/cordis/src/reflect.ts, the
 * `waterfall('internal/get', …)` guard). The plugin reaches the live Agent via
 * `ctx.agents.get(options.sessionId)`, so without this line `apply()` throws on
 * activation and every session in that deployment fails to run.
 *
 * TypeScript cannot catch this: `ctx.agents` type-checks as soon as
 * `@deepseek-ai/dsh-agent` is in the type graph, because the guard is purely
 * runtime. That is exactly how v0.1.1 shipped broken (issue #1).
 */
export const inject = ['agents']

/**
 * Register this plugin's own message-source kind with the harness.
 *
 * `MessageSourceMap` is a merge-extensible sum type: each producer declares its
 * own `kind` in its own module. The augmentation is what makes
 * `source: { kind: 'loop-guard', ... }` typecheck, and it is additive — consumers
 * fall through unknown kinds, so it cannot break a host that has never heard of
 * us. Declared this way rather than by widening our own literal, so the compiler
 * still rejects a misspelled kind.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'loop-guard': {
      kind: 'loop-guard'
    } & ContextFormed
  }
}

/** The attribution this plugin stamps on every notice it injects. */
const PLUGIN_SOURCE = { kind: 'loop-guard' } as const

/**
 * Build one model-facing notice from the guard.
 *
 * The source kind is the plugin's own id, which is what the transcript's
 * attribution row renders. `summary` is a one-line account of *what happened* —
 * the collapsed transcript row renders it, and `boundContextSummary` caps it at
 * {@link CONTEXT_SUMMARY_MAX_CHARS} — so it states the event rather than
 * repeating the plugin name, the way `guard/repeat-tool-reminder` summarises as
 * `<tool> × <count>`.
 *
 * @param text - the full notice body.
 * @param form - the context form; always `notice` here.
 * @param summary - the one-line account for the collapsed row.
 */
function message(text: string, form: 'notice', summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form, summary },
  })
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The language the guard speaks to the model in. Default `zh`.
 *
 * Chinese is the default and the fallback in every direction: this guard's
 * primary audience reads Chinese, and a wrong guess costs more than a default
 * does. Only an explicit `en` preference selects English; an absent settings
 * service, an unregistered namespace, a malformed section, an unknown id or a
 * throwing reader all resolve to `zh`.
 *
 * The service is read with `ctx.get('settings')` rather than `ctx.settings`:
 * Cordis's context proxy throws `cannot get property "settings" without inject`
 * for any service the fiber did not declare, and the guard only declares
 * `agents`. Reading through `get` is the non-throwing accessor, so the settings
 * service stays genuinely optional — a profile without it works, and one with it
 * gets the user's real choice.
 */
function readLanguage(ctx: Context): 'zh' | 'en' {
  try {
    const settings = (ctx as { get?: (name: string) => unknown }).get?.('settings') as
      | { get?: (ns: string) => unknown }
      | undefined
    if (settings === undefined || typeof settings.get !== 'function') return 'zh'
    const section = settings.get('locale')
    if (section === null || typeof section !== 'object') return 'zh'
    const preference = (section as { preference?: unknown }).preference
    if (typeof preference !== 'string') return 'zh'
    return preference.toLowerCase().startsWith('en') ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** Localized strings for the messages the guard sends the model. */
interface Strings {
  /** `warn` escalation notice. */
  warn(detail: string): string
  /** `steer` escalation notice. */
  steer(detail: string): string
  /** `cancel` escalation notice. */
  cancel(detail: string): string
  /** What the stall looked like, for the `warn`/`steer`/`cancel` templates. */
  detail(reason: StallReason): string
  /**
   * The correction queued after a mid-stream break.
   *
   * @param what - what repeated (visible output / reasoning).
   * @param chars - how much of the call was repetition, NOT the call's length.
   */
  correction(what: string, chars: number): string
  /** One-line account for the collapsed transcript row of a stall notice. */
  stallSummary(reason: StallReason): string
  /**
   * One-line account for the collapsed transcript row of a break notice.
   *
   * @param what - what repeated (visible output / reasoning).
   * @param chars - the repetition size, not the cut position.
   */
  breakSummary(what: string, chars: number): string
}

const EN: Strings = {
  warn: (d) => `The agent has produced ${d}. If this continues it will be interrupted.`,
  steer: (d) => `You are repeating the same reasoning without acting (${d}). Stop deliberating and carry on `
    + 'with the task: take the next concrete step instead of restating it.',
  cancel: (d) => `Aborting: ${d}.`,
  detail: (reason) => reason === 'reasoning-only'
    ? 'several long reasoning-only calls with no output'
    : 'several calls that restate the same reasoning without adding anything',
  correction: (what, chars) => `Your ${what} had repeated itself for ${chars} characters without progressing, `
    + 'so the response was cut off mid-stream. Do not repeat it: carry on with the task you were working on.',
  stallSummary: (reason) => reason === 'reasoning-only'
    ? 'stalled: reasoning-only calls'
    : 'stalled: restated reasoning',
  breakSummary: (what, chars) => `cut a repeating ${what} at ${chars} chars`,
}

const ZH: Strings = {
  warn: (d) => `模型已出现${d}。若继续，将被中断。`,
  steer: (d) => `你正在重复相同的推理而没有行动（${d}）。停止空转，继续推进任务：直接执行下一步，不要再复述。`,
  cancel: (d) => `正在中止：${d}。`,
  detail: (reason) => reason === 'reasoning-only'
    ? '连续多次只输出思考、没有任何产出'
    : '连续多次复述同样的推理、没有新增内容',
  // The correction must send the model BACK to its task, not wrap it up. An
  // earlier wording ("state the conclusion once, briefly") read as "finish now"
  // and made the model abandon work in progress — the break ended the loop but
  // also derailed the turn. The instruction is therefore only "stop repeating,
  // carry on".
  correction: (what, chars) => `你的${what}已连续重复 ${chars} 个字符而没有进展，因此响应被中途截断。`
    + '不要重复这段内容，继续完成你原本的任务。',
  stallSummary: (reason) => reason === 'reasoning-only'
    ? '空转：仅思考无产出'
    : '空转：复述推理',
  breakSummary: (what, chars) => `已截断重复的${what}（${chars} 字符）`,
}

/** The strings for one language. */
function stringsFor(lang: 'zh' | 'en'): Strings {
  return lang === 'zh' ? ZH : EN
}

/** The noun naming what repeated, in the language the model is addressed in. */
function whatFor(lang: 'zh' | 'en', rule: BreakRule): string {
  const visible = rule === 'identical-chunks' || rule === 'repeating-cycle' || rule === 'text-lines'
  if (lang === 'zh') return visible ? '可见输出' : '思考内容'
  return visible ? 'visible output' : 'reasoning'
}

/**
 * Install the listener. Per-`Agent` state is keyed in a `WeakMap` so a disposed
 * agent is collected; detectors are scoped to one agent lifecycle.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const detectors = new WeakMap<object, LoopDetector>()

  function detectorFor(agent: Agent): LoopDetector {
    let detector = detectors.get(agent)
    if (detector === undefined) {
      detector = new LoopDetector(config)
      detectors.set(agent, detector)
    }
    return detector
  }

  function react(agent: GuardableAgent, reason: StallReason): void {
    const s = stringsFor(readLanguage(ctx))
    switch (config.escalate) {
      case 'warn':
        agent.inject(message(s.warn(s.detail(reason)), 'notice', s.stallSummary(reason)))
        return
      case 'steer':
        agent.steer(message(s.steer(s.detail(reason)), 'notice', s.stallSummary(reason)))
        return
      case 'cancel':
        // `AgentCancelCause` is a discriminated union of OBJECTS, not a string:
        // `{ kind: 'user' } | { kind: 'parent' } | { kind: 'hook', reason } |
        // { kind: 'disposed' }`. Passing the bare `cancelCause` string used to
        // satisfy the type checker only through an `as unknown as` cast, and the
        // host then crashed: `abortedCancelCause` switches on `cause.kind`,
        // which is `undefined` for a string, and the `default` arm calls
        // `assertNever` -> `unreachable variant: "thinking-loop"`.
        //
        // `hook` is the only variant that carries a free-form reason, so the
        // user's configured `cancelCause` rides there and stays visible in the
        // session's `turn/end` record. The annotation is deliberate: it makes
        // the compiler reject a bare string if anyone reintroduces the cast.
        const cause: AgentCancelCause = { kind: 'hook', reason: config.cancelCause }
        agent.cancel(cause)
        return
    }
  }

  /**
   * End one in-flight model call from inside the stream wrapper.
   *
   * The synthesized `finish` is the part that must not be skipped: the agent
   * loop feeds every chunk this wrapper yields into the same assembler an
   * adapter feeds, and `packages/llm/llm/src/invariant.ts` requires a terminal
   * finish chunk while explicitly allowing `error`/`aborted` to leave blocks
   * open. Returning without one would violate that grammar.
   *
   * Order matters — steer first, then return the terminal chunk. The user
   * message must be durably enqueued *before* the `error` finish throws out of
   * the step, so the resumed turn that the loop's `turn/end` finally block
   * schedules (`if (!this.inbox.hasPending) return false`) claims it. The error
   * path reaches `turn/end` through `throwError` without passing a turn-stopping
   * idle check, so this ordering is what makes the correction survive.
   *
   * @param agent - the live agent that owns the call.
   * @param chars - visible-output characters emitted before the break.
   * @returns the terminal chunk to yield as the call's last.
   */
  /**
   * End one in-flight model call from inside the stream wrapper.
   *
   * ## Why the call is closed, not failed
   *
   * An earlier version ended the call with a terminal `error` finish. That is
   * legal at the stream level — `llm/invariant` permits `error`/`aborted` to
   * leave blocks open — but it produces a session shape the rest of the harness
   * cannot handle, in two independent ways:
   *
   *  1. **The client cannot render it.** `agent-loop` settles an `error` finish
   *     as an `assistant/attempt` and appends no `assistant/message`
   *     (`step()`, the `finish.kind === 'error' || 'aborted'` branch). The
   *     conversation renderer builds its `assistant-step` node from a settled
   *     message, so it returns `null` for that step — and
   *     `buildTargetUpserts` refuses to withdraw a target it already
   *     materialized, throwing `conversation Definition "assistant-step"
   *     withdrew materialized target "chat"`. A reasoning-only break has no
   *     visible content to fall back on, so every break crashed the UI.
   *  2. **The turn could never continue.** The same branch ends in
   *     `throwError(error)`, so `turn()` throws out of the loop *before* it
   *     reaches `if (!this.inbox.hasPending) return false` — the line that
   *     decides whether another turn opens. A queued steer was therefore never
   *     claimed, which is why a break looked like "it just stopped".
   *
   * Closing the open blocks and finishing with `stop` instead puts the call on
   * the ordinary path: `step()` assembles `live.blocks()` into a real
   * `assistant/message`, the client renders it, and `turn()` returns normally so
   * pending steering opens the next turn.
   *
   * The invariant requires `open.size === 0` for a `stop` finish, which is
   * exactly what closing the blocks establishes.
   *
   * @param agent - the live agent that owns the call.
   * @param repeated - characters of REPETITION, not the call's total length. The
   *   two differ by 1.6x-10.1x on measured firings, and the notice is about the
   *   repetition, so this is the figure that reaches the model.
   * @param rule - which detector fired.
   * @param open - the blocks still open, in stream order, with their text.
   * @returns the terminal chunks to yield, or `null` when the break cannot be
   *   made safe and the stream should be left alone.
   */
  function breakStream(
    agent: GuardableAgent,
    repeated: number,
    rule: BreakRule,
    open: readonly { index: number; blockType: string; text: string }[],
  ): StreamChunk[] | null {
    // A `stop` finish is only legal with no open block, so every open block must
    // be closed. That is safe for text/reasoning, whose payload this wrapper
    // accumulated. It is NOT safe for a tool-call: closing one would commit a
    // half-streamed call into `message.content`, and `step()` executes any
    // tool-call block it finds — running a call whose arguments are still
    // truncated JSON. Leaving it open fails the invariant instead. Neither is
    // acceptable, so the break is abandoned; the post-call detectors still
    // apply, and a few more repeated characters are cheaper than a bad call.
    if (open.some((block) => block.blockType !== 'text' && block.blockType !== 'reasoning')) {
      ctx.logger.warn(`loop-guard: repetition detected but a non-text block is open; not breaking (rule: ${rule})`)
      return null
    }
    const lang = readLanguage(ctx)
    const s = stringsFor(lang)
    const what = whatFor(lang, rule)
    ctx.logger.warn(`dsh-loop-guard: breaking a repetitive stream (${repeated} repeated chars, one call, rule: ${rule}, code: ${config.breakCode})`)
    if (config.breakCorrection) {
      agent.steer(message(s.correction(what, repeated), 'notice', s.breakSummary(what, repeated)))
    }
    // Start waiting for the driver to return to `idle` BEFORE the terminal chunk
    // is yielded. The `whenIdle()` promise is captured here, synchronously, so
    // it observes this turn's completion; awaiting it later (from the break
    // path) would race the very wind-down it needs to follow.
    if (config.resumeAfterBreak) scheduleResume(agent, s.correction(what, repeated), s.breakSummary(what, repeated))
    const out: StreamChunk[] = []
    for (const block of open) {
      // `block-end` wins over the accumulated deltas (`BlockAssembler.assemble`
      // returns `partial.block` when set), so this payload is what the committed
      // message carries.
      out.push({
        type: 'block-end',
        index: block.index,
        block: { type: block.blockType, text: block.text } as never,
      })
    }
    out.push({ type: 'finish', reason: { kind: 'stop' } })
    return out
  }

  /**
   * Re-enter the model once the broken turn has actually finished unwinding.
   *
   * `wakeDriver()` only starts a driver when the agent is `idle`, so a wake
   * issued from inside the stream wrapper (phase `running`) is silently
   * dropped: `send()` classifies it as a non-abort wake, `wakeDriver` refuses
   * to latch it, and `kick()`'s `finally` sees no `wakeRequested`. Waiting on
   * `whenIdle()` is what puts the wake on the far side of that boundary.
   *
   * The continuation is a follow-up turn carrying the correction text rather
   * than an empty message: an empty one would hand the model the same
   * degenerate history with no new instruction, which is the loop's own input.
   *
   * Failures here are logged, never thrown: this runs detached from the stream,
   * and a guard must not be the reason a session dies.
   */
  function scheduleResume(agent: GuardableAgent, text: string, summary: string): void {
    const whenIdle = agent.whenIdle
    const followup = agent.followup
    if (typeof whenIdle !== 'function' || typeof followup !== 'function') return
    void whenIdle.call(agent).then(() => {
      followup.call(agent, message(text, 'notice', summary))
      ctx.logger.debug('dsh-loop-guard: resumed the turn after a break')
    }).catch((error: unknown) => {
      ctx.logger.warn(`dsh-loop-guard: could not resume after a break: ${String(error)}`)
    })
  }

  // Observe every streaming model call through the `llm/stream` waterfall. This
  // is present on both dsh 0.1.2-rc.1 and 0.1.5-alpha.1 and carries the SAME
  // StreamChunk delta types, so no version branching is needed.
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    // Only agent-loop-built calls carry the loop identity; skip arbitrary
    // non-agent streaming (tool streams, assistant replay, etc.).
    if (!isAgentLoopRequest(options)) return next()
    if (options.sessionId === undefined) return next()
    const agent = ctx.agents.get(options.sessionId)
    if (agent === undefined) return next()
    const detector = detectorFor(agent)

    return (async function* wrapped(): AsyncIterable<StreamChunk> {
      let reasoning = ''
      let hasOutput = false
      const textBreaker = new TextRepetitionDetector(config)
      const reasoningBreaker = new ReasoningLoopBreaker(config)
      // Blocks still open, in stream order. A break has to close them itself:
      // `llm/invariant` rejects a `stop` finish while any block is open, and the
      // committed content of each block comes from the `block-end` payload.
      const open = new Map<number, { blockType: string; text: string }>()
      const openBlocks = () => [...open.entries()].map(([index, b]) => ({ index, ...b }))
      for await (const chunk of next()) {
        if (chunk.type === 'block-start') open.set(chunk.index, { blockType: chunk.blockType, text: '' })
        else if (chunk.type === 'block-end') open.delete(chunk.index)
        else if (chunk.type === 'reasoning-delta') {
          reasoning += chunk.text
          const block = open.get(chunk.index)
          if (block !== undefined) block.text += chunk.text
        } else if (chunk.type === 'text-delta') {
          hasOutput = true
          const block = open.get(chunk.index)
          if (block !== undefined) block.text += chunk.text
        } else if (chunk.type === 'tool-call-delta') hasOutput = true
        yield chunk
        // Visible-output repetition is the one failure the post-call judgement
        // above cannot reach (issue #2848: ~2825 repeats inside ONE call), so it
        // is checked per chunk and ends the stream while it is still open. The
        // returning branch skips the post-call observation: the call did not
        // finish, and its breaker already reacted.
        if (chunk.type === 'text-delta' && textBreaker.push(chunk.text)) {
          // `return` here ends the generator — this is not the C# `yield break`.
          const tail = breakStream(agent, textBreaker.repeatedChars, textBreaker.trippedBy ?? 'identical-chunks', openBlocks())
          if (tail === null) continue
          for (const c of tail) yield c
          return
        }
        // Reasoning repetition is the failure in issue #5976: the model emits
        // reasoning forever and never returns, so the step never settles and the
        // harness turn loop never breaks. This is the only detector here that
        // can end such a turn, and it must run mid-stream to do it.
        if (chunk.type === 'reasoning-delta' && reasoningBreaker.push(chunk.text)) {
          const tail = breakStream(agent, reasoningBreaker.repeatedChars, reasoningBreaker.trippedBy ?? 'reasoning-cycle', openBlocks())
          if (tail === null) continue
          for (const c of tail) yield c
          return
        }
      }
      // Judge the call only once its stream has ended: a call that turns out to
      // produce output after its reasoning is progress, not a thinking loop.
      const reason = detector.observe({ hasOutput, reasoning })
      if (reason !== undefined) ctx.logger.debug(`thinking-loop-guard: stalled call (${reason})`)
      const fire = detector.takeFire()
      if (fire !== undefined) react(agent, fire)
    })()
  })
}
