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
/**
 * This module is the DETECTOR ENTRY POINT and must stay free of `@deepseek-ai`
 * imports.
 *
 * Issue #4: on a DSH Desktop install the `@deepseek-ai/*` packages live only
 * inside `resources/app.asar` and never reach the profile's `node_modules` —
 * the host Cordis loader resolves them itself, so the running plugin is fine,
 * but a plain `node` process cannot. `tools/analyze-session.mjs` is such a
 * process, and it used to import `lib/index.js`, whose top-level imports pulled
 * the whole Cordis graph in and aborted with ERR_MODULE_NOT_FOUND.
 *
 * Everything the offline tool needs lives here, and nothing in this file may
 * import a `@deepseek-ai` package — not even a type-only import that could be
 * erased, because the next person cannot tell which kind it was. A test
 * (`test/detector-purity.spec.mjs`) enforces it against the built output.
 */

/**
 * The agent's public methods the guard reacts with.
 *
 * `whenIdle`/`followup` are optional because they are only needed for
 * {@link Config.resumeAfterBreak}, and a guard that required them would fail to
 * mount on any Agent-shaped stand-in that omits them.
 */

/** Plugin configuration. */
export interface Config {
  /**
   * Consecutive stalled model calls before a reaction. A call is stalled when it
   * produced no text/tool output, or when it repeated most of the previous
   * call's distinct reasoning material. Default `3`.
   */
  maxThinkingSteps?: number
  /**
   * Minimum reasoning text within one call before that call is judged at all; a
   * short burst is normal. Default `2048` chars.
   */
  minReasoningChars?: number
  /**
   * Cross-call similarity: how much of the previous call's distinct reasoning
   * material must reappear in this call before the call counts as a repetition
   * of stalled thinking rather than progress. `1.0` requires an exact rerun of
   * the same material; `0` disables this signal. Default `0.8`.
   */
  similarityThreshold?: number
  /**
   * Reaction to fire on a threshold crossing. `warn` injects a notice, `steer`
   * sends a steering message, `cancel` hard-aborts the turn. Default `steer`.
   */
  escalate?: 'warn' | 'steer' | 'cancel'
  /**
   * How many times one agent may be reacted to before the guard stops
   * re-firing. A single intervention often does not break a strong loop, so the
   * default allows several. Default `4`.
   */
  maxFires?: number
  /** Cancel cause used when `escalate` is `cancel`. Default `'thinking-loop'`. */
  cancelCause?: string
  /**
   * Consecutive identical normalized visible-output chunks that end the stream
   * mid-call. `0` disables the breaker. This is the only guard here that fires
   * *inside* a model call, so it is the only one that can stop a single-call
   * repetition bleed (issue #2848). Default `60`.
   *
   * Covers the period-1 case only (a byte-identical delta repeated); a model
   * bleeding a *cycle* of a few short lines resets this counter on every phase
   * change. See `maxRepeatedCycleChars`.
   */
  maxRepeatedText?: number
  /**
   * Longest repeating period, in visible-output characters, that
   * {@link trailingCycle} will recognize at the tail of a call's output.
   * `0` disables the cycle rule. Default `512`.
   *
   * Discussion #7043 reported a model that bleeds a cycle of a few short lines
   * ("好。 / 发。 / 好。 / 好。", and a mixed-language variant) for tens of
   * lines; measured on v0.1.7, that shape never fires `maxRepeatedText` under any
   * chunking, because no two consecutive deltas are identical.
   *
   * ## Why the default is 512 and not 64
   *
   * The same silent-failure rule that set the reasoning cap applies here, and
   * this side was left behind. Measured on a real 44 387-character visible-output
   * bleed: its exact minimal period is **172** characters (stable across every
   * tail window from 512 to 16 384), and the loop starts at character **139 —
   * 0.3 %** of the final text. At the old `64` default `trailingCycle` returned
   * **0** for it, so the guard never fired, the call was never cut, and the text
   * ran to 44 387 characters until the user stopped the turn by hand.
   *
   * A streaming replay of that text through {@link TextRepetitionDetector} — the
   * real detector, delta by delta, not the settled message — puts the candidate
   * caps side by side. The figures are for that ONE text:
   *
   * | cap | fires on it |
   * | --- | --- |
   * | 64 (shipped) | **0** |
   * | 128 | 0 |
   * | 256 | 1, cut at character 576 (1.3 %) |
   * | 512 | 1, cut at character 576 (1.3 %) |
   *
   * `512` is chosen over the bare-minimum `256` for the same reason the reasoning
   * side chose it: a cap below a real period fails *silently*, and the periods
   * seen on this side have already grown past a previous default once. It costs
   * nothing in precision — across every visible-output text in the session store
   * (2 973 texts of 1 500+ characters, all sessions) the cycle rule fires on
   * exactly one: the real bleed. The other 2 972 legitimate texts — reports,
   * code, tables — score `0` at every cap from 64 through 4096.
   */
  maxRepeatedCycleChars?: number
  /**
   * Shortest tail span that must be an exact repetition of a single period before
   * the cycle rule ends the stream. Default `256`.
   *
   * Exact repetition rather than a low-entropy ratio on purpose: measured against
   * legitimately repetitive long output — a 40-row markdown table (0.72 at a
   * 512-char tail), generated CSS rows (0.82), a JSON dump (0.84), a log listing
   * (0.76) — a coverage threshold only separates the loop (0.92-0.99) by ~0.06,
   * too thin for a rule that truncates a call. Verbatim periodicity is 0 for all
   * of those samples and non-zero only for the reported shapes.
   */
  minRepeatedCycleChars?: number
  /**
   * Longest repeating period, in **reasoning** characters, that ends the stream
   * mid-call. `0` disables the reasoning rule. Default `512`.
   *
   * This is the rule that closes issue #5976. That failure is a model bleeding
   * reasoning and never returning — no text, no tool call — so no post-call
   * detector can reach it and the harness turn loop never settles (`StepEndReason`
   * is derived from a finished message). Cutting the stream from inside the
   * `llm/stream` wrapper is the only mechanism that ends such a turn.
   *
   * Calibrated on real reproductions. Measured bleed periods: 89, 102, 105, 154,
   * 187, 235, and **409** characters. The 409 is why this default is `512` and
   * not the `256` an earlier calibration chose: with `256` that bleed was
   * invisible (`trailingCycle` returns 0), the guard never fired, and the turn
   * had to be aborted by hand — the exact failure the rule exists to prevent.
   * A too-low period cap fails silently, so it must sit above every observed
   * period rather than at the middle of the ones seen so far.
   */
  maxRepeatedReasoningCycleChars?: number
  /**
   * Shortest reasoning tail that must be an exact repetition of one period
   * before the reasoning rule ends the stream. Default `512`.
   *
   * Higher than the visible-output default (`256`) on purpose: reasoning is
   * private scratch space that legitimately restates a heading or a plan step, so
   * the reasoning rule demands a longer verbatim run before truncating a call.
   * Measured, `512` and `1024` select exactly the same seven calls as `256` on
   * the reproduction, so the stricter value costs no recall.
   */
  minRepeatedReasoningCycleChars?: number
  /**
   * How many characters of *repeated lines* end a reasoning bleed. Default
   * `2048`, `0` disables the rule.
   *
   * The cycle rule above only sees a bleed that repeats in the same order every
   * time. A measured reproduction recombined a pool of about eleven sentences in
   * a different order each pass, so it had no period at any cap and the cycle
   * rule never fired: 330 188 characters until the user aborted. Counting the
   * mass sitting in lines already seen catches that shape, and the two rules are
   * complementary — a pool of very short phrases is the cycle rule's job.
   *
   * The threshold is deliberately far below the smallest aborted bleed that
   * matters: the worst measured case is cut at 4096 characters, 1.2 % of its
   * final length, with no false positive on any of the 119 calls in the same
   * session that produced text or a tool call.
   */
  maxRepeatedReasoningLineChars?: number
  /**
   * The share of counted reasoning characters that must sit in repeated lines
   * before the line rule fires. Default `0.6`.
   *
   * Coherent reasoning reuses phrases ("Let me check", "OK") but the bulk of its
   * text is new, so its repeated share stays low; a bleed drawn from a fixed
   * pool approaches 1.0. Lines shorter than two characters are excluded from
   * both the numerator and the denominator, so generated code full of `}` and
   * `);` cannot drive the ratio up.
   */
  minRepeatedReasoningLineCoverage?: number
  /**
   * How concentrated the line vocabulary must be before the line rule fires:
   * the average number of sightings per distinct line. Default `4`.
   *
   * ## Why the coverage threshold alone is not enough
   *
   * `addLine` contributes `len * k` for a line seen `k >= 2` times, so the
   * "repeated mass" is exactly the total length of every line that appears at
   * least twice. The coverage ratio is therefore
   * `chars in lines seen >= 2x / chars in all lines`, and a model that quotes one
   * code block **twice** — the "before" and "after" of an edit it is planning —
   * puts almost all of its mass in lines seen exactly twice. Coverage approaches
   * 1.0 while the vocabulary is not a pool at all.
   *
   * Measured on a real reproduction (a 3713-character planning call that quoted
   * `chatStream` and `probeEffort` before and after): 58 distinct lines across
   * 104 sightings, i.e. **1.79 sightings per line**, coverage 0.640. The shipped
   * thresholds (2048 / 0.6) were cleared with 30 characters and 0.04 of margin to
   * spare, and the cut landed at character 3712 of 3713 — it saved nothing and
   * cost the turn a step.
   *
   * Across every session on this machine, the two populations separate cleanly at
   * the tripping delta:
   *
   * | shape | sightings per distinct line |
   * | --- | --- |
   * | real phrase-pool bleeds (28) | **6.4 - 84** |
   * | code-quoting calls (12) | **1.41 - 2.48** |
   *
   * `4` sits between them with a factor of ~1.6 on each side, and costs nothing
   * on the true positives: every real bleed trips at exactly the same character
   * with and without the guard.
   *
   * A large pool repeated few times (100 lines x 3) scores `3` and is rejected
   * here — that shape is {@link trailingCycle}'s job, and it catches it: 24 of
   * those 28 bleeds trip the cycle rule too.
   */
  minRepeatedReasoningLineConcentration?: number
  /**
   * Repeated-LINE characters in the call's **visible output** that end the stream
   * — the phrase-pool rule for text, mirroring
   * {@link Config.maxRepeatedReasoningLineChars}. `0` disables it. Default `2048`.
   *
   * ## Why the visible-output side needs its own phrase-pool rule
   *
   * The two visible-output rules that predate this one cannot see a reshuffled
   * phrase pool, and on a real 56 465-character bleed **both missed it by
   * construction, not by a margin**:
   *
   *  - `maxRepeatedText` counts *consecutive identical deltas*. Providers chunk
   *    text into 2-3 character fragments, so `Go.` arrives as `Go` + `.` and the
   *    longest run of identical payloads over the whole bleed was **1**, against a
   *    threshold of 60. It cannot fire at any length.
   *  - `maxRepeatedCycleChars` needs an exact period, and a reshuffled pool has
   *    none: `trailingCycle(512, 256)` returned **0**.
   *
   * That bleed was one call with zero reasoning and zero tool calls, so the
   * reasoning-side rule ({@link Config.maxRepeatedReasoningLineChars}) could not
   * reach it either — the loop ran entirely in visible output. Measured on it: 26
   * distinct phrases across 5 569 sightings, repeat mass **44 995** characters
   * (22x this threshold), coverage **0.993**, concentration **214**.
   */
  maxRepeatedTextLineChars?: number
  /**
   * Share of counted visible-output characters that must sit in repeated lines
   * before the phrase-pool rule fires. Default `0.6`, matching the reasoning side.
   */
  minRepeatedTextLineCoverage?: number
  /**
   * Average sightings per distinct line required of the visible output. Default
   * `4`, matching the reasoning side — see
   * {@link Config.minRepeatedReasoningLineConcentration} for why coverage alone is
   * not enough.
   */
  minRepeatedTextLineConcentration?: number
  /**
   * Error code carried by the breaker's terminal failure. Default
   * `'REPETITIVE_OUTPUT'`.
   *
   * There is deliberately no way to choose a quiet `stop` finish instead: the
   * breaker fires while the call's text block is still open, and the `llm/stream`
   * invariant rejects a `stop` finish with open blocks (only `error`/`aborted`
   * may leave them open). Verified by running the wrapper's own output through
   * `@deepseek-ai/dsh-llm/invariant` — see `test/text-breaker.spec.mjs`.
   */
  breakCode?: string
  /**
   * Steer the agent after a mid-stream break so the resumed turn is told what
   * happened instead of silently continuing. Default `true`.
   */
  breakCorrection?: boolean
  /**
   * Continue the turn automatically after a mid-stream break, instead of
   * leaving the session waiting for the user. Default `false`.
   *
   * Off by default because it re-enters the model without the user asking, and
   * because the failure it responds to is one where the model has already shown
   * it cannot act on its own. Turn it on when an unattended run must not stall.
   *
   * How it works, and why a naive attempt cannot work: the break is observed
   * inside the stream wrapper, which runs while the agent's phase is `running`.
   * In that phase `agent-loop` deliberately suppresses every wake —
   * `wakeDriver()` only latches behind maintenance or an aborted activity, so a
   * `steer()`/`followup()` issued here sets no `wakeRequested`, and `kick()`'s
   * `finally` (`if (wakeRequested && inbox.hasPending) wakeDriver()`) finds
   * neither and lets the session come to rest. The wake has to happen *after*
   * the driver returns to `idle`, which is what `whenIdle()` waits for.
   *
   * The continuation message is the same correction text `breakCorrection`
   * queues, delivered as a follow-up turn. It is never empty: a user message
   * with no text blocks carries no instruction, and `createUserMessage` is
   * happy to build one, so an "empty retry" would re-enter the model with the
   * degenerate history unchanged — the shape that produced the loop.
   */
  resumeAfterBreak?: boolean
}

