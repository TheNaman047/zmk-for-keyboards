// "Soft flash": push the keymap's bindings to the running keyboard over ZMK Studio RPC and
// save them to its settings, instead of reflashing.
//
// Source of truth is the *built* zephyr.dts, not config/*.keymap: dtc has already run the
// preprocessor and every binding is numeric (&kp 0x7002b), so nothing here re-implements
// the C preprocessor or ZMK's keycode headers.
//
// Only key bindings can be changed this way. Combos, macros, hold-tap settings, new
// behaviors, layer count and .conf options live in firmware, so they need a real flash.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { connect, StudioError } from './studio-rpc.mjs'

// --- zephyr.dts parsing --------------------------------------------------------------
export function parseDts (text) {
  const root = { name: '/', labels: [], props: {}, children: [] }
  const stack = [root]
  let pending = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('/dts-v1/') || line.startsWith('//')) continue
    if (pending) {
      pending += ' ' + line
      if (!line.endsWith(';')) continue
    } else {
      const open = line.match(/^((?:[\w-]+:\s*)*)([^\s{}]+)\s*\{$/)
      if (open) {
        const node = {
          name: open[2],
          labels: open[1].split(':').map(s => s.trim()).filter(Boolean),
          props: {},
          children: []
        }
        stack[stack.length - 1].children.push(node)
        stack.push(node)
        continue
      }
      if (line === '};') { stack.pop(); continue }
      if (!line.endsWith(';')) { pending = line; continue }
      pending = line
    }
    const prop = pending.match(/^([^\s=]+)\s*(?:=\s*([\s\S]*))?;$/)
    pending = ''
    if (prop) stack[stack.length - 1].props[prop[1]] = prop[2] === undefined ? true : prop[2].trim()
  }
  if (stack.length !== 1) throw new Error('unbalanced braces in zephyr.dts')
  return root.children.length === 1 && root.children[0].name === '/' ? root.children[0] : root
}

const walk = (node, fn) => { fn(node); node.children.forEach(c => walk(c, fn)) }
const unquote = v => (typeof v === 'string' && /^".*"$/.test(v) ? v.slice(1, -1) : null)
const cellsOf = v => {
  const m = typeof v === 'string' && v.match(/<\s*(0x[0-9a-f]+|\d+)\s*>/i)
  return m ? Number(m[1]) : null
}

// Behavior name as the firmware reports it: display-name, else the Zephyr device name,
// which is the `label` property, else the node name (DEVICE_DT_NAME in zephyr/device.h).
export function behaviorsByLabel (tree) {
  const map = new Map()
  walk(tree, node => {
    const cells = cellsOf(node.props['#binding-cells'])
    if (cells === null) return
    const deviceName = unquote(node.props.label) || node.name
    const displayName = unquote(node.props['display-name']) || deviceName
    for (const label of node.labels) map.set(label, { label, cells, deviceName, displayName })
  })
  return map
}

function parseBindings (value, behaviors, where) {
  const tokens = value.replace(/[<>,]/g, ' ').split(/\s+/).filter(Boolean)
  const out = []
  for (let i = 0; i < tokens.length;) {
    const t = tokens[i]
    if (!t.startsWith('&')) throw new Error(`${where}: expected a behavior reference, got "${t}"`)
    const label = t.slice(1)
    const b = behaviors.get(label)
    if (!b) throw new Error(`${where}: unknown behavior &${label}`)
    const params = tokens.slice(i + 1, i + 1 + b.cells).map(p => Number(p.replace(/[()]/g, '')))
    if (params.length !== b.cells || params.some(Number.isNaN)) {
      throw new Error(`${where}: &${label} needs ${b.cells} numeric parameter(s)`)
    }
    out.push({ label, param1: params[0] || 0, param2: params[1] || 0 })
    i += 1 + b.cells
  }
  return out
}

export function keymapFromDts (text) {
  const tree = parseDts(text)
  const behaviors = behaviorsByLabel(tree)
  let keymap = null
  walk(tree, n => { if (unquote(n.props.compatible) === 'zmk,keymap') keymap = n })
  if (!keymap) throw new Error('no zmk,keymap node in zephyr.dts')
  const layers = keymap.children
    .filter(l => l.props.bindings)
    .map(l => ({
      node: l.name,
      name: unquote(l.props['display-name']) || unquote(l.props.label) || l.name,
      bindings: parseBindings(l.props.bindings, behaviors, `layer ${l.name}`)
    }))
  return { tree, behaviors, layers }
}

// Fingerprint of everything a soft flash can NOT change, per top-level section. Keymap
// layer bindings are excluded (that is what soft flash applies). So are phandles: dtc only
// emits one for referenced nodes, so binding a behavior for the first time would otherwise
// look like a behavior change.
export function firmwareSections (dtsText, configText) {
  const tree = parseDts(dtsText)
  const ser = (node, inKeymap) => {
    const keymapNode = inKeymap || unquote(node.props.compatible) === 'zmk,keymap'
    const props = Object.keys(node.props).sort()
      .filter(k => k !== 'phandle' && !(inKeymap && k === 'bindings'))
      .map(k => `${k}=${node.props[k]}`)
    return `${node.labels.join(',')}:${node.name}{${props.join(';')}|${node.children.map(c => ser(c, keymapNode)).join('')}}`
  }
  const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
  const sections = {}
  for (const child of tree.children) sections[child.name] = hash(ser(child, false))
  if (configText !== undefined) {
    sections['.config'] = hash(configText.split('\n').filter(l => l && !l.startsWith('#')).sort().join('\n'))
  }
  return sections
}

