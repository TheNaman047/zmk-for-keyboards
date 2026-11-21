// Minimal ZMK Studio RPC client over the USB CDC-ACM serial port, with no npm dependencies.
// Wire format (zmk/app/src/studio/msg_framing.h): 0xAB <payload, 0xAB/0xAC/0xAD escaped by 0xAC> 0xAD.
// Payload is a protobuf zmk.studio.Request / zmk.studio.Response (zmk-studio-messages/proto).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const SOF = 0xab
const ESC = 0xac
const EOF = 0xad

// --- protobuf ------------------------------------------------------------------------
// Arithmetic instead of bitwise ops: params are uint32 (e.g. 0xa07001b) and JS bit ops are int32.
function varint (n) {
  const out = []
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b += 128
    out.push(b)
  } while (n > 0)
  return out
}
const zigzag = n => (n >= 0 ? n * 2 : -n * 2 - 1)
const unzigzag = n => (n % 2 === 0 ? n / 2 : -(n + 1) / 2)

const tag = (no, wt) => varint(no * 8 + wt)
// proto3: zero scalars are left off the wire (canonical, matches the official client).
// None of the scalars built here sit in a oneof, where a zero would have to be explicit.
export const pb = {
  uint: (no, v) => (v === 0 ? [] : [...tag(no, 0), ...varint(v)]),
  sint: (no, v) => (v === 0 ? [] : [...tag(no, 0), ...varint(zigzag(v))]),
  bool: (no, v = true) => [...tag(no, 0), v ? 1 : 0],
  msg: (no, bytes) => [...tag(no, 2), ...varint(bytes.length), ...bytes]
}

// Decodes one message level into { fieldNo: [value, ...] }; length-delimited values stay
// Buffers so the caller decides string vs sub-message.
export function decode (buf) {
  const out = {}
  let i = 0
  const rv = () => {
    let r = 0
    let mul = 1
    let b
    do {
      if (i >= buf.length) throw new Error('truncated varint')
      b = buf[i++]
      r += (b & 0x7f) * mul
      mul *= 128
    } while (b & 0x80)
    return r
  }
  while (i < buf.length) {
    const key = rv()
    const no = Math.floor(key / 8)
    const wt = key % 8
    let v
    if (wt === 0) v = rv()
    else if (wt === 2) { const len = rv(); v = buf.subarray(i, i + len); i += len } else if (wt === 5) { v = buf.readUInt32LE(i); i += 4 } else if (wt === 1) { v = buf.readBigUInt64LE(i); i += 8 } else throw new Error(`unsupported wire type ${wt}`)
    ;(out[no] ||= []).push(v)
  }
  return out
}
const first = (m, no, dflt) => (m[no] ? m[no][0] : dflt)
const str = (m, no) => (m[no] ? m[no][0].toString('utf8') : '')

// --- framing -------------------------------------------------------------------------
export function frame (bytes) {
  const out = [SOF]
  for (const b of bytes) {
    if (b === SOF || b === ESC || b === EOF) out.push(ESC)
    out.push(b)
  }
  out.push(EOF)
  return Buffer.from(out)
}

export class Deframer {
  constructor () { this.state = 'idle'; this.cur = [] }
  push (chunk, onFrame) {
    for (const b of chunk) {
      if (this.state === 'idle') { if (b === SOF) { this.state = 'data'; this.cur = [] } continue }
      if (this.state === 'esc') { this.cur.push(b); this.state = 'data'; continue }
      if (b === ESC) this.state = 'esc'
      else if (b === EOF) { this.state = 'idle'; onFrame(Buffer.from(this.cur)) } else if (b === SOF) this.cur = [] // resync
      else this.cur.push(b)
    }
  }
}