/** Resolved config: every field carries its validated default. */
export type ResolvedConfig = Required<Config>

/* -------------------------------------------------------------------------- */
/* Detection primitives (exported for tests)                                  */
/* -------------------------------------------------------------------------- */

/** Fixed window used for both the intra-call and cross-call measures. */
export const GRAM_SIZE = 4

/**
 * How many newly emitted visible characters must accumulate before the cycle
 * rule re-scans the tail. The scan is bounded by `minRepeatedCycleChars`, so a
 * fixed stride keeps the whole rule linear in emitted characters.
 */
const CYCLE_CHECK_STRIDE = 32

/**
 * The shortest line the line-repeat rule counts, in characters.
 *
 * A line this short or shorter is not evidence of anything: generated code
 * repeats `}` and `);` by the hundred legitimately, and a brace is one
 * character. Two characters is the floor at which a line starts carrying
 * content (`OK`, `Go`), which is exactly the vocabulary a phrase-pool bleed
 * recombines.
 */
const LINE_MIN_CHARS = 2

/**
 * Which detector ended a call, for the log line, the notice noun and tests.
 *
 * `identical-chunks` and `repeating-cycle` watch visible output;
 * `reasoning-cycle` and `reasoning-lines` watch reasoning under the two
 * complementary rules described on {@link ReasoningLoopBreaker}.
 */
