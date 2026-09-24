// Shared plumbing for the Playwright suites (tests/*.test.js): which server to
// drive, a browser, signing up, and the PASS/FAIL/SKIP reporting every suite
// prints. Playwright is installed outside the app, so this is the one helper
// that needs it:
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/core-crud.test.js
//
// By default a suite gets a server of its own on a throwaway database
// (helpers/server.js): signups are rate-limited per address, ten per fifteen
// minutes, so a shared server runs out of them after a few runs. BASE_URL aims
// a suite at a running server instead; suites delete the trees they make
// either way.

const { chromium } = require('playwright');
const { startServer } = require('./server');

// The example tree backend/db/seed.js adds. It predates accounts, so it has
// no owner and nobody — signed in or not — can change it.
const SEEDED_TITLE = 'Home Bread Baking';

function launchBrowser() {
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
}

// { base, srv }: BASE_URL if set, otherwise a fresh server (srv is null for
// BASE_URL, so callers know there is nothing to stop and no database file).
async function startTarget({ seed = false } = {}) {
  if (process.env.BASE_URL) return { base: process.env.BASE_URL.replace(/\/+$/, ''), srv: null };
  const srv = await startServer({ seed });
  return { base: srv.base, srv };
}

// PASS/FAIL lines as every suite prints them, a SKIP line for checks that
// can't be made here, and the closing tally and exit code.
function createReporter() {
  const results = [];
  const skipped = [];
  const check = (label, cond, detail) => {
    results.push({ label, ok: !!cond });
    const shown = !cond && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 400)}` : '';
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${shown}`);
    return !!cond;
  };
  const skip = (label, why) => {
    skipped.push(label);
    console.log(`SKIP - ${label}${why ? ` (${why})` : ''}`);
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    const skipNote = skipped.length ? `, ${skipped.length} skipped` : '';
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipNote}`);
    if (failed.length) console.log('FAILURES:', failed.map((f) => f.label));
    process.exit(failed.length || results.length === 0 ? 1 : 0);
  };
  return { check, skip, finish };
}

// Console errors and uncaught exceptions on a page, collected as text.
function watchConsole(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}

// Requests to the API that could change something (anything but GET/HEAD),
// as "METHOD /path" strings, seen two ways:
//   network    every one the page sent, for the life of the page (Playwright's
//              request events, which arrive asynchronously);
//   started()  every one the current document has *called fetch() for*,
//              recorded synchronously inside the page — so asking right after
//              a gesture can't miss a request that is still on its way out.
// Must be called before the page's first navigation.
async function watchWrites(page) {
  const isWrite = (method, pathname) => pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD';
  const network = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (isWrite(req.method(), pathname)) network.push(`${req.method()} ${pathname}`);
  });
  await page.addInitScript(() => {
    const writes = [];
    Object.defineProperty(window, '__apiWrites', { value: writes });
    const original = window.fetch;
    window.fetch = function (input, init) {
      try {
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const target = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
        const { pathname } = new URL(target, location.href);
        if (pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') writes.push(`${method} ${pathname}`);
      } catch (e) {
        /* recording must never break the page */
      }
      return original.apply(this, arguments);
    };
  });
  return { network, started: () => page.evaluate(() => window.__apiWrites.slice()) };
}

// Signs up a fresh account from inside a browser context. The context's
// request client shares its cookie jar, so every page in it is signed in.
async function signUp(context, base, prefix) {
  const username = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 40);
  const res = await context.request.post(`${base}/api/auth/signup`, {
    data: { username, password: 'correct horse battery staple' },
  });
  if (res.status() !== 201) {
    throw new Error(`signup ${username} failed: ${res.status()} ${await res.text()}`);
  }
  return username;
}

// The seeded tree's id. Found by title, lowest id first, so it also works
// against a server that has other trees (a copy imported under the same
// title comes later).
async function seededTreeId(request, base) {
  const trees = await (await request.get(`${base}/api/trees`)).json();
  const seeded = trees.filter((t) => t.title === SEEDED_TITLE).sort((a, b) => a.id - b.id)[0];
  if (!seeded) {
    throw new Error(`no "${SEEDED_TITLE}" tree on ${base}: run backend/db/seed.js against its database`);
  }
  return seeded.id;
}

module.exports = {
  SEEDED_TITLE,
  launchBrowser,
  startTarget,
  createReporter,
  watchConsole,
  watchWrites,
  signUp,
  seededTreeId,
};
