/**
 * Install the `@ghogiel/dsh-jev` plugin package into a local DSH_HOME.
 *
 * ## Why this is one atomic pnpm operation, not three hand-made steps
 *
 * An earlier version did it by hand: create the junction, write the `link:`
 * dependency into `package.json`, then ask pnpm to record it. That order has a
 * trap — the two writes land *before* the pnpm step, so when the pnpm step
 * cannot run the result is a **half-installed profile**: the preset can see the
 * plugin, the junction is on disk, but the lockfile has never heard of the
 * package, so the next `pnpm install` prunes the junction and sessions start
 * failing with "Cannot find package '@ghogiel/dsh-jev'".
 *
 * It also turned out to be unnecessary work. `pnpm install` creates the
 * link symlink itself for a `link:` dependency — verified on Windows: it makes
 * a **junction** (reparse tag 0xa0000003), no elevation and no Developer Mode
 * needed. So the sequence is now:
 *
 *   1. preflight `dsh plugin` end to end — change nothing if it cannot work
 *   2. write the `link:` dependency (original bytes kept in memory)
 *   3. `dsh plugin --profile <p> install` — creates the junction AND the lockfile entry
 *   4. verify both, and restore `package.json` if anything went wrong
 *
 * The invariant is therefore "either fully installed, or untouched".
 *
 * ## The preflight is `dsh plugin --version`, not a PATH poke
 *
 * `dsh plugin` forwards to pnpm in the profile directory, so the thing to test
 * is exactly that forward. `dsh plugin --profile <p> --version` runs pnpm with
 * a flag that installs nothing, and exits nonzero when pnpm is missing:
 *
 *   'pnpm' is not recognized as an internal or external command
 *   dsh: pnpm failed in profile directory <...>
 *
 * A clean DSH does not imply pnpm: booting a profile needs no pnpm (the bundles
 * resolve from the dsh installation), only `dsh plugin` does. So this is a real
 * state on a real machine, not a hypothetical.
 *
 * Usage:
 *   node preset/install.mjs              # default: the web profile
 *   node preset/install.mjs --profile web
 *   node preset/install.mjs --dry-run
 *   node preset/install.mjs --uninstall
 */

import { existsSync, readFileSync, writeFileSync, rmSync, lstatSync, readlinkSync } from 'node:fs'
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
// which is both the junction target and what the `link:` dependency points at.
const PLUGIN_DIR = resolve(import.meta.dirname, '..')

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const profile = arg('profile', 'web')
const profileDir = join(dshHome, 'profiles', profile)
const linkPath = join(profileDir, 'node_modules', SCOPE, NAME)
const pkgJsonPath = join(profileDir, 'package.json')
const lockPath = join(profileDir, 'pnpm-lock.yaml')

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

// ── Locate the dsh entry without spawning a .cmd (Node refuses: EINVAL) ──
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

/** Run `dsh plugin --profile <p> <args>`; the entry is already resolved. */
function dshPlugin(entry, args, timeout = 300_000) {
  return spawnSync(process.execPath, [entry, 'plugin', '--profile', profile, ...args], {
    cwd: profileDir, encoding: 'utf8', timeout, windowsHide: true,
  })
}

/**
 * Is `pnpm` on PATH? Our own check, rather than parsing the child's error text:
 * pnpm writes "not recognized as an internal or external command" in the OEM
 * code page on a non-English Windows, which prints as mojibake — and the fact
 * we actually want is directly observable anyway.
 */
function pnpmOnPath() {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.cmd', '.ps1', ''] : ['']
  return (process.env.PATH ?? '').split(sep).some((dir) =>
    dir && exts.some((ext) => existsSync(join(dir, `pnpm${ext}`))))
}

// ═══════════════════════════════════════════════════════════════
// 0. Preflight — refuse to touch anything if the plumbing cannot work
// ═══════════════════════════════════════════════════════════════
if (!existsSync(profileDir)) {
  console.error(`profile directory does not exist: ${profileDir}`)
  console.error('Start that profile at least once (`dsh --profile ' + profile + '`) so DSH creates it.')
  process.exit(2)
}
if (!existsSync(join(PLUGIN_DIR, 'package.json'))) {
  console.error(`no package.json in the package directory: ${PLUGIN_DIR}`)
  process.exit(2)
}

const entry = resolveDshEntry()
if (entry === null) {
  console.error('Cannot find the `dsh` command on PATH — nothing was changed.\n')
  console.error('`dsh plugin` is how this script keeps the profile consistent, and it is also')
  console.error('how pnpm learns about the package. Install DSH so `dsh` runs from a shell:')
  console.error('  npm i -g @deepseek-ai/dsh')
  console.error('(Running DSH through `npx` alone does not put `dsh` on PATH for other processes.)')
  process.exit(2)
}