export type BreakRule = 'identical-chunks' | 'repeating-cycle' | 'reasoning-cycle' | 'reasoning-lines' | 'text-lines'

/**
 * The phrase-pool accumulator shared by the reasoning and visible-output rules.
 *
 * Both sides need the same measure: how much of the text sits in lines that have
 * been seen more than once, and how concentrated that vocabulary is. Keeping one
 * implementation means a threshold change cannot make the two sides disagree.
 *
 * ## Why the visible-output side needs it at all
 *
 * A bleed can reshuffle a small phrase pool instead of repeating one period, and
 * that shape is invisible to both visible-output rules that predate this:
 *
 *  - `identical-chunks` counts *consecutive identical deltas*. Providers chunk
 *    text into 2-3 character fragments, so `Go.` arrives as `Go` + `.` and the
 *    longest run of identical payloads on a real 56 465-character bleed was
 *    **1** — the rule cannot reach 60 at any length.
 *  - `repeating-cycle` needs an exact period. A reshuffled pool has none: on that
 *    same bleed `trailingCycle(512, 256)` returned **0**.
 *
 * Measured on that bleed (one call, zero reasoning, zero tool calls): 26 distinct
 * phrases across 5 569 sightings, repeat mass **44 995** characters, coverage
 * **0.993**, concentration **214**. Every threshold here is cleared by an order of
 * magnitude, so the rule fires early rather than at the end.
 *
 * Incremental: each complete line is folded in exactly once, so the cost stays
 * linear in emitted characters.
 */
class PhrasePool {
  /** How many times each counted line has been seen. */
  private readonly counts = new Map<string, number>()
  /** Characters sitting in counted lines. */
  private total = 0
  /** Characters sitting in lines that have been seen more than once. */
  private repeat = 0
  /** Total sightings of counted lines (the denominator of the concentration). */
  private instances = 0
  /** Trailing text not yet terminated by a newline. */
  private partial = ''

