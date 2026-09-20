const { chromium } = require('playwright');
const fs = require('node:fs');
const BASE = 'http://localhost:3001';
const NODE_W = 170;

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
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${!cond && detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 400) : ''}`);
  };
  const cleanup = [];
  const importTree = async (obj) => {
    const r = await (await fetch(BASE + '/api/trees/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
    })).json();
    cleanup.push(r.id);
    return r;
  };
  const posOf = async (id) =>
    (await (await fetch(`${BASE}/api/trees/${id}`)).json()).skills;

  const structure = (layout) => ({
    format: 'skilltree', version: 1, title: `Mode ${layout}`, author: 't',
    ...(layout ? { layout } : {}),
    skills: [
      { id: 'a', name: 'A', position: { x: 999, y: 999 } },
      { id: 'b', name: 'B', requires: ['a'], position: { x: 999, y: 1200 } },
      { id: 'c', name: 'C', requires: ['b'], position: { x: 999, y: 1400 } },
    ],
  });

  // ---------- AUTO MODE ----------
  const auto = await importTree(structure('auto'));
  check('auto tree stores layout=auto', auto.layout === 'auto', auto);

  const autoSkills = await posOf(auto.id);
  check('auto import ignores the file\'s positions and computes columns',
    new Set(autoSkills.map((s) => s.pos_x)).size === 3 && !autoSkills.some((s) => s.pos_x === 999),
    autoSkills.map((s) => [s.name, s.pos_x, s.pos_y]));

  await page.goto(`${BASE}/tree.html?id=${auto.id}`);
  await page.waitForSelector('#nodes-layer > g');
  check('auto mode is shown in the tree meta line',
    (await page.locator('#tree-meta').textContent()).includes('auto-arranged'));

  const renderedX = async () => {
    const boxes = [];
    const n = await page.locator('#nodes-layer > g').count();
    for (let i = 0; i < n; i++) boxes.push((await page.locator('#nodes-layer > g').nth(i).locator('rect').boundingBox()).x);
    return boxes;
  };
  const beforeAdd = await renderedX();
  check('auto tree renders each skill in its own column', new Set(beforeAdd.map(Math.round)).size === 3, beforeAdd);

  // Add a skill -> the graph must re-flow, not place it at a free slot
  await page.click('#add-skill-btn');
  await page.fill('#skill-name', 'D');
  await page.click('#new-skill-form button[type=submit]');
  await page.waitForSelector('#skill-modal-overlay', { state: 'hidden' });
  await page.waitForTimeout(400);

  const afterSkills = await posOf(auto.id);
  const dRow = afterSkills.find((s) => s.name === 'D');
  check('new skill in an auto tree is laid out, not placed at a stored spot',
    dRow && dRow.pos_x === 0, dRow);
  check('auto tree still renders all 4 skills', await page.locator('#nodes-layer > g').count() === 4);

  // Link D -> requires C, so D must move to the far right column
  await page.click('#link-mode-btn');
  const labels = async () => {
    const out = [];
    const n = await page.locator('#nodes-layer > g').count();
    for (let i = 0; i < n; i++) out.push(await page.locator('#nodes-layer > g').nth(i).locator('.node-label').textContent());
    return out;
  };
  const names = await labels();
  const idxC = names.indexOf('C');
  const idxD = names.indexOf('D');
  await page.locator('#nodes-layer > g').nth(idxC).click();
  await page.waitForTimeout(200);
  await page.locator('#nodes-layer > g').nth(idxD).click();
  await page.waitForTimeout(600);

  const linkedSkills = await posOf(auto.id);
  const dAfterLink = linkedSkills.find((s) => s.name === 'D');
  const cAfterLink = linkedSkills.find((s) => s.name === 'C');
  // Stored positions stay put (they're not authoritative), but the RENDER must move D right of C.
  const renderedNames = await labels();
  const rects = {};
  for (let i = 0; i < renderedNames.length; i++) {
    rects[renderedNames[i]] = (await page.locator('#nodes-layer > g').nth(i).locator('rect').boundingBox()).x;
  }
  check('linking re-flows the graph: D now renders right of C', rects['D'] > rects['C'], rects);

  // ---------- MANUAL MODE ----------
  const manual = await importTree(structure('manual'));
  check('manual tree stores layout=manual', manual.layout === 'manual', manual);
  const manualSkills = await posOf(manual.id);
  check('manual import honors the file\'s positions',
    manualSkills.every((s) => s.pos_x === 999), manualSkills.map((s) => [s.name, s.pos_x]));

  const noField = await importTree(structure(null));
  check('a file with no layout field defaults to manual (backward compatible)',
    noField.layout === 'manual', noField);
  check('...and its positions are honored',
    (await posOf(noField.id)).every((s) => s.pos_x === 999));

  await page.goto(`${BASE}/tree.html?id=${manual.id}`);
  await page.waitForSelector('#nodes-layer > g');
  check('manual mode is not labelled auto-arranged',
    !(await page.locator('#tree-meta').textContent()).includes('auto-arranged'));

  // ---------- EXPORT CHOICE ----------
  // Drag a node (session-only), then export "keep arrangement" and confirm the
  // drag is captured even though the database never saw it.
  const box = await page.locator('#nodes-layer > g').nth(0).locator('rect').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 140, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const dbAfterDrag = await posOf(manual.id);
  check('dragging still does not touch the database',
    dbAfterDrag.every((s) => s.pos_x === 999), dbAfterDrag.map((s) => [s.name, s.pos_x, s.pos_y]));

  await page.click('#export-btn');
  await page.waitForSelector('#export-overlay:not([hidden])');
  await page.check('input[name="export-layout"][value="manual"]');
  const [dl1] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.click('#export-form button[type=submit]'),
  ]);
  const p1 = '/tmp/skilltree-test-keep.json';
  await dl1.saveAs(p1);
  const kept = JSON.parse(fs.readFileSync(p1, 'utf8'));
  check('"keep arrangement" export says layout=manual', kept.layout === 'manual');
  check('"keep arrangement" export captured the drag the database never saw',
    kept.skills.some((s) => s.position.x !== 999 || s.position.y !== 999),
    kept.skills.map((s) => [s.id, s.position]));

  // Export the same tree as "arrange automatically"
  await page.click('#export-btn');
  await page.waitForSelector('#export-overlay:not([hidden])');
  await page.check('input[name="export-layout"][value="auto"]');
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.click('#export-form button[type=submit]'),
  ]);
  const p2 = '/tmp/skilltree-test-auto.json';
  await dl2.saveAs(p2);
  const autoFile = JSON.parse(fs.readFileSync(p2, 'utf8'));
  check('"arrange automatically" export says layout=auto', autoFile.layout === 'auto');
  check('"arrange automatically" export carries no positions at all',
    autoFile.skills.every((s) => !('position' in s)), autoFile.skills[0]);
  check('...but keeps the full structure', autoFile.skills.length === 3 &&
    autoFile.skills.find((s) => s.id === 'c').requires.length === 1);

  // Re-importing the auto file yields an auto tree
  const reimported = await importTree(autoFile);
  check('re-importing an auto export produces an auto tree', reimported.layout === 'auto');

  // ---------- ROUND TRIP ----------
  const exp1 = await (await fetch(`${BASE}/api/trees/${manual.id}/export`)).text();
  const imp = await importTree(JSON.parse(exp1));
  const exp2 = await (await fetch(`${BASE}/api/trees/${imp.id}/export`)).text();
  check('manual round-trip is byte-identical', exp1 === exp2);

  const autoExp1 = await (await fetch(`${BASE}/api/trees/${auto.id}/export`)).text();
  const autoImp = await importTree(JSON.parse(autoExp1));
  const autoExp2 = await (await fetch(`${BASE}/api/trees/${autoImp.id}/export`)).text();
  check('auto round-trip is byte-identical', autoExp1 === autoExp2);

  // ---------- VALIDATOR ----------
  const bad = await fetch(BASE + '/api/trees/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'skilltree', version: 1, title: 'X', layout: 'sideways', skills: [] }),
  });
  const badBody = await bad.json();
  check('an invalid layout value is rejected',
    bad.status === 400 && JSON.stringify(badBody.problems).includes('layout'), badBody);

  const unexpected = consoleErrors.filter((e) => !e.includes('400 (Bad Request)'));
  check('no unexpected console errors', unexpected.length === 0, unexpected);

  for (const id of cleanup) await fetch(`${BASE}/api/trees/${id}`, { method: 'DELETE' });
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILURES:', failed.map((f) => f.label)); process.exit(1); }
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
