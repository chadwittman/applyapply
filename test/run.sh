#!/usr/bin/env bash
# End-to-end suite against a throwaway Postgres and a locally booted server.
# Nothing here touches production. Requires a local postgres and Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_SSL=off
DB_NAME="aa_e2e_$$"
export DATABASE_URL="postgresql://${PGUSER:-$(whoami)}@localhost:5432/$DB_NAME"
export APPLYAPPLY_JWT_SECRET="e2e-test-secret-not-production"
export APPLYAPPLY_ADMIN_SECRET="e2e-admin"
export ANTHROPIC_API_KEY="sk-ant-fake-local"
export HYPERBROWSER_API_KEY=""
export RESEND_API_KEY=""
export OPENROUTER_API_KEY=""
export STRIPE_SECRET_KEY="sk_test_fake"
export PORT="${AA_TEST_PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}"
export APP_ORIGIN="http://localhost:$PORT"
export NODE_ENV=test
export IMESSAGE_TESTERS="${IMESSAGE_TESTERS:-chat@test.local}"
# Suites assume new accounts start empty; the starter grant has its own check.
export STARTER_CREDITS="${STARTER_CREDITS:-0}"
if [[ -z "${AA_CHROME:-}" && -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ]]; then
  export AA_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
fi

cleanup() {
  if [[ -n "${SRV:-}" ]]; then kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; fi
  dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb "$DB_NAME"
node server/server.js > /tmp/aa-e2e-server.log 2>&1 &
SRV=$!

for _ in $(seq 1 30); do
  curl -sf --max-time 2 "$APP_ORIGIN/health" >/dev/null && break
  sleep 1
done
curl -sf --max-time 2 "$APP_ORIGIN/health" >/dev/null

fail=0
for t in ${AA_TEST_SUITES:-test/isolation.mjs test/kits-and-profiles.mjs test/evidence.mjs test/pages.mjs test/extension-ui.mjs test/source-ui.mjs test/background.cjs test/fast-kit.cjs test/ats-urls.cjs test/aeo.mjs test/demo.mjs test/url-prefix.mjs test/feedback.mjs test/imessage.mjs test/hardening.cjs}; do
  echo "═══ $t ═══"
  node "$t" || fail=1
done

# Every extension build still in Chrome Web Store review or in users' hands
# must keep working against this server. Tag each submission store-<version>.
if [[ -z "${AA_TEST_SUITES:-}" ]]; then
  for tag in $(git tag -l 'store-*'); do
    dir="$(mktemp -d)"
    git archive "$tag" extension | tar -x -C "$dir"
    for t in test/extension-ui.mjs test/background.cjs; do
      echo "═══ $t against $tag ═══"
      AA_EXTENSION_DIR="$dir/extension" node "$t" || fail=1
    done
    rm -rf "$dir"
  done
fi

[[ $fail -eq 0 ]] && echo "ALL SUITES PASSED" || { echo "SUITE FAILURES"; exit 1; }
