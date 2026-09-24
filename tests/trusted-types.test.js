// Trusted Types in a real browser. Every page is served with
// `require-trusted-types-for 'script'`, so Chromium refuses a plain string at
// every DOM XSS sink — innerHTML (even ''), insertAdjacentHTML, a script's
// src, a worker's URL, serviceWorker.register() — and a page that still
// used one would throw and log a violation. This drives every page and the
// UI each builds on the fly (cards, search, the featured hero and its SVG
// markers, the import problems, the side panel, link mode, the viewer and
// its drop zone, the account page's lists and dialogs, the offline page) and
// fails on any violation or console error. Titles, names and descriptions
// are hostile markup throughout, and must come out as text.
//
// Then it checks the enforcement itself: the header is there, each sink
// throws on a string and is reported, and the one policy
// (frontend/trusted-types.js) is as narrow as it says. And, without a
// browser, that the CSP names exactly the policies that file makes and that
// no script has picked an HTML sink up again.
//
// Starts its own server on a throwaway database, seeded with the example
// tree, with PUBLIC_ORIGIN set so the passkey section is on (a virtual
// authenticator stands in for the device):
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/trusted-types.test.js

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { SEEDED_TITLE, launchBrowser, createReporter, seededTreeId } = require('./helpers/browser');
const { startServer } = require('./helpers/server');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const FEATURE = path.join(ROOT, 'backend', 'db', 'feature.js');
const PASSWORD = 'correct horse battery staple';
const FIREFOX_ON_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

