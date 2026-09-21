# Skill Tree JSON format (v1)

A plain-JSON notation for stating a complete skill tree: its skills, which
skills unlock which, and optionally where they sit on the canvas.

Design goals, in priority order:

1. **Hand-writable.** Someone should be able to type a tree in a text editor
   without consulting a database.
2. **Readable in a diff.** References use human-meaningful names, not numeric
   ids, so a change in version control shows what actually changed.
3. **Portable.** A tree is one self-contained file that can be shared,
   imported, and re-exported without loss.

## Example

```json
{
  "format": "skilltree",
  "version": 1,
  "title": "Home Bread Baking",
  "description": "From flour and water to a full sourdough loaf.",
  "author": "Claude",
  "skills": [
    {
      "id": "measure-by-weight",
      "name": "Measure ingredients by weight",
      "description": "Use a kitchen scale for accurate ratios.",
      "requires": []
    },
    {
      "id": "knead",
      "name": "Knead dough",
      "requires": ["measure-by-weight"]
    }
  ]
}
```

## Top level

| Field | Type | Required | Meaning |
|---|---|---|---|
| `format` | string | yes | Always `"skilltree"`. Identifies the file type. |
| `version` | integer | yes | Spec version. Currently `1`. |
| `title` | string | yes | Name of the tree. |
| `description` | string | no | What the tree covers. Defaults to `""`. |
| `author` | string | no | Who wrote it. Defaults to `"Anonymous"`. |
| `layout` | string | no | `"manual"` or `"auto"`. Defaults to `"manual"`. See Layout. |
| `skills` | array | yes | The skills. May be empty, but the key must be present. |

`format` and `version` come first so a reader can identify and reject an
unknown file before parsing the rest.

## Skills

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable identifier, unique within the tree. |
| `name` | string | yes | Display name. |
| `description` | string | no | What learning this involves. Defaults to `""`. |
| `requires` | array | no | Prerequisites. Absent or `[]` means none. |
| `position` | object | no | `{ "x": number, "y": number }`. See Positions. |

### `id`

Lowercase letters, digits and hyphens: `^[a-z0-9]+(-[a-z0-9]+)*$`.

The id is what `requires` points at, so it should describe the skill rather
than its place in the tree — `bulk-fermentation`, not `step-4`. Renaming a
skill's `name` is free; changing its `id` means updating every reference.

Ids are deliberately not integers. Database row ids collide when two trees are
imported into the same system, and they tell a human reader nothing.

## Prerequisites

`requires` lists what must be learned before this skill becomes available.
The entries are **all required** — the default relationship is AND:

```json
"requires": ["knead", "sourdough-starter"]
```

means both `knead` and `sourdough-starter` must be learned first.

For alternative paths, an entry may instead be an `anyOf` object, satisfied
by any one of its members:

```json
"requires": ["knife-skills", { "anyOf": ["gas-oven", "electric-oven"] }]
```

means `knife-skills` **and** (`gas-oven` **or** `electric-oven`).

`anyOf` members must be plain id strings; it does not nest further. Two levels
(an implicit AND containing optional ORs) covers realistic prerequisite
structures without turning the format into a boolean-expression language.

> **Provisional.** How prerequisites combine is deliberately unsettled — see
> "Prerequisite logic" in `TODO.md`. Treat plain AND as the stable part of v1
> and expect `anyOf` to change or be replaced. The site currently implements
> the plain AND case only.
>
> Note that there is only ever one *kind* of link. A second type
> ("recommended") was considered and rejected; see `TODO.md` for why.

### Direction

An edge runs from prerequisite to dependent: the skill named inside `requires`
is the earlier one. A skill with no prerequisites is a **root** — a
"start here" skill. Every valid tree has at least one root, which follows from
the no-cycles rule below.

## Layout

`layout` says who decides where the skills sit.

- **`"manual"`** (the default) — the file's coordinates are authoritative.
  Whoever opens the tree sees the arrangement the author chose.
- **`"auto"`** — the file carries no coordinates at all. The tree is arranged
  from its structure wherever it is opened, and rearranges itself as skills
  and links are added.

Defaulting to `"manual"` means files written before this field existed behave
exactly as they always did.

The two modes are about authorship, not correctness: the same tree in either
mode has the same skills and the same prerequisites. Choose `auto` to write
trees by hand without thinking about coordinates, or to keep a tree tidy while
it is being edited; choose `manual` when the arrangement itself carries
meaning — grouping related branches, or placing a long path deliberately.

### Positions

`position` carries `x` / `y` in abstract canvas units (the renderer decides
pixel scale). It is meaningful only in `manual` mode; in `auto` mode it is
ignored if present, and exports omit it entirely.

In `manual` mode it is still optional per skill. Position some skills and not
others, and the positioned ones are honored while the rest are placed
automatically around them.

An importer must never reject a tree for lacking positions, and a tree's
correctness never depends on them.

## Validity rules

A tree is valid when all of the following hold. `tools/validate-tree.js`
enforces exactly these.

