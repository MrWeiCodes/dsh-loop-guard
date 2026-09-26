/**
 * The package must be installable from the repository, not just from a checkout.
 *
 * Issue #1 (dsh-plugin-hub, DSH 0.1.7-rc.2) reported:
 *
 *   [packaging] dsh-loop-guard: entry file missing: lib/index.js
 *   (git distribution lacks build output — install the npm version or report to the author)
 *
 * Root cause: `main` points at `lib/index.js`, `lib/` is in `.gitignore` (it is
 * build output and must not be committed), and **nothing builds it on install**.
 * A `git+https://…` install therefore produced a package containing only the files
 * that happen to be tracked — no entry point at all. The plugin could not be
 * installed from GitHub by anyone.
 *
 * The sibling plugin `dsh-fs-encoding` has the same layout and works, because its
 * `package.json` declares `"prepare": "tsc"`: npm and pnpm both run `prepare`
 * after a git install, so the consumer gets a built `lib/` without the build
 * output ever entering git.
 *
 * These assertions are structural on purpose — they need no network and no
 * install. A test that performed a real git install would be the strongest check
 * but cannot run in CI reliably; what can be checked here is that the three pieces
 * that make the install work are all present and consistent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('the entry point declared by `main` is the file the build produces', () => {
  // If these drift apart, `prepare` would build something the runtime never loads.
  assert.equal(pkg.main, 'lib/index.js')
  assert.ok(pkg.files.includes('lib/index.js'), 'the entry must be in `files`, or npm pack omits it')
})

test('the package name is scoped, because the unscoped name belongs to someone else', () => {
  // The unscoped `dsh-loop-guard` on npm is owned by a different maintainer and is
  // not a release of this project, so this plugin publishes as
  // `@mrweicodes/dsh-loop-guard`.
  //
  // What that other package contains is deliberately not asserted anywhere: this
  // project does not control it, so it could change at any time.
  assert.ok(
    pkg.name.startsWith('@'),
    `the package name must stay scoped: the unscoped "dsh-loop-guard" is not ours. `
    + `Got ${JSON.stringify(pkg.name)}.`,
  )
  assert.equal(pkg.name, '@mrweicodes/dsh-loop-guard')
})

test('the bundle patch registers the plugin under the scoped package name', () => {
  // The loader resolves this string as the module to mount, so it has to match
  // `package.json` exactly — a stale unscoped name here would fail to load.
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(
    patch.includes(`name: '${pkg.name}'`),
    `cordis.patch.yml must mount ${pkg.name}; it currently registers something else`,
  )
})

test('the READMEs warn about the same-named unscoped package', () => {
  // The warning is the only thing standing between a reader and installing a
  // package this project does not control, so it is pinned rather than trusted to
  // survive edits.
  //
  // The warning deliberately states ONLY that the unscoped package is unrelated and
  // not maintained here. It must not characterise that package's contents,
  // version, size or intent: this project has no control over what is published
  // there, so any such description could become false — and a reassuring one
  // ("it's just an empty placeholder") would amount to vouching for a stranger's
  // package. That is why the assertions below check for absence of such claims.
  for (const file of ['README.md', 'README_EN.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(text.includes(pkg.name), `${file} must name the real package`)
    assert.ok(
      /与本插件无关|unrelated to this plugin/.test(text),
      `${file} must say the unscoped package is unrelated to this plugin`,
    )
    assert.ok(
      /不要安装那个无 scope 的同名包|do not install the unscoped/.test(text),
      `${file} must tell the reader not to install it`,
    )
  }
})

test('the READMEs make no claim about what the unscoped package contains', () => {
  // Anything published under a name this project does not own can change at any
  // time. Describing it — even neutrally, and especially reassuringly — is a claim
  // we cannot keep true.
  for (const file of ['README.md', 'README_EN.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const forbidden = [
      [/\b0\.0\.1\b/, 'a version number of the unscoped package'],
      [/\b243\s*(字节|bytes|B\b)/, 'a size of the unscoped package'],
      [/Proprietary/i, "the unscoped package's license"],
      [/空包|empty package/, 'a characterisation of its contents'],
      [/\bcarbide\b/i, "the unscoped package's maintainer"],
    ]
    for (const [re, what] of forbidden) {
      assert.ok(
        !re.test(text),
        `${file} must not state ${what}: this project does not control that `
        + 'package, so the claim could become false (or read as a reassurance).',
      )
    }
  }
})

test('build output stays out of git, so something must build it on install', () => {
  // `lib/` is build output: committing it would mean every source commit carries a
  // generated diff. The trade is that an install must build it, which is what
  // `prepare` is for.
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  const ignoresLib = ignore.split('\n').map((l) => l.trim()).includes('lib/')
  assert.ok(ignoresLib, 'this suite assumes lib/ is gitignored; if that changed, revisit `prepare`')

  assert.ok(
    typeof pkg.scripts?.prepare === 'string' && pkg.scripts.prepare.trim() !== '',
    'issue #1: without a `prepare` script a git install has no entry file, because '
    + 'lib/ is gitignored and nothing builds it. Add `"prepare": "tsc"`.',
  )
})

test('`prepare` actually builds the declared entry point', () => {
  // The script must run the compiler over the source that emits `main`. Both are
  // checked rather than assumed, so renaming either one fails here.
  assert.equal(pkg.scripts.prepare.trim(), 'tsc', 'prepare must run the TypeScript build')
  const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'))
  assert.equal(tsconfig.compilerOptions?.outDir, 'lib', 'tsc must emit into lib/')
  assert.equal(tsconfig.compilerOptions?.rootDir, 'src', 'tsc must read from src/')
  assert.ok(existsSync(join(ROOT, 'src/index.ts')), 'the source entry must exist')
})

test('the compiler `prepare` invokes is a declared dependency', () => {
  // A `prepare` script naming a binary that no dependency provides fails at install
  // time on the consumer's machine — the worst place to find out.
  const typescript = pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript
  assert.ok(typescript, '`prepare` runs tsc, so typescript must be declared')
})

test('the declared files all exist, so npm pack ships what it promises', () => {
  // `files` entries that do not exist are silently skipped by npm pack. That is how
  // the entry point went missing without anyone noticing locally: the local
  // checkout HAS lib/ (built), so nothing looked wrong until a clean install.
  const missing = []
  for (const entry of pkg.files) {
    if (entry.includes('*')) continue
    if (!existsSync(join(ROOT, entry))) missing.push(entry)
  }
  assert.deepEqual(missing, [], `declared in \`files\` but absent from the repository: ${missing.join(', ')}`)
})
