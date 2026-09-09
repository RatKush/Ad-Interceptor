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

# _locales MUST ship. Without it a manifest using __MSG_extName__ fails to
# load outright, and a partial copy would put the literal string
# "__MSG_extName__" on the Chrome Web Store listing. scripts/check-locales.mjs
# asserts this against the staged package below.
cp -R _locales "$STAGE/"

mkdir -p "$STAGE/rules" "$STAGE/filters"
cp rules/custom-*.json rules/filters-*.json "$STAGE/rules/"
# filters/custom.txt is a BUILD INPUT (our supplemental list in adblock
# syntax); the extension reads the converted rules/custom-1.json instead.
cp filters/custom-generic.css filters/custom-cosmetic.json \
   filters/filters-generic.css filters/filters-cosmetic.json "$STAGE/filters/"

# --- Pro only ---------------------------------------------------------------
if [ "$PRO" = "true" ]; then
  # Mirror image of the free build's audit: a Pro build talks to a server, so
  # assert the server address is real before packaging. This is what makes a
  # repeat of the api.example.com placeholders impossible.
  node scripts/check-pro-config.mjs

  cp license.js scriptlets.js youtube.js "$STAGE/"
  cp rules/pro-*.json "$STAGE/rules/"
  cp filters/pro-generic.css filters/pro-cosmetic.json "$STAGE/filters/"
else
  # background.js imports './license.js' statically (dynamic import is
  # disallowed in service workers), so the file must exist — ship the stub,
  # which has the same API and no network code.
  cp license-stub.js "$STAGE/license.js"

  # Blank API_BASE in the FREE package. Nothing in a free build reads it (the
  # stub replaces license.js), but shipping the licence server's address inside
  # a package whose store disclosure says "collects nothing" is a claim nobody
  # should have to take on trust — and scripts/audit-package.mjs rightly fails
  # on any external URL in shipped code. Blanking it means the free artifact
  # provably contains no server address, and the audit stays strict rather
  # than gaining an exception.
  python3 - "$STAGE/config.js" <<'PYCFG'
import re, sys
p = sys.argv[1]
s = open(p).read()
s2 = re.sub(r"export const API_BASE = '[^']*';", "export const API_BASE = '';", s)
if s2 == s and "API_BASE = ''" not in s:
    sys.exit("package.sh: could not blank API_BASE in the staged config.js")
open(p, 'w').write(s2)
PYCFG

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

# Localisation is a store-listing surface: a broken catalogue shows up as
# "__MSG_extName__" as the item's public name, so check the staged files.
node scripts/check-locales.mjs "$STAGE"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"
OUT_ABS="$PWD/$OUT_FILE"
(cd "$STAGE" && zip -r -q "$OUT_ABS" . -x ".DS_Store" -x "*/.DS_Store")

echo "Wrote $OUT_FILE  (PRO_ENABLED=$PRO)"
unzip -l "$OUT_FILE"
