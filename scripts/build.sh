#!/usr/bin/env bash
# Merit build: wallet first, then the main contract.
#
# The wallet wasm is copied into contract/src/wallet.wasm (gitignored
# build artifact) so the main contract's include_bytes! path has no
# `..` in it — this environment intermittently fails to read `..`
# include paths out of target/ (rustc ENOENT on a file that ls and
# python can read). Rebuild the wallet whenever its source changes;
# the copy keeps the embedded bytes in sync.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== wallet =="
(cd "$ROOT/wallet" && cargo near build non-reproducible-wasm)
cp "$ROOT/target/near/merit_wallet/merit_wallet.wasm" "$ROOT/contract/src/wallet.wasm"
echo "wallet wasm: $(stat -c %s "$ROOT/contract/src/wallet.wasm") bytes, sha256 $(sha256sum "$ROOT/contract/src/wallet.wasm" | cut -d' ' -f1)"

echo "== main contract =="
(cd "$ROOT/contract" && cargo near build non-reproducible-wasm)
echo "merit wasm: $(stat -c %s "$ROOT/target/near/merit/merit.wasm") bytes, sha256 $(sha256sum "$ROOT/target/near/merit/merit.wasm" | cut -d' ' -f1)"

echo "== unit tests =="
export NEAR_SANDBOX_BIN_PATH="$HOME/.near/near-sandbox-2.14.0/near-sandbox"
(cd "$ROOT/contract" && cargo test --offline --lib)

echo "== test wasm copies =="
cp "$ROOT/target/near/merit/merit.wasm" "$ROOT/contract/tests/merit.wasm"
cp "$ROOT/target/near/merit_wallet/merit_wallet.wasm" "$ROOT/contract/tests/merit_wallet.wasm"
echo "test copies refreshed in contract/tests/"
