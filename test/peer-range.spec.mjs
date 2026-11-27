import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * Every `@deepseek-ai/dsh` version published as of 2026-11-27, oldest first;
 * `npm view @deepseek-ai/dsh versions` refreshes it.
 *
 * The list is deliberately frozen: it is a record of what the range was checked
 * against, not a live query. A version published later is not covered by this
 * test — that is what the release checklist is for.
 */
const PUBLISHED = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5',
  '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
  '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
  '0.2.0-rc.1', '0.2.0-rc.2',
  '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4',
  '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4',
  '0.2.1-rc.5',
  '0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3',
  '0.2.2-rc.4', '0.2.2-rc.5',
  '0.2.3-alpha.1', '0.2.3-alpha.2',
]

/**
 * The versions this plugin is expected to run on: every line from the first one
 * that carries the `llm/stream` waterfall and the three imported symbols.
 *
 * `createUserMessage`, `isAgentLoopRequest` and `markAgentLoopRequest` are
 * present, unchanged, in every entry below — checked against the published
 * tarballs rather than assumed.
 */
const SUPPORTED = [
  '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
  '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
  '0.2.0-rc.1', '0.2.0-rc.2',
  '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4',
  '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4',
  '0.2.1-rc.5',
  '0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3',
  '0.2.2-rc.4', '0.2.2-rc.5',
  '0.2.3-alpha.1', '0.2.3-alpha.2',
]

/**
 * ## One gate, not two
 *
 * The version range used to live in `peerDependencies`, which two independent
 * consumers read with different semver semantics:
 *
 *  - npm installs with DEFAULT semantics, under which a comparator admits a
 *    prerelease only when some comparator in the same group shares that
 *    prerelease's major.minor.patch tuple. `>=0.2.2-alpha.1 <0.2.3` therefore
 *    refuses `0.2.3-alpha.2`, and the install dies with
 *
 *      npm error ERESOLVE unable to resolve dependency tree
 *
 *  - the dsh runtime calls `evaluatePluginCompatibility` with
 *    `{ includePrerelease: true }`, under which the same range DOES admit
 *    `0.2.3-alpha.2`. A bundle the runtime rejects is not warned about: it is
 *    thrown out of `loadProfileDirectory` into `skippedBundles` and the plugin
 *    silently never loads.
 *
 * Keeping the two gates in agreement meant re-cutting the union for every dsh
 * line — 20 releases in seven weeks, and a wrong range fails silently on one
 * side or the other.
 *
 * `engines.dsh` removes the disagreement. `unmetRequirements` returns as soon
 * as an own `engines.dsh` range is present, so the dsh peers stop deciding
 * anything; npm does not read `engines.dsh` at all (it validates only `node`
 * and `npm`), so the peers become install-time no-ops. The range below is then
 * the single statement of what this plugin supports, and it covers every 0.2.x
 * line rather than one tuple at a time.
 */

test('the supported dsh range is declared as engines.dsh', () => {
  // Without this key the runtime falls back to the dsh peer ranges. Those are
  // `*` (see the test below), which admit everything — so a missing
  // `engines.dsh` does not fail loudly, it silently loads the plugin into a
  // dsh it was never checked against.
  assert.equal(
    typeof pkg.engines?.dsh,
    'string',
    'package.json must declare engines.dsh: it is the only gate the dsh runtime reads',
  )
})

test('engines.dsh admits exactly the tested dsh lines', () => {
  // Computed under `includePrerelease: true` because that is the only semantics
  // `engines.dsh` is ever read with: `evaluatePluginCompatibility` passes it
  // explicitly. npm never reads `engines.dsh` at all, so there is no second gate
  // to keep in agreement — which is the point of moving the range here.
  const range = pkg.engines.dsh
  const admitted = PUBLISHED.filter((v) => satisfies(v, range, { includePrerelease: true }))
  assert.deepEqual(
    admitted,
    SUPPORTED,
    `engines.dsh "${range}" admits [${admitted.join(', ')}] but the suite has only been ` +
      `run against [${SUPPORTED.join(', ')}]`,
  )
})

