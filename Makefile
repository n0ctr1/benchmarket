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

# Rebuilds the commit the deployed contract names on chain (NEP-330) and compares the hashes.
verify-wasm:
	bash scripts/verify-wasm.sh
