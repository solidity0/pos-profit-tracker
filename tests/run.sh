#!/usr/bin/env bash
# Runs every test against local Firebase emulators. Nothing touches the real database.
#   ./run.sh            all tests
#   ./run.sh rules      just the security rules
#   ./run.sh e2e        just the browser tests (also: pwa)
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
# The emulator only reads rules inside this folder, so test a fresh copy of the real ones.
cp ../firestore.rules .firestore.rules

# The app, served the way GitHub Pages serves it.
python3 -m http.server 8000 --bind 127.0.0.1 --directory .. >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT

case "${1:-all}" in
  rules) CMD="node rules-test.mjs" ;;
  e2e)   CMD="node e2e.js" ;;
  pwa)   CMD="node pwa.js" ;;
  all)   CMD="node rules-test.mjs && node e2e.js && node pwa.js" ;;
  *) echo "usage: ./run.sh [all|rules|e2e|pwa]"; exit 1 ;;
esac

# Lets the page's test routes also answer the service worker's requests (pwa.js).
export PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1
npx firebase emulators:exec --only firestore,auth --project ledger-3c7f0 "$CMD"
