// Build panel injected into the vendored keymap editor by editor/server.mjs.
// Lives in a shadow root so neither side's CSS leaks into the other.
(() => {
  const API = '__local'
  const LS_TARGET = 'local-build:target'
  const LS_OPEN = 'local-build:open'
  const store = {
    get: k => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch {} }
  }

  const host = document.createElement('div')
  host.id = 'local-build-panel'
  document.body.appendChild(host)
  const root = host.attachShadow({ mode: 'open' })

  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap {
    --bg: #ffffff; --fg: #1d2330; --muted: #6b7280; --line: #d9dde5; --code-bg: #f4f6f9;
    --accent: #2563eb; --ok: #15803d; --bad: #b91c1c; --warn: #b45309;
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg);
  }
  @media (prefers-color-scheme: dark) {
    .wrap { --bg: #1b1f27; --fg: #e5e7eb; --muted: #9ca3af; --line: #343a46; --code-bg: #12151b;
            --accent: #60a5fa; --ok: #4ade80; --bad: #f87171; --warn: #fbbf24; }
  }
  button { font: inherit; cursor: pointer; }
  .fab {
    display: flex; align-items: center; gap: 8px; margin-left: auto;
    padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); box-shadow: 0 4px 14px rgba(0,0,0,.18);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
  .dot.running { background: var(--accent); animation: pulse 1s infinite alternate; }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
  @keyframes pulse { to { opacity: .35; } }
  .panel {
    width: min(560px, calc(100vw - 32px)); margin-bottom: 10px; padding: 14px;
    background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0,0,0,.25); display: none;
  }
  .panel.open { display: block; }
  h2 { font-size: 14px; margin: 0 0 8px; display: flex; justify-content: space-between; align-items: center; }
  .x { border: 0; background: none; color: var(--muted); font-size: 18px; line-height: 1; padding: 0 4px; }
  .meta { color: var(--muted); font-size: 12px; margin: 0 0 10px; word-break: break-all; }
  .meta b { color: var(--fg); font-weight: 600; }
  .warn { color: var(--warn); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line);
           background: var(--bg); color: var(--fg); flex: 1 1 220px; min-width: 0; }
  label { color: var(--muted); display: flex; gap: 4px; align-items: center; }
  .go { padding: 7px 16px; border-radius: 6px; border: 0; background: var(--accent); color: #fff; font-weight: 600; }
  .go:disabled { opacity: .5; cursor: default; }
  .status { font-weight: 600; margin-bottom: 6px; }
  .status.ok { color: var(--ok); } .status.bad { color: var(--bad); } .status.running { color: var(--accent); }
  pre { margin: 0; height: 240px; overflow: auto; background: var(--code-bg); border: 1px solid var(--line);
        border-radius: 6px; padding: 8px; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap; word-break: break-all; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; font-size: 12px; color: var(--muted); }
  li { display: flex; justify-content: space-between; gap: 8px; }
  li span:first-child { color: var(--fg); font-family: ui-monospace, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; }
  kbd { font: 11px ui-monospace, Menlo, monospace; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
</style>
<div class="wrap">
  <div class="panel" part="panel">
    <h2>Firmware build <button class="x" title="Close" aria-label="Close">×</button></h2>
    <p class="meta keymap"></p>
    <div class="row">
      <select class="target" aria-label="Build target"></select>
      <label title="Clean rebuild - needed after editing .conf, shield files or west.yml">
        <input type="checkbox" class="pristine"> pristine
      </label>
      <label title="Start a build of the selected target every time the editor saves the keymap">
        <input type="checkbox" class="autobuild"> build on save
      </label>
      <button class="go">Build</button>
    </div>
    <div class="saved meta"></div>
    <div class="status"></div>
    <pre class="log" aria-live="polite"></pre>
    <ul class="fw"></ul>
  </div>
  <button class="fab" title="Firmware build (⌘/Ctrl+Shift+B)"><span class="dot"></span><span class="fab-label">Build</span></button>
</div>`

  const $ = s => root.querySelector(s)
  const panel = $('.panel'); const fab = $('.fab'); const dot = $('.dot'); const fabLabel = $('.fab-label')
  const targetSel = $('.target'); const pristine = $('.pristine'); const go = $('.go')
  const statusEl = $('.status'); const logEl = $('.log'); const fwEl = $('.fw'); const keymapEl = $('.keymap')
  const autobuild = $('.autobuild'); const savedEl = $('.saved')
  const LS_AUTO = 'local-build:autobuild'

  let state = null // last /status
  let current = null // build summary

  autobuild.checked = store.get(LS_AUTO) === '1'
  autobuild.addEventListener('change', () => store.set(LS_AUTO, autobuild.checked ? '1' : '0'))

  // Raised by fs-shim.js when the editor's Save reaches (or fails to reach) the disk.
  window.addEventListener('local-keymap-saved', e => {
    savedEl.className = 'saved meta'
    savedEl.textContent = `Saved config/${e.detail.name} at ${new Date(e.detail.mtime).toLocaleTimeString()}`
    if (autobuild.checked) {
      setOpen(true)
      if (current && current.running) savedEl.textContent += ' - a build is already running; build again when it finishes'
      else startBuild()
    } else {
      refresh()
    }
  })
  window.addEventListener('local-keymap-save-failed', e => {
    setOpen(true)
    savedEl.className = 'saved meta warn'
    savedEl.textContent = `Saving config/${e.detail.name} FAILED: ${e.detail.error}`
  })

  const ago = ms => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return new Date(ms).toLocaleString()
  }
  const dur = (a, b) => `${Math.round(((b || Date.now()) - a) / 1000)}s`

  function setOpen (open) {
    panel.classList.toggle('open', open)
    store.set(LS_OPEN, open ? '1' : '0')
    if (open) refresh()
  }
  fab.addEventListener('click', () => setOpen(!panel.classList.contains('open')))
  $('.x').addEventListener('click', () => setOpen(false))

  function appendLog (line) {
    const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20
    logEl.textContent += line + '\n'
    if (stick) logEl.scrollTop = logEl.scrollHeight
  }

  function render () {
    const running = current && current.running
    go.disabled = Boolean(running) || !state || !state.targets.length
    dot.className = 'dot ' + (running ? 'running' : current ? (current.exitCode === 0 ? 'ok' : 'bad') : '')
    fabLabel.textContent = running ? `Building ${dur(current.startedAt)}` : 'Build'

    if (!current) {
      statusEl.className = 'status'
      statusEl.textContent = 'No build yet this session.'
    } else if (running) {
      statusEl.className = 'status running'
      statusEl.textContent = `Building ${current.target}${current.pristine ? ' (pristine)' : ''} - ${dur(current.startedAt)}`
    } else if (current.exitCode === 0) {
      statusEl.className = 'status ok'
      statusEl.textContent = `Built ${current.target} in ${dur(current.startedAt, current.finishedAt)} - ${ago(current.finishedAt)}`
    } else {
      statusEl.className = 'status bad'
      statusEl.textContent = `Build of ${current.target} failed (exit ${current.exitCode}) - see log`
    }

    if (!state) return
    const km = state.keymap
    const target = targetSel.value
    const fw = state.firmware.find(f => target !== 'all' && f.name.startsWith(target))
    const stale = km.mtime && fw && km.mtime > fw.mtime
    keymapEl.innerHTML = ''
    keymapEl.append('Builds ', Object.assign(document.createElement('b'), { textContent: km.path }),
      km.mtime ? ` - last written ${ago(km.mtime)}. ` : ' - missing! ',
      'Unsaved edits in the editor are not built - Save first.')
    if (stale) {
      keymapEl.append(Object.assign(document.createElement('span'), {
        className: 'warn', textContent: ' Keymap changed since this target was last built.'
      }))
    }
    if (state.targetsError) {
      statusEl.className = 'status bad'
      statusEl.textContent = `Cannot read build targets: ${state.targetsError}`
    }

    fwEl.innerHTML = ''
    for (const f of state.firmware) {
      const li = document.createElement('li')
      li.append(Object.assign(document.createElement('span'), { textContent: f.name, title: `${state.firmwareDir}/${f.name}` }),
        Object.assign(document.createElement('span'), { textContent: ago(f.mtime) }))
      fwEl.append(li)
    }
  }

  async function refresh () {
    try {
      const res = await fetch(`${API}/status`, { cache: 'no-store' })
      state = await res.json()
    } catch (e) {
      statusEl.className = 'status bad'
      statusEl.textContent = 'Local server not reachable - is `node editor/server.mjs` running?'
      return
    }
    const want = targetSel.value || store.get(LS_TARGET)
    const opts = [...state.targets, 'all']
    if (targetSel.options.length !== opts.length) {
      targetSel.innerHTML = ''
      for (const t of opts) targetSel.append(new Option(t === 'all' ? 'all targets' : t, t))
    }
    targetSel.value = opts.includes(want) ? want : (state.targets.find(t => t.includes('left')) || opts[0])
    if (!current && state.build) current = state.build
    render()
  }
  targetSel.addEventListener('change', () => { store.set(LS_TARGET, targetSel.value); render() })

  async function startBuild () {
    if (go.disabled) return
    go.disabled = true
    logEl.textContent = ''
    try {
      const res = await fetch(`${API}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: targetSel.value, pristine: pristine.checked })
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || res.statusText)
      current = body
    } catch (e) {
      appendLog(`! ${e.message}`)
    }
    render()
  }
  go.addEventListener('click', startBuild)
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      setOpen(true)
      startBuild()
    }
  })

  // Live log. EventSource reconnects on its own if the server restarts.
  const es = new EventSource(`${API}/build/events`)
  es.addEventListener('replay', e => {
    const d = JSON.parse(e.data)
    logEl.textContent = d.lines.join('\n') + (d.lines.length ? '\n' : '')
    logEl.scrollTop = logEl.scrollHeight
    const { lines, ...rest } = d
    current = rest
    render()
  })
  es.addEventListener('start', e => { current = JSON.parse(e.data); logEl.textContent = ''; render() })
  es.addEventListener('log', e => appendLog(JSON.parse(e.data).line))
  es.addEventListener('done', e => {
    current = JSON.parse(e.data)
    render()
    refresh()
    if (current.exitCode !== 0) setOpen(true)
  })

  setInterval(() => {
    if (current && current.running) render()
  }, 1000)
  setInterval(() => { if (panel.classList.contains('open')) refresh() }, 4000)

  if (store.get(LS_OPEN) === '1') setOpen(true)
  else refresh()
})()
