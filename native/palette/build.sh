#!/bin/sh
# Builds src/palette.wasm, which is not committed: CI and the Dockerfile build
# it too. Uses local Rust if there is one (rustup installs the pinned version
# from rust-toolchain.toml), otherwise Docker:
#   sh native/palette/build.sh
set -eu
cd "$(dirname "$0")"
if command -v cargo >/dev/null 2>&1; then
  cargo build --release
else
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/src" -v hass-snapshotter-rustup:/usr/local/rustup -w /src rust:1.100.0-alpine \
    cargo build --release
fi
cp target/wasm32-unknown-unknown/release/palette.wasm ../../src/palette.wasm
