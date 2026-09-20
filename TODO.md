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
