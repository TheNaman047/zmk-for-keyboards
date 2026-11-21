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
- **build on save**: starts a build every time the editor saves.
- The log streams live and survives a page reload. A failed build opens the panel.

## How it works

| File | Role |
|---|---|
| `app/` | The upstream editor's built static site (its `pages` branch), pruned to the files it can reach. Pinned SHA and patches are in `app/VENDORED.json`. MIT, see `app/LICENSE`. |
| `vendor.mjs` | Regenerates `app/`: fetches the pinned commit, prunes it, applies the patches. Run `node editor/vendor.mjs <sha>` to take an upstream update. |
| `server.mjs` | Zero-dependency Node server on `127.0.0.1`: static files, keymap read/write, `POST /__local/build`, and a server-sent-events log stream. |
| `fs-shim.js` | Stands in for `window.showOpenFilePicker` with handles that read and write only this checkout's `config/*.keymap` through the server. The editor therefore always edits the file the Build button compiles. |
| `toolbar.js` | The Build panel, injected into the page in a shadow root. |

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
