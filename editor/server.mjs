#!/usr/bin/env node
// Local keymap editor: serves the vendored nickcoutsos/keymap-editor build (editor/app/)
// plus a Build panel that runs scripts/zmk-build.sh for this checkout.
//
//   node editor/server.mjs [--port 8737] [--open]
//
// The port is fixed on purpose: the editor keeps File System handles in IndexedDB, which
// is per-origin, so a stable origin means the browser remembers the opened keymap.

import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { softFlash } from './softflash.mjs'
import { listPorts } from './studio-rpc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = process.env.ZMK_WORKSPACE || path.join(os.homedir(), '.cache', 'zmk-workspace')
const REPO = path.resolve(here, '..')
const APP = path.join(here, 'app')
const BUILD_SH = path.join(REPO, 'scripts', 'zmk-build.sh')
const CONFIG = path.join(REPO, 'config')
const KEYMAP = path.join(CONFIG, 'corne.keymap')
const FIRMWARE = path.join(REPO, 'firmware')

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const PORT = Number(opt('--port', process.env.KEYMAP_EDITOR_PORT || 8737))
const HOST = '127.0.0.1'
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm', // instantiateStreaming refuses anything else
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

// --- build state ---------------------------------------------------------------------
const MAX_LOG_LINES = 5000
let build = null // { id, target, pristine, startedAt, finishedAt, exitCode, lines: [] }
let buildSeq = 0
const listeners = new Set()

function emit (event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of listeners) res.write(msg)
}

// Cached briefly: the panel polls /status, and `list` shells out to yq + jq per target.
// Resolves to [{ id, snippet }].
let targetsCache = { at: 0, promise: null }
function listTargetsDetailed () {
  if (targetsCache.promise && Date.now() - targetsCache.at < 10000) return targetsCache.promise
  const promise = new Promise((resolve, reject) => {
    execFile(BUILD_SH, ['list'], { cwd: REPO }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message))
      resolve(stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [id, ...rest] = l.split(/\s+/)
        const m = rest.join(' ').match(/snippet:\s*(\S+)/)
        return { id, snippet: m ? m[1] : '' }
      }))
    })
  })
  promise.catch(() => { targetsCache = { at: 0, promise: null } })
  targetsCache = { at: Date.now(), promise }
  return promise
}
const listTargets = async () => (await listTargetsDetailed()).map(t => t.id)
// Soft flash needs the half whose firmware speaks Studio RPC over USB.
const studioTarget = async () => (await listTargetsDetailed()).find(t => /studio/.test(t.snippet))?.id || null

const sh = (cmd, argv, timeout) => new Promise(resolve =>
  execFile(cmd, argv, { timeout }, err => resolve(!err)))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// zmk-build.sh would otherwise report a stopped daemon as a failed image pull.
// Starts the local engine (OrbStack or Docker Desktop) so the button really is one click.
async function ensureDocker (log) {
  if (await sh('docker', ['info'], 8000)) return true
  if (await sh('orb', ['version'], 5000)) {
    log('==> docker is not running - starting OrbStack')
    await sh('orb', ['start'], 60000)
  } else if (process.platform === 'darwin' && fs.existsSync('/Applications/Docker.app')) {
    log('==> docker is not running - starting Docker Desktop')
    await sh('open', ['-a', 'Docker'], 10000)
  } else {
    log('==> docker is not running - start it and build again')
    return false
  }
  for (let i = 0; i < 45; i++) {
    if (await sh('docker', ['info'], 8000)) { log('==> docker is up'); return true }
    await sleep(2000)
  }
  log('==> docker did not come up within 90s')
  return false
}

