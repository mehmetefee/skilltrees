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
- **Changing a username, or adding a password to a provider-made account.**
  Both belong with password change/reset, which doesn't exist yet. The
  account page has a place for that section.
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