  /** The repeated mass so far, for the break report. */
  get repeatedChars(): number {
    return this.repeat
  }

  /** Fold one delta in, counting only the lines it completes. */
  push(text: string): void {
    this.partial += text
    let idx: number
    while ((idx = this.partial.indexOf('\n')) >= 0) {
      this.addLine(this.partial.slice(0, idx).trim())
      this.partial = this.partial.slice(idx + 1)
    }
  }

  /**
   * Whether the accumulated pool has crossed every threshold.
   *
   * @param minRepeat - characters that must sit in repeated lines.
   * @param minCoverage - share of counted characters that must be repeated.
   * @param minConcentration - average sightings per distinct line. Coverage alone
   *   cannot tell a phrase pool from one long block quoted twice; see
   *   {@link Config.minRepeatedReasoningLineConcentration}.
   */
  tripped(minRepeat: number, minCoverage: number, minConcentration: number): boolean {
    if (this.repeat < minRepeat) return false
    if (this.total === 0) return false
    if (this.repeat / this.total < minCoverage) return false
    if (this.counts.size === 0) return false
    return this.instances / this.counts.size >= minConcentration
  }

  /**
   * Fold one complete line into the running counts.
   *
   * The repeat mass is maintained rather than recomputed: on the *second*
   * sighting of a line both copies become repetition, hence `* 2`, and every
   * sighting after that adds one more copy. Lines below {@link LINE_MIN_CHARS}
   * are dropped entirely so they never enter the denominator either.
   *
   * @param line - the trimmed line.
   */
  private addLine(line: string): void {
    if (line.length < LINE_MIN_CHARS) return
    const prev = this.counts.get(line) ?? 0
    this.counts.set(line, prev + 1)
    this.total += line.length
    this.instances += 1
    if (prev === 1) this.repeat += line.length * 2
    else if (prev > 1) this.repeat += line.length
  }
}

/**
 * The distinct fixed-length grams of one reasoning text.
 *
 * Fixed-length windows are the language-agnostic choice: CJK loops
 * ("好。执行。") have no whitespace, so a whitespace-token histogram collapses to
 * one token and can never distinguish repetition.
 *
 * @param text - the reasoning text of one call.
 * @param size - the window length in characters.
 * @returns the set of distinct windows (empty for text shorter than `size`).
 */
export function grams(text: string, size = GRAM_SIZE): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + size <= text.length; i++) out.add(text.slice(i, i + size))
  return out
}

/**
 * Low-entropy ratio: coverage of one text by repeated fixed-length grams.
 *
 * ## Not a loop detector — do not use it as one
 *
 * This is kept as a **diagnostic**, exported for `tools/analyze-session.mjs` and
 * the tests. It is deliberately no longer wired into {@link LoopDetector}; the
 * measurement behind that decision is on {@link LoopDetector.observe}.
 *
 * The short version: the ratio rises with **length**, because the number of
 * distinct 4-grams in natural language saturates. One continuous non-repeating
 * English document scores 0.290 at 2048 characters and 0.629 at 20 000; this
 * repo's own `README_EN.md` and `src/index.ts` score 0.54-0.65, above the `0.5`
 * that used to be the threshold, while a genuine periodic loop scores
 * 0.994-0.999. It separates "long" from "short", not "stuck" from "working".
 *
 * A tight repetition ("好。执行。" x N) still scores near 1.0, so it remains a
 * useful *descriptive* statistic on a text already known to be a loop.
 *
 * @param reasoning - the reasoning text of one call.
 * @returns the fraction of windows that had already appeared in the same text.
 */
export function repeatRatio(reasoning: string): number {
  if (reasoning.length < 16) return 0
  const k = Math.min(GRAM_SIZE, Math.max(2, Math.floor(reasoning.length / 16)))
  let repeated = 0
  let total = 0
  const seen = new Set<string>()
  for (let i = 0; i + k <= reasoning.length; i++) {
    const gram = reasoning.slice(i, i + k)
    total++
    if (seen.has(gram)) repeated++
    else seen.add(gram)
  }
  return total === 0 ? 0 : repeated / total
}

/**
 * Containment of one gram set in another: the fraction of the SMALLER set's
 * grams present in the larger.
 *
 * Containment rather than Jaccard on purpose. A stuck model typically restates
 * the previous step's material and appends another sentence, so the new set is a
 * near-superset of the old one; Jaccard would dilute that with the new material
 * and let the step look like progress, while containment reports the repetition
 * directly.
 *
 * @param a - one call's distinct grams.
 * @param b - another call's distinct grams.
 * @returns `0` when either set is empty, otherwise the containment in `[0, 1]`.
 */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const gram of small) if (large.has(gram)) shared++
  return shared / small.size
}

/** What one completed model call looked like to the guard. */
export interface StepObservation {
  /** Whether the call emitted any `text-delta` or `tool-call-delta`. */
  readonly hasOutput: boolean
  /** The call's total reasoning text. */
  readonly reasoning: string
}

/**
 * Why one call was counted as stalled (`undefined` = it was progress).
 *
 * Both reasons are structural: no output at all, or the previous call's material
 * restated. There is deliberately no "low-entropy" member — see
 * {@link LoopDetector.observe} for the measurement that removed it.
 */
export type StallReason = 'reasoning-only' | 'repeated-material'

/**
 * The per-agent detector: accumulates stalled calls and decides when to react.
 *
 * Kept free of Cordis types so the decision rule is unit-testable without a
 * harness: the plugin only feeds it observations and applies the reaction.
 */
export class LoopDetector {
  private stalled = 0
  private fires = 0
  private previous: Set<string> | undefined
  private lastReason: StallReason | undefined

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** The stalled-run length that would trigger the next reaction. */
  get threshold(): number {
    return this.config.maxThinkingSteps
  }

  /** How many reactions have fired for this agent so far. */
  get fired(): number {
    return this.fires
  }

