#!/usr/bin/env bash
# Build a clean, Chrome-Web-Store-ready zip of the extension.
#
# Usage: ./scripts/package.sh
#
# Builds into a staging directory from an EXPLICIT include list, rather than
# zipping the working tree with exclusions. An include list fails safe: a dev
# file added tomorrow is absent from the package by default, instead of being
# shipped because nobody remembered to add an -x rule for it.
#
# PRO BUILDS
# config.js's PRO_ENABLED decides what goes in. With it false the package omits
# license.js, scriptlets.js, youtube.js and every pro-* ruleset, and the pro-*
# entries are stripped from the packaged manifest. That is what makes the
# Chrome Web Store data disclosure "collects nothing" verifiable from the
# artifact itself: the free build contains no code that can call a server.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
PRO=$(grep -oE 'PRO_ENABLED[[:space:]]*=[[:space:]]*(true|false)' config.js | grep -oE '(true|false)')

OUT_DIR="dist"
if [ "$PRO" = "true" ]; then
  OUT_FILE="$OUT_DIR/ad-interceptor-v${VERSION}-pro.zip"
else
  OUT_FILE="$OUT_DIR/ad-interceptor-v${VERSION}.zip"
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# --- always shipped ---------------------------------------------------------
cp manifest.json background.js config.js popup.html popup.js cosmetic.js \
   ATTRIBUTION.md "$STAGE/"
cp -R icons "$STAGE/"

mkdir -p "$STAGE/rules" "$STAGE/filters"
cp rules/custom-*.json rules/filters-*.json "$STAGE/rules/"
# filters/custom.txt is a BUILD INPUT (our supplemental list in adblock
# syntax); the extension reads the converted rules/custom-1.json instead.
cp filters/custom-generic.css filters/custom-cosmetic.json \
   filters/filters-generic.css filters/filters-cosmetic.json "$STAGE/filters/"

# --- Pro only ---------------------------------------------------------------
if [ "$PRO" = "true" ]; then
  cp license.js scriptlets.js youtube.js "$STAGE/"
  cp rules/pro-*.json "$STAGE/rules/"
  cp filters/pro-generic.css filters/pro-cosmetic.json "$STAGE/filters/"
else
  # background.js imports './license.js' statically (dynamic import is
  # disallowed in service workers), so the file must exist — ship the stub,
  # which has the same API and no network code.
  cp license-stub.js "$STAGE/license.js"

  # Drop the pro-* rulesets from the packaged manifest — declaring a ruleset
  # whose file is absent makes the extension fail to load outright.
  python3 - "$STAGE/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
rr = m['declarative_net_request']['rule_resources']
m['declarative_net_request']['rule_resources'] = [r for r in rr if not r['id'].startswith('pro-')]
json.dump(m, open(p, 'w'), indent=2)
PY
fi

# --- audit: a free build must contain no outbound network code --------------
# The store listing for the free build claims "collects nothing". This asserts
# it against the actual staged files, so the claim cannot quietly stop being
# true — a stray fetch() to an external host fails the build rather than
# shipping and contradicting the data disclosure.
if [ "$PRO" = "false" ]; then
  node scripts/audit-package.mjs "$STAGE"
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"
OUT_ABS="$PWD/$OUT_FILE"
(cd "$STAGE" && zip -r -q "$OUT_ABS" . -x ".DS_Store" -x "*/.DS_Store")

echo "Wrote $OUT_FILE  (PRO_ENABLED=$PRO)"
unzip -l "$OUT_FILE"
