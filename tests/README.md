# Tests

Browser-level tests that drive the real UI with Playwright, plus one pure
unit suite for the format validator.

The modals are native `<dialog>` elements. A suite waiting for one to open
should wait for `#import-overlay[open]` (or `#export-overlay[open]`), not
`:not([hidden])`; waiting for a closed one with `{ state: 'hidden' }` works
as before.

## Running them

The app itself has no dependencies, and that's worth preserving — so install
Playwright **outside** `backend/package.json`:

```bash
npm install playwright        # once, from the project root
node backend/server.js        # in another terminal; these hit a live server
node tests/validator.test.js  # then run any suite
```

Each suite exits 0 on success and 1 on failure, and prints a PASS/FAIL line
per check. They create trees through the API and delete them afterwards, so
they're safe to run against your working database — though the core CRUD
suite does briefly add and remove skills.

If Playwright can't find a browser, either run `npx playwright install
chromium` or point the suites at an existing one:

```bash
CHROMIUM_PATH=/path/to/chrome node tests/core-crud.test.js
```

## The suites

| File | Covers |
| --- | --- |
| `validator.test.js` | The format validator: valid shapes, every documented failure mode, cycle detection. No browser or server needed. |
| `core-crud.test.js` | Creating trees and skills, linking prerequisites, the side panel, deletion, cycle rejection. |
| `import-export.test.js` | Both import paths (paste and file), export downloads, error surfaces, round-trip fidelity. |
| `layout-modes.test.js` | `auto` vs `manual`: re-flow on edit, position honouring, both export choices, backward compatibility. |
| `skill-placement.test.js` | New skills never overlap, stay on screen, and stay individually clickable. |
| `zoom-pan.test.js` | Scroll zoom, drag-to-pan, the zoom buttons, and that node dragging still works alongside them. |
| `drag-not-saved.test.js` | Dragging moves a node visually but never reaches the database. |
| `oauth-browser.test.js` | "Continue with ..." end to end in Chromium against the mock provider: sign-in, the account panel, connecting and disconnecting, error messages, and no console errors or CSP violations. Starts its own server and provider, so it needs no running server. |
| `a11y-keyboard.test.js` | Everything by keyboard: skip links, tabbing to a skill and opening it, arrow-key movement, Escape and where focus goes back to, link mode and removing a link, keyboard pan/zoom, native dialogs (and that closed ones block nothing), the search combobox, Share. Starts its own server — see below. |

### The keyboard suite starts its own server

`a11y-keyboard.test.js` signs up through the API, and signups are
rate-limited per address (ten per fifteen minutes), so a shared server runs
out after a few runs. It therefore starts a server of its own on a throwaway
database with `tests/helpers/server.js`, the same way the API suites do — no
server needs to be running:

```bash
node tests/a11y-keyboard.test.js
# Playwright installed globally rather than in the project:
NODE_PATH=$(npm root -g) node tests/a11y-keyboard.test.js
```

`BASE_URL=http://localhost:3001` aims it at a running server instead; the
featured-hero checks are then skipped, since featuring a tree takes a script
run against the database file (`backend/db/feature.js`). It deletes the trees
it creates either way.

## A note on what these caught

Two real bugs in this project were invisible to API-level testing and only
showed up by clicking through a browser:

- A modal overlay that stayed in the layout while "hidden", silently
  swallowing clicks on the page behind it.
- Link-mode clicks doing nothing, because the drag handler returned early
  before the click ever reached its handler.

Both looked completely fine in the DOM and in API responses. If you add
interactive behaviour, it's worth testing it this way rather than trusting
that the right handlers exist.

One caution: a few checks assert on *expected* console errors — a rejected
import legitimately logs a 400. Those assertions are written to distinguish
expected failures from unexpected ones, so don't "fix" them by asserting
zero console output.

## API suites (no dependencies)

`tests/api/` holds suites written against Node's built-in test runner
(`node:test`) and the global `fetch`, so they need nothing installed:

```bash
cd backend && npm test                   # or, from the root:
node --test "tests/api/*.test.js"
```

Each suite starts its own server through `tests/helpers/server.js`: a child
process on a port the OS picks (`PORT=0`), pointed at a throwaway database
with `SKILLTREE_DB`. Suites therefore don't need a server running, don't
touch your working database, and can run in parallel — every one gets fresh
accounts and fresh rate-limit counters. The helper's `signup(name)` returns a
client already carrying that account's session cookie.

| File | Covers |
| --- | --- |
| `api/smoke.test.js` | Public reads, signed-in writes, owner-only changes, the Origin check. |
| `api/http.test.js` | The HTTP layer: problem details, ETags/304, compression, HEAD/OPTIONS/405, 415, 413, 429 fields, security headers, `/api/reports`, Fetch Metadata, Early Hints, security.txt, graceful shutdown. Uses `node:http` rather than `fetch`, which would decode bodies and swallow 103s. |
| `api/http-lib.test.js` | Unit checks for `backend/lib/http.js`; starts no server. |
| `api/oauth.test.js` | Provider sign-in end to end against the mock provider: PKCE, state, `iss`, nonce and ID-token checks, login CSRF, linking and unlinking, cookie naming. |
| `api/oauth-lib.test.js` | Unit checks for `backend/lib/oauth.js`: ID-token verification, JWKS caching, discovery, outbound-request limits. |

The OAuth suites (`api/oauth.test.js`, `api/oauth-lib.test.js`) use
`helpers/mock-oidc.js`: a zero-dependency OpenID Connect provider on
127.0.0.1 — discovery, an auto-approving `/authorize`, a `/token` that checks
client authentication, `redirect_uri` and PKCE, RS256 ID tokens, `/jwks`, and
GitHub-shaped endpoints — with knobs that make it misbehave (wrong `iss`,
nonce or audience, expired tokens, `alg: none`, unknown `kid`, ...). The
server throttles sign-in starts per address and every test request comes
from 127.0.0.1, so suites that fail flows on purpose each start a server of
their own.
