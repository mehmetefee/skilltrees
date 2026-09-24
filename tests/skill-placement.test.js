// Where "Add skill" puts new skills in a manual tree: never on top of one
// another, at clean integer positions, inside the visible area, and each one
// still individually clickable — enough of them to fill the view and force
// the off-screen fallback.
//
// Starts its own server on a throwaway database (see tests/helpers/browser.js).
// BASE_URL aims it at a running server instead; it deletes its tree either way.
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/skill-placement.test.js

const { launchBrowser, startTarget, createReporter, watchConsole, signUp } = require('./helpers/browser');

const NODE_W = 170;
const NODE_H = 56;
const { check, finish } = createReporter();

(async () => {
  const { base: BASE, srv } = await startTarget();
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = watchConsole(page);
  let tree = null;

  try {
    await signUp(context, BASE, 'place');
    // Fresh empty tree
    tree = await (await context.request.post(`${BASE}/api/trees`, {
      data: { title: 'Placement Test', author: 'tester' },
    })).json();

    await page.goto(`${BASE}/tree.html?id=${tree.id}`);
    await page.waitForSelector('#add-skill-btn', { state: 'visible' });

    const addSkill = async (name, expected) => {
      await page.click('#add-skill-btn');
      await page.waitForSelector('#skill-modal-overlay[open]');
      await page.fill('#skill-name', name);
      await page.click('#new-skill-form button[type=submit]');
      await page.waitForSelector('#skill-modal-overlay', { state: 'hidden', timeout: 5000 });
      // The submit handler re-enables its button last, after reloading the
      // tree and refitting the view — the point where the next add can start.
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll('#nodes-layer > g').length === n &&
          !document.querySelector('#new-skill-form button[type=submit]').disabled,
        expected,
        { timeout: 5000 }
      );
    };

    // Add enough skills to fill a viewport and force the off-screen fallback.
    const N = 14;
    for (let i = 1; i <= N; i++) await addSkill(`Skill ${i}`, i);

    const nodeCount = await page.locator('#nodes-layer > g').count();
    check(`all ${N} skills were added`, nodeCount === N, nodeCount);

    // Check stored positions for overlaps
    const data = await (await context.request.get(`${BASE}/api/trees/${tree.id}`)).json();
    const overlaps = [];
    for (let i = 0; i < data.skills.length; i++) {
      for (let j = i + 1; j < data.skills.length; j++) {
        const a = data.skills[i], b = data.skills[j];
        const hit = a.pos_x < b.pos_x + NODE_W && a.pos_x + NODE_W > b.pos_x &&
                    a.pos_y < b.pos_y + NODE_H && a.pos_y + NODE_H > b.pos_y;
        if (hit) overlaps.push(`${a.name}@(${a.pos_x},${a.pos_y}) overlaps ${b.name}@(${b.pos_x},${b.pos_y})`);
      }
    }
    check('no two skills overlap', overlaps.length === 0, overlaps);

    // Positions must be deterministic, not random
    const allIntegers = data.skills.every((s) => Number.isInteger(s.pos_x) && Number.isInteger(s.pos_y));
    check('positions are clean integers (not random floats)', allIntegers,
      data.skills.slice(0, 3).map((s) => [s.pos_x, s.pos_y]));

    // Every node must be visible in the rendered viewBox after the adds
    const vb = (await page.locator('#graph-svg').getAttribute('viewBox')).split(/\s+/).map(Number);
    const [vx, vy, vw, vh] = vb;
    const offscreen = data.skills.filter(
      (s) => s.pos_x < vx || s.pos_y < vy || s.pos_x + NODE_W > vx + vw || s.pos_y + NODE_H > vy + vh
    );
    check('every skill ended up inside the visible area', offscreen.length === 0,
      { viewBox: vb, offscreen: offscreen.map((s) => [s.name, s.pos_x, s.pos_y]) });

    // Each node should also be individually clickable (nothing covering another)
    const notClickable = [];
    for (let i = 0; i < N; i++) {
      const g = page.locator('#nodes-layer > g').nth(i);
      const name = await g.locator('.node-label').textContent();
      try {
        await g.click({ timeout: 2000 });
        await page.waitForFunction((n) => {
          const panel = document.getElementById('side-panel');
          return panel.classList.contains('open') && document.getElementById('panel-name').textContent === n;
        }, name, { timeout: 2000 });
        await page.click('#panel-close');
        await page.waitForSelector('#side-panel:not(.open)', { state: 'attached', timeout: 2000 });
      } catch (e) {
        notClickable.push(name);
      }
    }
    check(`all ${N} nodes are individually clickable`, notClickable.length === 0, notClickable);

    check('no console errors', consoleErrors.length === 0, consoleErrors);
  } catch (err) {
    check('suite ran to completion', false, err.message);
  } finally {
    if (tree && tree.id) await context.request.delete(`${BASE}/api/trees/${tree.id}`).catch(() => {});
    await browser.close();
    if (srv) await srv.stop();
  }
  finish();
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
