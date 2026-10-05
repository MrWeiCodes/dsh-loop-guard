/**
 * The detector entry point must stay free of `@deepseek-ai` imports.
 *
 * Issue #4: on a DSH Desktop install the `@deepseek-ai/*` packages exist only
 * inside `resources/app.asar` and never reach the profile's `node_modules`. The
 * host's Cordis loader resolves those bare specifiers itself, so the running
 * plugin is unaffected — but `tools/analyze-session.mjs` is a plain `node`
 * process, and it used to import `lib/index.js`, whose top-level imports pulled
 * the whole Cordis graph in and aborted with:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis'
 *     imported from .../lib/index.js
 *
 * The fix is a second entry (`lib/detector.js`) whose module graph contains none
 * of those packages. That property is invisible at runtime on a CLI install —
 * where the packages ARE resolvable — so nothing but a test will catch its loss.
 *
 * The check runs against the BUILT output, not the source: a type-only import in
 * the source is erased by tsc and would pass a source-level grep while the built
 * file still carried a value import. It also walks the whole transitive graph
 * within the package, because a future refactor could reintroduce the dependency
 * one hop away.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DETECTOR = join(ROOT, 'lib', 'detector.js')

/** Every bare specifier imported by one built file. */
function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  // `import ... from 'x'`, `export ... from 'x'`, and bare `import 'x'`.
  const re = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2])
  return out
}

/** Resolve a relative specifier the way Node would, for graph walking. */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return undefined
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

test('the built detector entry exists and is exported', () => {
  // Without this the whole suite could pass while the artifact npm ships lacks
  // the entry the analyzer imports.
  assert.ok(existsSync(DETECTOR), 'lib/detector.js must be built')

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(
    pkg.files.includes('lib/detector.js'),
    'lib/detector.js must be in `files`, or npm pack omits it and Desktop users get the old failure',
  )
  assert.equal(
    pkg.exports?.['./detector']?.default,
    './lib/detector.js',
    'the ./detector subpath export must point at the built entry',
  )
})

test('the detector entry has no @deepseek-ai dependency, transitively', () => {
  const seen = new Set()
  const queue = [DETECTOR]
  const offenders = []

  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of importsOf(file)) {
      if (spec.startsWith('@deepseek-ai/')) {
        offenders.push(`${file.replace(ROOT, '.')} imports ${spec}`)
        continue
      }
      const local = resolveLocal(file, spec)
      if (local !== undefined) queue.push(local)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'the offline analyzer runs under a plain `node`, where @deepseek-ai packages are '
    + 'unresolvable on a DSH Desktop install (issue #4). Keep the detector graph free '
    + `of them:\n  ${offenders.join('\n  ')}`,
  )
  // The detector is currently self-contained (no imports at all), so the walk
  // legitimately visits one file. Assert it is non-empty rather than a size, so
  // this keeps holding if the module is later split into helpers.
  assert.ok(seen.size >= 1, 'the walk must have visited the detector entry')
})

test('the analyzer imports the detector entry, not the plugin entry', () => {
  // Importing `../lib/index.js` is exactly what caused issue #4: it drags in the
  // Cordis shell. The analyzer must depend on the detector alone.
  const analyzer = readFileSync(join(ROOT, 'tools', 'analyze-session.mjs'), 'utf8')
  assert.ok(
    /from\s+['"]\.\.\/lib\/detector\.js['"]/.test(analyzer),
    'analyze-session.mjs must import ../lib/detector.js',
  )
  assert.ok(
    !/from\s+['"]\.\.\/lib\/index\.js['"]/.test(analyzer),
    'analyze-session.mjs must NOT import ../lib/index.js (issue #4)',
  )
})

test('the offline tools needed to read a real session are shipped', () => {
  // A session file on disk is multi-frame zstd, not jsonl, so the analyzer alone
  // is not enough: without the decompressor a user cannot produce its input.
  // `decompress-session.mjs` was missing from `files` — a Desktop user could not
  // obtain it from the package at all.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const tool of ['tools/analyze-session.mjs', 'tools/decompress-session.mjs']) {
    assert.ok(pkg.files.includes(tool), `${tool} must be in \`files\``)
    assert.ok(existsSync(join(ROOT, tool)), `${tool} must exist`)
  }
})
