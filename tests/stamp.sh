#!/usr/bin/env bash
# Writes the current version of app.css and app.js into index.html's links
# (app.css?v=xxxxxxxx), so after an update a browser fetches the new files instead of
# using an old cached copy with the new page. Run it after changing either file:
#   ./stamp.sh          update the versions
#   ./stamp.sh --check  only check they're current (run.sh does this before testing)
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
for f in app.css app.js; do
  v=$(sha256sum "$f" | cut -c1-8)
  if [ "${1:-}" = "--check" ]; then
    grep -q "$f?v=$v\"" index.html || { echo "index.html has an old version of $f: run tests/stamp.sh"; status=1; }
  else
    sed -i -E "s/$f\?v=[^\"]*\"/$f?v=$v\"/" index.html
  fi
done
exit $status
