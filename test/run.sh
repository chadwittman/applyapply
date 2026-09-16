#!/usr/bin/env bash
# End-to-end suite against a throwaway Postgres and a locally booted server.
# Nothing here touches production. Requires a local postgres and Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_SSL=off
export DATABASE_URL="postgresql://$(whoami)@localhost:5432/aa_e2e"
export APPLYAPPLY_JWT_SECRET="e2e-test-secret-not-production"
export APPLYAPPLY_ADMIN_SECRET="e2e-admin"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-fake-local}"
export APP_ORIGIN="http://localhost:5099"
export PORT=5099
export NODE_ENV=development

cleanup() { [[ -n "${SRV:-}" ]] && kill "$SRV" 2>/dev/null || true; }
trap cleanup EXIT

dropdb --if-exists aa_e2e >/dev/null 2>&1
createdb aa_e2e
node server/server.js > /tmp/aa-e2e-server.log 2>&1 &
SRV=$!

for _ in $(seq 1 30); do
  curl -sf --max-time 2 http://localhost:5099/health >/dev/null && break
  sleep 1
done

fail=0
for t in test/isolation.mjs test/kits-and-profiles.mjs test/pages.mjs; do
  echo "═══ $t ═══"
  node "$t" || fail=1
done

[[ $fail -eq 0 ]] && echo "ALL SUITES PASSED" || { echo "SUITE FAILURES"; exit 1; }
