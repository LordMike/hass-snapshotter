#!/bin/sh
# Builds src/palette.wasm from this crate in Docker (no local Rust needed):
#   sh native/palette/build.sh
# The toolchain is pinned so the committed binary can be rebuilt as is.
set -eu
cd "$(dirname "$0")"
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/src" -v hass-snapshotter-rustup:/usr/local/rustup -w /src rust:1.100-alpine \
  sh -c 'rustup target add wasm32-unknown-unknown >/dev/null && cargo build --release'
cp target/wasm32-unknown-unknown/release/palette.wasm ../../src/palette.wasm
ls -l ../../src/palette.wasm
