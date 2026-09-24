// Import and export through the UI: the export dialog and its download, both
// import paths (pasting and choosing a file), round-trip fidelity, and every
// error surface — including telling expected failed requests (a rejected
// import is a 400, which Chrome logs) from unexpected console errors.
//
// Starts its own server on a throwaway database, seeded with the example tree
// (see tests/helpers/browser.js). BASE_URL aims it at a running server
// instead; it deletes the trees it imports either way.
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/import-export.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  launchBrowser,
  startTarget,
  createReporter,
  watchConsole,
  signUp,
  seededTreeId,
} = require('./helpers/browser');

const { check, finish } = createReporter();

(async () => {
  const { base: BASE, srv } = await startTarget({ seed: true });
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors = watchConsole(page);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-e2e-'));
  const createdTreeIds = [];
  const exportOf = async (id) => (await ctx.request.get(`${BASE}/api/trees/${id}/export`)).text();

  const openImport = async () => {
    await page.goto(BASE + '/');
    await page.click('[data-open="import"]');
    await page.waitForSelector('#import-overlay[open]');
  };
  const importedId = async () => {
    await page.waitForURL(/tree\.html\?id=\d+/, { timeout: 8000 });
    const id = Number(new URL(page.url()).searchParams.get('id'));
    createdTreeIds.push(id);
    return id;
  };

  try {
    await signUp(ctx, BASE, 'imex');
    const seededId = await seededTreeId(ctx.request, BASE);

    // ---------- EXPORT via the button ----------
    await page.goto(`${BASE}/tree.html?id=${seededId}`);
    await page.waitForSelector('#nodes-layer > g');

    // Export opens a dialog offering the layout choice; take the default,
    // which for this (manual) tree is "keep this arrangement".
    await page.click('#export-btn');
    await page.waitForSelector('#export-overlay[open]');
    check('the export dialog defaults to the tree\'s own layout',
      await page.isChecked('input[name="export-layout"][value="manual"]'));
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.click('#export-form button[type=submit]'),
    ]);
    check('export dialog produces a download', !!download);
    check('download filename derives from the title',
      download.suggestedFilename() === 'home-bread-baking.json', download.suggestedFilename());
    await page.waitForSelector('#export-overlay', { state: 'hidden' });
    check('the dialog closes after exporting', !(await page.evaluate(() => document.getElementById('export-overlay').open)));

    const dlPath = path.join(tmp, 'export.json');
    await download.saveAs(dlPath);
    const exportedText = fs.readFileSync(dlPath, 'utf8');
    const exported = JSON.parse(exportedText);
    check('downloaded file is valid notation',
      exported.format === 'skilltree' && exported.version === 1 && exported.skills.length === 9 &&
        exported.layout === 'manual');
    check('exported skills carry slug ids and requires',
      exported.skills.every((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id)) &&
        exported.skills.some((s) => s.requires && s.requires.length === 2),
      exported.skills.map((s) => s.id));
    check('...and the positions they are drawn at',
      exported.skills.every((s) => s.position && Number.isInteger(s.position.x) && Number.isInteger(s.position.y)));

    // ---------- IMPORT by pasting ----------
    await page.goto(BASE + '/');
    await page.waitForSelector('.tree-card');
    const treeCountBefore = await page.locator('.tree-card').count();

    await openImport();
    check('the import dialog opens with focus in the paste box',
      await page.evaluate(() => document.activeElement.id === 'import-text'));
    const pasteAndSubmit = async (text) => {
      await page.fill('#import-text', text);
      await page.click('#import-form button[type=submit]');
    };

    // A tree with no positions at all -> exercises auto-layout through the UI
    await pasteAndSubmit(JSON.stringify({
      format: 'skilltree', version: 1, title: 'Pasted Tree', author: 'paster',
      skills: [
        { id: 'basics', name: 'Basics' },
        { id: 'middle', name: 'Middle', requires: ['basics'] },
        { id: 'top', name: 'Top', requires: ['middle'] },
      ],
    }));
    const pastedId = await importedId();
    check('pasting a tree imports and redirects to it', Number.isInteger(pastedId) && pastedId > 0);

    await page.waitForSelector('#nodes-layer > g');
    check('imported tree renders all 3 skills', (await page.locator('#nodes-layer > g').count()) === 3);
    check('imported tree renders both links',
      (await page.locator('#edges-layer path.edge-line:not(.hit)').count()) === 2);
    // Share appears once the page has applied its permissions, which is when
    // the edit buttons would have been hidden from anyone but the owner.
    await page.waitForSelector('#share-btn', { state: 'visible' });
    check('the importer owns the imported tree', await page.locator('#add-skill-btn').isVisible());

    const laidOut = JSON.parse(await exportOf(pastedId));
    const xs = laidOut.skills.map((s) => s.position.x).sort((a, b) => a - b);
    check('auto-layout put each skill in its own column', new Set(xs).size === 3, xs);

    // ---------- IMPORT via file picker ----------
    await openImport();
    await page.setInputFiles('#import-file', dlPath);
    await page.waitForFunction(() => document.getElementById('import-text').value.length > 0, null, { timeout: 5000 });
    check('choosing a file fills the textarea', (await page.inputValue('#import-text')) === exportedText);
    await page.click('#import-form button[type=submit]');
    const fileImportedId = await importedId();
    await page.waitForSelector('#nodes-layer > g');
    check('file import round-trips all 9 skills', (await page.locator('#nodes-layer > g').count()) === 9);

    // Round-trip fidelity through the whole UI path: the file the export
    // button saved, imported through the file picker, exported again.
    const reExported = await exportOf(fileImportedId);
    check('export -> import -> export is byte-identical', reExported === exportedText);

    // ---------- ERROR SURFACES ----------
    const expectProblems = async (payload, expectSubstring) => {
      await openImport();
      await page.fill('#import-text', payload);
      await page.click('#import-form button[type=submit]');
      await page.waitForSelector('#import-problems:not([hidden])', { timeout: 5000 });
      const text = await page.locator('#import-problems').textContent();
      const stillOpen = await page.evaluate(() => document.getElementById('import-overlay').open);
      return text.includes(expectSubstring) && stillOpen;
    };

    check('malformed JSON shows an inline error',
      await expectProblems('{not json', 'not valid JSON'));
    check('cycle is reported inline',
      await expectProblems(JSON.stringify({
        format: 'skilltree', version: 1, title: 'C',
        skills: [{ id: 'a', name: 'A', requires: ['b'] }, { id: 'b', name: 'B', requires: ['a'] }],
      }), 'Cycle in prerequisites'));
    check('anyOf is refused with an explanation',
      await expectProblems(JSON.stringify({
        format: 'skilltree', version: 1, title: 'C',
        skills: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' },
                 { id: 'c', name: 'C', requires: [{ anyOf: ['a', 'b'] }] }],
      }), 'anyOf'));
    check('dangling reference is reported inline',
      await expectProblems(JSON.stringify({
        format: 'skilltree', version: 1, title: 'C',
        skills: [{ id: 'a', name: 'A', requires: ['ghost'] }],
      }), 'not a skill in this tree'));
    check('empty submission is caught client-side',
      await expectProblems('   ', 'Nothing to import'));

    // Closing the dialog however it's closed leaves it blank for next time.
    await page.keyboard.press('Escape');
    await page.waitForSelector('#import-overlay', { state: 'hidden' });
    await page.click('[data-open="import"]');
    await page.waitForSelector('#import-overlay[open]');
    check('a reopened import dialog starts blank',
      (await page.inputValue('#import-text')) === '' && (await page.locator('#import-problems').isHidden()));

    // a failed import must not have created anything
    await page.goto(BASE + '/');
    await page.waitForSelector('.tree-card');
    const treeCountAfter = await page.locator('.tree-card').count();
    check('failed imports created no trees',
      treeCountAfter === treeCountBefore + createdTreeIds.length,
      { treeCountBefore, treeCountAfter, created: createdTreeIds.length });

    // ---------- signed out ----------
    const visitorCtx = await browser.newContext();
    const visitor = await visitorCtx.newPage();
    const visitorErrors = watchConsole(visitor);
    await visitor.goto(BASE + '/');
    await visitor.click('[data-open="import"]');
    await visitor.waitForSelector('#import-overlay[open]');
    await visitor.fill('#import-text', exportedText);
    await visitor.click('#import-form button[type=submit]');
    await visitor.waitForSelector('#import-problems:not([hidden])', { timeout: 5000 });
    check('a signed-out import is refused, saying why',
      (await visitor.textContent('#import-problems')).includes('Sign in to import'),
      await visitor.textContent('#import-problems'));
    check('...and its 401 is the only console error it caused',
      visitorErrors.length === 1 && visitorErrors[0].includes('401 (Unauthorized)'), visitorErrors);
    await visitorCtx.close();

    // The three server-side rejection tests each get a 400, which Chrome logs as
    // a failed resource load. Those are expected; anything else is not.
    const expected400s = consoleErrors.filter((e) => e.includes('400 (Bad Request)'));
    const unexpected = consoleErrors.filter((e) => !e.includes('400 (Bad Request)'));
    check('no unexpected console errors', unexpected.length === 0, unexpected);
    check('exactly the 3 server-rejected imports logged a 400 (the other 2 never left the browser)',
      expected400s.length === 3, expected400s);
  } catch (err) {
    check('suite ran to completion', false, err.message);
  } finally {
    for (const id of createdTreeIds) {
      await ctx.request.delete(`${BASE}/api/trees/${id}`).catch(() => {});
    }
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (srv) await srv.stop();
  }
  finish();
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
