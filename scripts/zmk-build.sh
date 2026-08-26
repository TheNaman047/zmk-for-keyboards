#!/usr/bin/env bash
#
# Build this ZMK user config locally, in the same container CI uses.
#
# The west workspace lives OUTSIDE the repo (~/.cache/zmk-workspace by default) and this
# repo's config/ is bind-mounted into it read-only, so a local build never pollutes the
# checkout the way the CI workflow's `west init -l` would. The only thing written back
# into the repo is firmware/*.uf2.
#
#   ./scripts/zmk-build.sh setup            # one time: pull image, west init/update/export
#   ./scripts/zmk-build.sh build left       # build every target whose id matches "left"
#   ./scripts/zmk-build.sh build --pristine # rebuild everything from scratch
#   ./scripts/zmk-build.sh flash corne_left_nice_oled-nice_nano_v2
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WS="${ZMK_WORKSPACE:-$HOME/.cache/zmk-workspace}"
IMAGE="${ZMK_IMAGE:-zmkfirmware/zmk-build-arm:stable}"
OUT="$REPO/firmware"
CWS=/workspace          # workspace path inside the container - must never change:
                        # absolute paths get baked into the CMake caches.

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m==> %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m==> %s\033[0m\n' "$*" >&2; exit 1; }

# --- build matrix -----------------------------------------------------------------
# Parsed straight out of build.yaml so the local matrix can never fork from CI's.
# Two incompatible tools are called `yq`: python-yq (a jq wrapper, uses -c) and Go-yq
# (mikefarah, uses -o=json). Probe instead of assuming.
matrix_json() {
  command -v yq >/dev/null || die "yq not found (install python-yq or go-yq)"
  # Probe on whether the output actually parses as JSON, not on exit status: Go-yq
  # accepts -c, exits 0 and prints YAML, so an exit-status probe never falls through.
  local out
  for flags in "-o=json -I=0" "-c"; do
    if out=$(yq $flags '.include[]' "$REPO/build.yaml" 2>/dev/null) \
       && [ -n "$out" ] && jq -e . >/dev/null 2>&1 <<<"$out"; then
      printf '%s\n' "$out"
      return 0
    fi
  done
  die "could not parse build.yaml with this yq ($(yq --version 2>&1 | head -1))"
}

# target id: shield with spaces collapsed to _, plus board. Mirrors CI's artifact name
# (${shield}-${board}-zmk) with the spaces normalised away.
target_id() { # <board> <shield>
  local board=$1 shield=$2
  if [ -n "$shield" ]; then printf '%s-%s' "${shield// /_}" "$board"
  else printf '%s' "$board"; fi
}

# --- container --------------------------------------------------------------------
# Note: no -i. With stdin attached, `docker run` drains whatever is feeding the caller's
# loop, so a `while read ... done < <(matrix_json)` around this would build only its
# first target. Nothing here needs stdin.
docker_run() {
  local tty=()
  [ -t 1 ] && tty=(-t)
  docker run --rm "${tty[@]}" \
    --user "$(id -u):$(id -g)" \
    -e HOME="$CWS" \
    -e CCACHE_DIR="$CWS/.ccache" \
    -v "$WS:$CWS" \
    -v "$REPO/config:$CWS/config:ro" \
    -w "$CWS" \
    "$IMAGE" "$@"
}

west_yml_hash() { sha256sum "$REPO/config/west.yml" | cut -d' ' -f1; }

ensure_image() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { log "pulling $IMAGE"; docker pull "$IMAGE"; }
}

ensure_workspace() {
  { [ -d "$WS/.west" ] && [ -d "$WS/zmk" ]; } \
    || die "workspace not initialised - run: $0 setup"
  if [ "$(cat "$WS/.west-yml-hash" 2>/dev/null)" != "$(west_yml_hash)" ]; then
    warn "config/west.yml changed since the last 'west update' - run: $0 update"
  fi
}

# --- subcommands ------------------------------------------------------------------
cmd_setup() {
  ensure_image
  mkdir -p "$WS/.ccache" "$OUT"
  if [ ! -d "$WS/.west" ]; then
    log "west init"
    docker_run west init -l "$CWS/config"
  fi
  log "west update (slow - fetches ZMK, Zephyr and the display modules)"
  docker_run west update
  log "west zephyr-export"
  docker_run west zephyr-export
  west_yml_hash > "$WS/.west-yml-hash"
  log "workspace ready at $WS"
}

cmd_update() {
  ensure_image
  [ -d "$WS/.west" ] || die "workspace not initialised - run: $0 setup"
  docker_run west update
  docker_run west zephyr-export
  west_yml_hash > "$WS/.west-yml-hash"
}

