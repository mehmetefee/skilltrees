// The installable, offline-capable web app in a real browser: the manifest
// parses with no errors and Chromium calls the site installable; the service
// worker installs, takes control and turns on navigation preload; a tree
// visited online still opens offline (page and data), an unvisited page gets
// offline.html; an edit to a file on disk shows on a plain reload while
// online (the worker is network first); the speculation rules are accepted
// and a hovered tree link is prefetched while a draft link is not; and no
// page logs a console error or a CSP violation.
//
// Starts its own server on a throwaway database (tests/helpers/server.js),
// like the other browser suites that need accounts. Needs Playwright,
// installed outside the app:
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/pwa-browser.test.js
//
// The network-first check writes two small probe files into frontend/
// (pwa-probe-<pid>.*, git-ignored) and removes them when it finishes.

// Report requests a service worker makes, so the suite can see the worker go
// to the network rather than its cache. Read when the browser launches.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const PROBE = `pwa-probe-${process.pid}`;
const probeFiles = [path.join(FRONTEND, `${PROBE}.html`), path.join(FRONTEND, `${PROBE}.css`)];
const removeProbes = () => probeFiles.forEach((f) => fs.rmSync(f, { force: true }));
process.on('exit', removeProbes);

const results = [];
const check = (label, cond, detail) => {
  results.push({ label, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${!cond && detail !== undefined ? ` (got: ${JSON.stringify(detail)})` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = await startServer();
  const BASE = srv.base;
  // A persistent profile: Chromium never offers to install from an
  // incognito-style context, which is what newContext() gives.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-pwa-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    viewport: { width: 1280, height: 800 },
  });
  // CSP violations are events on the page; turn them into console errors
  // so one check catches both.
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  const page = context.pages()[0] || (await context.newPage());

  // Every console error and page error, with the phase it happened in.
  // Offline, the browser logs each request that couldn't be sent (the
  // /api/auth/me the pages ask for), and a manifest icon it tried to fetch
  // for itself — Chromium downloads those outside the service worker —
  // expected, and nothing else is.
  let offline = false;
  const problems = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (offline && /ERR_INTERNET_DISCONNECTED|icon from the Manifest/.test(m.text())) return;
    problems.push(`${page.url()} :: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror ${page.url()} :: ${e.message}`));

  const requests = [];
  context.on('request', (r) =>
    requests.push({
      url: r.url(),
      byWorker: !!r.serviceWorker(),
      purpose: r.headers()['sec-purpose'] || null,
    })
  );

  const workerState = () =>
    page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const deadline = Date.now() + 10000;
      while (!(navigator.serviceWorker.controller && reg.active.state === 'activated') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        controlled: !!navigator.serviceWorker.controller,
        state: reg.active && reg.active.state,
        scope: reg.scope,
        preload: (await reg.navigationPreload.getState()).enabled,
      };
    });
  // Waits until the worker has stored `url` (its put() runs after the
  // response has already gone to the page).
  const cached = (url) =>
    page.evaluate(async (u) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await caches.match(u, { ignoreVary: true })) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    }, url);

  try {
    // ---------- a signed-in visitor, a tree to look at, one never opened ----------
    const signup = await page.request.post(`${BASE}/api/auth/signup`, {
      data: { username: 'pwa' + Date.now().toString(36), password: 'correct horse battery staple' },
    });
    check('signed up through the API', signup.status() === 201, signup.status());
    const post = async (p, data) => (await page.request.post(BASE + p, { data })).json();
    const tree = await post('/api/trees', { title: 'Offline bread', description: 'Readable without a network.' });
    const a = await post(`/api/trees/${tree.id}/skills`, { name: 'Mix', pos_x: 0, pos_y: 0 });
    const b = await post(`/api/trees/${tree.id}/skills`, { name: 'Knead', pos_x: 250, pos_y: 0 });
    await post(`/api/trees/${tree.id}/skills`, { name: 'Bake', pos_x: 500, pos_y: 0 });
    await post(`/api/trees/${tree.id}/prereqs`, { skill_id: b.id, prereq_skill_id: a.id });
    const unvisited = await post('/api/trees', { title: 'Never opened' });
    const treeUrl = `${BASE}/tree.html?id=${tree.id}`;

    // ---------- the manifest, and installability ----------
    await page.goto(`${BASE}/`);
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    check('the page links the manifest', manifest.url === `${BASE}/manifest.webmanifest`, manifest.url);
    check('Chromium parses the manifest with no errors or warnings', manifest.errors.length === 0, manifest.errors);
    const parsed = manifest.data ? JSON.parse(manifest.data) : {};
    check('its name is Skill Trees', parsed.name === 'Skill Trees', parsed.name);
    const appId = await cdp.send('Page.getAppId').catch(() => ({}));
    check('the app id is the site root', appId.appId === `${BASE}/`, appId);

    // ---------- the service worker ----------
    const sw = await workerState();
    check('the service worker activates and controls the page', sw.controlled && sw.state === 'activated', sw);
    check('its scope is the whole site', sw.scope === `${BASE}/`, sw.scope);
    check('navigation preload is on', sw.preload === true, sw.preload);
    const installability = await cdp.send('Page.getInstallabilityErrors');
    check(
      'Chromium reports no installability errors',
      installability.installabilityErrors.length === 0,
      installability.installabilityErrors
    );
    const shell = await page.evaluate(async () => {
      const names = await caches.keys();
      const shellName = names.find((n) => n.startsWith('skilltrees-shell-'));
      const keys = shellName ? await (await caches.open(shellName)).keys() : [];
      return { names, shell: keys.map((r) => new URL(r.url).pathname + new URL(r.url).search) };
    });
    check('the app shell is precached', ['/', '/offline.html', '/style.css', '/app.js', '/layout.js'].every((p) => shell.shell.includes(p)), shell);
    check('the tree list is kept for offline', await cached(`${BASE}/api/trees`));
    check('nothing under /api/auth/ is cached', !(await page.evaluate(async () => !!(await caches.match('/api/auth/me')))));

    // ---------- speculation rules ----------
    await cdp.send('Preload.enable');
    const ruleSets = [];
    const prefetches = [];
    cdp.on('Preload.ruleSetUpdated', (e) => ruleSets.push(e.ruleSet));
    cdp.on('Preload.prefetchStatusUpdated', (e) => prefetches.push({ url: e.prefetchUrl, status: e.status, why: e.prefetchStatus }));
    await page.goto(`${BASE}/`);
    await page.waitForSelector(`#tree-grid a[href="/tree.html?id=${tree.id}"]`);
    await sleep(300);
    const rules = ruleSets.find((r) => r.url === `${BASE}/speculationrules.json`);
    check('the speculation rules are loaded from the Speculation-Rules header', !!rules, ruleSets.map((r) => r.url));
    check('and accepted without errors', rules && !rules.errorType && !rules.errorMessage, rules && rules.errorMessage);

    await page.hover(`#tree-grid a[href="/tree.html?id=${tree.id}"]`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !prefetches.some((p) => p.url === treeUrl && p.status === 'Ready')) await sleep(50);
    const prefetched = requests.filter((r) => r.url === treeUrl && r.purpose === 'prefetch');
    check('hovering a tree link prefetches the tree page', prefetched.length > 0, requests.filter((r) => r.url === treeUrl));
    check('and the prefetch completes', prefetches.some((p) => p.url === treeUrl && p.status === 'Ready'), prefetches);

    await page.hover('a[href="/tree.html"]');
    await sleep(800);
    await page.hover('.auth-slot a');
    await sleep(800);
    const wrongly = requests.filter((r) => r.purpose === 'prefetch' && r.url !== treeUrl);
    check('a draft link and the sign-in link are not prefetched', wrongly.length === 0, wrongly);

    await page.click(`#tree-grid a[href="/tree.html?id=${tree.id}"]`);
    await page.waitForSelector('#nodes-layer > g');
    await sleep(200);
    check('the click used the prefetched page', prefetches.some((p) => p.url === treeUrl && p.why === 'PrefetchResponseUsed'), prefetches);

    // ---------- the tree page's server-written metadata ----------
    const ld = await page.evaluate(() => {
      const el = document.querySelector('script[type="application/ld+json"]');
      return el ? JSON.parse(el.textContent) : null;
    });
    check('the tree page carries JSON-LD for the tree', ld && ld['@type'] === 'LearningResource' && ld.name === 'Offline bread', ld);
    check('it lists the skills the tree teaches', ld && JSON.stringify(ld.teaches) === '["Mix","Knead","Bake"]', ld && ld.teaches);

    // ---------- every page, online: no console errors, no CSP violations ----------
    for (const p of ['/', `/tree.html?id=${tree.id}`, '/tree.html', '/viewer.html', '/account.html', '/offline.html']) {
      const res = await page.goto(BASE + p);
      await page.waitForLoadState('networkidle').catch(() => {});
      check(`${p} is served through the worker`, res && res.fromServiceWorker(), res && res.url());
    }
    check('no console errors or CSP violations on any page', problems.length === 0, problems);

    // A navigation answered with a redirect goes through the worker as the
    // browser's own navigation-preload response, and is followed.
    await page.goto(`${BASE}/.well-known/change-password`);
    check(
      '/.well-known/change-password lands on the account page’s password section',
      page.url() === `${BASE}/account.html#account-password`,
      page.url()
    );

    // ---------- network first: an edit on disk shows on a plain reload ----------
    const write = (version, rgb) => {
      fs.writeFileSync(
        probeFiles[0],
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>Probe</title>` +
          // An icon of its own, or the browser asks for /favicon.ico (a 404).
          `<link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" />` +
          `<link rel="stylesheet" href="/${PROBE}.css" /></head>` +
          `<body><main><p id="probe">${version}</p></main></body></html>`
      );
      fs.writeFileSync(probeFiles[1], `#probe { color: rgb(${rgb}); }\n`);
    };
    const probe = () =>
      page.evaluate(() => {
        const el = document.getElementById('probe');
        return { text: el.textContent, color: getComputedStyle(el).color };
      });
    write('first version', '1, 2, 3');
    await page.goto(`${BASE}/${PROBE}.html`);
    let seen = await probe();
    check('the probe page loads', seen.text === 'first version' && seen.color === 'rgb(1, 2, 3)', seen);
    check('and the worker keeps a copy of it', (await cached(`${BASE}/${PROBE}.html`)) && (await cached(`${BASE}/${PROBE}.css`)));
    write('second, edited version', '4, 5, 6');
    const before = requests.length;
    const reloaded = await page.reload();
    seen = await probe();
    check('after editing the files, a plain reload shows the new page', seen.text === 'second, edited version', seen);
    check('and the new stylesheet', seen.color === 'rgb(4, 5, 6)', seen);
    check('the page still came through the worker', reloaded && reloaded.fromServiceWorker());
    const fetchedByWorker = requests.slice(before).filter((r) => r.byWorker).map((r) => new URL(r.url).pathname);
    check('which fetched the stylesheet from the network, not its cache', fetchedByWorker.includes(`/${PROBE}.css`), fetchedByWorker);
    removeProbes();

    // ---------- offline ----------
    await page.goto(treeUrl);
    await page.waitForSelector('#nodes-layer > g');
    check('the tree page is kept for offline', await cached(treeUrl));
    check('and so is its data', await cached(`${BASE}/api/trees/${tree.id}`));

    offline = true;
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('#nodes-layer > g', { timeout: 5000 }).catch(() => {});
    check('offline, the visited tree page still opens', (await page.title()) === 'Offline bread — Skill Trees', await page.title());
    check('with its skills drawn from the cached data', (await page.locator('#nodes-layer > g').count()) === 3);
    check('and its title in place', (await page.inputValue('#tree-title')) === 'Offline bread');

    await page.goto(`${BASE}/`);
    await page.waitForSelector('#tree-grid a', { timeout: 5000 }).catch(() => {});
    check('offline, the homepage lists the trees', (await page.locator(`#tree-grid a[href="/tree.html?id=${tree.id}"]`).count()) === 1);

    const missing = await page.goto(`${BASE}/tree.html?id=${unvisited.id}`);
    check('an unvisited page shows the offline page', (await page.locator('h1').first().textContent()) === "You're offline");
    check('at the address that was asked for', page.url() === `${BASE}/tree.html?id=${unvisited.id}` && missing.fromServiceWorker());
    check('whose "Try again" reloads that address', (await page.getAttribute('a:text("Try again")', 'href')) === '');
    await page.goto(`${BASE}/account.html`);
    check('the account page, which needs the server, is the offline page too', (await page.locator('h1').first().textContent()) === "You're offline");

    await context.setOffline(false);
    offline = false;
    await page.goto(`${BASE}/tree.html?id=${unvisited.id}`);
    await page.waitForSelector('#nodes-layer', { state: 'attached' });
    check('back online, the same address loads the real page', (await page.inputValue('#tree-title')) === 'Never opened');

    // ---------- the Import shortcut ----------
    await page.goto(`${BASE}/#import`);
    await page.waitForSelector('#import-overlay[open]', { timeout: 5000 }).catch(() => {});
    check('/#import (the manifest shortcut) opens the import dialog', await page.locator('#import-overlay[open]').isVisible());
    check('and takes the hash out of the address', new URL(page.url()).hash === '', page.url());

    check('no console errors or CSP violations at any point', problems.length === 0, problems);
  } catch (e) {
    check(`suite ran to completion (${e.message})`, false);
  } finally {
    removeProbes();
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
    await srv.stop();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
