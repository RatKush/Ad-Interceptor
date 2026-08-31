# Attribution

## Filter lists

Ad Interceptor's blocking rules are generated from:

- **EasyList** — https://easylist.to/
- **EasyPrivacy** — https://easylist.to/

Both lists are dual-licensed under the GNU General Public License v3.0 and the
Creative Commons Attribution-ShareAlike 3.0 Unported licence. **This project
uses them under CC BY-SA 3.0** (https://creativecommons.org/licenses/by-sa/3.0/).

Copyright © The EasyList authors.

The files in `rules/` and `filters/` are derived from those lists and are
therefore themselves available under CC BY-SA 3.0. That share-alike obligation
attaches to the filter data, not to the rest of this extension's source.

## Scriptlets

`scriptlets.js` is an independent implementation. It is deliberately **not**
derived from AdGuard's or uBlock Origin's scriptlet libraries, both of which
are GPL and would place the shipped extension under GPL-3.0. The underlying
techniques (property traps, constant pinning, bait-element defusal) are
long-established and not owned by any project; the code here is original.

If you extend it, write new scriptlets from scratch. Do not paste in
implementations from GPL blockers.

## Build tooling

`@adguard/dnr-converter` (GPL-3.0-only) converts adblock-syntax filters into
Chrome `declarativeNetRequest` rules. It is a **build-time-only devDependency**:
it is never bundled into or distributed with the extension package (see the
`node_modules/` exclusion in `scripts/package.sh`), and only its data output
ships.

Do not add `@adguard/dnr-rulesets` or any other GPL-licensed component to the
shipped package — those distribute GPL-covered material inside the extension,
which would place the extension itself under GPL-3.0.