  /**
   * Observe one completed model call.
   *
   * ## Why there is no intra-call ratio rule here
   *
   * An earlier version added a third reason, `low-entropy`: `repeatRatio` at or
   * above `0.5` on a call that did produce output. It was removed after being
   * measured on a real 4380-record session, where it fired **12 times and not
   * once on a loop**:
   *
   *  - Of the 36 calls it judged across those 12 fires, **33 (92 %)** were calls
   *    that had just made a tool call — `edit`, `write`, `read`, `grep`, `pwsh`.
   *    **Zero** were calls that produced neither output nor a tool call.
   *  - Across the whole session, on the 152 calls that produced output, it fired
   *    on **91 (59.9 %)**.
   *  - No threshold rescues it: the highest ratio on a productive call is
   *    **0.797** and the lowest on a reasoning-only call is **0.308**, so the
   *    ranges overlap and no cut-off separates them. At `0.5` it flags 60 % of
   *    productive calls; at `0.8` it flags none but also misses half the real
   *    bleeds.
   *  - The reason is arithmetic, not tuning. `repeatRatio` counts 4-grams
   *    already seen; the distinct 4-gram count of natural language saturates, so
   *    the ratio is pushed up by **length**. Scoring one continuous
   *    non-repeating English document at growing prefixes gives 0.290 at 2048
   *    characters, 0.495 at 8000, 0.629 at 20 000 — and the repo's own
   *    `README_EN.md` and `src/index.ts` score 0.54-0.65, i.e. above the
   *    threshold, while a genuine periodic loop scores 0.994-0.999. Spearman
   *    rho(length, ratio) = 0.606.
   *
   * So the rule was not a loop detector but a "reasoning longer than roughly
   * 8000 characters" detector. Its cost was not only the wrong steers: `fires` is
   * a per-agent budget, so four false positives exhausted `maxFires` and left the
   * guard silent for the rest of the process — the failure recorded in
   * {@link ReasoningLoopBreaker}'s calibration notes, where the three real bleeds
   * of a reproduction drew no reaction at all.
   *
   * The two reasons that remain are both structural and were clean on the same
   * data: `reasoning-only` fired on 0 of 152 productive calls, and
   * `repeated-material` needs 80 % of the previous call's distinct material
   * restated.
   *
   * @param step - the call's output shape and reasoning text.
   * @returns the reason it counted as stalled, or `undefined` when it was progress.
   */
  observe(step: StepObservation): StallReason | undefined {
    // A short burst is normal and carries too little material to judge. It is
    // neither counted nor treated as progress — it must not clear a run built
    // from substantive steps.
    if (step.reasoning.length < this.config.minReasoningChars) return undefined

    const current = grams(step.reasoning)
    const repeated = this.previous !== undefined
      && this.config.similarityThreshold > 0
      && containment(this.previous, current) >= this.config.similarityThreshold
    this.previous = current

    const reason: StallReason | undefined = !step.hasOutput
      ? 'reasoning-only'
      : repeated
        ? 'repeated-material'
        : undefined

    if (reason === undefined) {
      // Real progress: the run is over.
      this.stalled = 0
      this.lastReason = undefined
      return undefined
    }

    this.stalled += 1
    this.lastReason = reason
    return reason
  }

  /**
   * Whether a reaction is due now, consuming one fire when it is.
   *
   * A single intervention often does not break a strong loop, so a fire resets
   * the run counter (another full run of stalled calls is needed) and is capped
   * by `maxFires` so the guard cannot intervene forever.
   *
   * @returns the reason to report in the reaction, or `undefined` when no reaction is due.
   */
  takeFire(): StallReason | undefined {
    if (this.stalled < this.config.maxThinkingSteps) return undefined
    if (this.fires >= this.config.maxFires) return undefined
    this.fires += 1
    this.stalled = 0
    const reason = this.lastReason ?? 'reasoning-only'
    this.lastReason = undefined
    return reason
  }

  /** Forget every observation (used when a loop is judged broken by real output). */
  reset(): void {
    this.stalled = 0
    this.previous = undefined
    this.lastReason = undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Mid-stream repetition breaker (issue #2848)                                */
/* -------------------------------------------------------------------------- */

/**
 * Count how many of a list of visible-output chunks are a trailing run of
 * identical payloads (compared after trimming).
 *
 * Anchored at the tail on purpose: the breaker wants the *current* run, so
 * interleaved reasoning deltas (which are not passed here) and any earlier
 * unrelated text cannot mask it. Whitespace-only chunks normalize to `''` and
 * therefore count as repetitions of each other, which is the intended reading —
 * a stream emitting nothing but blank lines for a minute is equally stuck.
 *
 * @param texts - the call's `text-delta` payloads, in stream order.
 * @returns the length of the trailing identical run (`0` for an empty list).
 */
export function countRepeatedText(texts: readonly string[]): number {
  const last = texts.at(-1)
  if (last === undefined) return 0
  const normalized = last.trim()
  let run = 0
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i]!.trim() !== normalized) break
    run++
  }
  return run
}

