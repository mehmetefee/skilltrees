# Skill Trees

A public site for building and browsing skill trees: graphs where learning one
skill makes you eligible for others. Anyone can read anything without an
account; making or changing a tree needs one, and a tree can only be changed by
the account that made it.

## Running it

```bash
cd backend
node db/seed.js   # first time only, adds an example tree
node server.js    # http://localhost:3001
```

Node 22+ is required. **There are no dependencies and no install step** —
this is deliberate, not an oversight. The project uses `node:sqlite` and
`node:http` from the standard library. Don't add a package unless there's a
real reason; the zero-dependency property is worth keeping.

The server reads frontend files from disk per request, so changes to
`frontend/` only need a browser refresh. Changes to `backend/` need a restart.
SIGTERM or Ctrl-C shuts it down gracefully: requests already running finish,
then the database is closed (a second Ctrl-C, or 10 s, cuts that short).

Optional environment:

- `PORT` (default 3001; `0` picks a free one) and `SKILLTREE_DB` (the
  database file; tests point it at a throwaway one).
- `PUBLIC_ORIGIN` — the site's external origin, e.g.
  `https://skilltrees.example`. Accepted as a same-site `Origin` by the CSRF
  check (behind a proxy that rewrites `Host`, it's what browsers send) and
  used for security.txt's `Canonical`. Unset is fine.
- `SECURITY_CONTACT` — turns on `/.well-known/security.txt` (RFC 9116).
  One or more comma-separated `mailto:`, `https:` or `tel:` URIs (a bare
  address gets `mailto:`). Unset, the file is a 404: Contact is mandatory,
  and there is no made-up default.
- `SECURITY_POLICY` — optional `https://` link to a disclosure policy, added
  to security.txt as `Policy:`.

## Layout

```
backend/
  server.js        HTTP server, routing, all endpoints
  db/init.js       schema + migrations (runs on every startup)
  db/seed.js       example tree, skipped if any tree exists
  db/feature.js    CLI: set/clear the homepage-featured tree (server-side only)
  lib/notation.js  database <-> portable JSON conversion
  lib/text.js      control characters in text that gets printed
  lib/http.js      negotiation, ETags, compression, problem details (pure)
frontend/
  fonts/               Inter, self-hosted (see "web fonts" below)
  index.html/app.js    browse + search + import, featured-tree hero
  tree.html/tree.js    the graph view, and where trees are created:
                       render, edit, title/description, zoom/pan, export
  layout.js            automatic graph layout — SHARED WITH THE BACKEND
tools/validate-tree.js  format validator (CLI + module)
examples/               sample trees in the portable format
FORMAT.md               the JSON format spec — read this before touching import/export
TODO.md                 deferred ideas, and decisions made against things
```

## Things that will look wrong but aren't

**`frontend/layout.js` is required by the backend.** It's a UMD-style module
loaded by both `<script>` in the browser and `require()` in Node. It lives in
`frontend/` so the browser can fetch it as a static file. If the importer and
the renderer computed layouts differently, imported trees would jump the
moment they were displayed — hence one shared file.

**`layout.js` exports both `computeLayout` and `computeRoutes`.** They are the
same pass: `computeRoutes` returns `{ positions, routes }` and `computeLayout`
is a wrapper returning just the positions. Edges that skip a column get a
reserved empty row in each column they cross, and `routes` holds the waypoints
through it, so the browser can draw the edge around what's in the way instead
of straight through it. The backend only stores coordinates, so it uses the
narrower `computeLayout`. Ordering within a column is chosen to minimise
crossings (medians, then adjacent swaps) — minimise, not abolish: plenty of
graphs cannot be drawn in layers without any.

**The ordering runs on an allowance (`ORDER_BUDGET`).** Counting crossings is
quadratic in the edges crossing a gap, and the passes ask for a count once per
adjacent pair, so cost climbs steeply with size: 100 skills cost 41 million
comparisons, 250 skills 888 million — five seconds on the one thread that
serves every request. Past the budget the ordering stops and the graph is
drawn with the order it had reached. Every tree up to about a hundred skills
is ordered exactly as it always was; beyond that the drawing has more
crossings than an unbounded search would have found, which is the trade. The
charge depends only on the input, so the browser and the importer still agree.

**And a second allowance (`MAX_LANES`) on the lane pass.** `ORDER_BUDGET`
prices crossing *counts* and nothing else, which left the lane pass unpriced:
a lane is reserved for every column an edge skips, so the count follows the
total span of the edges rather than their number. A 1000-skill chain with
4001 long-range links — inside every validator limit — asked for 3.7 million
lanes and two minutes of work. Past the cap an edge gets no reserved row and
is drawn straight, as every edge was before lanes existed. The example trees
use one and two lanes; a 250-skill tree about 312.

**The web font is self-hosted, and that is what keeps the CSP strict.** Inter
lives in `frontend/fonts/` and is declared with `@font-face` in
`style.css`. A `<link>` to a font CDN would need `fonts.googleapis.com` added
to `style-src` and a new `font-src` for `fonts.gstatic.com`; served from
here, fonts fall under `default-src 'self'` and the policy needs no
exception at all — and no third party learns who visits. The files are
variable (one per script, every weight from 400 to 700) and carry
`unicode-range`, so a browser fetches only the scripts on screen: about 47 KB
for an English interface. `.woff2` has its own entry in the MIME table in
`server.js` and is served `immutable`, since a font's name changes when its
contents do.

**The curve an edge is drawn along lives in `layout.js`, not in the
renderers.** `edgeCurve()` builds the path and `controlPoints()` decides how
far the control points reach along x; `edgePath()` in `app.js` is a wrapper
kept because all three renderers call it by that name. They share one
definition on purpose: the clearance checks below test the shape that
actually reaches the screen, so a change to the drawing is a change to what
counts as a collision. Reach is half the run, floored at 36px and capped at
the run — the floor stops a short gap with a big drop from kinking at both
ends, and the cap is what keeps the curve inside the x it was given, which is
what the reserved rows and the detours rely on.

**Manual trees are routed at render time, by `routeAroundNodes()`.** The lane
pass above only protects auto layouts, because it is the thing that chose
where the nodes went. A tree stored as `'manual'` carries whatever
coordinates its author dragged things to, and nothing there keeps a box out
of a line's way — so all three renderers ask `layout.js` for detours instead,
from the positions as they currently stand. It runs inside `render()` rather
than at load, because a drag moves the obstacles every frame.

Two things about it are worth knowing before changing it. It treats
everything in an edge's way as **one** obstruction and lifts the line over or
under the whole group, rather than dodging boxes one at a time — stepping
under one node drops the line into the next, and by then the way around that
one is already behind the pen. And it is a heuristic, not a solver: on
layouts that look like an exported auto layout it removes about four fifths
of the crossings (measured: 51% of edges crossing a node, down to 10%), but
on freely scattered coordinates it only gets from 63% to about 42%. Closing
that gap needs real obstacle-avoiding routing — a visibility graph and a path
search — which is a different piece of work. `ROUTE_BUDGET` caps the cost at
roughly 15 ms however big the tree is, because a drag pays it per frame.

**There is no create page — `/tree.html` with no `id` is one.** Creating and
editing are the same screen: the title, description and author are edited in
place and saved as they're typed (debounced, plus on blur), so there is no
create form and no submit button. A tree with no id is a draft that exists
only in the browser; `ensureSaved()` in `tree.js` POSTs it the first time
there's something worth keeping (a title typed, or a skill added) and swaps
the URL to `?id=N` with `replaceState`. This is why anything that needs a tree
on the server awaits `ensureSaved()` first. Opening the page and leaving
deliberately saves nothing, so the public homepage doesn't collect empty
"Untitled" trees.

**Validation lives only in `tools/validate-tree.js`.** The import endpoint
calls it. Don't write a second validator in the backend; the whole point is
that the CLI and the API can't drift apart.

**Dragging a skill never saves.** Dragging is session-only; the way to keep an
arrangement is to export the tree with `layout: "manual"`, which sends the
browser's current positions with the request. The original reason was that
without accounts anyone could rearrange anyone's tree — accounts now exist, so
saving an owner's layout is possible and simply hasn't been built. See TODO.md.

**`anyOf` is valid in the format but rejected on import.** The database can't
represent alternative prerequisites, and silently flattening them to a plain
AND list would change what a tree means. Reject loudly instead.

**The featured tree has no API endpoint, on purpose.** `trees.featured` is a
plain column, but there's no route that sets it — with no accounts, any public
endpoint for it could be flipped by anyone. It's set with `node db/feature.js
<id|title|--clear>`, run on the machine hosting the database. The homepage
(`GET /api/trees`, which includes `featured`) only ever reads it.

That CLI takes an **exact** title, or an id of digits only, and refuses when
more than one tree answers to the title. It used to match a substring and
take the newest hit, which handed the choice to whoever could publish a tree:
titles are written by anyone with an account, so "<your title> - remastered"
would win the spotlight the moment an operator typed the real title.

### HTTP

Every response goes through the dispatcher and `sendRepresentation()` in
`server.js`, with the pure pieces in `lib/http.js`. Headers that belong on
everything are set there with `res.setHeader` before routing, so a route
that writes its own response (a redirect, say) still carries them. Add
behaviour there, not in handlers.

**Scripts and stylesheets are `no-cache`, not `immutable`.** Their names
don't change when their contents do — `/app.js` is always `/app.js` — so any
max-age would keep serving the old file after an edit, and "a refresh shows
it" is the promise above. `no-cache` means stored but revalidated every time;
the strong ETag (a content hash, memoised per path+mtime+size) turns that
into a 304 of a few hundred bytes. Only the fonts are `immutable`. To make
scripts long-lived, fingerprint their names first.

**Errors say the same thing twice, as `detail` and `error`.** They are RFC
9457 problem details (`application/problem+json`, `type: "about:blank"`,
`title` = the status phrase), and `detail` is the standard member. `error` is
the same text kept for every client written before — the frontend reads
`data.error`, and the import screen reads `problems`, which also stays. Keep
calling `sendJson(res, status, { error })`; it builds the rest.

**A page's 304 carries the page's CSP.** A browser folds a 304's headers into
the response it stored, so `serveStatic()` sets the page headers on `res`
before deciding between 200 and 304. Sending the dispatcher's default (the
API's `default-src 'none'`) on a page's 304 would make that the page's policy
on the next load.

**The stylesheet is in the 103 Early Hints but not in the page's `Link`
header.** Preloading it from the page's own response made Chromium 141 fetch
it twice and warn that the preload went unused; it's in the first bytes of
every page anyway. The font, which the browser only discovers after parsing
the CSS, is in both. Early Hints go only to requests with
`Sec-Fetch-Dest: document`: plenty of non-browser clients take a 1xx for the
final response, and Chromium only acts on 103 over HTTP/2 (behind a proxy).

**`bluetooth` and `web-share` are missing from Permissions-Policy.** Chromium
builds without those APIs (Linux, for one) log "unrecognized feature" on
every page for them. Check any new token in a real browser's console first.
`Cross-Origin-Embedder-Policy` is absent on purpose too: nothing here needs
cross-origin isolation, and it would be a second gate for any future
cross-origin image.

**HSTS and `upgrade-insecure-requests` only appear over https** (or with
`X-Forwarded-Proto: https`). RFC 6797 §7.2 forbids HSTS on plain http, and
upgrading subresources on plain-http localhost would break every page.

## Accounts and who can edit what

Reading is public: browsing, opening a tree, and exporting need no account.
Every write is checked on the server — hiding a button is not a permission.

`trees.user_id` is the owner. `ownedTree()` in `server.js` is the one gate
every mutating route goes through: 401 if signed out, 403 if it isn't yours.

**`user_id IS NULL` means nobody can edit it.** Trees made before accounts
existed have no recoverable owner, so the API refuses to change them for
everyone rather than guessing. Change them with a script against the database,
the way `db/feature.js` does.

The authentication itself is written against **OWASP ASVS** (V2 authentication,
V3 session management, V4 access control) and **NIST SP 800-63B**, using only
`node:crypto`. The measures, and the rule each one exists for:

- **Passwords**: scrypt at the OWASP Password Storage Cheat Sheet minimum
  (N=2^17, r=8, p=1 — Node's own default is N=2^14, about an eighth of the
  work). Per-password salt. Hashes are stored self-describing
  (`scrypt$N$r$p$salt$hash`) so the cost can be raised later without stranding
  existing passwords. Hashing is the async scrypt: at ~350 ms a sync hash would
  stall every other request for that long.
- **Password rules** (63B 5.1.1.2): at least 8 characters, long passphrases
  accepted, no composition rules, no expiry — plus a refusal list for common
  passwords and for passwords containing the username.
- **Sessions** (ASVS V3): 256-bit token, stored only as its SHA-256 so a leaked
  database yields no usable cookies; absolute expiry (30 days) and idle expiry
  (14 days); a fresh token on every login; logout deletes the row server-side.
- **Cookie** (ASVS V3.4): HttpOnly, SameSite=Lax, Path=/, and Secure whenever
  the request arrives over HTTPS.
- **Brute force and enumeration** (ASVS V2.2.1): failed logins are throttled per
  address *and* per account. Login failures say "wrong username or password"
  without saying which — and an unknown username still pays for a hash, because
  returning early would make it measurably faster and give the same answer away
  through timing.
- **CSRF** (ASVS V4.2.2): SameSite=Lax, plus a state-changing request whose
  `Origin` is present plays only if it matches the host (or `PUBLIC_ORIGIN`).
  A missing `Origin` means a non-browser caller, which carries no ambient
  cookie. Two more layers below: Fetch Metadata, and the JSON-only rule for
  request bodies.
- **Fetch Metadata** (W3C, resource isolation): an `/api/` request marked
  `Sec-Fetch-Site: cross-site` is refused unless it is a top-level GET
  navigation (`navigate` + `document`) — which is what an OAuth provider
  sending someone back to a callback is. Other sites can link to the API but
  not fetch, post to, frame or embed it. No `Sec-Fetch-*` at all (curl, old
  browsers) passes, as with `Origin`.
- **Request bodies must be declared `application/json`** (ASVS V13.1.5), or
  get 415 with `Accept` before the handler runs; a route can name other
  types with `route(..., { accepts: [...] })`. The only types a cross-site
  form, or a fetch avoiding a CORS preflight, can send are form-encoded,
  multipart and `text/plain`, so this shuts out forged posts on its own.

- **Responses** carry `Content-Security-Policy`, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`,
  `Cross-Origin-Resource-Policy: same-origin` (no other site may load our
  responses as subresources — the start of most cross-site leaks) and
  `X-Permitted-Cross-Domain-Policies: none`; pages add
  `Origin-Agent-Cluster: ?1` and a `Permissions-Policy` that switches off
  camera, microphone, geolocation, payment, USB, serial, HID, MIDI, screen
  capture, Topics and the like, leaving passkeys (`publickey-credentials-*`),
  `clipboard-write` and `fullscreen` to this origin only. The CSP allows
  inline *styles* (several pages use style attributes) but not inline
  scripts, so injected markup can't execute. Adding an inline `<script>` to
  a page will now silently do nothing — put it in a `.js` file.
- **CSP violations are reported** (`report-to` via `Reporting-Endpoints`,
  and legacy `report-uri`) to `POST /api/reports`, which takes
  `application/reports+json` and `application/csp-report`, caps bodies at
  64 KB, is throttled per address like logins, logs one `logSafe` line per
  report with query strings removed (a callback URL's `?code=` included) and
  stores nothing. A report means a bug in our markup or an injection attempt.
- **Nothing about a session is cached.** `/api/auth/*`, and any response that
  sets a cookie, is `private, no-store`; every API response has
  `Vary: Cookie`, so a shared cache can't hand one person's answer to
  another. Public API GETs are `no-cache` with an ETag. API responses are
  `X-Robots-Tag: noindex`, and their `Server-Timing` is rounded to whole
  milliseconds, so it tells a timing attack on the login little that the
  wall clock doesn't.
- **Throttled responses say when to retry**: every 429 gets `Retry-After`
  (the whole window, since call sites don't know how far into it they are)
  and the IETF `RateLimit-Policy`/`RateLimit` fields — still a draft
  (draft-ietf-httpapi-ratelimit-headers-11), so treat them as advisory.
- **Slow and oversized requests are cut off.** Explicit `headersTimeout`
  (20 s), `requestTimeout` (60 s), checked every 5 s, and a header-count cap
  stop slowloris-style clients holding connections. A body declared larger
  than the 1 MB limit is refused with 413 before a byte is read, and any
  refused or unread oversized body closes the connection instead of being
  drained.
- **Static paths** are refused outright when the decoded URL holds a control
  character. `fs.readFile` validates its path *synchronously*, so a decoded
  NUL threw out of the async listener and ended the process — an
  unauthenticated `GET /%00` was a site-wide outage. Process-level
  `unhandledRejection`/`uncaughtException` handlers are the backstop, so one
  malformed request costs that request and nothing else.
- **Text interpolated into a log line** goes through `logSafe()`: a newline in
  a username or a tree title would otherwise let the writer forge whole log
  records, including successful-login ones. `clean()` does not do this — it
  trims and truncates only.
- **The database file** is chmod'ed to 0600, and its directory to 0700, on
  every startup. SQLite would otherwise create the file holding every password
  hash as 0644, readable by any other local account. Best effort: a failure
  warns rather than stopping the server, and on Windows the directory ACL is
  what applies.
- **Post-login redirects** resolve `next` and compare origins rather than
  pattern-matching it. Browsers strip tab and newline from a URL *after* any
  check we run, so `?next=/%09/evil.example` passed a "slash, then not a
  slash" regex and then resolved as protocol-relative.
- **Imported trees** are bounded by the validator: 1000 skills, 5000
  prerequisite links, and the same text lengths `clean()` applies elsewhere
  (FORMAT.md's Limits section). Import was the one path that could store text
  no form would accept, and an unbounded graph could hand the layout more work
  than it could finish.
- **Request bodies** must parse as a JSON object. Valid JSON that isn't one
  (`null`, a number, an array) is refused, because every `body.field` read
  after that point would otherwise throw or behave strangely.
- **Throttling counts attacks, not typos**, and counts them *before* the slow
  part. A rejected password (too short, too common) still doesn't count: it
  reveals nothing, costs nothing, and only locks out someone fumbling their
  own signup. Anything that reaches the scrypt does count, including a signup
  with a username nobody has taken — that used to reach a 128 MiB, ~350 ms
  derivation without touching any counter, which made a 200-byte request
  worth a thousand times its weight in server work.
- **The counter moves before the password is checked, never after.** With the
  increment on the far side of the hash, every request that arrived while one
  was running read the same pre-increment number: a burst of 40 simultaneous
  guesses all passed a limit of 10. `overLimit()` counts and checks in one
  synchronous step, so concurrent requests see each other. A successful login
  takes back its own increment on the address counter rather than clearing
  it — clearing let an attacker spray guesses at other accounts, log in as
  themselves to zero the counter, and repeat without limit.
- **The per-account login key carries the address too.** Keyed on the username
  alone it was a weapon rather than a defence: the username comes from
  whoever is asking, so ten junk attempts against a name read off the public
  tree list locked the real owner out of their own account, renewably.
- **At most two password derivations run at once.** scrypt uses the libuv
  threadpool, which defaults to four threads and is shared with the `fs`
  reads that serve every page, so enough concurrent hashes took the whole
  site down rather than just the login. Past the cap a caller gets a 503.
- **Stored text carries no control characters.** `cleanLine()` strips them
  from single-line fields and `cleanText()` from paragraphs (which keep
  newlines and tabs); the validator refuses them on import. They matter
  because a title is printed to an operator's terminal by `db/feature.js`,
  where an escape sequence rewrites what a person sees. `logSafe()` still
  neutralizes at the sink, for rows written before this existed.

Known limits, deliberate for a site this size: the throttle is a table in the
same SQLite database, so it survives a restart but wouldn't be shared across
hosts; there is no account-wide guess limit, only per-address and
per-account-per-address, so one account attacked from many addresses at once
is rationed only by each address's own count (NIST 800-63B argues against
account-wide lockout for exactly the reason above, and an account-wide
counter keyed on a caller-supplied username is a lockout weapon); the
common-password
list is the head of the published lists rather than a full breach corpus;
`clientIp()` uses the socket address, not `X-Forwarded-For`, which is
caller-supplied — running behind a proxy needs that handled properly; signup
reveals whether a username is taken, which it has to in order to be usable; and
there is no password change, reset or second factor yet.

## Conventions

- Skills reference each other by slug (`knead-dough`), never by database id,
  in anything that leaves the system. Slugs are generated from names with
  accent transliteration (`Hamur yoğurmak` -> `hamur-yogurmak`).
- Prerequisite graphs must stay acyclic. Both the API (`wouldCreateCycle`)
  and the validator enforce this.
- Export -> import -> export must stay byte-identical. There are tests for it.
- `trees.layout` is `'manual'` (stored coordinates are authoritative) or
  `'auto'` (ignored; layout computed from structure on every render).
- Schema changes go in `migrate()` in `db/init.js`, guarded by a check so
  they're safe to run on every startup. `CREATE TABLE IF NOT EXISTS` does not
  alter existing databases.

## Testing

Browser-level tests were written with Playwright against a running server,
covering: core CRUD, cycle rejection, zoom/pan, drag-not-persisting, new-skill
placement, import/export round-trips, and both layout modes. They live in
`tests/` if they were copied over; they need `npm install playwright`, which
breaks the zero-dependency property for the app itself — keep any test
dependency out of `backend/package.json`.

API suites need nothing installed: `node --test "tests/api/*.test.js"` (or
`npm test` in `backend/`). `tests/api/http.test.js` pins the HTTP layer —
problem details, ETags and 304s, compression, HEAD/OPTIONS/405, 415,
429 fields, security headers, reports, Fetch Metadata, Early Hints,
security.txt and graceful shutdown; it talks `node:http` directly because
`fetch` decodes bodies and hides 1xx responses.

Worth knowing: two bugs in this project were only caught by clicking through
a real browser, not by API tests — a modal that invisibly blocked clicks, and
link-mode clicks being swallowed by the drag handler. API-level testing would
have missed both.

## Open questions

See `TODO.md`. In short: accounts and progress tracking are deferred;
prerequisite combining (any-of, thresholds) is unsettled; creator-owned saved
layouts are blocked on accounts. Link types (required vs recommended) were
considered and deliberately rejected — the reasoning is recorded there, so
don't re-add them without reading it.
