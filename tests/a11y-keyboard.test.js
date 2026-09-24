// Keyboard and assistive-technology behaviour, driven through a real browser:
// the graph by keyboard (roving tab stop, arrow keys, Enter, Escape), link
// mode and unlinking without a mouse, keyboard pan and zoom, the side panel's
// focus handling, native dialogs (and that closed ones block nothing), the
// search combobox, skip links, and Share.
//
// Starts its own server on a throwaway database through tests/helpers/server.js
// — signing up is rate-limited per address, so a shared server would run out
// of signups after a few runs. Set BASE_URL to aim it at a running server
// instead (the featured-hero checks are then skipped, since featuring a tree
// needs the database file). Needs Playwright, installed outside the app:
//
//   node tests/a11y-keyboard.test.js
//   CHROMIUM_PATH=/path/to/chrome node tests/a11y-keyboard.test.js

const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const results = [];
const check = (label, cond, detail) => {
  results.push({ label, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${!cond && detail !== undefined ? ` (got: ${JSON.stringify(detail)})` : ''}`);
};
const skip = (label) => console.log(`SKIP - ${label}`);

(async () => {
  const srv = process.env.BASE_URL ? null : await startServer();
  const BASE = process.env.BASE_URL || srv.base;

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-write'], { origin: BASE });
  // The site's Permissions-Policy denies clipboard-read — it only ever writes
  // — so the test can't read the clipboard back from the page. It records
  // what the page writes instead; the real write still goes through.
  await context.addInitScript(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard || !clipboard.writeText) return;
    const write = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text) => {
      window.__lastClipboardWrite = text;
      return write(text);
    };
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', (d) => d.accept()); // confirm() before unlinking

  const created = [];
  const active = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      const g = a && a.closest && a.closest('g[data-skill-id]');
      return {
        tag: a ? a.tagName.toLowerCase() : null,
        id: a ? a.id : null,
        skillId: g ? g.dataset.skillId : null,
        role: a ? a.getAttribute('role') : null,
        label: a ? a.getAttribute('aria-label') : null,
        text: a ? (a.textContent || '').trim().slice(0, 60) : null,
        inPanel: !!(a && a.closest && a.closest('#side-panel')),
      };
    });
  const viewBox = () =>
    page.evaluate((sel) => document.querySelector(sel).getAttribute('viewBox').split(/\s+/).map(Number), '#graph-svg');
  const edgeCount = () => page.locator('#edges-layer path.edge-line:not(.hit)').count();

  try {
    // ---------- sign in, and a tree to work on ----------
    await page.goto(BASE + '/');
    const username = 'kbd' + Date.now().toString(36);
    const signup = await page.request.post(BASE + '/api/auth/signup', {
      data: { username, password: 'correct horse battery staple' },
    });
    check('signed up through the API', signup.status() === 201, signup.status());

    const post = async (p, data) => (await page.request.post(BASE + p, { data })).json();
    const tree = await post('/api/trees', { title: 'Keyboard tree', description: 'For the a11y suite', author: 'Bot' });
    created.push(tree.id);
    // A (0,0) -> B (250,0) -> D (500,0), and A -> C (250,120).
    // Reading order, column by column: A, B, C, D.
    const A = await post(`/api/trees/${tree.id}/skills`, { name: 'Alpha', pos_x: 0, pos_y: 0 });
    const B = await post(`/api/trees/${tree.id}/skills`, { name: 'Beta', pos_x: 250, pos_y: 0 });
    const C = await post(`/api/trees/${tree.id}/skills`, { name: 'Gamma', pos_x: 250, pos_y: 120 });
    const D = await post(`/api/trees/${tree.id}/skills`, { name: 'Delta', pos_x: 500, pos_y: 0 });
    await post(`/api/trees/${tree.id}/prereqs`, { skill_id: B.id, prereq_skill_id: A.id });
    await post(`/api/trees/${tree.id}/prereqs`, { skill_id: C.id, prereq_skill_id: A.id });
    await post(`/api/trees/${tree.id}/prereqs`, { skill_id: D.id, prereq_skill_id: B.id });
    const second = await post('/api/trees', { title: 'Second keyboard tree', description: 'x', author: 'Bot' });
    created.push(second.id);

    // ---------- skip link ----------
    await page.goto(`${BASE}/tree.html?id=${tree.id}`);
    await page.waitForSelector('#nodes-layer > g');
    await page.keyboard.press('Tab');
    let a = await active();
    const skipBox = await page.locator('.skip-link').boundingBox();
    check('first Tab reaches the skip link', a.text === 'Skip to the skill graph', a);
    check('the focused skip link is on screen', skipBox && skipBox.y >= 0);
    await page.keyboard.press('Enter');
    a = await active();
    check('the skip link moves focus to the graph canvas', a.id === 'graph-svg', a);

    // ---------- tab to a node, roving tab stop ----------
    await page.keyboard.press('Tab');
    a = await active();
    check('Tab from the canvas lands on a skill', a.skillId === String(A.id), a);
    check('a skill is exposed as a button', a.role === 'button', a.role);
    check('its name includes the skill and that it is a starting point',
      /Alpha/.test(a.label) && /starting point/.test(a.label), a.label);
    const tabStops = await page.locator('#nodes-layer g[tabindex="0"]').count();
    check('exactly one skill is in the tab order (roving tabindex)', tabStops === 1, tabStops);
    const ringOpacity = await page.evaluate(
      () => getComputedStyle(document.activeElement.querySelector('.node-focus-ring')).opacity
    );
    check('the focused skill shows its SVG focus ring', ringOpacity === '1', ringOpacity);
    const hintShown = await page.locator('.graph-kbd-hint').isVisible();
    check('the keyboard hint appears while the graph has keyboard focus', hintShown);

    // ---------- arrow keys ----------
    await page.keyboard.press('ArrowRight');
    a = await active();
    check('Right follows a link to the skill drawn level with it', a.skillId === String(B.id), a);
    await page.keyboard.press('ArrowRight');
    a = await active();
    check('Right again reaches the next unlock', a.skillId === String(D.id), a);
    await page.keyboard.press('ArrowLeft');
    a = await active();
    check('Left goes back to a prerequisite', a.skillId === String(B.id), a);
    await page.keyboard.press('ArrowLeft');
    a = await active();
    check('Left again reaches the starting skill', a.skillId === String(A.id), a);
    await page.keyboard.press('ArrowLeft');
    a = await active();
    check('Left on a starting skill stays put', a.skillId === String(A.id), a);
    await page.waitForTimeout(150);
    const said = await page.locator('#sr-announcer').textContent();
    check('...and says why to screen readers', /no prerequisites/.test(said), said);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    a = await active();
    check('Down steps through skills column by column', a.skillId === String(C.id), a);
    await page.keyboard.press('ArrowUp');
    a = await active();
    check('Up steps back', a.skillId === String(B.id), a);
    await page.keyboard.press('End');
    a = await active();
    check('End goes to the last skill', a.skillId === String(D.id), a);
    await page.keyboard.press('Home');
    a = await active();
    check('Home goes to the first skill', a.skillId === String(A.id), a);

    // ---------- Enter opens the panel, Escape closes it ----------
    await page.keyboard.press('ArrowRight'); // Beta
    await page.keyboard.press('Enter');
    await page.waitForSelector('#side-panel.open');
    a = await active();
    check('Enter opens the details panel and moves focus into it', a.id === 'panel-name' && a.inPanel, a);
    const panelName = await page.evaluate(() => {
      const panel = document.getElementById('side-panel');
      return document.getElementById(panel.getAttribute('aria-labelledby')).textContent;
    });
    check('the panel is labelled by its heading', panelName === 'Beta', panelName);
    const expanded = await page.getAttribute(`#nodes-layer g[data-skill-id="${B.id}"]`, 'aria-expanded');
    check('the open skill reports aria-expanded="true"', expanded === 'true', expanded);

    await page.focus('#tree-title');
    await page.keyboard.press('Escape');
    check('Escape while typing in a field does not close the panel',
      await page.locator('#side-panel.open').count() === 1);
    await page.focus('#panel-name');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    a = await active();
    check('Escape closes the panel', await page.locator('#side-panel.open').count() === 0);
    check('...and returns focus to the skill it described', a.skillId === String(B.id), a);
    const closeVis = await page.evaluate(() => getComputedStyle(document.getElementById('panel-close')).visibility);
    await page.waitForTimeout(450); // after the slide-out
    const closeVisLater = await page.evaluate(() => getComputedStyle(document.getElementById('panel-close')).visibility);
    check('a closed panel leaves nothing in the tab order', closeVisLater === 'hidden', [closeVis, closeVisLater]);

    // ---------- link mode by keyboard, and unlinking from the panel ----------
    await page.focus('#link-mode-btn');
    await page.keyboard.press('Enter');
    check('link mode turns on from the keyboard',
      (await page.textContent('#link-mode-btn')).includes('Cancel'));
    await page.focus('#graph-svg');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); // Gamma
    a = await active();
    check('link mode: reached Gamma by keyboard', a.skillId === String(C.id), a);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const chosen = await page.getAttribute(`#nodes-layer g[data-skill-id="${C.id}"]`, 'aria-label');
    check('choosing the prerequisite is reflected in its name', /chosen as the prerequisite/.test(chosen), chosen);
    await page.keyboard.press('ArrowDown'); // Delta
    const before = await edgeCount();
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('#edges-layer path.edge-line:not(.hit)').length === n + 1, before);
    check('Enter on the second skill creates the link', (await edgeCount()) === before + 1);
    const toastAdded = await page.textContent('#toast');
    check('the result is announced through the status toast', /link added/i.test(toastAdded), toastAdded);
    check('link mode ends after linking', (await page.textContent('#link-mode-btn')).includes('Link prerequisite'));
    a = await active();
    check('focus stays on the skill that was linked', a.skillId === String(D.id), a);

    await page.keyboard.press('Enter'); // Delta's details
    await page.waitForSelector('#side-panel.open');
    const unlink = page.locator('#panel-prereqs .panel-unlink[aria-label*="Gamma"]');
    let reachedUnlink = false;
    for (let i = 0; i < 6 && !reachedUnlink; i++) {
      await page.keyboard.press('Tab');
      const now = await active();
      reachedUnlink = now.label && now.label.includes('Gamma') && now.label.startsWith('Remove');
    }
    check('the panel offers a keyboard way to remove a link', reachedUnlink && (await unlink.count()) === 1);
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('#edges-layer path.edge-line:not(.hit)').length === n, before);
    check('removing the link from the panel works', (await edgeCount()) === before);
    const toastRemoved = await page.textContent('#toast');
    check('the removal is announced', /link removed/i.test(toastRemoved), toastRemoved);
    a = await active();
    check('focus is not dropped after the row it was on disappears', a.inPanel, a);
    await page.keyboard.press('Escape');

    // ---------- keyboard pan and zoom (the WCAG 2.5.7 alternative to dragging) ----------
    await page.focus('#graph-svg');
    await page.keyboard.press('0');
    const fit = await viewBox();
    await page.keyboard.press('+');
    const zoomedIn = await viewBox();
    check('+ on the canvas zooms in', zoomedIn[2] < fit[2], [fit, zoomedIn]);
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    const zoomedOut = await viewBox();
    check('- zooms out', zoomedOut[2] > zoomedIn[2], [zoomedIn, zoomedOut]);
    const beforePan = await viewBox();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const afterPan = await viewBox();
    check('arrow keys on the canvas pan it', afterPan[0] > beforePan[0] && afterPan[1] > beforePan[1], [beforePan, afterPan]);
    await page.keyboard.press('0');
    const refit = await viewBox();
    check('0 fits the tree to the screen again', refit.join() === fit.join(), [fit, refit]);
    await page.focus('#tree-author');
    await page.keyboard.press('End');
    await page.keyboard.press('0');
    await page.keyboard.press('+');
    const typed = await viewBox();
    check('typing 0 and + in a field does not zoom', typed.join() === refit.join(), typed);
    check('...and the characters reach the field', (await page.inputValue('#tree-author')).endsWith('0+'));
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    // Zoomed far in, the skills are off screen; focusing one brings it into
    // view, clear of the floating chrome (WCAG 2.4.11).
    await page.focus('#graph-svg');
    for (let i = 0; i < 6; i++) await page.keyboard.press('+');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Tab');
    await page.keyboard.press('End');
    const obscured = await page.evaluate(() => {
      const r = document.activeElement.getBoundingClientRect();
      const offScreen = r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight;
      const covers = ['.tree-overlay-topright', '.zoom-controls', '.legend', '.graph-kbd-hint']
        .map((s) => document.querySelector(s))
        .filter((el) => el && el.offsetParent !== null)
        .map((el) => el.getBoundingClientRect())
        .some((b) => b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top);
      return { offScreen, covers };
    });
    check('a skill focused off screen is panned into view, uncovered', !obscured.offScreen && !obscured.covers, obscured);

    // ---------- dialogs ----------
    await page.focus('#add-skill-btn');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#skill-modal-overlay[open]');
    a = await active();
    check('the add-skill dialog opens with focus in its first field', a.id === 'skill-name', a);
    const isModal = await page.evaluate(() => document.getElementById('skill-modal-overlay').matches(':modal'));
    check('it is a true modal (top layer, page behind inert)', isModal);
    // A native modal lets Tab out to the browser's own toolbar (focus then
    // reads as <body>), which is intended; what must never happen is focus
    // landing on something in the page behind it.
    const escaped = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab');
      const where = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        return document.getElementById('skill-modal-overlay').contains(el) ? null : el.id || el.tagName;
      });
      if (where) escaped.push(where);
    }
    check('Tab never reaches the page behind an open dialog', escaped.length === 0, escaped);
    await page.focus('#skill-name');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#skill-modal-overlay', { state: 'hidden' });
    a = await active();
    check('Escape closes the dialog and returns focus to its opener', a.id === 'add-skill-btn', a);
    const hit = await page.evaluate(() => {
      const r = document.getElementById('zoom-in-btn').getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).id;
    });
    check('a closed dialog covers nothing', hit === 'zoom-in-btn', hit);
    const vbBefore = await viewBox();
    await page.click('#zoom-in-btn', { timeout: 2000 });
    check('...and clicks reach the page behind it', (await viewBox())[2] < vbBefore[2]);

    await page.click('#export-btn');
    await page.waitForSelector('#export-overlay[open]');
    a = await active();
    check('the export dialog puts focus on the chosen layout option', a.tag === 'input', a);
    await page.mouse.click(8, 400); // the backdrop
    await page.waitForSelector('#export-overlay', { state: 'hidden', timeout: 2000 });
    check('clicking the backdrop closes a dialog', !(await page.evaluate(() => document.getElementById('export-overlay').open)));

    // ---------- Share ----------
    await page.click('#share-btn');
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => window.__lastClipboardWrite);
    check('Share copies the tree link where there is no share sheet', clip === `${BASE}/tree.html?id=${tree.id}`, clip);
    check('...and says so', /copied/i.test(await page.textContent('#toast')));
    await page.goto(BASE + '/tree.html');
    await page.waitForSelector('#tree-title');
    check('an unsaved draft has no Share button', await page.locator('#share-btn').isHidden());

    // ---------- homepage: skip link, import dialog, combobox ----------
    await page.goto(BASE + '/');
    await page.waitForSelector('.tree-card');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    a = await active();
    check('the homepage skip link moves focus to <main>', a.tag === 'main', a);

    await page.focus('[data-open="import"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#import-overlay[open]');
    a = await active();
    check('the import dialog opens with focus in the paste box', a.id === 'import-text', a);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#import-overlay', { state: 'hidden' });
    a = await active();
    check('Escape returns focus to the Import button', a.text === 'Import', a);

    const search = page.locator('#tree-search');
    await search.focus();
    await page.keyboard.type('keyboard tree');
    const combo = () =>
      page.evaluate(() => {
        const input = document.getElementById('tree-search');
        const ad = input.getAttribute('aria-activedescendant');
        const opt = ad && document.getElementById(ad);
        return {
          expanded: input.getAttribute('aria-expanded'),
          options: document.querySelectorAll('#search-dropdown [role="option"]').length,
          active: opt ? opt.querySelector('.search-item-title').textContent : null,
          selected: opt ? opt.getAttribute('aria-selected') : null,
          focus: document.activeElement.id,
          value: input.value,
        };
      });
    let cb = await combo();
    check('typing opens the listbox (aria-expanded)', cb.expanded === 'true' && cb.options === 2, cb);
    await page.keyboard.press('ArrowDown');
    cb = await combo();
    check('Down highlights the first result through aria-activedescendant',
      cb.active === 'Keyboard tree' && cb.selected === 'true' && cb.focus === 'tree-search', cb);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    cb = await combo();
    check('Down wraps from the last result to the first', cb.active === 'Keyboard tree', cb);
    await page.keyboard.press('ArrowUp');
    cb = await combo();
    check('Up wraps from the first result to the last', cb.active === 'Second keyboard tree', cb);
    await page
      .waitForFunction(() => /found/.test(document.getElementById('search-status').textContent), null, { timeout: 2000 })
      .catch(() => {});
    const count = await page.textContent('#search-status');
    check('the number of results is announced', /2 skill trees found/.test(count), count);
    await page.keyboard.press('Escape');
    cb = await combo();
    check('Escape closes the listbox and keeps the text', cb.expanded === 'false' && cb.value === 'keyboard tree', cb);
    await page.keyboard.press('Escape');
    cb = await combo();
    check('Escape again clears the field', cb.value === '', cb);
    await page.keyboard.type('second');
    await page.keyboard.press('ArrowDown');
    await Promise.all([page.waitForURL(/tree\.html\?id=\d+/), page.keyboard.press('Enter')]);
    check('Enter opens the highlighted tree', page.url().endsWith(`/tree.html?id=${second.id}`), page.url());

    // ---------- featured hero ----------
    if (srv) {
      execFileSync(process.execPath, [path.join(__dirname, '..', 'backend', 'db', 'feature.js'), String(tree.id)], {
        env: { ...process.env, SKILLTREE_DB: srv.dbPath },
        stdio: 'ignore',
      });
      await page.goto(BASE + '/');
      await page.waitForSelector('#featured-svg g[data-skill-id]');
      await page.focus('#featured-svg');
      await page.keyboard.press('Tab');
      a = await active();
      check('hero: Tab from the canvas reaches a skill, exposed as a link',
        a.skillId === String(A.id) && a.role === 'link', a);
      await page.keyboard.press('ArrowRight');
      a = await active();
      check('hero: arrow keys move between skills', a.skillId === String(B.id), a);
      await Promise.all([page.waitForURL(/tree\.html\?id=\d+/), page.keyboard.press('Enter')]);
      check('hero: Enter opens the tree', page.url().endsWith(`/tree.html?id=${tree.id}`), page.url());
    } else {
      skip('featured hero (needs the database file; not available with BASE_URL)');
    }

    // ---------- viewer ----------
    await page.goto(BASE + '/viewer.html');
    await page.waitForSelector('#viewer-empty[open]');
    check('the viewer opens its file dialog as a modal', await page.evaluate(() => document.getElementById('viewer-empty').matches(':modal')));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#viewer-empty', { state: 'hidden' });
    // A dialog's close event is queued, not fired synchronously, so wait for
    // its handler rather than reading the heading the instant it hides.
    await page
      .waitForFunction(() => document.getElementById('viewer-title').textContent === 'No skill tree loaded', null, { timeout: 2000 })
      .catch(() => {});
    const emptyTitle = await page.textContent('#viewer-title');
    check('...which Escape dismisses, leaving a heading that says so', emptyTitle === 'No skill tree loaded', emptyTitle);
    await page.evaluate(() =>
      sessionStorage.setItem('viewer_tree', JSON.stringify({
        format: 'skilltree', version: 1, title: 'Viewer tree', layout: 'auto',
        skills: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two', requires: ['one'] }],
      }))
    );
    await page.reload();
    await page.waitForSelector('#viewer-svg g[data-skill-id]');
    await page.focus('#viewer-svg');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowRight');
    a = await active();
    check('viewer: arrow keys follow links', a.skillId === 'two', a);
    await page.keyboard.press(' ');
    await page.waitForSelector('#side-panel.open');
    a = await active();
    check('viewer: Space opens the details panel', a.id === 'panel-name', a);
    await page.keyboard.press('Escape');
    a = await active();
    check('viewer: Escape closes it and returns focus to the skill', a.skillId === 'two', a);
    const zoomNames = await page.evaluate(() =>
      ['viewer-zoom-in', 'viewer-zoom-out', 'viewer-zoom-fit'].map((id) => document.getElementById(id).getAttribute('aria-label'))
    );
    check('viewer zoom buttons have accessible names', zoomNames.every(Boolean), zoomNames);

    check('no console errors', consoleErrors.length === 0, consoleErrors);
  } catch (err) {
    check('suite ran to completion', false, err.message);
  } finally {
    for (const id of created) {
      await page.request.delete(`${BASE}/api/trees/${id}`).catch(() => {});
    }
    await browser.close();
    if (srv) await srv.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