// --- request builders (zmk.studio.Request: request_id=1, core=3, behaviors=4, keymap=5) -----
export const req = {
  deviceInfo: () => pb.msg(3, pb.bool(1)),
  lockState: () => pb.msg(3, pb.bool(2)),
  listBehaviors: () => pb.msg(4, pb.bool(1)),
  behaviorDetails: id => pb.msg(4, pb.msg(2, pb.uint(1, id))),
  getKeymap: () => pb.msg(5, pb.bool(1)),
  setBinding: (layerId, position, b) => pb.msg(5, pb.msg(2, [
    ...pb.uint(1, layerId),
    ...pb.uint(2, position), // int32, non-negative here, so plain varint
    ...pb.msg(3, [...pb.sint(1, b.behaviorId), ...pb.uint(2, b.param1), ...pb.uint(3, b.param2)])
  ])),
  checkUnsaved: () => pb.msg(5, pb.bool(3)),
  save: () => pb.msg(5, pb.bool(4)),
  discard: () => pb.msg(5, pb.bool(5))
}

const META_ERRORS = ['GENERIC', 'UNLOCK_REQUIRED', 'RPC_NOT_FOUND', 'MSG_DECODE_FAILED', 'MSG_ENCODE_FAILED']
const SET_BINDING = ['OK', 'INVALID_LOCATION', 'INVALID_BEHAVIOR', 'INVALID_PARAMETERS']
const SAVE_ERRORS = ['OK', 'GENERIC', 'NOT_SUPPORTED', 'NO_SPACE']

export class StudioError extends Error {}

// --- serial transport ----------------------------------------------------------------
export function listPorts () {
  if (process.platform === 'darwin') {
    return fs.readdirSync('/dev').filter(f => f.startsWith('cu.usbmodem')).map(f => `/dev/${f}`)
  }
  return fs.readdirSync('/dev').filter(f => /^ttyACM\d+$/.test(f)).map(f => `/dev/${f}`)
}

// Two readers on one tty split its bytes unpredictably: whoever else has it open (usually
// the ZMK Studio app) would eat our responses. Names the holder so the user knows what to close.
export function portHolders (port) {
  try {
    const out = execFileSync('lsof', ['-F', 'pc', port], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const procs = []
    let pid
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1)
      else if (line.startsWith('c')) procs.push({ pid: Number(pid), command: line.slice(1) })
    }
    return procs.filter(p => p.pid !== process.pid)
  } catch {
    return [] // lsof exits 1 when nobody has it open
  }
}

export class StudioConnection {
  constructor (port) {
    this.port = port
    this.nextId = 1
    this.pending = new Map()
    this.deframer = new Deframer()
    this.closed = false
  }

  open () {
    const { O_RDWR, O_NOCTTY, O_NONBLOCK } = fs.constants
    this.fd = fs.openSync(this.port, O_RDWR | O_NOCTTY | O_NONBLOCK)
    // Raw mode: no echo, no CR/LF translation - the frames are binary.
    const flag = process.platform === 'darwin' ? '-f' : '-F'
    execFileSync('stty', [flag, this.port, 'raw', '-echo'], { stdio: 'ignore' })
    this.buf = Buffer.alloc(4096)
    this.timer = setInterval(() => this.poll(), 10)
    return this
  }

  poll () {
    for (;;) {
      let n
      try {
        n = fs.readSync(this.fd, this.buf, 0, this.buf.length, null)
      } catch (e) {
        if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') return
        this.fail(new StudioError(`serial read failed: ${e.message}`))
        return
      }
      if (!n) return
      this.deframer.push(this.buf.subarray(0, n), f => this.onFrame(f))
    }
  }

