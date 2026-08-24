# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A ZMK **user config** repo for a Corne split keyboard on `nice_nano_v2` controllers. There is no
application source here — only Devicetree, Kconfig fragments, and a build matrix. ZMK itself and all
display modules are pulled in by west at build time.

## Building

There is **no local toolchain** (`west` is not installed and no ZMK workspace exists on this machine).
Builds happen in GitHub Actions only:

- Push a commit touching `config/**` — that path filter is the trigger (`.github/workflows/build.yml`).
  Changes to `build.yaml` alone do **not** trigger a build; use `workflow_dispatch` (Actions → "Build ZMK
  firmware" → Run workflow) or bundle them with a `config/**` change.
- Firmware `.uf2` files come out as artifacts of the run. Flash by double-tapping reset on the nice!nano
  and copying the `.uf2` to the mounted drive.
- To validate a change without pushing to the tracked branch, push a scratch branch — the workflow runs
  on any branch.

There is no test suite, linter, or formatter. "Does it compile" is the only check, and it lives in CI.

## Architecture

Three layers combine at build time:

1. **`build.yaml`** — the CI matrix. Each entry is a board + space-separated shield list. Current targets:
   `corne_left`/`corne_right` paired with either `nice_oled` (SSD1306 I²C OLED) or
   `nice_view_adapter nice_view_custom` (SPI nice!view), plus a `settings_reset` target for clearing
   stored BLE pairings. The left half gets the `studio-rpc-usb-uart` snippet, which is what enables ZMK
   Studio over USB.
2. **`config/west.yml`** — dependency manifest. ZMK is pinned to `v0.2`; the rest are community display
   modules. `nice_oled` comes from `mctechnology17/zmk-nice-oled`; `nice_view_custom` comes from
   `GPeye/hammerbeam-slideshow`. The other four modules (`nice-view-elemental`, `nice-view-gem`,
   `zmk-shield-nice-view-cats`, `nice-view-battery`) are fetched but **no build target uses their
   shields** — they are available alternatives, not active code.
3. **`config/boards/shields/`** — local shield definitions that **shadow upstream ZMK's built-in `corne`
   shield**. `corne.dtsi` holds the shared matrix transform, kscan GPIOs, I²C/OLED node, and the SPI
   WS2812 node; `corne_left.overlay` / `corne_right.overlay` add per-half column GPIOs (right applies
   `col-offset = <6>`) and the VDDH battery sensor. `nice_view_adapter` repurposes the OLED's I²C pins as
   SPI (`&pro_micro_i2c` disabled, `spi0` remapped) — which is why it is mutually exclusive with
   `nice_oled`.

Keymap edits go in **`config/corne.keymap`**. It defines 5 layers (L0 base, L1 symbols, L2 numpad/nav,
L3 media/arrows, L4 bluetooth), the `hm` homerow-mod hold-tap (used 13 times, `balanced` flavor), and
bracket/paren/brace combos by key position. A second hold-tap, `ltq`, is declared but never bound to any
key — it is dead. Layer switching uses `&to` (not `&mo`), so layers are sticky — every non-base
layer must keep a `&to 0` binding or the keyboard becomes unusable until reflashed.

## Gotchas

These are the traps that cost real debugging time:

- **`config/boards/shields/corne/corne.keymap` is inert.** It is the stock upstream Corne keymap and is
  not what runs. The live keymap is `config/corne.keymap`. Editing the shield one changes nothing.
- **Two files named `corne.conf` with conflicting values.** `config/boards/shields/corne/corne.conf` sets
  `CONFIG_ZMK_DISPLAY=n`; `config/corne.conf` sets `=y`. The user config (`config/corne.conf`) is merged
  last and wins — display behavior has been tuned there across commits `ff586ce`…`bced3d2`. Edit
  `config/corne.conf`; treat the shield-level one as legacy.
- **`config/corne.conf` sets both `..._STATUS_SCREEN_BUILT_IN=y` and `..._STATUS_SCREEN_CUSTOM=y`.** Per
  commit `bced3d2` ("revert OLED config to use zmk-nice-oled custom screen"), the zmk-nice-oled custom
  screen is what actually renders. Do not "fix" this by deleting the custom line — that reverts a
  deliberate decision. The built-in widget flags (`LAYER_STATUS`, `PERIPHERAL_STATUS`) are set to `n`
  because the custom screen draws its own.
- **The ZMK version is pinned in two places that must move together:** `revision: v0.2` in
  `config/west.yml` and `@v0.2` on the reusable workflow in `.github/workflows/build.yml`. Bumping one
  without the other builds new firmware with an old CI harness, or vice versa.
- **The left half is the BLE central** (`ZMK_SPLIT_BLE_ROLE_CENTRAL` in `Kconfig.defconfig`). Pairing and
  Studio connections go to the left half; the right half only talks to the left.
- **`config/boards/shields/corne/custom_config.h`** defines QMK-style RGB macros that ZMK does not read.
  It is included by the inert shield keymap only — dead code.
- Comments in the `.conf` files are in Chinese, inherited from the upstream config this was forked from.

Key positions in combos and `&key_physical_attrs` entries are indexed against the 42-key layout in
`corne-layouts.dtsi` / `config/corne.json`, numbered left-to-right, top-to-bottom, thumbs last (36–41).
Renumbering the layout invalidates every combo.