test('engines.dsh refuses the 0.3 line, so an untested line cannot load by accident', () => {
  // `>=0.1.2-rc.1 <0.3.0` looks equivalent and is not: under the runtime's
  // `includePrerelease: true`, `<0.3.0` admits `0.3.0-alpha.1`. The `-0` upper
  // bound is what actually closes the line.
  for (const beyond of ['0.3.0-0', '0.3.0-alpha.1', '0.3.0', '0.3.5', '1.0.0']) {
    assert.equal(
      satisfies(beyond, pkg.engines.dsh, { includePrerelease: true }),
      false,
      `engines.dsh must not admit ${beyond}: that line has never been tested`,
    )
  }
})

test('the dsh peers stay at `*`, which is the only range npm admits a prerelease host under', () => {
  // Not a simplification target. npm's peer resolver special-cases `*` to mean
  // "any version, prereleases included"; a normal range does not, and semver's
  // own `satisfies` cannot express the difference (`satisfies('0.2.3-alpha.2',
  // '*')` is false). Measured against a host on `0.2.3-alpha.2`:
  //
  //   peer "*"                        -> installs
  //   peer ">=0.0.0-0"                -> ERESOLVE
  //   peer ">=0.1.2-rc.1-0 <0.3.0-0"  -> ERESOLVE
  //   peer "<0.3.0-0"                 -> ERESOLVE
  //
  // Narrowing any of these reinstates the install failure `engines.dsh` was
  // adopted to remove, and the range would have to be re-cut for every dsh line.
  for (const dep of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']) {
    assert.equal(
      pkg.peerDependencies[dep],
      '*',
      `${dep} must stay at "*": any other range refuses a prerelease host under npm's ` +
        `default semantics, and the dsh runtime ignores the peer entirely once engines.dsh is set`,
    )
  }
})

test('every dsh peer is optional, so npm never picks a version for the user', () => {
  // `*` alone is not enough. npm resolves a missing peer by its `latest`
  // dist-tag, and the dsh packages tag `latest` at their *oldest* published
  // line — `@deepseek-ai/dsh-agent` points at 0.1.0-rc.6 and
  // `@deepseek-ai/dsh-llm` at 0.0.1-rc.1, while the newest release sits on
  // `next`/`alpha`. Installing the plugin on its own therefore pulled a
  // five-week-old dsh next to it.
  //
  // Marking the peers optional stops npm from installing them at all: a dsh
  // profile always supplies its own copies, and a bare `npm install` of this
  // package should not invent a runtime. Measured on a package-only install:
  // optional peers pulled zero `@deepseek-ai/dsh*` packages; required peers
  // pulled 0.1.0-rc.6.
  for (const dep of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']) {
    assert.equal(
      pkg.peerDependenciesMeta?.[dep]?.optional,
      true,
      `${dep} must be marked optional in peerDependenciesMeta: a required peer makes npm ` +
        `auto-install the version its stale \`latest\` tag points at`,
    )
  }
})

test('the dev pins stay on a line the supported range admits', () => {
  // A dev pin outside the range would mean the suite ran against a line the
  // published package refuses — the exact mismatch this file exists to prevent.
  //
  // The pin tracks the newest line that is NOT a fresh alpha, so the type
  // checker and the standalone suite run against the same release a user is
  // most likely on. That leaves the newest prerelease in SUPPORTED without a
  // permanent pin; it is covered by running the suite once against that line
  // before a release, not by moving the pin.
  for (const dep of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']) {
    const pin = pkg.devDependencies[dep]
    assert.ok(
      SUPPORTED.includes(pin),
      `devDependency ${dep}@"${pin}" is not in the tested set`,
    )
  }
})

test('the shipped description states the same range as engines.dsh', () => {
  // The description is the npm search result and the package page. A stale
  // range there tells users a different story than the manifest enforces.
  assert.ok(
    pkg.description.includes(pkg.engines.dsh),
    `description must quote engines.dsh "${pkg.engines.dsh}" verbatim, or it drifts on the next bump`,
  )
})
