const { chromium } = require('playwright');
const BASE = 'http://localhost:3001';
const NODE_W = 170, NODE_H = 56;

(async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const results = [];
  const check = (label, cond, detail) => {
    results.push({ label, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${!cond && detail ? '\n        ' + JSON.stringify(detail).slice(0, 400) : ''}`);
  };

  // Fresh empty tree
  const tree = await (await fetch(BASE + '/api/trees', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Placement Test', author: 'tester' }),
  })).json();

  await page.goto(`${BASE}/tree.html?id=${tree.id}`);
  await page.waitForSelector('#add-skill-btn');

  const addSkill = async (name) => {
    await page.click('#add-skill-btn');
    await page.fill('#skill-name', name);
    await page.click('#new-skill-form button[type=submit]');
    await page.waitForSelector('#skill-modal-overlay', { state: 'hidden', timeout: 5000 });
    await page.waitForTimeout(150);
  };

  // Add enough skills to fill a viewport and force the off-screen fallback.
  const N = 14;
  for (let i = 1; i <= N; i++) await addSkill(`Skill ${i}`);

  const nodeCount = await page.locator('#nodes-layer > g').count();
  check(`all ${N} skills were added`, nodeCount === N, nodeCount);

  // Check stored positions for overlaps
  const data = await (await fetch(`${BASE}/api/trees/${tree.id}`)).json();
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
  const vb = (await page.locator('#graph-svg').getAttribute('viewBox')).split(' ').map(Number);
  const [vx, vy, vw, vh] = vb;
  const offscreen = data.skills.filter(
    (s) => s.pos_x < vx || s.pos_y < vy || s.pos_x + NODE_W > vx + vw || s.pos_y + NODE_H > vy + vh
  );
  check('every skill ended up inside the visible area', offscreen.length === 0,
    { viewBox: vb, offscreen: offscreen.map((s) => [s.name, s.pos_x, s.pos_y]) });

  // Each node should also be individually clickable (nothing covering another)
  let clickable = 0;
  for (let i = 0; i < N; i++) {
    try {
      await page.locator('#nodes-layer > g').nth(i).click({ timeout: 2000 });
      await page.waitForSelector('#side-panel.open', { timeout: 2000 });
      await page.click('#panel-close');
      clickable++;
    } catch (e) { /* counted as not clickable */ }
  }
  check(`all ${N} nodes are individually clickable`, clickable === N, `${clickable}/${N}`);

  check('no console errors', consoleErrors.length === 0, consoleErrors);

  await fetch(`${BASE}/api/trees/${tree.id}`, { method: 'DELETE' });
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILURES:', failed.map((f) => f.label)); process.exit(1); }
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