// One job at a time: a build, or a build followed by a soft flash. Both share the log.
// kind: 'build' | 'softflash'
function startJob ({ kind, target, pristine = false, force = false, dryRun = false }) {
  const id = ++buildSeq
  build = { id, kind, target, pristine, dryRun, startedAt: Date.now(), finishedAt: null, exitCode: null, lines: [] }
  emit('start', summary())
  const finish = code => {
    build.exitCode = code
    build.finishedAt = Date.now()
    emit('done', summary())
  }
  const push = chunk => {
    // Strip ANSI colours/cursor codes; docker without -t still emits some from west.
    const text = chunk.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    for (const line of text.split(/\r?\n|\r/)) {
      if (!line) continue
      build.lines.push(line)
      if (build.lines.length > MAX_LOG_LINES) build.lines.shift()
      emit('log', { id, line })
    }
  }
  const log = line => push(Buffer.from(line + '\n'))

  const runBuild = () => new Promise(resolve => {
    const argv = ['build', target, ...(pristine ? ['--pristine'] : [])]
    log(`$ scripts/zmk-build.sh ${argv.join(' ')}`)
    const child = spawn(BUILD_SH, argv, {
      cwd: REPO,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', err => log(`failed to start build: ${err.message}`))
    child.on('close', code => resolve(code ?? 1))
  })

  ;(async () => {
    if (!(await ensureDocker(log))) return finish(1)
    const code = await runBuild()
    if (code !== 0 || kind !== 'softflash') return finish(code)
    log(dryRun
      ? '==> soft flash preview: comparing the build with the keyboard (read-only)'
      : '==> soft flash: pushing key bindings to the keyboard over ZMK Studio RPC')
    try {
      await softFlash({
        buildDir: path.join(WORKSPACE, 'build', target),
        baselineDir: path.join(FIRMWARE, '.flashed', target),
        force,
        dryRun,
        log: line => log(line)
      })
      finish(0)
    } catch (e) {
      log(`soft flash failed: ${e.message}`)
      finish(1)
    }
  })().catch(err => { log(`job failed: ${err.message}`); finish(1) })
}

function summary () {
  if (!build) return null
  const { lines, ...rest } = build
  return { ...rest, running: build.finishedAt === null }
}

function firmwareFiles () {
  if (!fs.existsSync(FIRMWARE)) return []
  return fs.readdirSync(FIRMWARE)
    .filter(f => /\.(uf2|bin)$/.test(f))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(FIRMWARE, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
}

// --- http helpers --------------------------------------------------------------------
function send (res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(data)
}

function readBody (req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson (req) {
  const body = await readBody(req, 1e5)
  return body ? JSON.parse(body) : {}
}

const keymapNames = () => fs.readdirSync(CONFIG).filter(f => /^[\w.-]+\.keymap$/.test(f)).sort()

// A page on any other site could otherwise POST to localhost and start builds.
function sameOrigin (req) {
  const origin = req.headers.origin
  if (!origin) return false
  try { return ALLOWED_HOSTS.has(new URL(origin).host) } catch { return false }
}

let cachedIndex = null
function indexHtml () {
  if (!cachedIndex) {
    const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
    // fs-shim must run before the deferred app bundles: the editor decides at module load
    // whether to offer the File System source, based on window.showOpenFilePicker.
    cachedIndex = html
      .replace('<head>', '<head><script src="__local/fs-shim.js"></script>')
      .replace('</head>', '<script defer src="__local/toolbar.js"></script></head>')
    if (!cachedIndex.includes('fs-shim.js') || !cachedIndex.includes('toolbar.js')) {
      throw new Error('could not inject local scripts into editor/app/index.html')
    }
  }
  return cachedIndex
}

function serveStatic (req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') return send(res, 200, indexHtml(), TYPES['.html'])
  const file = path.normalize(path.join(APP, decodeURIComponent(pathname)))
  if (!file.startsWith(APP + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'not found', 'text/plain')
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    // Hashed chunk names never change content; everything else revalidates.
    'Cache-Control': /\.[a-f0-9]{20}\./.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'
  })
  fs.createReadStream(file).pipe(res)
}

// --- routes --------------------------------------------------------------------------
async function handle (req, res) {
  // DNS-rebinding guard: only answer to the names we are actually bound as.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, { error: 'unexpected Host header' })

  const { pathname } = new URL(req.url, `http://${req.headers.host}`)

  if (pathname === '/__local/toolbar.js' || pathname === '/__local/fs-shim.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' })
    return fs.createReadStream(path.join(here, path.basename(pathname))).pipe(res)
  }

  if (pathname === '/__local/status' && req.method === 'GET') {
    let targets = []
    let studio = null
    let targetsError = null
    try { targets = await listTargets(); studio = await studioTarget() } catch (e) { targetsError = e.message }
    const keymapStat = fs.existsSync(KEYMAP) ? fs.statSync(KEYMAP) : null
    const baseline = studio && path.join(FIRMWARE, '.flashed', studio, 'zephyr.dts')
    return send(res, 200, {
      repo: REPO,
      keymap: { path: KEYMAP, mtime: keymapStat ? keymapStat.mtimeMs : null },
      targets,
      targetsError,
      softflash: {
        target: studio,
        // when the left half was last really flashed via zmk-build.sh flash (drift baseline)
        flashedAt: baseline && fs.existsSync(baseline) ? fs.statSync(baseline).mtimeMs : null,
        ports: listPorts()
      },
      build: summary(),
      firmware: firmwareFiles(),
      firmwareDir: FIRMWARE
    })
  }

  if (pathname === '/__local/keymaps' && req.method === 'GET') {
    return send(res, 200, keymapNames())
  }

  const km = pathname.match(/^\/__local\/keymaps\/([^/]+)$/)
  if (km) {
    const name = decodeURIComponent(km[1])
    if (!keymapNames().includes(name)) return send(res, 404, { error: `no config/${name}` })
    const file = path.join(CONFIG, name)
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Mtime': String(fs.statSync(file).mtimeMs)
      })
      return fs.createReadStream(file).pipe(res)
    }
    if (req.method === 'PUT') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' })
      let text
      try { text = await readBody(req, 2e6) } catch (e) { return send(res, 413, { error: e.message }) }
      // Write-then-rename so a build starting mid-save never reads a half-written keymap.
      const tmp = path.join(CONFIG, `.${name}.${process.pid}.tmp`)
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, file)
      console.log(`saved config/${name} (${text.length} bytes)`)
      return send(res, 200, { name, mtime: fs.statSync(file).mtimeMs })
    }
    return send(res, 405, { error: 'method not allowed' })
  }

  if (pathname === '/__local/build/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    // Replay the current/last build so a reload mid-build still shows the whole log.
    if (build) {
      res.write(`event: replay\ndata: ${JSON.stringify({ ...summary(), lines: build.lines })}\n\n`)
    }
    listeners.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 20000)
    req.on('close', () => { clearInterval(ping); listeners.delete(res) })
    return
  }

  if (pathname === '/__local/build' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' })
    if (build && build.finishedAt === null) return send(res, 409, { error: 'a build is already running' })
    let body
    try { body = await readJson(req) } catch { return send(res, 400, { error: 'invalid JSON' }) }
    const target = String(body.target || '')
    let targets
    try { targets = await listTargets() } catch (e) { return send(res, 500, { error: e.message }) }
    if (target !== 'all' && !targets.includes(target)) {
      return send(res, 400, { error: `unknown target '${target}'`, targets })
    }
    startJob({ kind: 'build', target, pristine: Boolean(body.pristine) })
    return send(res, 202, summary())
  }

  if (pathname === '/__local/softflash' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' })
    if (build && build.finishedAt === null) return send(res, 409, { error: 'a build is already running' })
    let body
    try { body = await readJson(req) } catch { return send(res, 400, { error: 'invalid JSON' }) }
    let target
    try { target = await studioTarget() } catch (e) { return send(res, 500, { error: e.message }) }
    if (!target) return send(res, 400, { error: 'no build target has the studio-rpc-usb-uart snippet' })
    startJob({ kind: 'softflash', target, force: Boolean(body.force), dryRun: Boolean(body.dryRun) })
    return send(res, 202, summary())
  }

  if (pathname.startsWith('/__local/')) return send(res, 404, { error: 'no such endpoint' })
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' })
  return serveStatic(req, res, pathname)
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err)
    if (!res.headersSent) send(res, 500, { error: err.message })
    else res.end()
  })
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is busy - is the editor already running? (or pass --port N)`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/`
  console.log(`keymap editor: ${url}`)
  console.log(`  building:    ${REPO}`)
  console.log(`  keymap file: ${KEYMAP}`)
  if (flag('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
  }
})
