#!/bin/sh
# Builds reader/bin/mordinals-carrier (needs a Rust toolchain).
#   sh reader/carrier/build.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
cargo build --release --locked --manifest-path "$HERE/Cargo.toml"
mkdir -p "$HERE/../bin"
cp "${CARGO_TARGET_DIR:-$HERE/target}/release/mordinals-carrier" "$HERE/../bin/mordinals-carrier"
shasum -a 256 "$HERE/../bin/mordinals-carrier"
