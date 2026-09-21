# KaTeX 0.18.7, vendored

Renders the TeX in skill descriptions (see the Maths section of `FORMAT.md`).
Vendored rather than loaded from a CDN, for the same two reasons the Inter
fonts are: served from here everything falls under `default-src 'self'`, so
the Content-Security-Policy in `backend/server.js` needs no exception at all,
and no third party learns who reads a tree.

## Provenance

Downloaded from `https://cdn.jsdelivr.net/npm/katex@0.18.7/dist/`, and
verified two ways before being committed:

| File | SHA-384 (as published on katex.org/docs/browser) |
|---|---|
| `katex.min.css` | `sha384-JctiRyLzXCrSoOOzFlSoWLdyzQl7OrrRnhyeBmzB6ZWtcjccUyc8lCQJqIbs3uQX` |
| `katex.min.js` | `sha384-+7Keh381hSkXmXqnjC0JBM/kzsN6TFj+wMKychSLjTvJ8/0ElMde2uKl8i6p6Buj` |

Both hashes match, and every file here was also fetched from unpkg and found
byte-identical, so what is committed is what npm published rather than what
one CDN chose to serve.

## What was left out

Only the `.woff2` fonts are here — 20 files, 304 KB. `katex.min.css` also
lists `.woff` and `.ttf` in each `@font-face`, but a browser takes the first
format it supports and never requests the rest, so those would be dead weight
on disk. This is the same call already made for Inter. The CSS itself is
unmodified, which is what keeps the hash above meaningful.

A font is fetched only when a rule actually matches, so a description with no
maths in it costs nothing, and the usual page pulls two or three faces.

## Upgrading

Replace all three parts together, re-check the hashes against katex.org, and
re-run the TeX parse check over the example trees. Nothing in the app calls
KaTeX except `renderDescription()` in `frontend/app.js`, which passes
`trust: false` so no `\url`, `\href` or `\html*` command can put a link or raw
markup into the page — descriptions arrive from imported JSON, so that flag is
load-bearing rather than tidy.
