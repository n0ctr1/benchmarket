#!/usr/bin/env bash
# Rebuilds the deployed contract and compares it with the code on chain.
# The contract names its own source (NEP-330 contract_source_metadata: repository, commit and
# build image). This checks out that commit, builds it in that image with
# `cargo near build reproducible-wasm`, and compares the SHA-256 with the code hash on chain.
# Needs git, Docker, cargo-near and python3.
set -euo pipefail
RPC=${NEAR_RPC_URL:-https://test.rpc.fastnear.com}
CONTRACT=${LEAGUE_ACCOUNT:-benchmarket.testnet}
cd "$(dirname "$0")/.."

view() {
  curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}"
}

rev=$(view "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"contract_source_metadata\",\"args_base64\":\"e30=\"}" |
  python3 -c "import json,sys;m=json.loads(bytes(json.load(sys.stdin)['result']['result']));print(m['build_info']['source_code_snapshot'].split('rev=')[1])")
echo "deployed from commit $rev"

git fetch -q --depth 1 origin "$rev" 2>/dev/null || true
work=$(mktemp -d)
git worktree add -q --detach "$work" "$rev"
trap 'git worktree remove --force "$work"' EXIT

(cd "$work/contract" && cargo near build reproducible-wasm >/dev/null)

local_hash=$(python3 - "$work/contract/target/near/benchmarket.wasm" <<'PY'
import hashlib, sys
h = int.from_bytes(hashlib.sha256(open(sys.argv[1], "rb").read()).digest(), "big")
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
out = ""
while h:
    h, r = divmod(h, 58)
    out = alphabet[r] + out
print(out)
PY
)
chain_hash=$(view "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" |
  python3 -c "import json,sys;print(json.load(sys.stdin)['result']['code_hash'])")

echo "local build: $local_hash"
echo "on chain:    $chain_hash"
if [ "$local_hash" = "$chain_hash" ]; then echo "verify-wasm: identical"; else echo "verify-wasm: MISMATCH"; exit 1; fi
