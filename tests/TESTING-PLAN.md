# Cue — QA Test Plan

Stack: Vite + React 19 (JS, ESM). Test runner: **Vitest 4** (Node env).
Tests import and call the **real shipped functions** from `src/lib/*` — zero
re-implementation. Additive only: no `src/**` or build-config changes. A
test-only `vitest.config.js` supplies throwaway `VITE_SUPABASE_*` env vars
because `src/lib/supabase.js` throws at import time without them (and
`claude.js` imports it transitively).

Run: `npm test` (alias `vitest run`) or `npx vitest run`.

---

## NOT COVERED (and why) — read this first

These carry real risk but are **not exported as pure functions**, so testing
them would require editing app source (forbidden) or standing up the full React
+ Supabase + network stack. Documented here instead of patched.

1. **`normalizeType` / `normalizeStatus` / `recToItem` / `mediaToItem` /
   `patchToDb` / `deriveCreator` / `deriveYear` (`src/lib/items.js`)** — the
   adopted-table mapping layer (Ink `recommendations` + `media_entries` →
   Cue item shape). This is HIGH risk (legacy `restaurant`/`film`/null
   `media_type`, `saved`→`queued` status, dedupe by lowercased title,
   media-rating attach-back, nested `enrichment.synopsis`→`summary`). **None are
   exported** — only the `useItems()` hook is. Cannot test without editing
   source to export them, or rendering the hook against live Supabase.
   Recommend: export the pure helpers (no behavior change) to make them
   unit-testable.

2. **`extractVideoId` / `isoDurationToMinutes` / `bestThumb`
   (`src/lib/sources/youtube.js`)** — pure and regex-heavy (good test targets)
   but **not exported**; only the network `youtubeLookup` is.

3. **`fallbackCard` / the `merge*` source-merge functions / `applySources` /
   `gatherSources` (`src/lib/enrichment.js`)** — pure (except gather) and the
   priority-ordering of merges is subtle, but **not exported**; only the async
   `enrich()` is, which calls Claude + external APIs.

4. **Network/IO surface** — `enrich`, `claudeComplete`, `fetchUrlViaProxy`,
   `tmdbLookup`, `jwLookup`, `openLibraryLookup`, `openGraphLookup`,
   `youtubeLookup`, `useItems` CRUD: all hit Supabase / 3rd-party APIs or React.
   Out of scope for offline unit tests; would need MSW mocks or e2e.

5. **React components** (`primitives.jsx`, `CueBar.jsx`, screens): no
   component/DOM tests added; covered indirectly via the pure logic they call.

6. **Playwright smoke**: skipped — `npm run dev` boots a real Supabase-backed
   app requiring live auth/env; a meaningful smoke needs network and was not
   worth the flakiness for this pass. Pure-logic coverage prioritized instead.

---

## Risk ranking (what IS covered)

### R1 — `metaFor()` defensive type lookup  *(#1 stated risk)* — `meta.js`
Called unguarded as `metaFor(item.type).spine` in CueBar/primitives. A throw or
a non-object return crashes the renderer on legacy rows. **Covered:** all 5
known types; 12 surprise inputs (unknown string, `restaurant`, `film`, empty,
garbage, uppercase, null, undefined, number, object, array, boolean, NaN) —
asserting no throw + a usable `{label,plural,spine}` of strings; placeholder
fallback (`label: 'Item'`, `spine: '··'`).
**→ Found REAL BUG (see below).**

### R2 — 5-type registry & ordering — `meta.js`
Spec says "6 rec types"; **shipped registry is media-only with 5** (restaurants
moved to Ink). **Covered:** exact key set, `TYPE_ORDER` is a 1:1 permutation
with no dupes/extras, unique spines, non-empty labels/plurals, `PARTNER`.

### R3 — `extractJSON()` defensive parse — `claude.js`
Gate between Claude's raw text and the enrichment pipeline (`enrich` does
`if (!parsed) fallback`). **Covered:** clean object/array; ```json``` & bare
fence stripping; JSON embedded in prose; first-wins when both object+array
present; multiline nested payload; 7 junk inputs (null/undefined/number/object/
empty/prose/broken-braces) all return `null` without throwing; documented the
greedy-match trailing-prose edge.

### R4 — `editionForHour()` / `formatClock()` — `meta.js`
Drive the day/night theme + masthead. **Covered:** every range boundary
(5/11/17/21), full 0–23 coverage (no gap/undefined), `isPaper` flags, 12h
conversion incl. midnight→`12:00a` / noon→`12:00p`, minute zero-padding.

---

## REAL APP BUGS FOUND (documented, NOT patched)

### BUG-1 — `metaFor()` is NOT fully defensive against prototype-member type names
`src/lib/meta.js:16` — `return TYPE_META[type] || FALLBACK_META`

`TYPE_META` is a plain object literal, so a `type` value equal to an
`Object.prototype` member name resolves through the prototype chain to a truthy
function and the `|| FALLBACK_META` guard never fires:

- `metaFor('constructor')` → returns the **`Object` constructor** (a function),
  not the placeholder. `.label` / `.spine` are then `undefined`.
- Same for `'toString'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'`, etc.

Impact: callers in `CueBar.jsx:23` and `primitives.jsx` read `.spine`/`.label`
unguarded → renders a literal `undefined`, and any `.spine.length`-style access
would throw. A legacy/imported row whose `media_type` happens to be one of these
strings would trip it. (Note: `items.js` `normalizeType` value-gates types via
an `includes()` allowlist before they reach `metaFor`, which masks this for the
normal read path — but `metaFor` is also called directly elsewhere and is
documented as the defensive boundary, so the latent bug stands.)

Suggested fix (1 line, behavior-preserving for valid types):
`return Object.hasOwn(TYPE_META, type) ? TYPE_META[type] : FALLBACK_META`
or define `TYPE_META` via `Object.assign(Object.create(null), {...})`.

`tests/meta.test.js` pins the **current buggy behavior** (asserts the Object
ctor is returned / `.label` undefined) so the suite is green and the regression
is captured. Flip those assertions to the commented-out expectations once fixed.
