#!/bin/bash
# Merit one-click demo: run the full 11-step live demo end to end on
# testnet, then verify it. Prints a clear PASS/FAIL summary at the end.
#
#   bash scripts/run-demo.sh            # run all 11 phases, resuming from merit-demo-log.json
#   bash scripts/run-demo.sh --fresh    # ignore any previous log and start over
#   bash scripts/run-demo.sh --only 11  # re-run one phase (e.g. resume the manual-vote wait)
#
# What it does (the 11 steps, all real onchain transactions):
#   1  Mint a blank Merit to the worker
#   2  Blank Merit tries a gated job and is REFUSED onchain
#   3  Earn stamp 1: pass_test (answer "merit") -> merit-basics 1
#   4  Earn stamp 2: DAO attestation, owner stamps welding 2
#   5  Deposit a kit item (welding torch) into the Merit
#   6  Poster creates a 2 NEAR paid job; worker accepts and gets IN
#   7  Poster confirms completion; payment + welding 3 land
#   8  Holder withdraws 1.9 NEAR from the sub-account
#   9  LEND to the poster: delegate opens a gated job, then expiry refuses
#   10 TIMEOUT path: 60s job, poster silent, anyone releases
#   11 DISPUTE path: DAO proposal, Joseph votes, MANUAL second vote, pay_full executes
#
# A pass looks like: "61 live + receipt checks passed (61/61 total)" from
# the verifier (43 live + 18 receipt). The demo log is merit-demo-log.json.
#
# NOTE on phase 11: the dispute's second council vote is MANUAL — this
# script cannot cast it (it cannot sign for Isaiah or James). The demo
# waits onchain for that vote (up to 30 minutes), then continues. If it
# times out, the log is saved; re-run this script (or
# "node scripts/demo.mjs --only 11") to resume waiting.
#
# Prerequisites: node, and the deployed contract + demo accounts.
# The demo signs only for accounts whose keys are in
# .testnet-accounts.json (contract/owner, Joseph stand-in, poster,
# worker). If that file is missing, this script stops and tells you
# the exact setup commands instead of failing obscurely.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node is not installed. Install Node.js, then re-run this script."
command -v npm >/dev/null 2>&1 || fail "npm is not installed. Install Node.js (which includes npm), then re-run this script."

# Dependencies: install them if they are not already there, so a fresh
# checkout works with a single command.
if [ ! -d "node_modules/near-api-js" ]; then
  echo "Installing dependencies (npm install) ..."
  npm install || fail "npm install failed. Check your network and re-run."
fi

# The demo needs the demo accounts and the deployed contract. These are
# live project state (not part of a fresh checkout), so fail loudly with
# the exact setup commands instead of dying inside the demo.
[ -f "demo-config.json" ] || fail "demo-config.json is missing. It ships in the repo; restore it and re-run."
[ -f ".testnet-accounts.json" ] || {
  echo "FAIL: .testnet-accounts.json is missing." >&2
  echo "The demo signs for the demo accounts (contract, DAO, Joseph stand-in, poster, worker)." >&2
  echo "Set them up first, in order:" >&2
  echo "  node scripts/create-accounts.mjs   # fresh testnet accounts via the faucet" >&2
  echo "  node scripts/create-dao.mjs        # deploy the Merit DAO" >&2
  echo "  node scripts/deploy.mjs            # deploy the Merit contract + publish the wallet" >&2
  echo "Then re-run this script." >&2
  exit 1
}

echo "== Merit demo: running the 11 phases (resuming from merit-demo-log.json if it exists) =="
echo "   Phase 11 needs a MANUAL second DAO vote; the demo waits onchain for it (up to 30 min)."
node scripts/demo.mjs "$@" || fail "the demo stopped with an error. See the output above. To resume one phase: bash scripts/run-demo.sh --only <phase> (1-11)."

echo ""
echo "== Merit demo: verifying (read-only, no transactions) =="
node scripts/verify-demo.mjs || fail "the verifier found failing checks. See the FAILED lines above."

echo ""
echo "== DEMO PASSED: all 11 phases ran and the verifier passed (expect 61/61) =="