/**
 * The tail span that is an exact repetition of one short period, or `0` when the
 * tail is not periodic (discussion #7043).
 *
 * This generalizes {@link countRepeatedText} from "the same delta twice" to
 * "the same *cycled* output for hundreds of characters", and it is
 * newline-agnostic: the period is measured in characters, so a bleed that never
 * emits a line break is caught identically to a one-line-per-delta bleed.
 *
 * Two guards keep it off legitimate output:
 *
 *  - **Exactness.** The whole span must be a verbatim repetition; a near-repeat
 *    scores `0`. Measured: a 40-row markdown table, generated CSS rows, a JSON
 *    dump and a 60-line log listing are all period-free while scoring
 *    0.72-0.84 on a *coverage* measure of the same text — a ratio rule would
 *    have had to separate the loop from those by ~0.06.
 *  - **A period of at least two distinct characters.** A run of `=` or `-` is a
 *    legitimate divider, and a one-character period would flag every long rule
 *    line in a generated document.
 *
 * The scan stops as soon as the minimum is met, so the returned span is
 * `max(minSpan, 2 * period)` rather than the longest periodic tail that exists:
 * the caller only distinguishes zero from non-zero, and stopping early keeps the
 * rule bounded on a call that bleeds for hundreds of thousands of characters.
 *
 * @param text - the accumulated visible output of one call.
 * @param maxPeriod - the longest period to consider, in characters.
 * @param minSpan - the shortest qualifying tail span, in characters.
 * @returns the qualifying span in characters (`>= minSpan`), or `0`.
 */
/**
 * How many identical characters end `text` (the run containing the last one).
 *
 * Exists to answer the "template has at least two distinct characters" guard
 * without materializing the template. That guard used to be written
 *
 *     new Set(text.slice(text.length - period)).size < 2
 *
 * which allocates and deduplicates `period` characters for EVERY candidate
 * period, making one scan O(maxPeriod^2) instead of O(maxPeriod). At the
 * shipped `maxPeriod` of 512 that is ~2 ms per scan, and the rule is scanned
 * every {@link CYCLE_CHECK_STRIDE} characters — so a single 183 760-character
 * reasoning call (the real bleed of issue #5976) burned **17.6 seconds of CPU**,
 * and `tools/analyze-session.mjs`, which replays a whole session synchronously,
 * went from seconds to tens of minutes on the same file.
 *
 * The two forms are equivalent, not merely similar: "every character in the last
 * `period` positions is the same" holds exactly when the run of identical
 * characters ending at the last position is at least `period` long. Verified
 * differentially against the `Set` form on 816 inputs — the shipped fixtures
 * included, at 8 `(maxPeriod, minSpan)` settings — with zero disagreements, and
 * measured 73x faster on the bleed above.
 *
 * @param text - the accumulated output of one call.
 * @returns the trailing run length in characters (`0` for empty text).
 */
function trailingRunLength(text: string): number {
  const len = text.length
  if (len === 0) return 0
  const last = text[len - 1]
  let run = 1
  while (run < len && text[len - 1 - run] === last) run++
  return run
}


export function trailingCycle(text: string, maxPeriod: number, minSpan: number): number {
  if (maxPeriod < 1) return 0
  const len = text.length
  const tailRun = trailingRunLength(text)
  for (let period = 1; period <= maxPeriod; period++) {
    // A template of one repeated character is not a cycle — see the guard above.
    if (tailRun >= period) continue
    // The last `period` characters are the template; walk backwards while the
    // output still matches itself one period earlier.
    const need = Math.max(minSpan, 2 * period) - period
    const limit = Math.min(len - period, need)
    let matched = 0
    while (matched < limit && text[len - period - 1 - matched] === text[len - 1 - matched]) matched++
    if (matched >= need) return matched + period
  }
  return 0
}

/**
 * The FULL span of the periodic tail, for reporting how much actually repeated.
 *
 * {@link trailingCycle} is the decision rule and deliberately stops as soon as the
 * minimum span is met — it runs on a fixed stride while the stream is still open,
 * so walking the whole tail every time would be wasted work. The consequence is
 * that its return value is a **lower bound** (`>= minSpan`), not the size of the
 * repetition: a bleed that cycles for 20 000 characters still reports `512`, the
 * threshold.
 *
 * That is fine for deciding, and wrong for telling the model how long it has been
 * going in circles. This picks the same period by the same qualification test and
 * then walks it all the way back, so the figure is the true span. It is O(tail)
 * and runs exactly once, at the delta that trips the rule.
 *
 * @param text - the accumulated output of one call.
 * @param maxPeriod - the longest period to consider, in characters.
 * @param minSpan - the shortest qualifying tail span, in characters.
 * @returns the full periodic span in characters, or `0` when no period qualifies.
 */
export function periodicTailSpan(text: string, maxPeriod: number, minSpan: number): number {
  if (maxPeriod < 1) return 0
  const len = text.length
  const tailRun = trailingRunLength(text)
  for (let period = 1; period <= maxPeriod; period++) {
    if (tailRun >= period) continue
    const need = Math.max(minSpan, 2 * period) - period
    // Same test as `trailingCycle`, but the walk is unbounded, so `matched` is
    // the real extent of the periodicity rather than a capped one.
    const limit = len - period
    let matched = 0
    while (matched < limit && text[len - period - 1 - matched] === text[len - 1 - matched]) matched++
    if (matched >= need) return matched + period
  }
  return 0
}

