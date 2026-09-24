// Core editing in a real browser: making a tree on the draft page, adding
// skills, linking prerequisites, the side panel, cycle rejection, what other
// people see, and deleting a skill and then the tree.
//
// Starts its own server on a throwaway database, seeded with the example tree
// (see tests/helpers/browser.js). BASE_URL aims it at a running server
// instead; it deletes the tree it makes either way.
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/core-crud.test.js

const { launchBrowser, startTarget, createReporter, watchConsole, signUp } = require('./helpers/browser');

const { check, skip, finish } = createReporter();

(async () => {
  const { base: BASE, srv } = await startTarget({ seed: true });
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = watchConsole(page);
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.accept();
  });

  let treeId = null;
  let treeDeleted = false;
  const nodes = page.locator('#nodes-layer > g');
  const edgeCount = () => page.locator('#edges-layer path.edge-line:not(.hit)').count();
  const nodeByName = (name) => page.locator('#nodes-layer > g', { has: page.locator('.node-label', { hasText: name }) });
  const waitForCounts = (nodeCount, edges) =>
    page.waitForFunction(
      ([n, e]) =>
        document.querySelectorAll('#nodes-layer > g').length === n &&
        document.querySelectorAll('#edges-layer path.edge-line:not(.hit)').length === e,
      [nodeCount, edges]
    );
  const waitForToast = (pattern) =>
    page.waitForFunction(
      (src) => new RegExp(src).test(document.getElementById('toast').textContent),
      pattern.source
    );
  // Link mode switches off once the link request has settled, a step after
  // the toast; give it that step rather than reading the button too early.
  const linkModeOff = () =>
    page
      .waitForFunction(() => document.getElementById('link-mode-btn').textContent === 'Link prerequisite', null, { timeout: 2000 })
      .catch(() => {});
  const apiTree = async () => (await context.request.get(`${BASE}/api/trees/${treeId}`)).json();

  try {
    // ---------- the homepage ----------
    await page.goto(BASE + '/');
    await page.waitForSelector('.tree-card', { timeout: 5000 });
    check('home page shows at least 1 tree card', (await page.locator('.tree-card').count()) >= 1);
    check('the browse heading is shown', (await page.textContent('h2.page-title')) === 'Browse public skill trees');

    // ---------- a new tree is a draft until it has a title ----------
    await signUp(context, BASE, 'crud');
    await Promise.all([page.waitForURL(`${BASE}/tree.html`), page.click('a[href="/tree.html"]')]);
    // The draft's header is drawn, and its title focused, in one step.
    await page.waitForFunction(() => document.getElementById('tree-meta-time').textContent !== '');
    const draft = await page.evaluate(() => ({
      search: location.search,
      meta: document.getElementById('tree-meta-time').textContent,
      focus: document.activeElement.id,
    }));
    check('"New skill tree" opens an unsaved draft with the title field focused',
      draft.search === '' && draft.meta.includes('not saved yet') && draft.focus === 'tree-title', draft);

    await page.fill('#tree-title', 'E2E Test Tree');
    await page.waitForURL(/\/tree\.html\?id=\d+$/, { timeout: 5000 });
    treeId = Number(new URL(page.url()).searchParams.get('id'));
    check('typing a title saves the draft, and the URL becomes ?id=N', Number.isInteger(treeId) && treeId > 0, page.url());

    await page.fill('#tree-desc', 'Created by automated test');
    // Every save sends all three fields, so the one carrying the author is
    // the last one that matters.
    const authorSaved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && (r.request().postData() || '').includes('"author":"E2E Bot"')
    );
    await page.fill('#tree-author', 'E2E Bot');
    await page.press('#tree-author', 'Enter'); // commits the field: blur saves at once
    await authorSaved;
    const saved = await apiTree();
    check('title, description and author are saved as they are typed',
      saved.title === 'E2E Test Tree' && saved.description === 'Created by automated test' && saved.author === 'E2E Bot',
      saved);
    await page
      .waitForFunction(() => document.getElementById('tree-heading').textContent === 'E2E Test Tree', null, { timeout: 2000 })
      .catch(() => {});
    check('the page heading mirrors the title', (await page.textContent('#tree-heading')) === 'E2E Test Tree');

    await page.reload();
    await page.waitForFunction(() => document.getElementById('tree-title').value !== '');
    check('tree title rendered after a reload', (await page.inputValue('#tree-title')) === 'E2E Test Tree');

    // ---------- adding skills ----------
    const addSkill = async (name, desc, expected) => {
      await page.click('#add-skill-btn');
      await page.waitForSelector('#skill-modal-overlay[open]');
      await page.fill('#skill-name', name);
      await page.fill('#skill-desc', desc);
      await page.click('#new-skill-form button[type=submit]');
      await page.waitForSelector('#skill-modal-overlay', { state: 'hidden', timeout: 5000 });
      // The submit handler re-enables its button last, after reloading the tree.
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll('#nodes-layer > g').length === n &&
          !document.querySelector('#new-skill-form button[type=submit]').disabled,
        expected
      );
    };
    await addSkill('Skill A', 'The first skill', 1);
    await addSkill('Skill B', 'The second skill', 2);
    check('two skill nodes rendered', (await nodes.count()) === 2);
    const labels = await page.locator('#nodes-layer .node-label').allTextContents();
    check('...labelled with their names', labels.join() === 'Skill A,Skill B', labels);

    // ---------- linking A -> B ----------
    await page.click('#link-mode-btn');
    check('link mode turns on', (await page.textContent('#link-mode-btn')) === 'Cancel linking');
    await nodeByName('Skill A').click();
    await page.waitForSelector('#nodes-layer g[aria-label*="chosen as the prerequisite"]');
    await nodeByName('Skill B').click();
    await waitForCounts(2, 1);
    check('one edge rendered after linking', (await edgeCount()) === 1);
    await waitForToast(/link added/);
    check('the new link is announced', (await page.textContent('#toast')) === 'Prerequisite link added: "Skill A" → "Skill B".',
      await page.textContent('#toast'));
    await linkModeOff();
    check('link mode ends after linking', (await page.textContent('#link-mode-btn')) === 'Link prerequisite');
    const stored = await apiTree();
    const [a, b] = ['Skill A', 'Skill B'].map((n) => stored.skills.find((s) => s.name === n));
    check('the link is stored as A before B',
      stored.edges.length === 1 && stored.edges[0].prereq_skill_id === a.id && stored.edges[0].skill_id === b.id,
      stored.edges);

    // ---------- the side panel ----------
    await nodeByName('Skill B').click();
    await page.waitForSelector('#side-panel.open', { timeout: 3000 });
    check('side panel opened with correct skill name', (await page.textContent('#panel-name')) === 'Skill B');
    check('...and its description', (await page.textContent('#panel-desc')) === 'The second skill');
    const prereqRows = await page.locator('#panel-prereqs li.interactive button.panel-jump').allTextContents();
    check('side panel shows correct prerequisite name', prereqRows.join() === 'Skill A', prereqRows);
    check('...with a button to remove that link, for the owner',
      (await page.locator('#panel-prereqs li.interactive button.panel-unlink').count()) === 1);
    check('an empty list says so', (await page.locator('#panel-unlocks li.panel-empty').count()) === 1);

    await page.click('#panel-prereqs button.panel-jump');
    await page.waitForFunction(() => document.getElementById('panel-name').textContent === 'Skill A');
    const unlockRows = await page.locator('#panel-unlocks li.interactive button.panel-jump').allTextContents();
    check('a prerequisite row jumps to that skill, which lists what it unlocks', unlockRows.join() === 'Skill B', unlockRows);
    await page.click('#panel-close');
    await page.waitForSelector('#side-panel:not(.open)');

    // Dragging as the owner of a manual tree. The old version of this suite
    // asserted the new position survived a reload; drag-not-saved asserted the
    // opposite. CLAUDE.md ("Dragging a skill never saves") and TODO.md ("Saved
    // layouts, creator-only") say it never saves, but attachNodeInteractions()
    // in frontend/tree.js PATCHes the owner's drop. Which is right is an open
    // decision, so neither is asserted here; see drag-not-saved.test.js.
    skip('owner drag on a manual tree survives a reload', 'pending the decision on whether an owner\'s drag saves');

    // ---------- cycle rejection ----------
    await page.click('#link-mode-btn');
    await nodeByName('Skill B').click();
    await page.waitForSelector('#nodes-layer g[aria-label*="chosen as the prerequisite"]');
    await nodeByName('Skill A').click();
    await waitForToast(/cycle/);
    check('cycle-creating link was rejected (still only 1 edge)', (await edgeCount()) === 1);
    check('...with the reason shown', (await page.textContent('#toast')).includes('would create a cycle'));
    check('...and nothing stored', (await apiTree()).edges.length === 1);
    await linkModeOff();
    check('link mode ends after a rejected link too', (await page.textContent('#link-mode-btn')) === 'Link prerequisite');

    // ---------- what everyone else sees ----------
    const visitorContext = await browser.newContext();
    const visitor = await visitorContext.newPage();
    const visitorErrors = watchConsole(visitor);
    await visitor.goto(`${BASE}/tree.html?id=${treeId}`);
    await visitor.waitForSelector('#nodes-layer > g');
    await visitor.waitForSelector('#share-btn', { state: 'visible' }); // permissions applied
    const hiddenButtons = await visitor.evaluate(() =>
      ['add-skill-btn', 'link-mode-btn', 'delete-tree-btn'].map((id) => document.getElementById(id).hidden)
    );
    check('a signed-out visitor gets no edit buttons', hiddenButtons.every(Boolean), hiddenButtons);
    const readOnly = await visitor.evaluate(() =>
      ['tree-title', 'tree-desc', 'tree-author'].map((id) => document.getElementById(id).readOnly)
    );
    check('...and read-only title, description and author', readOnly.every(Boolean), readOnly);
    check('...and is told whose tree it is',
      (await visitor.textContent('#toolbar-hint')) === 'Read-only — E2E Bot made this tree.',
      await visitor.textContent('#toolbar-hint'));
    await visitor.locator('#nodes-layer > g', { has: visitor.locator('.node-label', { hasText: 'Skill B' }) }).click();
    await visitor.waitForSelector('#side-panel.open');
    check('...whose side panel lists links but offers no way to remove them or the skill',
      (await visitor.locator('#panel-prereqs button.panel-jump').count()) === 1 &&
        (await visitor.locator('#panel-prereqs button.panel-unlink').count()) === 0 &&
        (await visitor.locator('#panel-delete-btn').isHidden()));
    check('no console errors for the visitor', visitorErrors.length === 0, visitorErrors);
    await visitorContext.close();

    // ---------- deleting a skill ----------
    await nodeByName('Skill B').click();
    await page.waitForSelector('#side-panel.open');
    await page.click('#panel-delete-btn');
    await waitForCounts(1, 0);
    check('skill deleted, 1 node remains', (await nodes.count()) === 1);
    check('...and its link went with it', (await edgeCount()) === 0);
    await waitForToast(/deleted/);
    check('the deletion is announced', (await page.textContent('#toast')) === 'Skill deleted: Skill B.',
      await page.textContent('#toast'));
    check('the panel closes when its skill is deleted', (await page.locator('#side-panel.open').count()) === 0);

    // ---------- deleting the tree ----------
    await Promise.all([page.waitForURL(BASE + '/', { timeout: 5000 }), page.click('#delete-tree-btn')]);
    treeDeleted = true;
    check('deleting the tree asks first, by name', dialogs.some((m) => m.includes('"E2E Test Tree"')), dialogs);
    await page.waitForSelector('.tree-card', { timeout: 5000 });
    const titles = await page.locator('.tree-card h3').allTextContents();
    check('deleted tree no longer in list', !titles.includes('E2E Test Tree'), titles);
    check('...and gone from the API', (await context.request.get(`${BASE}/api/trees/${treeId}`)).status() === 404);

    // The rejected cycle is refused with a 400, which Chrome logs as a failed
    // resource load. That one is expected; anything else is not.
    const is400 = (e) => e.includes('400 (Bad Request)');
    check('no unexpected console errors', consoleErrors.filter((e) => !is400(e)).length === 0, consoleErrors);
    check('exactly one 400 logged: the rejected cycle', consoleErrors.filter(is400).length === 1, consoleErrors);
  } catch (err) {
    check('suite ran to completion', false, err.message);
  } finally {
    if (treeId && !treeDeleted) await context.request.delete(`${BASE}/api/trees/${treeId}`).catch(() => {});
    await browser.close();
    if (srv) await srv.stop();
  }
  finish();
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