1. `format` is `"skilltree"` and `version` is an integer the reader supports.
2. `title` is a non-empty string.
3. `skills` is an array; every entry is an object.
4. Every skill has a valid `id` and a non-empty `name`.
5. Ids are unique within the tree.
6. Every id referenced in any `requires` (including inside `anyOf`) exists in
   `skills`.
7. No skill lists itself as a prerequisite, directly or transitively — the
   graph is acyclic. (A cycle would make a set of skills permanently
   unreachable, since none could ever be the first one learned.)
8. `position`, when present, has numeric `x` and `y`.

Rules 6 and 7 are the ones worth enforcing on import; the rest are shape
checks a JSON schema would also catch.

## Using it with the site

- **Export:** `GET /api/trees/:id/export` returns a tree in this format, with
  `Content-Disposition: attachment` so a browser downloads it as
  `<tree-title>.json`. It uses the tree's own layout mode; `?layout=auto` or
  `?layout=manual` overrides that.
- **Export with an arrangement:** `POST /api/trees/:id/export` accepts
  `{ layout, positions: { "<skillId>": { x, y } } }`. The Export button uses
  this, because dragging a skill on the page is session-only and never reaches
  the database — so capturing "how it looks right now" requires sending those
  coordinates with the request.
- **Import:** `POST /api/trees/import` with a tree as the body creates a new
  tree and returns it. Import always creates; it never overwrites an existing
  tree. On failure it returns 400 with `{ error, problems: [...] }`, where
  `problems` is the same list `validate()` produces.

The Export button asks which layout mode to write, so a person can rearrange a
tree to taste and choose whether that arrangement travels with the file.

Ids are regenerated on export from skill names (`Knead dough` ->
`knead-dough`), transliterating accented Latin so `Hamur yoğurmak` becomes
`hamur-yogurmak` rather than losing characters. Names that share a slug get a
numeric suffix; names with no Latin equivalent at all fall back to `skill-N`.

Export → import → export is byte-identical, so a tree can make the round trip
without drifting.

Two things the site rejects on import rather than accepting loosely:

- `anyOf`, because the database cannot represent alternatives and silently
  flattening them to a plain AND list would change what the tree means.
- Anything `validate()` rejects — cycles and dangling references especially.

A tree whose skills have no `position` is laid out automatically: each skill's
column is the longest path from a root, so every skill sits to the right of
all of its prerequisites.

## Limits

A tree has to be small enough to draw and small enough to serve, so the
validator enforces both:

| Limit | Value |
|---|---|
| `title` | 120 characters |
| `description` (tree and skill) | 1000 characters |
| `author` | 80 characters |
| skill `name` | 120 characters |
| `skills` | 1000 entries |
| `requires` entries, whole tree | 5000 |

The text limits are the ones the site's own forms have always applied; before
they were written down, an imported file was the one way to store a title no
form would accept, and every one of them is re-served to every visitor on the
homepage.

Text fields also carry no control characters. A single-line field — `title`,
`author`, a skill's `name` — may contain none at all; a `description` may
contain newlines and tabs and nothing else from that range. The reason is
that these strings are printed: into the server's log, and into the terminal
of whoever runs the operator scripts, where an escape sequence is a way to
rewrite what a person sees rather than a character they read.

The size limits exist because arranging a tree costs more than linear time in
its skills and links: a graph of a few hundred densely connected skills takes
seconds to lay out, and one built to be awkward took minutes before these
limits and the layout's own work budget existed. A tree anywhere near either
limit is long past the point of being readable by a person, so the numbers
cost nothing real and stop a file aimed at the machine drawing it.

## Maths in descriptions

A `description` may carry TeX, between `$…$` inline or `$$…$$` for a formula
on its own line:

```json
"description": "Vary the action and the stationary path obeys $$\\frac{d}{dt}\\frac{\\partial L}{\\partial\\dot q}=\\frac{\\partial L}{\\partial q}$$"
```

This is a convention about the text, not a change to the format: a
description is still a plain string, the validator neither checks nor
requires it, and a reader that does not render maths shows the source with
its dollar signs, which stays legible. That is why it is stated here rather
than added as a field.

The site renders it with KaTeX, vendored under `frontend/vendor/katex/`.
Everything outside the delimiters is inserted as text and never parsed, and
KaTeX runs with `trust: false`, so no description can put a link or raw
markup into the page however the file was written. A blank line in a
description starts a new paragraph.

Writing a literal `$` that is not maths is the one thing to watch: a pair of
them on the same line will be read as an expression.

## Extensions

Readers must ignore unrecognized fields rather than failing, so a tree written
against a later version stays usable. Anything experimental or
application-specific goes under an `x-` prefix (`"x-color": "#2f6f4f"`) to
guarantee it will never collide with a field this spec adds later.

Plausible v2 candidates, deliberately left out of v1: `tags`, `resources`
(links per skill), `estimatedHours`, and grouping skills into tiers.
