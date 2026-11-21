# Local keymap editor

[nickcoutsos/keymap-editor](https://github.com/nickcoutsos/keymap-editor), served from this repo,
with a **Build** button that compiles firmware on this machine.

```sh
./scripts/keymap-editor.sh        # serves http://localhost:8737/ and opens it
```

Then choose **File System** → **Import Keymaps** → **Continue**, and pick `corne.keymap` in the
second dropdown. The browser remembers it after that. Edit, click **Save changes**, then click
**Build** (bottom right) or press <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>. Firmware lands in
`firmware/`. Flashing is still `./scripts/zmk-build.sh flash <target>`.

Requirements: Node 18+, plus what `scripts/zmk-build.sh` needs (Docker, `yq`, `jq`, and a one-time
`./scripts/zmk-build.sh setup`). If Docker is stopped, the Build button starts OrbStack or Docker
Desktop first. Works in any modern browser; it does not rely on the browser's File System Access
API.

## Build panel

- **Target**: defaults to the left half. Keymap-only edits need only the left half reflashed,
  because the left half is the BLE central and runs the keymap.
- **pristine**: does a clean rebuild. Tick it after editing `*.conf`, shield files or `west.yml`.
- **on save**: choose do nothing, build, or soft flash every time the editor saves.
- The log streams live and survives a page reload. A failed job opens the panel.

## Soft flash (no reflash)

**Soft flash** builds the left half, then sends the key bindings to the keyboard over USB using
ZMK Studio's protocol. The keyboard saves them to its settings, so they survive a power cycle.
There's no bootloader and no drag-and-drop. Only keys that differ are sent.

1. Plug the **left** half in over USB. It's the half with Studio enabled.
2. **Quit the ZMK Studio app.** It holds the serial port open, and soft flash will name the
   process blocking it.
3. Save in the editor, then click **Soft flash**, or set **on save** to soft flash.

What it can and can't change:

| Change | Soft flash | Real flash |
|---|---|---|
| Any key's binding on an existing layer, using a behavior already in the firmware (`&kp`, `&hm`, `&to`, `&mt`, `&bt`, ...) | ✅ | ✅ |
| Combos, macros, hold-tap timing/flavor, a newly defined behavior | ❌ | ✅ |
| Adding, removing or reordering layers | ❌ | ✅ |
| `.conf` / Kconfig options, shield files | ❌ | ✅ |

**Guards** (`editor/softflash.mjs`):
- **Firmware drift.** Every build saves its `zephyr.dts` and `.config` into `firmware/.meta/<target>/`,
  and `zmk-build.sh flash` copies them to `firmware/.flashed/<target>/`. Soft flash compares
  everything except the key bindings against that record. If combos, behaviors, macros, layers or
  `.config` changed, it refuses and names what changed. **Apply bindings anyway** pushes the key
  bindings regardless. Until you've flashed once with `zmk-build.sh flash`, nothing is recorded and
  this check is skipped; the panel says so.
- **The keyboard's own checks.** A behavior missing from the firmware, a locked keyboard, layers
  reordered in Studio, or a different layer count stops it before anything is written.
- **Rollback.** If the keyboard rejects any binding, the unsaved changes are discarded on the
  keyboard and nothing is saved.

Soft-flashed bindings live in the same settings storage as Studio edits, so the same "saved
bindings beat flashed firmware" rule applies. Soft flash rewrites every key that differs from the
build, which also clears earlier Studio edits. After a real flash that changes key bindings, run
soft flash once (or Restore Stock Settings), or the old saved bindings stay in effect.

How the bindings are read: from the built `zephyr.dts`, where every binding is already numeric
(`&kp 0x7002b`). Nothing re-implements the C preprocessor. Behaviors are matched to the keyboard
by name: `display-name`, else the node's `label`, else the node name, which is how ZMK names them
(`&hm` shows up as `HOMEROW_MODS`). The serial client (`editor/studio-rpc.mjs`) is dependency-free
Node: protobuf plus `0xAB`/`0xAC`/`0xAD` framing over `/dev/cu.usbmodem*` in raw mode. Its requests
are byte-identical to ZMK's official `zmk-studio-ts-client`.

Tests: `node --test editor/test/`.

## ZMK Studio edits override flashed keymaps

Studio saves its key changes in the keyboard's settings storage, and flashing a `.uf2` does not
erase that storage. On boot, every key you changed in Studio and saved keeps its Studio binding.
So a key edited in Studio, then edited here, built and flashed, looks like the flash did nothing.

To hand control back to the `.keymap` file, connect with ZMK Studio and use **Restore Stock
Settings**. In ZMK v0.2 it resets only the keymap subsystem (`zmk_keymap_reset_settings`), so BLE
pairings are kept. The heavier fallback is the `settings_reset` firmware target, which also wipes
pairings.

## How it works

| File | Role |
|---|---|
| `app/` | The upstream editor's built static site (its `pages` branch), pruned to the files it can reach. Pinned SHA and patches are in `app/VENDORED.json`. MIT, see `app/LICENSE`. |
| `vendor.mjs` | Regenerates `app/`: fetches the pinned commit, prunes it, applies the patches. Run `node editor/vendor.mjs <sha>` to take an upstream update. |
| `server.mjs` | Zero-dependency Node server on `127.0.0.1`: static files, keymap read/write, `POST /__local/build`, and a server-sent-events log stream. |
| `fs-shim.js` | Stands in for `window.showOpenFilePicker` with handles that read and write only this checkout's `config/*.keymap` through the server. The editor therefore always edits the file the Build button compiles. |
| `toolbar.js` | The Build panel, injected into the page in a shadow root. |
| `softflash.mjs` | Reads bindings from `zephyr.dts`, checks for firmware drift, compares with the keyboard, applies the changes and saves them. |
| `studio-rpc.mjs` | ZMK Studio RPC client over USB serial. |

Why the built site and not the upstream source: the published source (`main`, last touched 2023)
is an older editor that only edits layer bindings and regenerates the whole `.keymap` from a
template. That would throw away the `hm`/`ltq` hold-taps and the combos. The current editor's
source was never published; its build is.

The GitHub source is hidden (patched off). Its sign-in redirects to github.io, so it cannot work
from localhost, and upstream is shutting its server down. The only network requests the page
makes are to Google Fonts, for the title font.

The editor rewrites the whole keymap on save. It re-aligns binding columns and writes some
parameters in parentheses (`&hm (RIGHT_ALT) LC(LEFT_ALT)`). Both compile the same, but expect
whitespace churn in the first diff.

## Safety

The server listens on `127.0.0.1` only. It rejects requests whose `Host` header is not
`localhost`/`127.0.0.1` on its port (this blocks DNS rebinding). Every write (`PUT` keymap,
`POST` build) must carry a same-origin `Origin` header. Build targets must match an entry in
`zmk-build.sh list`, and the script is run with an argument array, never through a shell. Only one
build runs at a time.