  onFrame (bytes) {
    let resp
    try { resp = decode(bytes) } catch { return }
    if (!resp[1]) return // notification (field 2) - not needed here
    const rr = decode(resp[1][0])
    const id = first(rr, 1, 0)
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timeout)
    if (rr[2]) {
      const meta = decode(rr[2][0])
      if (meta[2]) return p.reject(new StudioError(`keyboard returned ${META_ERRORS[meta[2][0]] || meta[2][0]}`))
      return p.reject(new StudioError('keyboard returned no response'))
    }
    for (const sub of [3, 4, 5]) if (rr[sub]) return p.resolve(decode(rr[sub][0]))
    p.reject(new StudioError('empty response'))
  }

  fail (err) {
    for (const p of this.pending.values()) { clearTimeout(p.timeout); p.reject(err) }
    this.pending.clear()
  }

  call (body, timeoutMs = 3000) {
    if (this.closed) return Promise.reject(new StudioError('connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new StudioError(`keyboard did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      try {
        fs.writeSync(this.fd, frame([...pb.uint(1, id), ...body]))
      } catch (e) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new StudioError(`serial write failed: ${e.message}`))
      }
    })
  }

  close () {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.fail(new StudioError('connection closed'))
    try { fs.closeSync(this.fd) } catch {}
  }

  // --- typed calls ---
  async deviceInfo () {
    const core = await this.call(req.deviceInfo(), 1500)
    const info = decode(first(core, 1, Buffer.alloc(0)))
    return { name: str(info, 1), serial: first(info, 2, Buffer.alloc(0)).toString('hex') }
  }

  async lockState () {
    const core = await this.call(req.lockState())
    return first(core, 2, 0) === 1 ? 'unlocked' : 'locked'
  }

  async behaviors () {
    const list = decode(first(await this.call(req.listBehaviors()), 1, Buffer.alloc(0)))
    const ids = []
    for (const v of list[1] || []) {
      // repeated uint32 may arrive packed (one buffer) or unpacked (one varint each)
      if (Buffer.isBuffer(v)) {
        let i = 0
        while (i < v.length) { let r = 0; let mul = 1; let b; do { b = v[i++]; r += (b & 0x7f) * mul; mul *= 128 } while (b & 0x80); ids.push(r) }
      } else ids.push(v)
    }
    const out = []
    for (const id of ids) {
      const d = decode(first(await this.call(req.behaviorDetails(id)), 2, Buffer.alloc(0)))
      out.push({ id: first(d, 1, id), name: str(d, 2) })
    }
    return out
  }

  async keymap () {
    const km = decode(first(await this.call(req.getKeymap()), 1, Buffer.alloc(0)))
    return {
      availableLayers: first(km, 2, 0),
      layers: (km[1] || []).map(buf => {
        const l = decode(buf)
        return {
          id: first(l, 1, 0),
          name: str(l, 2),
          bindings: (l[3] || []).map(bb => {
            const b = decode(bb)
            return { behaviorId: unzigzag(first(b, 1, 0)), param1: first(b, 2, 0), param2: first(b, 3, 0) }
          })
        }
      })
    }
  }

  async setBinding (layerId, position, binding) {
    const r = first(await this.call(req.setBinding(layerId, position, binding)), 2, 0)
    if (r !== 0) throw new StudioError(`set binding rejected: ${SET_BINDING[r] || r}`)
  }

  async save () {
    const r = decode(first(await this.call(req.save(), 5000), 4, Buffer.alloc(0)))
    if (r[2]) throw new StudioError(`save failed: ${SAVE_ERRORS[r[2][0]] || r[2][0]}`)
  }

  async discard () { await this.call(req.discard()) }
}

// Finds the keyboard's Studio port: the first USB modem that answers get_device_info.
export async function connect ({ log = () => {}, expectName } = {}) {
  const ports = listPorts()
  if (!ports.length) {
    throw new StudioError('no USB serial port found - plug the LEFT half in over USB (Studio RPC is only on the central half)')
  }
  const problems = []
  for (const port of ports) {
    const holders = portHolders(port)
    if (holders.length) {
      problems.push(`${port} is in use by ${holders.map(h => `${h.command} (pid ${h.pid})`).join(', ')}`)
      continue
    }
    const conn = new StudioConnection(port)
    try {
      conn.open()
      const info = await conn.deviceInfo()
      if (expectName && info.name !== expectName) {
        problems.push(`${port} is "${info.name}", not "${expectName}"`)
        conn.close()
        continue
      }
      log(`connected to "${info.name}" on ${port}`)
      return { conn, info }
    } catch (e) {
      conn.close()
      problems.push(`${port}: ${e.message}`)
    }
  }
  const studioOpen = problems.some(p => /zmk-studio|ZMK Studio/i.test(p))
  throw new StudioError(
    `could not reach the keyboard: ${problems.join('; ')}` +
    (studioOpen ? ' - quit the ZMK Studio app (it holds the port) and try again' : '')
  )
}
