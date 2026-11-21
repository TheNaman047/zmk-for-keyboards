// node --test editor/test/
import assert from 'node:assert/strict'
import test from 'node:test'
import { decode, frame, Deframer, pb, req } from '../studio-rpc.mjs'
import { keymapFromDts, firmwareSections, parseDts } from '../softflash.mjs'

const DTS = `/dts-v1/;

/ {
	behaviors {
		kp: key_press {
			compatible = "zmk,behavior-key-press";
			#binding-cells = < 0x1 >;
			display-name = "Key Press";
			phandle = < 0x12 >;
		};
		none: none {
			compatible = "zmk,behavior-none";
			#binding-cells = < 0x0 >;
			display-name = "None";
		};
		to: to_layer {
			compatible = "zmk,behavior-to-layer";
			#binding-cells = < 0x1 >;
			display-name = "To Layer";
		};
		hm: homerow_mods {
			compatible = "zmk,behavior-hold-tap";
			label = "HOMEROW_MODS";
			#binding-cells = < 0x2 >;
			bindings = < &kp >, < &kp >;
		};
		ltq: ltq {
			compatible = "zmk,behavior-hold-tap";
			#binding-cells = < 0x2 >;
			bindings = < &kp >, < &kp >;
		};
	};
	combos {
		compatible = "zmk,combos";
		left_bkt {
			bindings = < &kp 0x7002f >;
			key-positions = < 0x4 0x3 >;
		};
	};
	keymap {
		compatible = "zmk,keymap";
		L0 {
			bindings = < &none &kp 0x70014 &hm 0x700e2 0x70007 &to 0x1 >;
			label = "0";
		};
		L1 {
			bindings = < &kp 0xa07001b &none &none &to 0x0 >;
			display-name = "Sym";
		};
	};
};
`

test('parses behaviors with Zephyr device-name rules', () => {
  const { behaviors } = keymapFromDts(DTS)
  assert.equal(behaviors.get('kp').displayName, 'Key Press')
  assert.equal(behaviors.get('hm').displayName, 'HOMEROW_MODS') // label prop wins over node name
  assert.equal(behaviors.get('ltq').displayName, 'ltq') // falls back to node name
  assert.equal(behaviors.get('hm').cells, 2)
})

test('splits layer bindings by #binding-cells', () => {
  const { layers } = keymapFromDts(DTS)
  assert.equal(layers.length, 2)
  assert.deepEqual(layers[0].bindings, [
    { label: 'none', param1: 0, param2: 0 },
    { label: 'kp', param1: 0x70014, param2: 0 },
    { label: 'hm', param1: 0x700e2, param2: 0x70007 },
    { label: 'to', param1: 1, param2: 0 }
  ])
  assert.equal(layers[0].name, '0')
  assert.equal(layers[1].name, 'Sym')
  assert.equal(layers[1].bindings[0].param1, 0xa07001b) // > int32 range-safe
})

test('binding-only edits do not change firmware sections; others do', () => {
  const base = firmwareSections(DTS, 'CONFIG_A=y\n')
  const bindingEdit = DTS.replace('&kp 0x70014', '&kp 0x7002b')
  assert.deepEqual(firmwareSections(bindingEdit, 'CONFIG_A=y\n'), base)

  // first use of a behavior gives it a phandle - must not count as a change
  assert.deepEqual(firmwareSections(DTS.replace('display-name = "To Layer";', 'display-name = "To Layer";\n\t\t\tphandle = < 0x30 >;'), 'CONFIG_A=y\n'), base)

  const combo = firmwareSections(DTS.replace('< 0x4 0x3 >', '< 0x4 0x5 >'), 'CONFIG_A=y\n')
  assert.notEqual(combo.combos, base.combos)
  assert.equal(combo.keymap, base.keymap)

  const conf = firmwareSections(DTS, 'CONFIG_A=n\n')
  assert.notEqual(conf['.config'], base['.config'])

  const layerName = firmwareSections(DTS.replace('label = "0";', 'label = "base";'), 'CONFIG_A=y\n')
  assert.notEqual(layerName.keymap, base.keymap)
})

test('rejects unknown behaviors and wrong cell counts', () => {
  assert.throws(() => keymapFromDts(DTS.replace('&none &kp 0x70014', '&mo 0x1 &kp 0x70014')), /unknown behavior &mo/)
  assert.throws(() => keymapFromDts(DTS.replace('&to 0x0 >', '&to >')), /needs 1 numeric/)
})

test('parseDts handles multi-line properties', () => {
  const t = parseDts('/ {\n\tn {\n\t\tp = < 0x1\n\t\t\t0x2 >;\n\t};\n};\n')
  assert.equal(t.children[0].props.p, '< 0x1 0x2 >')
})

test('protobuf varints, zigzag and uint32 params round-trip', () => {
  const body = req.setBinding(3, 41, { behaviorId: 7, param1: 0xa07001b, param2: 0xffffffff })
  const top = decode(Buffer.from(body))
  const keymap = decode(top[5][0])
  const set = decode(keymap[2][0])
  assert.equal(set[1][0], 3)
  assert.equal(set[2][0], 41)
  const b = decode(set[3][0])
  assert.equal(b[1][0], 14) // zigzag(7)
  assert.equal(b[2][0], 0xa07001b)
  assert.equal(b[3][0], 0xffffffff)
  assert.deepEqual(pb.sint(1, -1), [0x08, 0x01])
})

test('framing escapes SOF/ESC/EOF and survives chunk splits', () => {
  const payload = [0x01, 0xab, 0xac, 0xad, 0x02]
  const f = frame(payload)
  assert.deepEqual([...f], [0xab, 0x01, 0xac, 0xab, 0xac, 0xac, 0xac, 0xad, 0x02, 0xad])
  const got = []
  const d = new Deframer()
  const noisy = Buffer.concat([Buffer.from([0x00, 0x13]), f, f])
  for (const b of noisy) d.push([b], fr => got.push([...fr]))
  assert.deepEqual(got, [payload, payload])
})
