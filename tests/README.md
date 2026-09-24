# Tests

Browser-level tests that drive the real UI with Playwright, plus one pure
unit suite for the format validator.

The modals are native `<dialog>` elements. A suite waiting for one to open
should wait for `#import-overlay[open]` (or `#export-overlay[open]`), not
`:not([hidden])`; waiting for a closed one with `{ state: 'hidden' }` works
as before.

## Running them

The app itself has no dependencies, and that's worth preserving — so install
Playwright **outside** `backend/package.json`. No server needs to be running:
every browser suite starts one of its own (see below).

```bash
npm install playwright          # once, from the project root
node tests/run-e2e.js           # every browser suite, one after another
node tests/core-crud.test.js    # or any single suite
node tests/validator.test.js    # the pure validator suite (no browser, no server)
```

Playwright installed globally rather than in the project? Node's `require`
doesn't look in the global folder by itself, so tell it where that is:

```bash
NODE_PATH=$(npm root -g) node tests/run-e2e.js
```

If Playwright can't find a browser, either run `npx playwright install
chromium` or point the suites at an existing one:

```bash
CHROMIUM_PATH=/path/to/chrome node tests/run-e2e.js
```

Each suite prints a PASS/FAIL line per check, a SKIP line for a check it
can't make (and why), and exits 0 on success and 1 on failure.

### Running every browser suite: `run-e2e.js`

`tests/run-e2e.js` finds the browser suites by pattern — every
`tests/*.test.js` except the pure ones it lists (`validator.test.js`) — so a
new suite is picked up by adding the file. It runs them one at a time (each
starts its own server and Chromium, and running several at once makes
timing-sensitive checks flaky), streams their output, and ends with a table:

```
Suite            Result  Checks  Failed  Skipped   Time
---------------  ------  ------  ------  -------  -----
core-crud        pass     38/38       0        1   6.6s
...
```

It exits non-zero if any suite failed, crashed or timed out. The environment
is passed through unchanged, so `NODE_PATH`, `CHROMIUM_PATH` and `BASE_URL`
reach every suite. Name suites to run only those
(`node tests/run-e2e.js core-crud zoom-pan`); `E2E_TIMEOUT_MS` caps each one
(default ten minutes).

### Every browser suite starts its own server

Writing needs an account, and signups are rate-limited per address (ten per
fifteen minutes; imports too, per account and per address), so a shared
server runs out after a few runs. Each browser suite therefore starts a
server of its own on a throwaway database with `tests/helpers/server.js`, the
same way the API suites do, and signs up through the API inside its browser
context (`context.request` shares the context's cookies). Suites that need
the example tree ("Home Bread Baking", which predates accounts and so has no
owner) ask for it with `startServer({ seed: true })`, which runs
`backend/db/seed.js` against the throwaway database first.
`tests/helpers/browser.js` holds what the suites share: launching Chromium,
picking the server, signing up, finding the example tree, the PASS/FAIL/SKIP
reporter, and watchers for console errors and for write requests.

`BASE_URL=http://localhost:3001` aims a suite at a running server instead
(all but `oauth-browser`, which needs its mock provider configured on the
server it starts, and `passkeys-browser`, which needs `PUBLIC_ORIGIN` to be
the very origin the browser is on). They delete the trees they create either way; the
accounts they sign up stay.
The suites that use the example tree need it seeded there
(`node backend/db/seed.js`), and the rate limits above apply — run them one or
two at a time. The keyboard suite skips its featured-hero checks under
`BASE_URL`, since featuring a tree takes a script run against the database
file (`backend/db/feature.js`).

### An open question the suites skip: does the owner's drag save?

CLAUDE.md says "Dragging a skill never saves", and TODO.md ("Saved layouts,
creator-only") says the frontend doesn't call `PATCH /api/skills/:id` for it.
But `attachNodeInteractions()` in `frontend/tree.js` does PATCH the new
position when the tree's owner drags a skill on a manual-layout tree. Until
that's decided, no suite asserts the owner's manual-layout drag either way:
`drag-not-saved`, `core-crud` and `layout-modes` print a SKIP line for it.
What holds either way is asserted — a signed-out visitor's or another
account's drag never reaches the database, nor does anyone's drag on an
auto-layout tree. Once it's decided, replace those SKIPs with the answer.

## The suites

| File | Covers |
| --- | --- |
| `validator.test.js` | The format validator: valid shapes, every documented failure mode, cycle detection. No browser or server needed. |
| `core-crud.test.js` | Creating a tree on the draft page (saved once it has a title), adding skills, linking prerequisites and the announcement, the side panel, cycle rejection, what a signed-out visitor sees (no edit controls), deleting a skill and the tree. |
| `import-export.test.js` | Both import paths (paste and file), export downloads, error surfaces (including a signed-out import), byte-identical round trip. |
| `layout-modes.test.js` | `auto` vs `manual`: re-flow on edit, position honouring, both export choices (capturing a drag the database never saw), backward compatibility. |
| `skill-placement.test.js` | New skills never overlap, stay on screen, and stay individually clickable. |
| `zoom-pan.test.js` | Scroll zoom, drag-to-pan, the zoom buttons and Fit, and that node dragging still moves the node rather than the view. Runs signed out: it writes nothing. |
| `drag-not-saved.test.js` | Dragging moves a node on screen but never reaches the database for a signed-out visitor, another account, or on an auto-layout tree; the owner's manual-layout drag is skipped (see above). |
| `oauth-browser.test.js` | "Continue with ..." end to end in Chromium against the mock provider: sign-in, the account panel, connecting and disconnecting, error messages, and no console errors or CSP violations. Starts its own mock provider too. |
| `passkeys-browser.test.js` | Passkeys in Chromium with a virtual authenticator attached over CDP (`WebAuthn.addVirtualAuthenticator`: CTAP2, internal, resident keys, user verification): sign-up with a passkey, the account page's Passkeys section (list, "only way in", add — including one the authenticator already holds, rename inline, remove with confirmation), "sign in again" for an old session, both Signal API calls (the authenticator really forgets the credential), signing in with the button and through autofill, a password sign-in with autofill pending, and a second pass without the Level 3 JSON helpers to exercise the base64url fallback. Picks a free port first, since `PUBLIC_ORIGIN` must be `http://localhost:<port>`. Fails on any console error or CSP violation except the refusals it provokes. |
| `account-browser.test.js` | The account page's own sections in Chromium: ending another session and "sign out everywhere else", changing a password (a wrong one first), downloading your data, deleting the account through its dialog (Escape, a wrong name, a wrong password, then for real), and "sign in again" for an account without a password. Focus and live-region checks throughout; fails on any console error or CSP violation except the refusals it provokes. Starts its own server. |
| `a11y-keyboard.test.js` | Everything by keyboard: skip links, tabbing to a skill and opening it, arrow-key movement, Escape and where focus goes back to, link mode and removing a link, keyboard pan/zoom, native dialogs (and that closed ones block nothing), the search combobox, Share. |
| `pwa-browser.test.js` | The installable app: the manifest parses with no errors and Chromium reports nothing stopping an install; the service worker takes control with navigation preload on; a tree visited online opens offline (page and data) and an unvisited page gets `offline.html`; an edit to a file on disk shows on a plain reload (network first); speculation rules accepted, a hovered tree link prefetched and a draft link not; no console errors or CSP violations. Starts its own server; uses a persistent browser profile, since Chromium never offers to install from an incognito-style context. |

### The service worker and these suites

Every page registers `frontend/sw.js`, so from the second page a suite
opens, requests go through it. It is network first and never touches
writes or `/api/auth/*`, so suites that just click around see the same
responses as before. Two things behave differently under a worker:

- **`page.route()` / `context.route()` don't see what the worker fetches.**
  A suite that mocks or intercepts responses should launch its context
  with the worker blocked, so the page talks to the network directly:

  ```js
  const context = await browser.newContext({ serviceWorkers: 'block' });
  ```

- **Requests the worker makes are invisible to `context.on('request')`**
  unless `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` is set before
  the browser launches (`pwa-browser.test.js` sets it, to see the worker
  go to the network). `context.setOffline(true)` does reach the worker.

`pwa-browser.test.js` checks that edits show on a reload by writing two
probe files into `frontend/` (`pwa-probe-<pid>.*`, git-ignored) and
removing them when it finishes, pass or fail.

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
import legitimately logs a 400 (three of them in `import-export`, plus the
401 of a signed-out import), and so does the refused cycle in `core-crud`.
Those assertions are written to distinguish expected failures from
unexpected ones, so don't "fix" them by asserting zero console output.

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
| `api/pwa.test.js` | The web app manifest (shape, type, icons that exist at their declared sizes), `sw.js` (type, `no-cache`, its own CSP; every precached URL exists; its caching rules, run from the worker's own source), `<head>` metadata on every page with and without `PUBLIC_ORIGIN`, a tree page's title/description/Open Graph/JSON-LD with hostile text in every field coming out inert, its ETag/304/HEAD/compression, robots.txt, sitemap.xml, the two well-known URLs, and the speculation rules. |
| `api/oauth.test.js` | Provider sign-in end to end against the mock provider: PKCE, state, `iss`, nonce and ID-token checks, login CSRF, linking and unlinking, cookie naming. |
| `api/oauth-lib.test.js` | Unit checks for `backend/lib/oauth.js`: ID-token verification, JWKS caching, discovery, outbound-request limits. |
| `api/passkeys.test.js` | Passkeys end to end, driven by the software authenticator: register and sign in with ES256, EdDSA and RS256; passkey sign-up; options shape; challenge replay, expiry, cross-purpose use, browser and account binding; wrong origin, RP ID, type or framing; UP/UV; bad signatures; the counter rule (clones logged); BE/BS; user-handle mismatch; unknown credentials; excludeCredentials; duplicate credential IDs; algorithms and weak RSA; attestation formats; the list, rename and remove (owner-only); the last-way-in rule; RP ID changes; the automatic upgrade; the recent sign-in adding one needs; malformed input never a 500; throttling. |
| `api/webauthn-lib.test.js` | Unit checks for `backend/lib/webauthn.js`: configuration, the CBOR reader (truncated, huge lengths, deep nesting, tags, floats, 3000 random inputs), authenticator data, COSE keys and signatures, and both ceremonies' checks. Starts no server. |
| `api/account.test.js` | Account management: changing a password and setting a first one (only within ten minutes of signing in), what is and isn't counted, other sessions ended and the cookie rotated, a change whose session ends mid-hash; listing and ending sessions, including another account's (404) and without a recent sign-in (403); deleting the account with its trees, sessions and identities and nobody else's; a schema audit that every reference to `users` cascades except `trees.user_id`; the export's contents, secrets left out, and its trees importing again unchanged; throttling. |

`api/account.test.js` makes accounts without a password by writing them
straight into the test database (`srv.dbPath`), with a session of a chosen
age — the rules under test are what such an account may do, not how a
provider made it. Signups are rationed per address, so each of its groups
starts a server of its own and signs up no more than ten accounts on it.

The passkey suites use `helpers/webauthn-authenticator.js`: a
zero-dependency software authenticator standing in for the browser and the
device together. It takes the options JSON the server hands out and returns
what `credential.toJSON()` would — client data, authenticator data, a CBOR
attestation object with `fmt: "none"`, signed assertions — for ES256,
Ed25519 and RS256 keys, with knobs to get each part wrong (origin, RP ID,
type, challenge, UP/UV/BE/BS, counter, user handle, signature, algorithm,
attestation format, credential ID, raw bytes anywhere). API suites can use
any `PUBLIC_ORIGIN` as long as the authenticator uses the same one;
`api/passkeys.test.js` uses `https://skilltrees.test`. It clears
`rate_limits` before each test, since every request comes from 127.0.0.1.

The OAuth suites (`api/oauth.test.js`, `api/oauth-lib.test.js`) use
`helpers/mock-oidc.js`: a zero-dependency OpenID Connect provider on
127.0.0.1 — discovery, an auto-approving `/authorize`, a `/token` that checks
client authentication, `redirect_uri` and PKCE, RS256 ID tokens, `/jwks`, and
GitHub-shaped endpoints — with knobs that make it misbehave (wrong `iss`,
nonce or audience, expired tokens, `alg: none`, unknown `kid`, ...). The
server throttles sign-in starts per address and every test request comes
from 127.0.0.1, so suites that fail flows on purpose each start a server of
their own.
