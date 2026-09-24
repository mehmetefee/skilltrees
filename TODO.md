# Ideas for later

## Prerequisite logic (any-of, thresholds)
There is exactly one kind of link — "A must be learned before B" — and when a
skill has several prerequisites, all of them are required (AND). The one open
question is whether prerequisites should be able to combine differently: any
one of a set, or thresholds like "any 2 of these 4". `FORMAT.md` sketches an
`anyOf` escape hatch for this and marks it provisional.

Implementing it would need a grouping column on `prereqs` (which alternatives
belong to the same choice), and the unlock check would stop being "every
incoming edge satisfied".

### Decided against: link types (required vs recommended)
Considered adding a second kind of link — "recommended" alongside "required"
— and rejected it. A recommended link by definition doesn't gate anything, so
a skill whose only incoming links were recommended would still render as a
starting point; the label would have earned its keep on presentation alone
(a dashed line and a side-panel list) while adding a `type` column, a second
visual language, and a real chance of authors misreading it as soft gating.

Keeping links single-typed means the acyclicity rule stays unconditional and
the unlocked/locked state stays binary. Revisit only with a concrete case
that advisory links actually solve.

## Saved layouts, creator-only
Right now dragging a skill node to reposition it is purely visual and never
saved (see `frontend/tree.js`, `attachNodeInteractions` — the drag handler
intentionally does not call the `PATCH /api/skills/:id` endpoint). The
backend still supports saving a position via that endpoint; only the
frontend stopped calling it.

The original idea was for the tree's creator to be able to lay out the
skills once and have that stick for everyone. The blocker used to be that
there was no concept of "the creator" — anyone editing positions would
clobber anyone else's layout.

**No longer blocked.** Accounts exist now and `PATCH /api/skills/:id` is
already gated on owning the tree, so the remaining work is frontend only:
give the owner an explicit "Save layout" action rather than auto-saving
every drag, and keep dragging session-only for everyone else.

## Personal progress tracking
Logged-in users marking skills "learned" to see what they've unlocked.
Still deferred. Accounts landed for ownership, not for progress, so this
needs its own table (user + skill) and a way to show unlocked state
without making the graph unreadable.

## Done: accounts
Trees now belong to the account that made them, and only that account can
change them. Reading stays public and account-free. Trees created before
this are owned by nobody and are read-only through the API on purpose —
there was no way to work out who had made them.

## Sign-in through providers: deferred on purpose
GitHub, Google and one generic OpenID Connect provider are in (see
CLAUDE.md, "Signing in through GitHub, Google or an OIDC provider"). Left
out, each for a reason:

- **Revoking GitHub's access token** after reading `/user`
  (`DELETE /applications/{client_id}/token`). The token is never stored or
  logged and carries no scopes — public profile only — so revoking it buys
  little for a second outbound call on every sign-in, with its own failures.
  Worth doing if a scope is ever requested.
- **The userinfo endpoint.** Names come from the ID token only. Google,
  Keycloak, Okta and Entra put a name or email there; a provider that
  doesn't produces usernames like `user-2`. Calling userinfo (and checking
  its `sub` matches) fixes that, but only matters once someone hits it.
- **Changing a username.** Adding a password to a provider-made account is
  done (see "Account management" below); renaming is not. It needs the
  signup rules, a check that the new name is free, and a decision about the
  `author` text on existing trees, which defaults to the username.