const describe = (b, nameById) => {
  const name = nameById.get(b.behaviorId) || `behavior#${b.behaviorId}`
  const hex = v => '0x' + v.toString(16)
  return [name, b.param1 ? hex(b.param1) : null, b.param2 ? hex(b.param2) : null].filter(Boolean).join(' ')
}

// --- main entry ----------------------------------------------------------------------
// opts: { buildDir, baselineDir?, force?, dryRun?, log, connectFn? (tests inject a fake keyboard) }
export async function softFlash ({ buildDir, baselineDir, force = false, dryRun = false, log = console.log, connectFn = connect }) {
  const dtsPath = path.join(buildDir, 'zephyr', 'zephyr.dts')
  const configPath = path.join(buildDir, 'zephyr', '.config')
  if (!fs.existsSync(dtsPath)) throw new StudioError(`no ${dtsPath} - build the left half first`)
  const dtsText = fs.readFileSync(dtsPath, 'utf8')
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined

  const want = keymapFromDts(dtsText)
  log(`keymap from build: ${want.layers.length} layers x ${want.layers[0]?.bindings.length ?? 0} keys`)

  // 1. Refuse (unless forced) when the build differs from what was last flashed in ways
  //    a soft flash cannot apply - otherwise those edits would silently not take effect.
  const baseDts = baselineDir && path.join(baselineDir, 'zephyr.dts')
  if (baseDts && fs.existsSync(baseDts)) {
    const baseConfigPath = path.join(baselineDir, '.config')
    const before = firmwareSections(fs.readFileSync(baseDts, 'utf8'),
      fs.existsSync(baseConfigPath) ? fs.readFileSync(baseConfigPath, 'utf8') : undefined)
    const now = firmwareSections(dtsText, configText)
    const changed = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(k => before[k] !== now[k])
    if (changed.length) {
      const msg = `firmware-level changes since the last real flash (${changed.join(', ')}) - ` +
        'combos, macros, behavior settings, layer count and .conf need a real flash'
      if (!force) throw new StudioError(msg)
      log(`WARNING: ${msg}; applying key bindings only`)
    }
  } else {
    log('note: no record of the last real flash, so combo/macro/.conf drift cannot be checked - ' +
      'flash once with `zmk-build.sh flash` to record one')
  }

  // 2. Talk to the keyboard.
  const { conn, info } = await connectFn({ log })
  try {
    if ((await conn.lockState()) !== 'unlocked') {
      throw new StudioError('keyboard is locked for Studio - press its &studio_unlock key (or set CONFIG_ZMK_STUDIO_LOCKING=n)')
    }

    const devBehaviors = await conn.behaviors()
    const idByName = new Map()
    const dupes = new Set()
    for (const b of devBehaviors) {
      if (idByName.has(b.name)) dupes.add(b.name)
      idByName.set(b.name, b.id)
    }
    const nameById = new Map()
    for (const b of want.behaviors.values()) {
      const id = idByName.get(b.displayName)
      if (id !== undefined) nameById.set(id, `&${b.label}`)
    }

    const resolve = label => {
      const b = want.behaviors.get(label)
      if (dupes.has(b.displayName)) throw new StudioError(`two behaviors on the keyboard are named "${b.displayName}" - cannot tell which is &${label}`)
      const id = idByName.get(b.displayName)
      if (id === undefined) {
        throw new StudioError(`&${label} ("${b.displayName}") is not in the firmware on the keyboard - new behaviors need a real flash`)
      }
      return id
    }

    const have = await conn.keymap()
    if (have.layers.length !== want.layers.length) {
      throw new StudioError(`keyboard has ${have.layers.length} layers, the build has ${want.layers.length} - layer changes need a real flash ` +
        '(or Studio added/removed layers: use Restore Stock Settings)')
    }
    have.layers.forEach((l, i) => {
      if (l.id !== i) {
        throw new StudioError('layers were reordered in ZMK Studio - use Restore Stock Settings in Studio first')
      }
      if (l.bindings.length !== want.layers[i].bindings.length) {
        throw new StudioError(`layer ${i} has ${l.bindings.length} keys on the keyboard but ${want.layers[i].bindings.length} in the build`)
      }
    })

    // 3. Diff.
    const changes = []
    want.layers.forEach((layer, li) => {
      layer.bindings.forEach((b, pos) => {
        const target = { behaviorId: resolve(b.label), param1: b.param1, param2: b.param2 }
        const cur = have.layers[li].bindings[pos]
        if (cur.behaviorId !== target.behaviorId || cur.param1 !== target.param1 || cur.param2 !== target.param2) {
          changes.push({ layerId: have.layers[li].id, layerName: layer.name, position: pos, from: cur, to: target })
        }
      })
    })

    if (!changes.length) {
      log(`"${info.name}" already matches the build - nothing to send`)
      return { info, changes }
    }
    for (const c of changes) {
      log(`  layer ${c.layerName} key ${c.position}: ${describe(c.from, nameById)} -> ${describe(c.to, nameById)}`)
    }
    if (dryRun) {
      log(`dry run: ${changes.length} key(s) would change`)
      return { info, changes }
    }

    // 4. Apply, then persist. Any rejection rolls back the unsaved changes on the keyboard.
    try {
      for (const c of changes) await conn.setBinding(c.layerId, c.position, c.to)
      await conn.save()
    } catch (e) {
      log(`error: ${e.message} - discarding unsaved changes on the keyboard`)
      try { await conn.discard() } catch {}
      throw e
    }
    log(`soft flashed ${changes.length} key(s) to "${info.name}" and saved them on the keyboard`)
    return { info, changes }
  } finally {
    conn.close()
  }
}
