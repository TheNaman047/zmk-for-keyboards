#!/usr/bin/env node
// Re-create editor/app/ from nickcoutsos/keymap-editor's built `pages` branch.
//
// That branch is exactly what https://nickcoutsos.github.io/keymap-editor/ serves, but it
// accumulates every past build's hashed chunks (~28 MB). Only the files reachable from
// index.html + the webpack runtime's chunk map are kept, then a few patches make it run
// from localhost. Run again with a new SHA to take an upstream update.
//
//   node editor/vendor.mjs            # pinned SHA below
//   node editor/vendor.mjs <sha>      # some other pages-branch commit

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM = 'https://github.com/nickcoutsos/keymap-editor.git'
const PINNED_SHA = '62ec4d9b529bf377aa711128825b84f354292eed' // pages, 2026-10-28
const sha = process.argv[2] || PINNED_SHA

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, 'app')

const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString()

// --- fetch ---------------------------------------------------------------------------
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'keymap-editor-pages-'))
console.log(`fetching ${sha} into ${src}`)
run(src, 'init', '-q')
run(src, 'remote', 'add', 'origin', UPSTREAM)
run(src, 'fetch', '-q', '--depth', '1', 'origin', sha)
run(src, 'checkout', '-q', 'FETCH_HEAD')
run(src, 'fetch', '-q', '--depth', '1', 'origin', 'main')
const license = run(src, 'show', 'FETCH_HEAD:LICENSE')

// --- reachability --------------------------------------------------------------------
const exists = rel => fs.existsSync(path.join(src, rel)) && fs.statSync(path.join(src, rel)).isFile()
const read = rel => fs.readFileSync(path.join(src, rel), 'utf8')

const keep = new Set(['index.html'])
const queue = []
const add = rel => {
  rel = rel.replace(/^\.?\//, '')
  if (!keep.has(rel) && exists(rel)) { keep.add(rel); queue.push(rel) }
}

const indexHtml = read('index.html')
for (const [, ref] of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
  add(ref.replace('https://nickcoutsos.github.io/keymap-editor/', ''))
}

const runtimeFile = [...keep].find(f => /^runtime\.[a-f0-9]+\.js$/.test(f))
if (!runtimeFile) throw new Error('webpack runtime not referenced from index.html - layout changed upstream')

// l.u=function(e){return({id:"name",...}[e]||e)+"."+{id:"hash",...}[e]+".js"}
const runtime = read(runtimeFile)
const u = runtime.match(/\.u=function\(e\)\{return\(\{([^}]*)\}\[e\]\|\|e\)\+"\."\+\{([^}]*)\}\[e\]\+"\.js"\}/)
if (!u) throw new Error('could not find the chunk filename map in the webpack runtime')
const toMap = body => Object.fromEntries([...body.matchAll(/(\d+):"([^"]+)"/g)].map(m => [m[1], m[2]]))
const names = toMap(u[1])
const hashes = toMap(u[2])
for (const [id, hash] of Object.entries(hashes)) {
  const chunk = `${names[id] || id}.${hash}.js`
  if (!exists(chunk)) throw new Error(`runtime references missing chunk ${chunk}`)
  add(chunk)
}

// Assets (wasm, fonts, images) are referenced by bare filename from JS and CSS.
const assetRef = /["'(/]([A-Za-z0-9_./-]+\.(?:wasm|woff2?|ttf|eot|png|svg|gif|jpg|json))["')?#]/g
while (queue.length) {
  const file = queue.shift()
  if (!/\.(js|css|html)$/.test(file)) continue
  for (const [, ref] of read(file).matchAll(assetRef)) add(path.posix.join(path.posix.dirname(file), ref))
  for (const [, ref] of read(file).matchAll(assetRef)) add(ref)
  if (exists(`${file}.LICENSE.txt`)) add(`${file}.LICENSE.txt`)
}

// --- patches -------------------------------------------------------------------------
// Each patch must match exactly once, so an upstream change fails loudly instead of
// silently shipping an unpatched bundle.
function patchOnce (text, from, to, what) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`patch "${what}": expected 1 match, found ${n}`)
  return text.replace(from, to)
}

const patched = {
  // Absolute github.io URLs for the stylesheet and icons -> served locally.
  'index.html': indexHtml.replaceAll('https://nickcoutsos.github.io/keymap-editor/', '')
}

// Feature flags (module 28962): k0=GitHub, qo=Local(author-only server), IX=Demo,
// mC=Clipboard, XG=File System. GitHub sign-in redirects back to github.io, so it cannot
// work from localhost, and its server is being shut down anyway - hide it.
const mainFile = [...keep].find(f => /^main\.[a-f0-9]+\.js$/.test(f))
patched[mainFile] = patchOnce(
  read(mainFile),
  's=r("true"),c=r("false")',
  's=r("false"),c=r("false")',
  'disable GitHub source'
)

// --- write ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true })
let bytes = 0
for (const rel of [...keep].sort()) {
  const dest = path.join(outDir, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (rel in patched) fs.writeFileSync(dest, patched[rel])
  else fs.copyFileSync(path.join(src, rel), dest)
  bytes += fs.statSync(dest).size
}
fs.writeFileSync(path.join(outDir, 'LICENSE'), license)
fs.writeFileSync(path.join(outDir, 'VENDORED.json'), JSON.stringify({
  upstream: UPSTREAM,
  branch: 'pages',
  sha,
  files: keep.size,
  patches: ['index.html: github.io URLs made relative', `${mainFile}: GitHub source disabled`]
}, null, 2) + '\n')

fs.rmSync(src, { recursive: true, force: true })
console.log(`kept ${keep.size} files (${(bytes / 1e6).toFixed(1)} MB) -> ${path.relative(process.cwd(), outDir)}`)
