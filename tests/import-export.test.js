const { chromium } = require('playwright');
const fs = require('node:fs');
const BASE = 'http://localhost:3001';

(async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const results = [];
  const check = (label, cond, detail) => {
    results.push({ label, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${!cond && detail ? '\n        ' + JSON.stringify(detail).slice(0, 300) : ''}`);
  };

  const createdTreeIds = [];

  // ---------- EXPORT via the button ----------
  await page.goto(`${BASE}/tree.html?id=1`);
  await page.waitForSelector('#nodes-layer > g');

  // Export now opens a dialog offering the layout choice; take the default
  // ("keep this arrangement") to reproduce the old behaviour.
  await page.click('#export-btn');
  await page.waitForSelector('#export-overlay:not([hidden])');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.click('#export-form button[type=submit]'),
  ]);
  check('export dialog produces a download', !!download);
  check('download filename derives from the title',
    download.suggestedFilename() === 'home-bread-baking.json', download.suggestedFilename());

  const dlPath = '/tmp/skilltree-test-export.json';
  await download.saveAs(dlPath);
  const exported = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
  check('downloaded file is valid notation',
    exported.format === 'skilltree' && exported.version === 1 && exported.skills.length === 9);
  check('exported skills carry slug ids and requires',
    exported.skills.every((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id)) &&
    exported.skills.some((s) => s.requires.length === 2), exported.skills.map(s => s.id));

  // ---------- IMPORT by pasting ----------
  await page.goto(BASE + '/');
  await page.waitForSelector('.tree-card');
  const treeCountBefore = await page.locator('.tree-card').count();

  await page.click('#import-btn');
  await page.waitForSelector('#import-overlay:not([hidden])');

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
  await page.waitForURL(/tree\.html\?id=\d+/, { timeout: 8000 });
  const pastedId = Number(new URL(page.url()).searchParams.get('id'));
  createdTreeIds.push(pastedId);
  check('pasting a tree imports and redirects to it', Number.isInteger(pastedId));

  await page.waitForSelector('#nodes-layer > g');
  check('imported tree renders all 3 skills', await page.locator('#nodes-layer > g').count() === 3);
  check('imported tree renders both links',
    await page.locator('#edges-layer path.edge-line:not(.hit)').count() === 2);

  const laidOut = await (await fetch(`${BASE}/api/trees/${pastedId}/export`)).json();
  const xs = laidOut.skills.map((s) => s.position.x).sort((a, b) => a - b);
  check('auto-layout put each skill in its own column', new Set(xs).size === 3, xs);

  // ---------- IMPORT via file picker ----------
  await page.goto(BASE + '/');
  await page.click('#import-btn');
  await page.waitForSelector('#import-overlay:not([hidden])');
  await page.setInputFiles('#import-file', dlPath);
  await page.waitForFunction(() => document.getElementById('import-text').value.length > 0, null, { timeout: 5000 });
  check('choosing a file fills the textarea',
    (await page.inputValue('#import-text')).includes('skilltree'));
  await page.click('#import-form button[type=submit]');
  await page.waitForURL(/tree\.html\?id=\d+/, { timeout: 8000 });
  const fileImportedId = Number(new URL(page.url()).searchParams.get('id'));
  createdTreeIds.push(fileImportedId);
  await page.waitForSelector('#nodes-layer > g');
  check('file import round-trips all 9 skills',
    await page.locator('#nodes-layer > g').count() === 9);

  // Round-trip fidelity through the whole UI path
  const reExported = await (await fetch(`${BASE}/api/trees/${fileImportedId}/export`)).json();
  const strip = (t) => JSON.stringify({ ...t, skills: t.skills });
  check('export -> import -> export is identical', strip(reExported) === strip(exported));

  // ---------- ERROR SURFACES ----------
  const expectProblems = async (payload, expectSubstring) => {
    await page.goto(BASE + '/');
    await page.click('#import-btn');
    await page.waitForSelector('#import-overlay:not([hidden])');
    await page.fill('#import-text', payload);
    await page.click('#import-form button[type=submit]');
    await page.waitForSelector('#import-problems:not([hidden])', { timeout: 5000 });
    const text = await page.locator('#import-problems').textContent();
    return text.includes(expectSubstring);
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

  // a failed import must not have created anything
  await page.goto(BASE + '/');
  await page.waitForSelector('.tree-card');
  const treeCountAfter = await page.locator('.tree-card').count();
  check('failed imports created no trees',
    treeCountAfter === treeCountBefore + createdTreeIds.length,
    { treeCountBefore, treeCountAfter, created: createdTreeIds.length });

  // The three server-side rejection tests each get a 400, which Chrome logs as
  // a failed resource load. Those are expected; anything else is not.
  const expected400s = consoleErrors.filter((e) => e.includes('400 (Bad Request)'));
  const unexpected = consoleErrors.filter((e) => !e.includes('400 (Bad Request)'));
  check('no unexpected console errors', unexpected.length === 0, unexpected);
  check('exactly the 3 server-rejected imports logged a 400 (the other 2 never left the browser)',
    expected400s.length === 3, expected400s);

  // cleanup
  for (const id of createdTreeIds) {
    await fetch(`${BASE}/api/trees/${id}`, { method: 'DELETE' });
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILURES:', failed.map((f) => f.label)); process.exit(1); }
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
