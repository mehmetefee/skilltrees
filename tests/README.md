# Tests

Browser-level tests that drive the real UI with Playwright, plus one pure
unit suite for the format validator.

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
