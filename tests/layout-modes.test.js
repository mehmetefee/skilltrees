// `auto` vs `manual` layout: auto trees re-flow on every edit and ignore
// stored positions, manual trees honour them, files without the field stay
// manual, both export choices, and byte-identical round trips.
//
// Starts its own server on a throwaway database (see tests/helpers/browser.js).
// BASE_URL aims it at a running server instead; it deletes the trees it
// imports either way. It imports seven trees, and imports are rate-limited
// per address (ten per fifteen minutes), which a shared server may not have
// left after other suites.
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/layout-modes.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  launchBrowser,
  startTarget,
  createReporter,
  watchConsole,
  watchWrites,
  signUp,
} = require('./helpers/browser');

const { check, skip, finish } = createReporter();

(async () => {
  const { base: BASE, srv } = await startTarget();
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors = watchConsole(page);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-e2e-'));
  const cleanup = [];

  const importTree = async (obj) => {
    const res = await ctx.request.post(`${BASE}/api/trees/import`, { data: obj });
    const body = await res.json();
    if (res.status() === 201) cleanup.push(body.id);
    return body;
  };
  const posOf = async (id) => (await (await ctx.request.get(`${BASE}/api/trees/${id}`)).json()).skills;
  const exportText = async (id) => (await ctx.request.get(`${BASE}/api/trees/${id}/export`)).text();

  const structure = (layout) => ({
    format: 'skilltree', version: 1, title: `Mode ${layout}`, author: 't',
    ...(layout ? { layout } : {}),
    skills: [
      { id: 'a', name: 'A', position: { x: 999, y: 999 } },
      { id: 'b', name: 'B', requires: ['a'], position: { x: 999, y: 1200 } },
      { id: 'c', name: 'C', requires: ['b'], position: { x: 999, y: 1400 } },
    ],
  });

  // Where each skill is drawn, in screen pixels, keyed by name.
  const renderedX = async (p) => {
    const out = {};
    const groups = p.locator('#nodes-layer > g');
    const n = await groups.count();
    for (let i = 0; i < n; i++) {
      const g = groups.nth(i);
      out[await g.locator('.node-label').textContent()] = (await g.locator('.node-card').boundingBox()).x;
    }
    return out;
  };
  const exportFromDialog = async (p, layout, file) => {
    await p.click('#export-btn');
    await p.waitForSelector('#export-overlay[open]');
    await p.check(`input[name="export-layout"][value="${layout}"]`);
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 8000 }),
      p.click('#export-form button[type=submit]'),
    ]);
    await dl.saveAs(file);
    await p.waitForSelector('#export-overlay', { state: 'hidden' });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };

  try {
    await signUp(ctx, BASE, 'layout');

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
      (await page.textContent('#tree-meta-time')).includes('auto-arranged'));

    const beforeAdd = Object.values(await renderedX(page));
    check('auto tree renders each skill in its own column', new Set(beforeAdd.map(Math.round)).size === 3, beforeAdd);

    // Add a skill -> the graph must re-flow, not place it at a free slot
    await page.click('#add-skill-btn');
    await page.waitForSelector('#skill-modal-overlay[open]');
    await page.fill('#skill-name', 'D');
    await page.click('#new-skill-form button[type=submit]');
    await page.waitForSelector('#skill-modal-overlay', { state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('#nodes-layer > g').length === 4);

    const afterSkills = await posOf(auto.id);
    const dRow = afterSkills.find((s) => s.name === 'D');
    check('new skill in an auto tree is laid out, not placed at a stored spot',
      dRow && dRow.pos_x === 0 && dRow.pos_y === 0, dRow);
    check('auto tree still renders all 4 skills', (await page.locator('#nodes-layer > g').count()) === 4);

    // Link D -> requires C, so D must move to the far right column
    const cRow = afterSkills.find((s) => s.name === 'C');
    await page.click('#link-mode-btn');
    await page.click(`#nodes-layer g[data-skill-id="${cRow.id}"]`);
    await page.waitForSelector('#nodes-layer g[aria-label*="chosen as the prerequisite"]');
    await page.click(`#nodes-layer g[data-skill-id="${dRow.id}"]`);
    await page.waitForFunction(() => document.querySelectorAll('#edges-layer path.edge-line:not(.hit)').length === 3);

    // Stored positions stay put (they're not authoritative), but the RENDER
    // must move D right of C.
    const dAfterLink = (await posOf(auto.id)).find((s) => s.name === 'D');
    check('linking in an auto tree writes no positions', dAfterLink.pos_x === 0 && dAfterLink.pos_y === 0, dAfterLink);
    const rects = await renderedX(page);
    check('linking re-flows the graph: D now renders right of C', rects.D > rects.C, rects);

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
    await page.waitForFunction(() => document.getElementById('tree-meta-time').textContent !== '');
    check('manual mode is not labelled auto-arranged',
      !(await page.textContent('#tree-meta-time')).includes('auto-arranged'));

    // ---------- EXPORT CHOICE ----------
    // Drag a node (session-only), then export "keep arrangement" and confirm
    // the drag is captured even though the database never saw it. This runs
    // as a signed-out visitor: whether the *owner's* drag should be saved is
    // an open decision (CLAUDE.md says a drag never saves; frontend/tree.js
    // PATCHes the owner's drop), and exporting is open to everyone anyway.
    skip('an owner\'s drag on a manual tree does not touch the database',
      'pending the decision on whether an owner\'s drag saves; see drag-not-saved.test.js');
    const visitorCtx = await browser.newContext({ acceptDownloads: true });
    const visitor = await visitorCtx.newPage();
    const visitorErrors = watchConsole(visitor);
    const visitorWrites = await watchWrites(visitor);
    await visitor.goto(`${BASE}/tree.html?id=${manual.id}`);
    await visitor.waitForSelector('#nodes-layer > g');

    const dragged = visitor.locator('#nodes-layer > g').first();
    const draggedId = Number(await dragged.getAttribute('data-skill-id'));
    const draggedName = manualSkills.find((s) => s.id === draggedId).name;
    const box = await dragged.locator('.node-card').boundingBox();
    await visitor.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await visitor.mouse.down();
    await visitor.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 140, { steps: 8 });
    await visitor.mouse.up();
    const drawnAt = await visitor.evaluate((id) => {
      const m = document
        .querySelector(`#nodes-layer g[data-skill-id="${id}"]`)
        .getAttribute('transform')
        .match(/translate\(([-\d.e]+),\s*([-\d.e]+)\)/);
      return { x: Math.round(Number(m[1])), y: Math.round(Number(m[2])) };
    }, draggedId);
    check('the drag moved the skill on screen', drawnAt.x !== 999 && drawnAt.y !== 999, drawnAt);

    const startedByDrag = await visitorWrites.started();
    const dbAfterDrag = await posOf(manual.id);
    check('dragging still does not touch the database',
      startedByDrag.length === 0 && dbAfterDrag.every((s) => s.pos_x === 999),
      { writes: startedByDrag, db: dbAfterDrag.map((s) => [s.name, s.pos_x, s.pos_y]) });

    const kept = await exportFromDialog(visitor, 'manual', path.join(tmp, 'keep.json'));
    check('"keep arrangement" export says layout=manual', kept.layout === 'manual');
    const keptDragged = kept.skills.find((s) => s.name === draggedName);
    check('"keep arrangement" export captured the drag the database never saw',
      keptDragged && keptDragged.position.x === drawnAt.x && keptDragged.position.y === drawnAt.y,
      { drawnAt, exported: kept.skills.map((s) => [s.id, s.position]) });

    // Export the same tree as "arrange automatically"
    const autoFile = await exportFromDialog(visitor, 'auto', path.join(tmp, 'auto.json'));
    check('"arrange automatically" export says layout=auto', autoFile.layout === 'auto');
    check('"arrange automatically" export carries no positions at all',
      autoFile.skills.every((s) => !('position' in s)), autoFile.skills[0]);
    check('...but keeps the full structure', autoFile.skills.length === 3 &&
      autoFile.skills.find((s) => s.id === 'c').requires.length === 1);
    check('the visitor\'s page sent nothing but its two exports',
      visitorWrites.network.length === 2 &&
        visitorWrites.network.every((w) => /^POST \/api\/trees\/\d+\/export$/.test(w)), visitorWrites.network);
    check('no console errors for the visitor', visitorErrors.length === 0, visitorErrors);
    await visitorCtx.close();

    // Re-importing the auto file yields an auto tree
    const reimported = await importTree(autoFile);
    check('re-importing an auto export produces an auto tree', reimported.layout === 'auto', reimported);

    // ---------- ROUND TRIP ----------
    const exp1 = await exportText(manual.id);
    const imp = await importTree(JSON.parse(exp1));
    const exp2 = await exportText(imp.id);
    check('manual round-trip is byte-identical', exp1 === exp2);

    const autoExp1 = await exportText(auto.id);
    const autoImp = await importTree(JSON.parse(autoExp1));
    const autoExp2 = await exportText(autoImp.id);
    check('auto round-trip is byte-identical', autoExp1 === autoExp2);

    // ---------- VALIDATOR ----------
    const bad = await ctx.request.post(`${BASE}/api/trees/import`, {
      data: { format: 'skilltree', version: 1, title: 'X', layout: 'sideways', skills: [] },
    });
    const badBody = await bad.json();
    check('an invalid layout value is rejected',
      bad.status() === 400 && JSON.stringify(badBody.problems).includes('layout'), badBody);

    // Every import above went through the API, not the page, so the page
    // itself has no failed request to show.
    check('no console errors', consoleErrors.length === 0, consoleErrors);
  } catch (err) {
    check('suite ran to completion', false, err.message);
  } finally {
    for (const id of cleanup) await ctx.request.delete(`${BASE}/api/trees/${id}`).catch(() => {});
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (srv) await srv.stop();
  }
  finish();
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
