#!/usr/bin/env bash
# Relaunches the league on a fresh testnet account: new account, contract, agents with their
# own faces, model scouts, rounds with real models, a brief with a confidential hire, a job
# and a disputed round. Stops at the first error. Usage:
#   scripts/relaunch.sh <funded-testnet-account> [new-account] [NEAR to move]
set -euo pipefail
FROM="${1:?funded account}"
TO="${2:-benchmarket.testnet}"
AMOUNT="${3:-17}"
cd "$(dirname "$0")/.."

npm run build:contract
npm run league -- bootstrap --from "$FROM" --to "$TO" --amount "$AMOUNT"
sed -i "s/^LEAGUE_ACCOUNT=.*/LEAGUE_ACCOUNT=$TO/" .env
npm run setup -- --agent-balance 0.35 --scout-balance 0.3
npm run identities
npm run league -- scouts-sync --max 6
npm run demo -- --rounds 6 --llm --market-seconds 30
npm run demo -- --rounds 4 --offset 6 --market-seconds 30
npm run league -- round --task cron-next --lie
npm run league -- job --task eval-expr --min-rating 1500 --budget 0.1 --llm
npm run league -- brief --task parse-duration --category parsing --summary "I need a strict parser for duration strings in our job scheduler" --budget 0.1 --reward 0.01 --confidential --llm
npm run league -- status
npm run evidence       # snapshot of the off-chain records for the repository