// Markup where text belongs. Each must reach the screen as these exact
// characters, and never as an element.
const HOSTILE_TITLE = '<img src=x onerror=alert(1)>';
const HOSTILE_SKILL = '<svg onload=alert(2)>';
const HOSTILE_ADDED = '<iframe srcdoc=x>';
const HOSTILE_KEY = '<b>my key</b>';
const HOSTILE_TREE = {
  format: 'skilltree',
  version: 1,
  title: HOSTILE_TITLE,
  description: '</p><script>alert(3)</script>',
  author: '<b>author</b>',
  layout: 'auto',
  skills: [
    { id: 'mix', name: HOSTILE_SKILL, description: '<a href="javascript:alert(4)">x</a>' },
    { id: 'knead', name: 'Knead & fold', requires: ['mix'] },
    { id: 'bake', name: '<i>Bake</i>', requires: ['knead'] },
  ],
};
// Refused on import, with problems that quote the file back.
const BROKEN_TREE = {
  format: 'skilltree',
  version: 1,
  title: 'Broken',
  skills: [
    { id: HOSTILE_TITLE, name: 'x' },
    { id: 'ok', name: 'y', requires: ['<b>missing</b>'] },
  ],
};
const VIEWER_TREE = {
  format: 'skilltree',
  version: 1,
  title: 'Viewer only',
  skills: [
    { id: 'a', name: 'First', position: { x: 0, y: 0 } },
    { id: 'b', name: 'Second', requires: ['a'], position: { x: 260, y: 0 } },
  ],
};

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Code lines only: a sink named in a comment is documentation.
function codeLines(file) {
  return fs
    .readFileSync(path.join(FRONTEND, file), 'utf8')
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

const { check, skip, finish } = createReporter();

(async () => {
  const port = Number(process.env.PORT) || (await freePort());
  const srv = await startServer({ seed: true, env: { PORT: String(port), PUBLIC_ORIGIN: `http://localhost:${port}` } });
  const BASE = srv.base;
  const browser = await launchBrowser();
  const contexts = [];

  // A browser profile that reports every CSP violation — Trusted Types ones
  // included — as a console error, and sorts what the console says into
  // violations (never allowed), expected failures (a step that sets `allow`
  // is making a request fail on purpose) and everything else.
  async function openProfile({ authenticator = false, ...options } = {}) {
    const context = await browser.newContext(options);
    contexts.push(context);
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`CSP violation: ${e.effectiveDirective} blocked ${e.blockedURI}${e.sample ? ` (${e.sample})` : ''}`);
      });
    });
    const page = await context.newPage();
    const watch = { violations: [], problems: [], allow: null, dialogs: [] };
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = `${page.url()} :: ${m.text()}`;
      if (/CSP violation|Refused to|Trusted(HTML|Script|ScriptURL|TypePolicy)/.test(m.text())) watch.violations.push(text);
      else if (!(watch.allow && watch.allow.test(m.text()))) watch.problems.push(text);
    });
    page.on('pageerror', (e) => watch.problems.push(`pageerror ${page.url()} :: ${e.message}`));
    page.on('dialog', (d) => {
      watch.dialogs.push(d.message());
      d.accept();
    });
    if (authenticator) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable', { enableUI: false });
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
    }
    return { context, page, watch };
  }

  // Expected failures, for one step: requests refused on purpose log a 4xx.
  const failing = async (watch, step) => {
    watch.allow = /Failed to load resource: the server responded with a status of 4\d\d/;
    try {
      await step();
    } finally {
      watch.allow = null;
    }
  };
  const texts = (page, selector) => page.locator(selector).allTextContents();
  const count = (page, selector) => page.locator(selector).count();
  const nodeByName = (page, layer, name) =>
    page.locator(`${layer} g[data-skill-id]`, { has: page.locator('.node-label', { hasText: name }) }).first();

  try {
    // ================= without a browser: the header, the policies, the sinks

    const home = await srv.request('/');
    const csp = home.headers.get('content-security-policy');
    check('pages require Trusted Types for every script sink', csp.includes("require-trusted-types-for 'script'"), csp);
    const listed = (/(?:^|;\s*)trusted-types ([^;]*)/.exec(csp) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
    const made = [...fs.readFileSync(path.join(FRONTEND, 'trusted-types.js'), 'utf8').matchAll(/createPolicy\('([^']+)'/g)].map((m) => m[1]);
    check('the CSP names exactly the policies trusted-types.js makes',
      made.length > 0 && listed.slice().sort().join() === made.slice().sort().join(), { listed, made });
    check('none of them is a default policy, and duplicates are not allowed',
      !listed.includes('default') && !listed.includes("'allow-duplicates'") && !listed.includes("'none'"), listed);

    const scripts = fs.readdirSync(FRONTEND).filter((f) => f.endsWith('.js'));
    const SINKS = [
      /\.(innerHTML|outerHTML)\s*\+?=(?!=)/,
      /\.insertAdjacentHTML\s*\(/,
      /\bdocument\.write(ln)?\s*\(/,
      /\.parseFromString\s*\(/,
      /\.createContextualFragment\s*\(/,
      /\b(setHTMLUnsafe|parseHTMLUnsafe)\s*\(/,
      /\.srcdoc\s*=/,
      /\bnew\s+(Shared)?Worker\s*\(/,
      /\bimportScripts\s*\(/,
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\bset(Timeout|Interval)\s*\(\s*['"`]/,
    ];
    const found = [];
    for (const file of scripts) {
      for (const { line, n } of codeLines(file)) {
        if (SINKS.some((re) => re.test(line))) found.push(`${file}:${n}: ${line.trim()}`);
        if (file !== 'trusted-types.js' && /createPolicy\s*\(/.test(line)) found.push(`${file}:${n}: ${line.trim()}`);
      }
    }
    check('no frontend script hands a string to an HTML or script sink, or makes a policy of its own', found.length === 0, found);

    // ================= the owner: account page, homepage, import, tree page

    const owner = await openProfile({ authenticator: true, acceptDownloads: true });
    const { page } = owner;
    const username = `tt${Date.now().toString(36)}`.slice(0, 20);

    // --- signed out, then signing up through the form
    await page.goto(`${BASE}/account.html`);
    await page.waitForSelector('#sign-in-view:not([hidden])');
    await page.locator('#passkey-sign-in-button').waitFor({ state: 'visible', timeout: 5000 });
    check('account page, signed out: the sign-in view and its passkey button', true);
    check('the page has a skip link to its <main>',
      (await page.getAttribute('body > a.skip-link', 'href')) === '#main' && (await count(page, 'main#main[tabindex="-1"] #auth-form')) === 1);
    await page.click('#auth-toggle');
    await page.locator('#passkey-sign-up-button').waitFor({ state: 'visible' });
    await page.fill('#auth-username', username);
    await page.fill('#auth-password', PASSWORD);
    await Promise.all([page.waitForURL(`${BASE}/#browse`), page.click('#auth-submit')]);

    // --- the homepage, signed in
    await page.waitForSelector('.auth-slot .user-chip');
    const chip = await page.evaluate(() => {
      const c = document.querySelector('.auth-slot .user-chip');
      return {
        label: c.getAttribute('aria-label'),
        role: c.getAttribute('role'),
        title: c.title,
        name: c.querySelector('.auth-name').textContent,
        avatar: c.querySelector('.user-avatar[aria-hidden="true"]').textContent,
        signOut: c.querySelector('[data-sign-out]').getAttribute('aria-label'),
      };
    });
    check('the signed-in chip is built as nodes: name, avatar, sign-out button',
      chip.name === username && chip.avatar === username[0].toUpperCase() && chip.signOut === `Sign out of ${username}`, chip);
    check('and names nothing on the role-less chip itself (ARIA forbids it)', chip.label === null && chip.role === null, chip);

    // --- the import dialog, with problems
    await page.click('[data-open="import"]');
    await page.waitForSelector('#import-overlay[open]');
    await page.click('#import-form button[type=submit]');
    await page.waitForSelector('#import-problems:not([hidden])');
    check('import with nothing pasted says so',
      (await page.textContent('#import-problems strong')) === 'Nothing to import.' &&
        (await texts(page, '#import-problems li')).join() === 'Paste a skill tree, or choose a file.');
    await page.fill('#import-text', '{');
    await page.click('#import-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#import-problems strong')?.textContent === 'That is not valid JSON.');
    check('import of broken JSON lists the parse error', (await count(page, '#import-problems li')) === 1);
    await failing(owner.watch, async () => {
      await page.fill('#import-text', JSON.stringify(BROKEN_TREE));
      await page.click('#import-form button[type=submit]');
      await page.waitForFunction(() => /problem/.test(document.querySelector('#import-problems strong')?.textContent || ''));
    });
    const problems = await texts(page, '#import-problems li');
    check("the server's problems are listed, quoting the file as text",
      problems.some((p) => p.includes(`"${HOSTILE_TITLE}"`)) && problems.some((p) => p.includes('"<b>missing</b>"')), problems);
    check('none of it became an element', (await count(page, '#import-problems img, #import-problems b')) === 0);

    // --- a tree of hostile names, imported and opened as its owner
    await page.fill('#import-text', JSON.stringify(HOSTILE_TREE));
    await Promise.all([page.waitForURL(/\/tree\.html\?id=\d+$/), page.click('#import-form button[type=submit]')]);
    const hostileId = Number(new URL(page.url()).searchParams.get('id'));
    await page.waitForFunction(() => document.querySelectorAll('#nodes-layer > g').length === 3);
    check('tree page, owner: hostile names are node labels, as text',
      (await texts(page, '#nodes-layer .node-label')).includes(HOSTILE_SKILL) && (await count(page, '#nodes-layer image, #nodes-layer foreignObject')) === 0);

    await nodeByName(page, '#nodes-layer', '<i>Bake</i>').click();
    await page.waitForSelector('#side-panel.open');
    check('the side panel names the skill as text', (await page.textContent('#panel-name')) === '<i>Bake</i>' && (await count(page, '#side-panel i')) === 0);
    check('its "Requires" row has a remove button whose × is hidden from screen readers',
      (await page.textContent('#panel-prereqs .panel-jump')) === 'Knead & fold' &&
        (await page.textContent('#panel-prereqs .panel-unlink > span[aria-hidden="true"]')) === '×');
    check('and an empty "Unlocks" list says so', (await page.textContent('#panel-unlocks .panel-empty')) === 'Nothing yet.');
    check('the highlighted path got its coloured arrowheads (SVG markers built as nodes)',
      (await count(page, '#graph-svg defs marker[id^="arrowhead-dyn-"] polygon')) >= 1);
    await page.click('#panel-prereqs .panel-unlink');
    await page.waitForFunction(() => document.querySelector('#panel-prereqs .panel-empty')?.textContent === 'None — this is a starting skill.');
    check('removing the link from the panel redraws its lists', (await count(page, '#edges-layer path.edge-line:not(.hit)')) === 1);
    await page.click('#panel-close');

    await page.click('#link-mode-btn');
    await nodeByName(page, '#nodes-layer', 'Knead & fold').click();
    await page.waitForSelector('#nodes-layer g[aria-label*="chosen as the prerequisite"]');
    await nodeByName(page, '#nodes-layer', '<i>Bake</i>').click();
    await page.waitForFunction(() => document.querySelectorAll('#edges-layer path.edge-line:not(.hit)').length === 2);
    check('link mode draws the new edge', true);

    await page.waitForFunction(() => document.getElementById('link-mode-btn').textContent === 'Link prerequisite');
    await page.click('#add-skill-btn');
    await page.waitForSelector('#skill-modal-overlay[open]');
    await page.fill('#skill-name', HOSTILE_ADDED);
    await page.click('#new-skill-form button[type=submit]');
    await page.waitForFunction(() => document.querySelectorAll('#nodes-layer > g').length === 4);
    check('a skill added through the dialog is drawn with its name as text',
      (await texts(page, '#nodes-layer .node-label')).includes(HOSTILE_ADDED) && (await count(page, '#nodes-layer iframe')) === 0);

    // --- a draft
    await page.goto(`${BASE}/tree.html`);
    await page.waitForFunction(() => document.getElementById('tree-meta-time').textContent.includes('not saved yet'));
    check('a draft (tree page with no id) loads', new URL(page.url()).search === '');

    // --- the featured spot goes to the hostile tree (server side, as always)
    execFileSync(process.execPath, ['--no-warnings', FEATURE, String(hostileId)], {
      env: { ...process.env, SKILLTREE_DB: srv.dbPath },
      stdio: 'pipe',
    });
    // And enough trees below it for the page to scroll past it, which is
    // when the scroll hint rewrites itself.
    for (let i = 1; i <= 12; i++) {
      await owner.context.request.post(`${BASE}/api/trees`, { data: { title: `Filler ${i}` } });
    }

    // --- the account page, signed in: every section
    await page.goto(`${BASE}/account.html`);
    await page.waitForSelector('#account-view:not([hidden])');
    await page.waitForSelector('#sign-in-methods-list li');
    check('sign-in methods are listed', (await page.textContent('#sign-in-methods-list .sign-in-method-name')) === 'Password');
    await page.waitForSelector('#account-passkeys:not([hidden]) #passkey-empty:not([hidden])');
    await page.click('#passkey-add');
    await page.waitForSelector('#passkey-list li.passkey-item');
    await page.waitForFunction(() => /Passkeys/.test(document.getElementById('sign-in-methods-list').textContent));
    check('adding a passkey lists it, and the methods list gains a Passkeys row', (await count(page, '#passkey-list li')) === 1);
    await page.click('#passkey-list [data-action="rename"]');
    await page.fill('.passkey-rename input', HOSTILE_KEY);
    await page.press('.passkey-rename input', 'Enter');
    await page.waitForFunction((n) => document.querySelector('#passkey-list .sign-in-method-name')?.textContent === n, HOSTILE_KEY);
    check('a renamed passkey shows its name as text', (await count(page, '#passkey-list b')) === 0);
    await page.click('#passkey-list [data-action="remove"]');
    await page.waitForSelector('#passkey-list button:text("Confirm remove")');
    await page.click('#passkey-list button:text("Cancel")');
    await page.waitForSelector('#passkey-list [data-action="remove"]');
    check('removing asks to confirm, and Cancel puts the row back', true);

    await srv.request('/api/auth/login', {
      method: 'POST',
      body: { username, password: PASSWORD },
      headers: { 'User-Agent': FIREFOX_ON_WINDOWS },
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#session-list .session').length === 2);
    await page.locator('#session-list .session', { hasText: 'Firefox on Windows' }).locator('button').click();
    await page.waitForFunction(() => document.querySelectorAll('#session-list .session').length === 1);
    check('sessions are listed, and another one can be ended', true);

    await failing(owner.watch, async () => {
      await page.fill('#current-password', 'not the password');
      await page.fill('#new-password', 'an entirely new passphrase');
      await page.click('#password-submit');
      await page.waitForSelector('#password-error:not([hidden])');
    });
    check('a wrong current password is reported', (await page.textContent('#password-error')).includes('not your current password'));

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#data-download')]);
    check('the data download works', download.suggestedFilename() === `skilltrees-${username}.json`);

    await page.click('#delete-open');
    await page.waitForSelector('#delete-dialog[open]');
    await page.fill('#delete-confirm-username', 'somebody-else');
    await page.fill('#delete-password', PASSWORD);
    await page.click('#delete-submit');
    await page.waitForSelector('#delete-error:not([hidden])');
    check('the delete dialog opens and refuses a wrong username', (await page.textContent('#delete-error')).includes('Type your username'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('delete-dialog').open);

    // ================= a visitor: homepage, search, tree pages, viewer

    const visitor = await openProfile();
    const v = visitor.page;
    await v.goto(`${BASE}/`);
    await v.waitForSelector('#featured-hero:not([hidden])');
    await v.waitForSelector('.tree-card');
    check('the featured hero shows the hostile title as text',
      (await v.textContent('#featured-title')) === HOSTILE_TITLE && (await count(v, '#featured-hero img')) === 0);
    check('its graph carries the three arrowhead markers', (await count(v, '#featured-svg > defs > marker > polygon')) === 3);
    await nodeByName(v, '#featured-svg', '<i>Bake</i>').dispatchEvent('mouseenter');
    await v.waitForSelector('#featured-svg marker[id^="arrowhead-dyn-"]', { state: 'attached' });
    check('hovering a skill colours its path, arrowheads included', true);
    const titles = await texts(v, '.tree-card h3');
    check('tree cards show titles as text', titles.includes(HOSTILE_TITLE) && titles.includes(SEEDED_TITLE) && (await count(v, '#tree-grid img')) === 0, titles);
    check('and meta lines as text',
      (await texts(v, '.tree-card .meta span')).some((t) => t.startsWith('by <b>author</b> · ')) && (await count(v, '#tree-grid b')) === 0);
    check('signed out, the header offers "Sign in"', (await v.textContent('.auth-slot a.btn-signin')) === 'Sign in');

    // --- the scroll hint, rewritten as the page scrolls
    const hint = () => v.evaluate(() => {
      const a = document.getElementById('scroll-hint-btn');
      return { text: a.textContent, arrow: a.querySelector('span[aria-hidden="true"]')?.textContent, href: a.getAttribute('href') };
    });
    const roomToScroll = await v.evaluate(() => {
      const hero = document.getElementById('featured-hero');
      return document.documentElement.scrollHeight - innerHeight >= hero.offsetTop + hero.offsetHeight - 120;
    });
    if (!roomToScroll) {
      skip('the scroll hint swaps between its two labels', 'the page is too short to scroll past the hero');
    } else {
      await v.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      await v.waitForSelector('#scroll-hint-btn.is-fixed');
      const down = await hint();
      await v.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await v.waitForSelector('#scroll-hint-btn:not(.is-fixed)');
      const up = await hint();
      check('the scroll hint swaps between its two labels',
        down.text === '↑ Featured tree' && down.arrow === '↑' && down.href === '#featured' &&
          up.text === 'Browse all trees ↓' && up.arrow === '↓' && up.href === '#browse', { down, up });
    }

    // --- search
    await v.fill('#tree-search', 'bread');
    await v.waitForSelector('#search-dropdown:not([hidden]) .search-item');
    check('search lists matches', (await v.textContent('.search-item .search-item-title')) === SEEDED_TITLE &&
      (await v.textContent('.search-item .search-item-meta')) === '9 skills');
    await v.press('#tree-search', 'ArrowDown');
    check('arrowing down highlights the first one',
      (await v.getAttribute('#tree-search', 'aria-activedescendant')) === 'search-option-0' && (await count(v, '.search-item.active[aria-selected="true"]')) === 1);
    await v.press('#tree-search', 'Escape');
    await v.fill('#tree-search', '<img');
    await v.waitForSelector('#search-dropdown:not([hidden]) .search-item');
    check('a hostile title in the results is text',
      (await v.textContent('.search-item .search-item-title')) === HOSTILE_TITLE && (await count(v, '#search-dropdown img')) === 0);
    await v.press('#tree-search', 'Escape');
    await v.press('#tree-search', 'Escape');

    // --- tree pages, read only
    const seededId = await seededTreeId(visitor.context.request, BASE);
    await v.goto(`${BASE}/tree.html?id=${seededId}`);
    await v.waitForFunction(() => document.querySelectorAll('#nodes-layer > g').length === 9);
    const withPrereq = v.locator('#nodes-layer g[data-skill-id]', { has: v.locator('.node-card.locked') }).first();
    await withPrereq.click();
    await v.waitForSelector('#side-panel.open');
    check('tree page, visitor: the side panel lists links with no way to remove them',
      (await count(v, '#panel-prereqs .panel-jump')) >= 1 && (await count(v, '.panel-unlink')) === 0);
    await v.click('#panel-close');
    await v.goto(`${BASE}/tree.html?id=${hostileId}`);
    await v.waitForFunction(() => document.querySelectorAll('#nodes-layer > g').length === 4);
    check('and the hostile tree reads as text', (await v.inputValue('#tree-title')) === HOSTILE_TITLE &&
      (await texts(v, '#nodes-layer .node-label')).includes(HOSTILE_SKILL));

    // --- the viewer, with nothing loaded
    await v.goto(`${BASE}/viewer.html`);
    await v.waitForSelector('#viewer-empty[open]');
    await v.click('#modal-load-btn');
    check('viewer, empty: loading nothing says so', (await v.textContent('#modal-problems')) === 'Please choose a file or paste JSON.');
    await v.fill('#modal-text-input', '{');
    await v.click('#modal-load-btn');
    check('and broken JSON is reported', (await v.textContent('#modal-problems')).startsWith('Invalid JSON: '));
    await v.fill('#modal-text-input', JSON.stringify(HOSTILE_TREE));
    await v.click('#modal-load-btn');
    await v.waitForFunction(() => document.querySelectorAll('#nodes-layer > g').length === 3);
    check('a pasted tree is drawn, its title as text', (await v.textContent('#viewer-title')) === HOSTILE_TITLE);
    await nodeByName(v, '#nodes-layer', HOSTILE_SKILL).click();
    await v.waitForSelector('#side-panel.open');
    check('its side panel fills in, empty lists included',
      (await v.textContent('#panel-name')) === HOSTILE_SKILL &&
        (await v.textContent('#panel-prereqs .panel-empty')) === 'None — this is a starting skill.' &&
        (await v.textContent('#panel-unlocks .panel-jump')) === 'Knead & fold');
    await v.click('#panel-close');
    const drop = await v.evaluate(() => {
      const style = (sel) => getComputedStyle(document.querySelector(sel));
      return {
        icon: [document.querySelector('.drop-zone-icon').textContent, style('.drop-zone-icon').fontSize, style('.drop-zone-icon').marginBottom],
        hint: [document.querySelector('.drop-zone-hint').textContent, style('.drop-zone-hint').fontSize, style('.drop-zone-hint').fontWeight],
        hidden: document.querySelector('.drop-zone-overlay').getAttribute('aria-hidden'),
      };
    });
    check('the drop zone is built, and looks as it did',
      drop.icon.join() === '📂,36px,12px' && drop.hint.join() === 'Supports valid Skill Tree JSON files,13px,400' && drop.hidden === 'true', drop);
    await v.dispatchEvent('body', 'dragenter');
    await v.waitForSelector('.drop-zone-overlay.active');
    await v.dispatchEvent('body', 'dragleave');
    await v.waitForSelector('.drop-zone-overlay:not(.active)');
    check('and shows while a file is dragged over the page', true);

    // --- the viewer, handed a tree by the import dialog
    await v.goto(`${BASE}/`);
    await v.click('[data-open="import"]');
    await v.waitForSelector('#import-overlay[open]');
    await v.fill('#import-text', JSON.stringify(VIEWER_TREE));
    await Promise.all([v.waitForURL(`${BASE}/viewer.html`), v.click('#import-viewer-btn')]);
    await v.waitForFunction(() => document.querySelectorAll('#nodes-layer > g').length === 2);
    check('viewer, with a tree: "Open in viewer" draws it', (await v.textContent('#viewer-title')) === 'Viewer only');

    // ================= the offline page, and the worker it registers

    const traveller = await openProfile();
    const t = traveller.page;
    await t.goto(`${BASE}/offline.html`);
    const worker = await t.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const deadline = Date.now() + 10000;
      while (reg.active.state !== 'activated' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return { script: reg.active.scriptURL, state: reg.active.state };
    });
    check('offline.html registers the service worker through the policy',
      worker.script === `${BASE}/sw.js` && worker.state === 'activated', worker);
    traveller.watch.allow = /ERR_INTERNET_DISCONNECTED|icon from the Manifest/;
    await traveller.context.setOffline(true);
    await t.goto(`${BASE}/tree.html?id=987654`);
    check('offline, an unvisited page gets offline.html, scripts and policy from the cache',
      (await t.locator('h1').first().textContent()) === "You're offline");
    // Closed while still offline: the manifest icon the browser fetches for
    // itself can report its failure late, and it belongs to this phase.
    await traveller.context.close();

    // ================= the enforcement itself

    const prober = await openProfile();
    const p = prober.page;
    await p.addInitScript(() => {
      window.__violations = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        window.__violations.push({ directive: e.effectiveDirective, sample: e.sample })
      );
    });
    const response = await p.goto(`${BASE}/`);
    await p.waitForSelector('.tree-card');
    const pageCsp = response.headers()['content-security-policy'];
    check("the page's CSP carries require-trusted-types-for 'script'", /(^|; )require-trusted-types-for 'script'(;|$)/.test(pageCsp), pageCsp);

    const sinks = await p.evaluate(async () => {
      const outcome = (fn) => {
        try {
          fn();
          return 'allowed';
        } catch (e) {
          return e.name;
        }
      };
      const host = document.body.appendChild(document.createElement('div'));
      return {
        'innerHTML = markup': outcome(() => (host.innerHTML = '<b>x</b>')),
        "innerHTML = ''": outcome(() => (host.innerHTML = '')),
        outerHTML: outcome(() => (host.outerHTML = '<b>x</b>')),
        insertAdjacentHTML: outcome(() => host.insertAdjacentHTML('beforeend', '<b>x</b>')),
        'document.write': outcome(() => document.write('<b>x</b>')),
        'DOMParser.parseFromString': outcome(() => new DOMParser().parseFromString('<b>x</b>', 'text/html')),
        'Range.createContextualFragment': outcome(() => document.createRange().createContextualFragment('<b>x</b>')),
        'iframe srcdoc': outcome(() => (document.createElement('iframe').srcdoc = '<b>x</b>')),
        'script src': outcome(() => (document.createElement('script').src = '/app.js')),
        'script text': outcome(() => (document.createElement('script').text = 'alert(1)')),
        'new Worker': outcome(() => new Worker('/layout.js')),
        'serviceWorker.register': await navigator.serviceWorker.register('/sw.js').then(() => 'allowed', (e) => e.name),
        unchanged: host.childNodes.length === 0,
      };
    });
    const { unchanged, ...stringSinks } = sinks;
    check('assigning a plain string to innerHTML throws', sinks['innerHTML = markup'] === 'TypeError', sinks);
    check('every DOM and script-URL sink refuses a plain string',
      Object.values(stringSinks).every((o) => o === 'TypeError') && unchanged, sinks);

    // Strings as code: not eval() here — the DevTools protocol that runs
    // page.evaluate() lifts the page's eval rules for what it runs — but a
    // string timer and a javascript: link, which the page itself compiles.
    const ran = await p.evaluate(async () => {
      let timer = 'allowed';
      try {
        setTimeout('window.__ranTimer = true', 0);
      } catch (e) {
        timer = e.name;
      }
      const link = document.body.appendChild(document.createElement('a'));
      link.href = 'javascript:window.__ranLink = true';
      link.click();
      link.remove();
      await new Promise((r) => setTimeout(r, 300));
      return { timer, timerRan: window.__ranTimer === true, linkRan: window.__ranLink === true };
    });
    check('and a string never runs as code: a string timer throws, a javascript: link does nothing',
      ran.timer === 'TypeError' && !ran.timerRan && !ran.linkRan, ran);

    const policy = await p.evaluate(() => {
      const outcome = (fn) => {
        try {
          fn();
          return 'allowed';
        } catch (e) {
          return e.name;
        }
      };
      const url = SkillTreeTrustedTypes.serviceWorkerURL('/sw.js');
      try {
        window.SkillTreeTrustedTypes = { serviceWorkerURL: (u) => u };
      } catch (e) {
        /* read-only, as it should be */
      }
      return {
        noDefault: trustedTypes.defaultPolicy === null,
        trusted: trustedTypes.isScriptURL(url) && String(url) === '/sw.js',
        query: outcome(() => SkillTreeTrustedTypes.serviceWorkerURL('/sw.js?v=2')),
        elsewhere: outcome(() => SkillTreeTrustedTypes.serviceWorkerURL('https://evil.example/sw.js')),
        otherScript: outcome(() => SkillTreeTrustedTypes.serviceWorkerURL('/app.js')),
        stillPolicy: trustedTypes.isScriptURL(SkillTreeTrustedTypes.serviceWorkerURL('/sw.js')),
        makeDefault: outcome(() => trustedTypes.createPolicy('default', { createHTML: (s) => s })),
        duplicate: outcome(() => trustedTypes.createPolicy('service-worker-url', { createScriptURL: (s) => s })),
        unlisted: outcome(() => trustedTypes.createPolicy('anything-else', { createHTML: (s) => s })),
      };
    });
    check('the service-worker-url policy vouches for /sw.js, and there is no default policy',
      policy.trusted && policy.noDefault && policy.stillPolicy, policy);
    check('and for nothing else: another path, a query, another origin',
      policy.query === 'TypeError' && policy.elsewhere === 'TypeError' && policy.otherScript === 'TypeError', policy);
    check('no page script can add a default policy, a second copy of this one, or one of its own',
      policy.makeDefault === 'TypeError' && policy.duplicate === 'TypeError' && policy.unlisted === 'TypeError', policy);

    await p.waitForFunction(() => window.__violations.length >= 14, null, { timeout: 5000 }).catch(() => {});
    const reported = await p.evaluate(() => window.__violations);
    const directives = new Set(reported.map((r) => r.directive));
    check('each refusal is reported as a CSP violation (so report-to hears of it)',
      directives.has('require-trusted-types-for') && directives.has('trusted-types') &&
        reported.some((r) => r.directive === 'require-trusted-types-for' && /innerHTML/.test(r.sample || '')), reported);
    check('the probing page had no other errors', prober.watch.problems.length === 0, prober.watch.problems);

    // ================= and last, the owner deletes the account

    await page.click('#delete-open');
    await page.waitForSelector('#delete-dialog[open]');
    await page.fill('#delete-confirm-username', username);
    await page.fill('#delete-password', PASSWORD);
    await Promise.all([page.waitForURL(`${BASE}/`), page.click('#delete-submit')]);
    await page.waitForSelector('.tree-card');
    check('deleting the account through the dialog lands on the homepage', true);
    check('the only dialog on the way was the link removal', owner.watch.dialogs.length === 1 && visitor.watch.dialogs.length === 0,
      [...owner.watch.dialogs, ...visitor.watch.dialogs]);

    const everyone = [owner, visitor, traveller];
    const violations = everyone.flatMap((x) => x.watch.violations);
    const errors = everyone.flatMap((x) => x.watch.problems);
    check(`no Trusted Types or other CSP violations on any page (${violations.length})`, violations.length === 0, violations);
    check(`no console errors on any page (${errors.length})`, errors.length === 0, errors);
  } catch (e) {
    check(`suite ran to completion (${e.message})`, false);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close();
    await srv.stop();
  }
  finish();
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