/**
 * The reasoning breaker: the one rule that can end a thinking loop.
 *
 * ## Why this exists separately from every other detector here
 *
 * Issue #5976's failure is a model that degrades into a **pure reasoning bleed**
 * and never returns: no `text-delta`, no `tool-call-delta`, so the step never
 * settles. Measured on a real reproduction (a 174 MB session, 4628 calls, dsh
 * 0.1.5-rc.2), the final three calls emitted 74 193 / 357 112 / 134 244
 * characters of reasoning and nothing else.
 *
 * Every other detector in this file is structurally too late for that shape:
 *
 *  - {@link LoopDetector} judges a call **after** it ends. A bleed that does not
 *    end never reaches it. On the reproduction its `maxFires` budget was already
 *    spent by four false positives early in the session (the `low-entropy` rule,
 *    since removed — see {@link LoopDetector.observe}), so the three real bleeds
 *    produced no reaction at all.
 *  - {@link TextRepetitionDetector} watches `text-delta` only, by design, because
 *    visible output is what a repetition is normally visible in. Here the bleed
 *    is entirely in reasoning, so it never saw a chunk.
 *
 * The harness itself has no seam for this either: `packages/core/agent-loop`
 * derives `StepEndReason` from the finished message, so a stream that keeps
 * producing reasoning never settles and the `while (true)` turn loop never
 * breaks — which is exactly what the reporter observed as "只能手动中止".
 *
 * ## Why it is safe to watch reasoning, which legitimately revisits itself
 *
 * The rule is the same **exact verbatim periodicity** as the visible-output
 * cycle rule, not a low-entropy ratio. Calibrated against real reproductions —
 * every call with >= 2048 reasoning characters, of which the overwhelming
 * majority produced text or a tool call:
 *
 *  - Measured bleed periods: **89, 102, 105, 154, 187, 235 and 409** characters.
 *  - `maxPeriod: 64` (the shipped visible-output default) finds **none** of them.
 *  - The period cap must sit **above every observed period**, not in the middle
 *    of the ones seen so far: a cap below a real period fails *silently* —
 *    `trailingCycle` returns 0, the breaker never fires, and the turn runs until
 *    the user aborts it. A `256` default did exactly that to the 409-character
 *    bleed. Hence `512`.
 *  - Verbatim periodicity is what separates a bleed from legitimately repetitive
 *    reasoning: the highest-`repeatRatio` non-loop calls have *no* period at
 *    all, so a ratio rule would flag them while the exact rule does not.
 *
 * Free of Cordis types so the decision rule is unit-testable without a harness.
 */
export class ReasoningLoopBreaker {
  private broken = false
  private chars = 0
  private reasoning = ''
  private lastCycleCheck = 0
  private trippedRule: 'reasoning-cycle' | 'reasoning-lines' | undefined
  /** The phrase-pool accumulator for the `reasoning-lines` rule. */
  private readonly pool = new PhrasePool()
  /** Repetition size recorded by whichever rule tripped. */
  private repeated = 0

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** Whether the breaker has already fired for this call. */
  get tripped(): boolean {
    return this.broken
  }

  /** Which rule fired, for the log line and for tests. */
  get trippedBy(): 'reasoning-cycle' | 'reasoning-lines' | undefined {
    return this.trippedRule
  }

  /**
   * How much of this call was repetition, in characters.
   *
   * NOT the same as {@link emittedChars}: that is the call's total length, and
   * most of a real call is new material even when it bleeds. Reporting the total
   * as "repeated" overstated the repetition by **1.6x to 10.1x** across 17
   * measured firings (median 1.9x), which matters because the notice's whole
   * purpose is to tell the model how long it has been going in circles.
   *
   * Each rule reports its own measure:
   *
   *  - `reasoning-lines` -> {@link lineRepeat}, the mass sitting in repeated lines;
   *  - `reasoning-cycle` -> the periodic span {@link trailingCycle} returned.
   */
  get repeatedChars(): number {
    return this.repeated
  }

  /** Reasoning characters observed so far in this call (the call's total length). */
  get emittedChars(): number {
    return this.chars
  }

  /**
   * Observe one `reasoning-delta` payload.
   *
   * @param text - the delta's text.
   * @returns `true` exactly once, on the delta that trips a rule.
   */
  push(text: string): boolean {
    if (this.broken) return false
    this.chars += text.length
    this.reasoning += text
    if (this.pushLines(text)) {
      this.broken = true
      this.trippedRule = 'reasoning-lines'
      // The line rule's own measure of how much repeated: the mass sitting in
      // lines seen more than once. Reporting `chars` here instead would claim the
      // call's entire length was repetition.
      this.repeated = this.pool.repeatedChars
      return true
    }
    if (this.config.maxRepeatedReasoningCycleChars <= 0) return false
    // Same fixed-stride scan as the visible-output rule: the check is bounded by
    // `minRepeatedReasoningCycleChars`, so a bleed that runs for hundreds of
    // thousands of characters is still scanned a bounded number of times.
    if (this.reasoning.length - this.lastCycleCheck < CYCLE_CHECK_STRIDE) return false
    this.lastCycleCheck = this.reasoning.length
    const span = trailingCycle(
      this.reasoning,
      this.config.maxRepeatedReasoningCycleChars,
      this.config.minRepeatedReasoningCycleChars,
    )
    if (span === 0) return false
    this.broken = true
    this.trippedRule = 'reasoning-cycle'
    // `span` is the decision rule's capped lower bound; report the real extent.
    this.repeated = periodicTailSpan(
      this.reasoning,
      this.config.maxRepeatedReasoningCycleChars,
      this.config.minRepeatedReasoningCycleChars,
    ) || span
    return true
  }

