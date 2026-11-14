# One-command checks for judges and reviewers. Needs Node 22; `verify-wasm` also needs Docker
# and cargo-near, and `test` needs Rust.

.PHONY: judge screen test verify-wasm

# Everything that runs without keys or credit: the README's screening against the live contract,
# the type check, every TypeScript and contract test, and the site build.
judge: node_modules screen test
	npm run web:build
	@echo "judge: all checks passed"

node_modules:
	npm ci --no-audit --no-fund

# The ten claims of the README's "Screening in 60 seconds", run as written, plus link checks.
screen:
	npm run smoke:readme

test: node_modules
	npm run typecheck
	npm test
	cd contract && cargo test --quiet

# Rebuilds the contract in the pinned image and compares it with the code deployed on chain.
verify-wasm:
	cd contract && cargo near build reproducible-wasm
	@local=$$(python3 -c "import hashlib,sys;d=open('contract/target/near/benchmarket.wasm','rb').read();h=int.from_bytes(hashlib.sha256(d).digest(),'big');A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';s='';exec('while h:\n h,r=divmod(h,58);s=A[r]+s');print(s)"); \
	chain=$$(curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"benchmarket.testnet"}}' | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['code_hash'])"); \
	echo "local build: $$local"; echo "on chain:    $$chain"; test "$$local" = "$$chain" && echo "verify-wasm: identical"
