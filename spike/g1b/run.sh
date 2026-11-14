#!/usr/bin/env bash
# G1b: run zkVerify's own UltraHonk verifier (v0.4.0, the V5_0 runtime crate) on our proof.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; W="${1:-$HERE/.uhv}"
[ -d "$W" ] || git clone -q https://github.com/zkVerify/ultrahonk_verifier "$W"
git -C "$W" checkout -q 610d689
mkdir -p "$W/examples" "$W/tests/data/ours"
cp "$HERE/ours.rs" "$W/examples/"; cp "$HERE/data/"* "$W/tests/data/ours/"
cd "$W" && cargo run --release --example ours
