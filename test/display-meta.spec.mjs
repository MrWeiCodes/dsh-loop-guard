/**
 * The Plugin Manager reads display text and an icon from the manifest WITHOUT
 * activating the plugin, so a broken declaration is invisible at runtime: the
 * card simply falls back to the raw package name and the default artwork.
 *
 * Per DSH's own host-plugin reference, the contract is:
 *
 *   - `locale/en.json` and `locale/zh.json`, each `{ "meta": { "title", "description" } }`;
 *   - a top-level `icon` in package.json pointing at a file relative to the manifest;
 *   - SVG, PNG, JPEG or WebP, at most 256 KiB; absolute paths, URLs, paths outside
 *     the package and symlinks leaving it are rejected;
 *   - `exports` must expose the locale files, and `files` must ship them plus the icon.
 *
 * These assertions exist because every one of those failures degrades silently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The locales DSH ships; each must carry the same fields. */
const LOCALES = ['zh', 'en']

test('each locale file declares the display title and description', () => {
  for (const lang of LOCALES) {
    const path = join(ROOT, 'locale', `${lang}.json`)
    assert.ok(existsSync(path), `locale/${lang}.json must exist`)

    const doc = JSON.parse(readFileSync(path, 'utf8'))
    assert.ok(doc.meta, `locale/${lang}.json must carry a "meta" object`)
    for (const field of ['title', 'description']) {
      const value = doc.meta[field]
      assert.equal(typeof value, 'string', `locale/${lang}.json meta.${field} must be a string`)
      assert.ok(value.trim().length > 0, `locale/${lang}.json meta.${field} must not be empty`)
    }
    // The title is what the card shows; falling back to the package name is the
    // exact outcome this file exists to prevent.
    assert.notEqual(
      doc.meta.title,
      pkg.name,
      `locale/${lang}.json must not simply repeat the package name`,
    )
  }
})

test('the two locales stay in step', () => {
  // A locale added to one file and forgotten in the other shows English text to
  // Chinese users (or vice versa) with no error anywhere.
  const keys = LOCALES.map((lang) => Object.keys(JSON.parse(readFileSync(join(ROOT, 'locale', `${lang}.json`), 'utf8')).meta).sort())
  assert.deepEqual(keys[0], keys[1], 'both locale files must declare the same meta fields')
})

test('the declared icon is a real, permitted file', () => {
  assert.equal(typeof pkg.icon, 'string', 'package.json must declare a top-level `icon`')

  // DSH rejects absolute paths, URLs and paths outside the package directory.
  assert.ok(!isAbsolute(pkg.icon), '`icon` must be a relative path')
  assert.ok(!/^[a-z]+:/i.test(pkg.icon), '`icon` must not be a URL')

  const abs = resolve(ROOT, pkg.icon)
  const rel = relative(ROOT, abs)
  assert.ok(!rel.startsWith('..'), '`icon` must stay inside the package directory')
  assert.ok(existsSync(abs), `icon file ${pkg.icon} must exist`)

  // DSH rejects symlinks that leave the package directory.
  const real = realpathSync(abs)
  assert.ok(!relative(ROOT, real).startsWith('..'), '`icon` must not resolve outside the package')

  const bytes = statSync(abs).size
  assert.ok(bytes > 0, '`icon` must not be empty')
  assert.ok(bytes <= 256 * 1024, `\`icon\` must be at most 256 KiB, got ${bytes} bytes`)
  assert.match(pkg.icon, /\.(svg|png|jpe?g|webp)$/i, '`icon` must be SVG, PNG, JPEG or WebP')
})

test('the icon is well-formed SVG on the shared 36x36 canvas', () => {
  // The official icons all use a 36x36 viewBox; a different canvas renders at the
  // wrong scale beside them.
  const svg = readFileSync(join(ROOT, pkg.icon), 'utf8')
  assert.match(svg, /^<svg[\s>]/, 'the icon must start with an <svg> element')
  assert.match(svg, /viewBox="0 0 36 36"/, 'the icon must use the 36x36 viewBox the other icons use')
  assert.match(svg, /<\/svg>\s*$/, 'the icon must be a complete <svg> document')
  // A gradient referenced by id must actually be defined, or the icon renders blank.
  const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1])
  for (const id of refs) {
    assert.ok(svg.includes(`id="${id}"`), `the icon references gradient #${id} but never defines it`)
  }
})

test('the locale files and icon are published and reachable', () => {
  // `exports` gates subpath access, and `files` gates what npm packs. Missing
  // either one means the Plugin Manager cannot read the metadata at all.
  for (const lang of LOCALES) {
    assert.ok(
      pkg.files.includes('locale/*.json'),
      '`files` must ship locale/*.json, or the title never reaches the Plugin Manager',
    )
  }
  assert.ok(pkg.files.includes('icon.svg'), '`files` must ship the icon')
  assert.equal(
    pkg.exports?.['./locale/*.json'],
    './locale/*.json',
    '`exports` must expose the locale files as a subpath',
  )
})