{
  // `--version` is forwarded to pnpm and installs nothing — a faithful probe of
  // the exact mechanism the rest of this script depends on. Safe under
  // `--dry-run` too (it mutates nothing), so a dry run reports the real verdict
  // instead of glossing over the most likely failure.
  const probe = dshPlugin(entry, ['--version'], 120_000)
  if (probe.status !== 0) {
    console.error('`dsh` works, but it failed to reach pnpm — nothing was changed.\n')
    if (!pnpmOnPath()) {
      console.error('  diagnosis: no `pnpm` on PATH.')
    } else {
      // pnpm exists yet the forward failed — show its error, ASCII lines only:
      // on a non-English Windows pnpm writes its message in the OEM code page,
      // which prints as mojibake.
      console.error('  diagnosis: `pnpm` is on PATH, but it could not run in the profile directory:')
      const ascii = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.split(/\r?\n/)
        .filter(l => l.trim() && /^[\x20-\x7e]+$/.test(l.trim())).slice(-3)
      for (const l of ascii) console.error(`    ${l.trim()}`)
    }
    console.error('')
    console.error('`dsh plugin` forwards to pnpm inside the profile directory, and booting DSH does')
    console.error('not require pnpm — so a working DSH can still have none. Install pnpm, then re-run:')
    console.error('  corepack enable pnpm        # or: npm i -g pnpm')
    console.error('')
    console.error('Why this refuses instead of installing anyway: writing the junction and the `link:`')
    console.error('dependency without the lockfile entry leaves a half-installed profile. The preset')
    console.error('stays visible, but the next pnpm operation prunes the link and sessions die with')
    console.error('"Cannot find package \'' + PKG + '\'".')
    process.exit(2)
  }
}

// ── uninstall ────────────────────────────────────────────────
if (UNINSTALL) {
  if (!DRY && existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true })
  console.log(`junction removed${DRY ? ' (dry-run)' : ''}`)
  console.log(`thorough route: dsh plugin --profile ${profile} remove ${PKG}`)
  console.log('(that also drops the dependency from package.json and the lockfile; this script does not')
  console.log(' touch your dependency table)')
  process.exit(0)
}

// ═══════════════════════════════════════════════════════════════
// 1. Write the `link:` dependency
// ═══════════════════════════════════════════════════════════════
const originalPkgJson = readFileSync(pkgJsonPath, 'utf8')
let pkg
try { pkg = JSON.parse(originalPkgJson) } catch (e) {
  console.error(`cannot parse ${pkgJsonPath}: ${e.message}`)
  process.exit(2)
}
pkg.dependencies = pkg.dependencies ?? {}
// pnpm records link dependencies with forward slashes here; keep the same shape.
const want = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`
const had = pkg.dependencies[PKG]
const depUnchanged = had === want
if (!depUnchanged && !DRY) {
  pkg.dependencies[PKG] = want
  const indent = /\n(\s+)"/.exec(originalPkgJson)?.[1]?.length ?? 2
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, indent)}\n`, 'utf8')
}
ok(depUnchanged ? 'package.json already has the right link dependency' : `link dependency written${had ? ` (replacing ${had})` : ''}${DRY ? ' (dry-run)' : ''}`,
  true, want)

// ═══════════════════════════════════════════════════════════════
// 2. Let pnpm do the junction AND the accounting in one step
// ═══════════════════════════════════════════════════════════════
/** Undo our own writes. A half-installed profile is worse than no install at all. */
const rollback = () => {
  if (DRY) return
  try { writeFileSync(pkgJsonPath, originalPkgJson, 'utf8') } catch { /* 尽力而为 */ }
  try {
    if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()
      && resolve(readlinkSync(linkPath)) === PLUGIN_DIR) {
      rmSync(linkPath, { recursive: true, force: true })
    }
  } catch { /* 尽力而为 */ }
}

if (DRY) {
  console.log('  --  dry-run: would run `dsh plugin --profile ' + profile + ' install` (creates the junction + lockfile entry)')
} else {
  const r = dshPlugin(entry, ['install'])
  const outText = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const lock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : ''
  const recorded = r.status === 0 && lock.includes(PKG)

  let linked = false
  try { linked = existsSync(linkPath) && resolve(readlinkSync(linkPath)) === PLUGIN_DIR } catch { linked = false }

  ok('pnpm reconcile (lockfile records the package)', recorded,
    recorded ? PKG : outText.trim().split(/\r?\n/).slice(-3).join(' | '))
  ok('link in place (created/maintained by pnpm)', linked, linkPath)

  if (!recorded || !linked) {
    rollback()
    console.log('\nrolled back: package.json restored, link removed — the profile is untouched.')
    console.log(`to finish by hand, from ${profileDir}:`)
    console.log(`  dsh plugin --profile ${profile} install`)
    process.exit(1)
  }
}

console.log(`\n${DRY ? 'dry-run complete — nothing was changed' : fails === 0 ? 'installed' : fails + ' checks failed'}`)
process.exit(DRY || fails === 0 ? 0 : 1)
