// Replaces the browser File System Access API for the editor's "File System" source with
// handles backed by editor/server.mjs, which only reads and writes this checkout's
// config/*.keymap. Two reasons:
//   - Brave (and Firefox/Safari) ship without showOpenFilePicker, which hides the source.
//   - The Build button compiles this checkout, so the editor must edit exactly that file -
//     a native picker would happily open a keymap from some other clone.
(() => {
  const API = '__local/keymaps'
  const MARK = '__localKeymapHandle'
  const notify = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }))

  class LocalKeymapHandle {
    constructor (name) {
      this.kind = 'file'
      this.name = name
      this[MARK] = true // survives IndexedDB's structured clone; methods do not
    }

    async queryPermission () { return 'granted' }
    async requestPermission () { return 'granted' }
    async isSameEntry (other) { return Boolean(other && other[MARK] && other.name === this.name) }

    async getFile () {
      const res = await fetch(`${API}/${encodeURIComponent(this.name)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`could not read config/${this.name}: ${res.status}`)
      const text = await res.text()
      return new File([text], this.name, {
        type: 'text/plain',
        lastModified: Number(res.headers.get('X-Mtime')) || Date.now()
      })
    }

    async createWritable () {
      const name = this.name
      const parts = []
      return {
        async write (data) {
          if (data && typeof data === 'object' && 'type' in data && !(data instanceof Blob)) {
            if (data.type !== 'write') throw new Error(`unsupported write op ${data.type}`)
            data = data.data
          }
          parts.push(data instanceof Blob ? await data.text() : String(data))
        },
        // The editor fires close() without awaiting it, so failures are surfaced as
        // events for the build panel instead of being lost.
        async close () {
          try {
            const res = await fetch(`${API}/${encodeURIComponent(name)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
              body: parts.join('')
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
            notify('local-keymap-saved', body)
          } catch (err) {
            notify('local-keymap-save-failed', { name, error: err.message })
            throw err
          }
        },
        async abort () { parts.length = 0 }
      }
    }
  }

  window.showOpenFilePicker = async () => {
    const res = await fetch(API, { cache: 'no-store' })
    const names = await res.json()
    if (!names.length) throw new DOMException('no config/*.keymap in this checkout', 'AbortError')
    return names.map(n => new LocalKeymapHandle(n))
  }

  // The editor persists its handles with idb-keyval. A structured clone keeps only own
  // data properties, so restore the prototype on the way back out.
  const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result')
  const revive = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 4) return value
    if (Array.isArray(value)) { value.forEach(v => revive(v, depth + 1)); return value }
    if (Object.getPrototypeOf(value) !== Object.prototype) return value
    if (value[MARK] === true) return Object.setPrototypeOf(value, LocalKeymapHandle.prototype)
    for (const k of Object.keys(value)) revive(value[k], depth + 1)
    return value
  }
  Object.defineProperty(IDBRequest.prototype, 'result', {
    ...desc,
    get () { return revive(desc.get.call(this), 0) }
  })
})()