- **More than one generic OIDC provider.** One `OIDC_*` slot covers "your
  company's SSO". Several would need a naming scheme for the env vars and
  the callback paths (each provider needs its own path, which is the mix-up
  defence for providers that don't send `iss`).
- **A clearer error when the button is clicked on a host other than
  `PUBLIC_ORIGIN`'s** (www vs the bare domain, say). The flow cookie is set on
  the host that was clicked, so the callback then reports an expired
  sign-in. Refusing at the start with a message naming the right host would
  be kinder; serving one canonical host avoids it entirely.
- **`private_key_jwt`, PAR (RFC 9126) and DPoP.** Stronger client
  authentication and sender-constrained tokens. The site holds tokens for
  the length of one request and stores none, which is where these add the
  least; client secrets are what GitHub and most SSO setups hand out.

## Account management: deferred on purpose
Changing or setting a password, the session list, deleting the account and
exporting its data are in (see CLAUDE.md, "Account management"). Left out,
each for a reason:

- **Password reset ("forgot password").** Needs a channel to the person that
  isn't the password — in practice email: collecting and verifying an
  address, a sending service or SMTP settings, single-use expiring reset
  tokens stored hashed, and throttling that doesn't let anyone flood an
  inbox. The site has no email at all today. Until then, an account with a
  provider connected can still get in through it; one without depends on an
  operator.
- **Telling the owner** about a password change or a new sign-in. The same
  missing channel. The session list is the in-site substitute.
- **Recording how a session signed in** (password, provider, passkey). The
  ten-minute window treats any recent sign-in as proof, so a cookie stolen
  within ten minutes of a provider sign-in can set a password the owner
  can't then change without knowing it. Knowing the method would let a
  fresh provider sign-in replace that password; so would asking the provider
  for a fresh login (`max_age=0` / `prompt=login`) before sensitive changes.
- **Removing a password** from an account that also has a provider or a
  passkey. Needs the same "last way in" check as disconnecting a provider
  (`signInMethodCount()`); nobody has asked for it yet.
- **A grace period before deletion** (soft delete, undo within N days).
  Decided against for now: erasure should mean erasure, and a grace period
  is keeping data after someone asked for it to go. The typed username, the
  password and the export offered first are the guard against mistakes.
- **Erasing a deleted account's throttle rows at once.** They are keyed on
  the id or the username and age out within the hour (the hourly purge).
  They are security records with a short life, and deleting them early buys
  nothing a new signup of the same name could use.
- **Holding a deleted username** so nobody can claim it straight away.
  Nothing on the site links to a username once its trees are gone, so the
  impersonation risk is small; revisit if profiles or mentions ever exist.
- **Checking new passwords against a breach corpus** (NIST 800-63B
  §5.1.1.2 asks for it). The list in `passwordProblem()` is the head of the
  published lists; a full corpus is a data file or an outbound call to a
  k-anonymity range API — a third party learning when people change
  passwords.

## Passkeys: deferred on purpose
Passkeys are in (see CLAUDE.md, "Passkeys"): sign-up, sign-in with the
button and through autofill, add/rename/remove, the automatic upgrade after
a password sign-in, and the Signal API. Left out, each for a reason:

- **Attestation trust.** Options ask for `"none"`, and a statement in any
  other format is accepted unread. Verifying `packed`, `tpm`, `apple` and
  the rest means holding the FIDO Metadata Service's roots and keeping them
  current, and it only pays for a site that allows some makes of
  authenticator and not others. A consumer site has no such list; the
  passkeys.dev guidance is the same.
- **Related origins** (`/.well-known/webauthn`, Level 3). Passkeys are
  scoped to `PUBLIC_ORIGIN`'s host; serving www and the bare domain both, or
  a second domain, needs that file and an allowlist. Serve one canonical
  host instead, as for provider sign-in. (`/.well-known/passkey-endpoints`,
  which is in, only tells password managers where to manage passkeys:
  `/account.html#account-passkeys`, the section's id.)
- **Moving to a new host.** Changing `PUBLIC_ORIGIN`'s host strands every
  passkey (they're bound to the old RP ID). They stay listed, removable and
  uncounted; a migration would need related origins first, then a period
  where both hosts work.
- **A passkey as the "sign in again" proof.** Re-authentication before a
  sensitive change is a sign-out and a fresh sign-in today. A `get()` with
  `allowCredentials` set to the account's passkeys, verified in place,
  would be smoother — and would let the ten-minute window ask for something
  a stolen cookie can't give (see "Recording how a session signed in").
- **The same recent sign-in for linking a provider.** Adding a passkey needs
  one, because a sign-in method added through a lifted cookie outlives a
  password change; connecting a provider has the same property and doesn't
  ask yet.
- **Choosing a name when adding a passkey.** New ones are named from the
  AAGUID when it's a known provider ("iCloud Keychain"), else "Passkey", and
  renamed afterwards. Asking first is one more step in the one flow that
  should be quick.
- **`hints`** (`"security-key"`, `"client-device"`, `"hybrid"`). Nothing on
  the page distinguishes those cases yet; the browser's own chooser does.
- **PRF, largeBlob and other extensions.** Nothing here encrypts anything
  client-side.

## Trusted Types: deferred
Pages require Trusted Types, markup is built with DOM calls, and the one
policy vouches for the service worker's URL (see CLAUDE.md, "Markup is built
with DOM calls" and "Trusted Types"). Left for later, each for a reason:

- **Rich text in descriptions** (Markdown, links). Would be the first real
  need for markup from a string. Don't add an HTML policy for it: use
  `Element.setHTML()` (the HTML Sanitizer API, which strips script and
  isn't a Trusted Types sink) once every browser the site supports has it,
  or build the few allowed elements with `buildElement()` from a parse of
  our own. Until then descriptions stay plain text.
- **Logging a report's `sample`.** A Trusted Types report carries the first
  40 characters of what was refused, sink first (`Element innerHTML|<img
  src=x ...`). `/api/reports` logs the directive and not the sample, since
  the sample quotes whatever text reached the sink — someone's tree title,
  or an attacker's payload, straight into the operator's log. Through
  `logSafe()` and cut short it would say which sink tripped; worth it the
  first time a report needs diagnosing.
- **Trusted Types in the service worker's CSP.** Not needed while
  `WORKER_CSP` is `default-src 'none'`, which refuses `importScripts()`,
  eval and string timers outright. If `sw.js` ever imports a script, it
  needs `script-src 'self'` there, and then `require-trusted-types-for
  'script'` and a policy of the worker's own as well.
- **A lint rule** instead of the scan in `tests/trusted-types.test.js`,
  which reads code lines with regexes and would miss a sink reached
  indirectly (`el[prop] = html`). The browser still refuses those at run
  time; the scan only makes the failure show before anyone clicks. A real
  rule means an ESLint config and a dependency, for the tests at least.

## Installable app, offline, search metadata: deferred
The manifest, the network-first service worker, page metadata, robots.txt,
the sitemap and the well-known URLs are in (CLAUDE.md, "Installable app,
offline reading and search metadata"). Left for later, each for a reason:

- **`trees.updated_at`.** Would give the sitemap an honest `lastmod` (it
  uses `created_at` now), tree pages a `Last-Modified` (they send none, so
  a crawler sending only `If-Modified-Since` always gets a 200), and JSON-LD
  a `dateModified`. Needs a migration and every write route to touch it,
  skills and links included.
- **A sitemap index** once there are more than 50,000 trees. The sitemap
  stops at the protocol's cap, keeping the newest.
- **Editing offline.** Queuing writes (Background Sync) would mean replaying
  them later against checks — ownership, cycles — that may fail by then,
  with nobody there to see why. Offline stays read-only.
- **A timeout on network-first.** On a connection that is up but hopeless
  ("lie-fi"), a page waits for the browser to give up before the cached copy
  is used. A timeout would fall back sooner, at the cost of serving a stale
  page to someone who was merely on a slow line — which is exactly what the
  network-first rule exists to prevent.
- **The static routing API** (`InstallEvent.addRoutes()`) could send
  `/api/auth/*` straight to the network without starting the worker at all.
  Chromium only so far; the fetch handler's rule does the same everywhere.
- **A preview image per tree** (a drawing of the graph as `og:image`). Needs
  rendering on the server, which means a dependency or a lot of SVG-to-PNG
  code; every page shares the one social card for now.
- **The tree's title in the page body, server-side.** Only the `<head>` is
  filled in; a crawler that doesn't run script sees the title there and in
  JSON-LD, but not in the visible heading.
- **`share_target` and `file_handlers` in the manifest**, so the installed
  app could receive a shared `.json` or open one from the file manager into
  the import dialog. `share_target` with a file needs the worker to accept a
  POST, which it deliberately never intercepts today.