cmd_list() {
  local entry board shield snippet
  local -a targets=()
  mapfile -t targets < <(matrix_json)
  # die() inside matrix_json runs in a subshell and cannot fail us; check here.
  [ ${#targets[@]} -gt 0 ] || die "could not read the build matrix from build.yaml"
  for entry in "${targets[@]}"; do
    board=$(jq -r '.board' <<<"$entry")
    shield=$(jq -r '.shield // ""' <<<"$entry")
    snippet=$(jq -r '.snippet // ""' <<<"$entry")
    printf '%-58s %s\n' "$(target_id "$board" "$shield")" "${snippet:+snippet: $snippet}"
  done
}

cmd_build() {
  local filter="" arg
  local -a pristine=()
  for arg in "$@"; do
    case "$arg" in
      --pristine|-p) pristine=(-p always) ;;
      all|"")        filter="" ;;
      *)             filter="$arg" ;;
    esac
  done

  ensure_image
  ensure_workspace
  mkdir -p "$OUT"

  local entry board shield snippet id src ext skipped=0
  local -a built=() snip_args=() shield_arg=() targets=()
  mapfile -t targets < <(matrix_json)
  # die() inside matrix_json runs in a subshell and cannot fail us; check here.
  [ ${#targets[@]} -gt 0 ] || die "could not read the build matrix from build.yaml"

  for entry in "${targets[@]}"; do
    board=$(jq -r '.board' <<<"$entry")
    shield=$(jq -r '.shield // ""' <<<"$entry")
    snippet=$(jq -r '.snippet // ""' <<<"$entry")
    id=$(target_id "$board" "$shield")

    if [ -n "$filter" ] && [[ "$id" != *"$filter"* ]]; then
      skipped=$((skipped + 1)); continue
    fi

    log "building $id ${snippet:+(snippet: $snippet)}"
    snip_args=();   [ -n "$snippet" ] && snip_args=(-S "$snippet")
    shield_arg=(); [ -n "$shield" ]  && shield_arg=(-DSHIELD="$shield")

    docker_run west build -s zmk/app -d "$CWS/build/$id" -b "$board" \
      "${snip_args[@]}" "${pristine[@]}" \
      -- -DZMK_CONFIG="$CWS/config" "${shield_arg[@]}"

    src="$WS/build/$id/zephyr/zmk.uf2"
    [ -f "$src" ] || src="$WS/build/$id/zephyr/zmk.bin"
    [ -f "$src" ] || die "$id: no zmk.uf2 or zmk.bin produced"
    ext="${src##*.}"
    cp "$src" "$OUT/${id}-zmk.${ext}"
    built+=("${id}-zmk.${ext}")
  done

  [ ${#built[@]} -gt 0 ] || die "no targets matched filter '${filter}' (see: $0 list)"

  log "firmware in $OUT"
  local f
  for f in "${built[@]}"; do
    printf '    %-56s %s\n' "$f" "$(du -h "$OUT/$f" | cut -f1)"
  done
  [ "$skipped" -gt 0 ] && log "$skipped target(s) skipped by filter '$filter'"
  return 0
}

cmd_clean() {
  case "${1:-}" in
    --all) log "removing $WS"; rm -rf "$WS" ;;
    "")    log "removing build dirs"; rm -rf "$WS/build" ;;
    *)     log "removing build dirs matching '$1'"; rm -rf "$WS"/build/*"$1"* ;;
  esac
}

# Where the nice!nano bootloader shows up as a mass-storage volume. macOS mounts by
# volume label under /Volumes with no $USER component; Linux uses /run/media/$USER or
# /media/$USER. The trailing * catches macOS appending " 1" when a stale mount lingers.
# Overridable so the wait loop can be exercised without a keyboard attached.
NICENANO_PATHS="${ZMK_NICENANO_PATHS:-/Volumes/NICENANO* /run/media/$USER/NICENANO* /media/$USER/NICENANO*}"

nicenano_mount() {
  # shellcheck disable=SC2086  # deliberate split+glob over the path list
  ls -d $NICENANO_PATHS 2>/dev/null | head -1 || true
}

cmd_flash() {
  local id="${1:-}" uf2 mnt=""
  [ -n "$id" ] || die "usage: $0 flash <target>   (see: $0 list)"
  uf2=$(ls "$OUT"/*"$id"*.uf2 2>/dev/null | head -1 || true)
  [ -n "$uf2" ] || die "no firmware for '$id' in $OUT - build it first"

  log "double-tap reset on the nice!nano - waiting for the NICENANO drive"
  for _ in $(seq 1 60); do
    mnt=$(nicenano_mount)
    [ -n "$mnt" ] && break
    sleep 1
  done
  [ -n "$mnt" ] || die "NICENANO drive never appeared (looked in: $NICENANO_PATHS)"

  # -X keeps macOS from writing ._ AppleDouble sidecars onto the bootloader's FAT
  # volume; GNU cp has no such flag and needs none.
  local -a cpflags=()
  [ "$(uname -s)" = Darwin ] && cpflags=(-X)

  log "copying $(basename "$uf2") -> $mnt"
  if ! cp "${cpflags[@]}" "$uf2" "$mnt/" 2>/dev/null; then
    # The board reboots the instant the last block lands, so the volume can vanish
    # mid-copy and cp reports an I/O error on a flash that actually succeeded. A
    # drive that is still mounted means the copy really did fail.
    [ -d "$mnt" ] && die "copy to $mnt failed"
  fi
  sync
  log "flashed - the board reboots on its own and the drive disappears"
}

usage() {
  cat <<USAGE
usage: $0 <command> [args]

  setup                  pull the image and initialise the west workspace ($WS)
  update                 re-run 'west update' after editing config/west.yml
  list                   list build targets from build.yaml
  build [filter] [--pristine]
                         build matching targets into $OUT
                         filter is a substring of the target id: left, oled,
                         nice_view, settings_reset ... omit it to build all
  clean [filter|--all]   drop build dirs (--all drops the whole workspace)
  flash <target>         copy a built .uf2 to a double-tapped nice!nano

Use --pristine after changing *.conf, config/boards/shields/**, west.yml or the
shield/snippet list. Keymap-only edits rebuild correctly without it.

env: ZMK_WORKSPACE=$WS
     ZMK_IMAGE=$IMAGE
USAGE
}

case "${1:-}" in
  setup)  shift; cmd_setup "$@" ;;
  update) shift; cmd_update "$@" ;;
  list)   shift; cmd_list "$@" ;;
  build)  shift; cmd_build "$@" ;;
  clean)  shift; cmd_clean "$@" ;;
  flash)  shift; cmd_flash "$@" ;;
  ""|-h|--help|help) usage ;;
  *) die "unknown command '$1' (try: $0 --help)" ;;
esac