  /**
   * The line-repeat rule: a bleed that recombines a small pool of phrases.
   *
   * Verbatim periodicity ({@link trailingCycle}) only catches a bleed whose unit
   * repeats in the same order every time. A real reproduction broke that
   * assumption: 330 188 reasoning characters drawn from roughly eleven sentences
   * — `Let me read the section.` / `Executing.` / `Go.` / `Now.` / `Writing.` /
   * `OK.` / `Let me write.` — **reshuffled** each pass, so no period exists at
   * any cap (measured: 0 at every cap from 64 to 4096, and the minimum period of
   * the trailing 8192 characters was 6767, i.e. none). The cycle rule was blind
   * to it and the turn ran to 330 188 characters until the user aborted.
   *
   * What such a bleed *does* have is a tiny line vocabulary. Counting how much
   * of the text sits in lines already seen separates it cleanly, and the two
   * rules are complementary rather than redundant: short-phrase bleeds (`Go.`,
   * `OK.` — under {@link LINE_MIN_CHARS}) are the cycle rule's job, long-phrase
   * pools are this one's.
   *
   * Calibrated on 146 real reasoning calls (17 aborted bleeds, 119 calls that
   * produced text or a tool call): the shipped thresholds catch the bleed at
   * **4096 characters — 1.2 % of its 330 188** — with **zero false positives on
   * all 119 producing calls**, and zero across every parameter set in the sweep
   * that this one was chosen from.
   *
   * ## What that control set could not see
   *
   * The 119-call control contains only calls that **produced output**, so it
   * structurally excludes reasoning-only calls — which is exactly where a
   * planning call that quotes code lives. Re-measured over every session on this
   * machine (85 firings), the coverage threshold alone fires on 12 calls that are
   * quoting a code block before and after an edit rather than bleeding, with a
   * vocabulary of 1.4-2.5 sightings per line. One of them was cut for real, at
   * character 3712 of 3713 — see
   * {@link Config.minRepeatedReasoningLineConcentration} for the guard that
   * separates the two shapes and the margin it leaves.
   *
   * Incremental, so the rule stays linear in emitted characters: only complete
   * lines are counted, and each line is folded in exactly once.
   *
   * @param text - the delta's text.
   * @returns `true` when the repeated mass crosses every threshold.
   */
  private pushLines(text: string): boolean {
    if (this.config.maxRepeatedReasoningLineChars <= 0) return false
    this.pool.push(text)
    return this.pool.tripped(
      this.config.maxRepeatedReasoningLineChars,
      this.config.minRepeatedReasoningLineCoverage,
      this.config.minRepeatedReasoningLineConcentration,
    )
  }
}

/**
 * The intra-call breaker: watches one call's visible output and reports when the
 * model has repeated itself enough to be considered degenerate.
 *
 * Kept separate from {@link LoopDetector} because the two answer different
 * questions on different clocks — this one must decide *while the stream is
 * still open* (a call that bleeds for ten minutes never reaches the other), and
 * it is deliberately blind to reasoning text, which legitimately revisits itself
 * far more often than visible output does. A bleed that happens *inside*
 * reasoning is {@link ReasoningLoopBreaker}'s job, under a stricter rule.
 * Free of Cordis types so the decision rule is unit-testable without a harness.
 */
export class TextRepetitionDetector {
  private texts: string[] = []
  private broken = false
  private visible = ''
  private lastCycleCheck = 0
  private reason: 'identical-chunks' | 'repeating-cycle' | 'text-lines' | undefined
  /** Repetition size recorded by whichever rule tripped. */
  private repeated = 0
  /** The phrase-pool accumulator for the `text-lines` rule. */
  private readonly pool = new PhrasePool()

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** Whether the breaker has already fired for this call. */
  get tripped(): boolean {
    return this.broken
  }

  /** Which rule fired, for the log line and for tests. */
  get trippedBy(): 'identical-chunks' | 'repeating-cycle' | 'text-lines' | undefined {
    return this.reason
  }

  /**
   * How much of this call's visible output was repetition, in characters.
   *
   * Distinct from {@link emittedChars}, which is the call's total output. The
   * two are far apart on a real bleed: a call can emit thousands of characters of
   * new material before its tail starts cycling, and the notice must report the
   * repetition, not the total.
   *
   * Each rule reports its own measure:
   *
   *  - `identical-chunks` -> the trailing run of identical deltas;
   *  - `repeating-cycle` -> the periodic span {@link trailingCycle} returned.
   */
  get repeatedChars(): number {
    return this.repeated
  }

  /** How many characters the call had emitted when the breaker tripped. */
  private chars = 0

  /** Visible-output characters observed so far in this call. */
  get emittedChars(): number {
    return this.chars
  }

  /**
   * Observe one `text-delta` payload.
   *
   * @param text - the delta's text.
   * @returns `true` exactly once, on the delta that completes the run.
   */
  push(text: string): boolean {
    if (this.broken) return false
    this.chars += text.length
    if (this.config.maxRepeatedText <= 0 && this.config.maxRepeatedCycleChars <= 0
      && this.config.maxRepeatedTextLineChars <= 0) return false
    this.texts.push(text)
    if (this.config.maxRepeatedText > 0
      && this.texts.length >= this.config.maxRepeatedText
      && countRepeatedText(this.texts) >= this.config.maxRepeatedText) {
      this.broken = true
      this.reason = 'identical-chunks'
      // The run of identical deltas IS the repetition; multiply by the payload
      // length so the figure is comparable with the cycle rule's span.
      this.repeated = countRepeatedText(this.texts) * text.length
      return true
    }
    // The phrase-pool rule. Fed before the cycle scan and independent of it: a
    // reshuffled pool has no period at all, so the two rules cannot substitute
    // for each other. See {@link PhrasePool} for the measurement.
    if (this.config.maxRepeatedTextLineChars > 0) {
      this.pool.push(text)
      if (this.pool.tripped(
        this.config.maxRepeatedTextLineChars,
        this.config.minRepeatedTextLineCoverage,
        this.config.minRepeatedTextLineConcentration,
      )) {
        this.broken = true
        this.reason = 'text-lines'
        this.repeated = this.pool.repeatedChars
        return true
      }
    }
    if (this.config.maxRepeatedCycleChars <= 0) return false
    this.visible += text
    // The scan grows with the qualifying span, so run it on a fixed stride
    // rather than per delta: a bleed is hundreds of characters long and 32
    // characters of latency cost nothing next to the cost of not firing.
    if (this.visible.length - this.lastCycleCheck < CYCLE_CHECK_STRIDE) return false
    this.lastCycleCheck = this.visible.length
    const span = trailingCycle(this.visible, this.config.maxRepeatedCycleChars, this.config.minRepeatedCycleChars)
    if (span === 0) return false
    this.broken = true
    this.reason = 'repeating-cycle'
    // `span` is the decision rule's capped lower bound; report the real extent.
    this.repeated = periodicTailSpan(
      this.visible,
      this.config.maxRepeatedCycleChars,
      this.config.minRepeatedCycleChars,
    ) || span
    return true
  }
}
