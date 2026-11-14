#!/usr/bin/env bash
# Builds the Benchmarket site from the public repository and publishes it for Caddy.
# Runs as the unprivileged `site` user from a systemd timer; only rebuilds when main moved.
set -euo pipefail
REPO=/var/lib/benchmarket-site/repo
OUT=/var/www/benchmarket
if [ ! -d "$REPO/.git" ]; then git clone -q https://github.com/n0ctr1/benchmarket "$REPO"; fi
cd "$REPO"
git fetch -q origin main
NEW=$(git rev-parse origin/main)
OLD=$(cat /var/lib/benchmarket-site/built 2>/dev/null || true)
if [ "$NEW" = "$OLD" ] && [ -f "$OUT/index.html" ]; then exit 0; fi
git reset -q --hard origin/main
npm ci --no-audit --no-fund --loglevel=error
BASE_PATH=./ LEAGUE_ACCOUNT=benchmarket.testnet NEAR_NETWORK=testnet NEAR_RPC_URL=https://test.rpc.fastnear.com PUBLIC_VERIFIER_URL=https://verifier.bench-market.xyz npm run web:build
rsync -a --delete packages/web/dist/ "$OUT/"
echo "$NEW" > /var/lib/benchmarket-site/built
echo "published $NEW"
