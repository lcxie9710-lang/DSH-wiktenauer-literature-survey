/**
 * Install the `@ghogiel/dsh-jev` plugin package into a local DSH_HOME.
 *
 * Mirrors `packages/dsh-hema-v2/preset/install.mjs`: junction, `link:` dependency,
 * then a pnpm reconcile through `dsh plugin --profile <p> install`. Skipping that
 * last step is the mistake that costs an hour — the junction and the preset look
 * right, but the lockfile does not know about the package, so the next pnpm
 * operation deletes the junction and the preset starts failing with
 * "Cannot find package '@ghogiel/dsh-jev'".
 *
 * This does NOT copy `conditioned-reflex/` into `<DSH_HOME>/.agent-presets/`.
 * Run `node preset/sync-preset.mjs` first to regenerate it from the installed
 * build, then `node install.mjs` at the repository root, which copies it.
 *
 * Usage:
 *   node preset/install.mjs              # default: the web profile
 *   node preset/install.mjs --profile web
 *   node preset/install.mjs --dry-run
 *   node preset/install.mjs --uninstall
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const DRY = argv.includes('--dry-run')
const UNINSTALL = argv.includes('--uninstall')

const PKG = '@ghogiel/dsh-jev'
const [SCOPE, NAME] = PKG.split('/')
// This script lives in <package>/preset/, so one level up is the package root —
// which is also the junction target, because `package.json` and `index.js` sit there.
const PLUGIN_DIR = resolve(import.meta.dirname, '..')

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const profile = arg('profile', 'web')
const profileDir = join(dshHome, 'profiles', profile)
const linkPath = join(profileDir, 'node_modules', SCOPE, NAME)
const pkgJsonPath = join(profileDir, 'package.json')

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}

console.log(`DSH_HOME   : ${dshHome}`)
console.log(`profile    : ${profile}`)
console.log(`package dir: ${PLUGIN_DIR}`)
console.log(`link target: ${linkPath}`)
console.log(`dry-run    : ${DRY}\n`)

if (!existsSync(profileDir)) {
  console.error(`profile directory does not exist: ${profileDir}`)
  process.exit(2)
}
if (!existsSync(join(PLUGIN_DIR, 'package.json'))) {
  console.error(`no package.json in the package directory: ${PLUGIN_DIR}`)
  process.exit(2)
}

if (UNINSTALL) {
  if (!DRY && existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true })
  console.log(`junction removed${DRY ? ' (dry-run)' : ''}`)
  console.log('note: the link dependency in package.json and .agent-presets/conditioned-reflex are left alone')
  process.exit(0)
}

// ── 1. junction ─────────────────────────────────────────────
const scopeDir = join(profileDir, 'node_modules', SCOPE)
if (!DRY) mkdirSync(scopeDir, { recursive: true })
let linkState = 'created'
if (existsSync(linkPath)) {
  const st = lstatSync(linkPath)
  if (st.isSymbolicLink() && resolve(readlinkSync(linkPath)) === PLUGIN_DIR) {
    linkState = 'already-correct'
  } else {
    linkState = 'replaced'
    if (!DRY) rmSync(linkPath, { recursive: true, force: true })
  }
}
if (!DRY && linkState !== 'already-correct') symlinkSync(PLUGIN_DIR, linkPath, 'junction')
ok(`junction in place (${linkState})`, DRY || existsSync(linkPath))

// ── 2. the `link:` dependency ────────────────────────────────
const raw = readFileSync(pkgJsonPath, 'utf8')
let pkg
try { pkg = JSON.parse(raw) } catch (e) {
  console.error(`cannot parse ${pkgJsonPath}: ${e.message}`)
  process.exit(2)
}
pkg.dependencies = pkg.dependencies ?? {}
// pnpm records link dependencies with forward slashes here; keep the same shape.
const want = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`
const had = pkg.dependencies[PKG]
if (had === want) {
  ok('package.json already has the right link dependency', true, want)
} else {
  pkg.dependencies[PKG] = want
  if (!DRY) {
    const indent = /\n(\s+)"/.exec(raw)?.[1]?.length ?? 2
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, indent)}\n`, 'utf8')
  }
  ok(`link dependency written${had ? ` (replacing ${had})` : ''}`, true, want)
}

// ── 3. pnpm reconcile ───────────────────────────────────────
function resolveDshEntry() {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.cmd', '.ps1', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      if (!existsSync(join(dir, `dsh${ext}`))) continue
      const cand = join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(cand)) return cand
    }
  }
  return null
}

if (DRY) {
  console.log('  --  dry-run: skipping the pnpm reconcile')
} else {
  const entry = resolveDshEntry()
  if (entry === null) {
    ok('pnpm reconcile (no dsh entry found, skipped)', false, `run by hand: dsh plugin --profile ${profile} install`)
  } else {
    const r = spawnSync(process.execPath, [entry, 'plugin', '--profile', profile, 'install'], {
      cwd: profileDir, encoding: 'utf8', timeout: 300_000, windowsHide: true,
    })
    const outText = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const lock = existsSync(join(profileDir, 'pnpm-lock.yaml'))
      ? readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8') : ''
    const recorded = r.status === 0 && lock.includes(PKG)
    ok('pnpm reconcile (lockfile records the package)', recorded,
      recorded ? PKG : outText.trim().split(/\r?\n/).slice(-3).join(' | '))
  }
}

console.log(`\n${fails === 0 ? 'installed' : fails + ' checks failed'}`)
process.exit(fails === 0 ? 0 : 1)
