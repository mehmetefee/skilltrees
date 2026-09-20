const { chromium } = require('playwright');

const BASE = 'http://localhost:3001';

(async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  const results = [];
  const check = (label, cond) => {
    results.push({ label, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  };

  // 1. Home page loads and shows seeded tree
  await page.goto(BASE + '/');
  await page.waitForSelector('.tree-card', { timeout: 5000 });
  const cardCount = await page.locator('.tree-card').count();
  check('home page shows at least 1 tree card', cardCount >= 1);

  // 2. Create a new tree via the modal
  await page.click('#new-tree-btn');
  await page.fill('#tree-title', 'E2E Test Tree');
  await page.fill('#tree-desc', 'Created by automated test');
  await page.fill('#tree-author', 'E2E Bot');
  await page.click('#new-tree-form button[type=submit]');
  await page.waitForURL(/tree\.html\?id=\d+/, { timeout: 5000 });
  const treeUrl = page.url();
  const treeId = new URL(treeUrl).searchParams.get('id');
  check('redirected to new tree page', !!treeId);

  await page.waitForSelector('#tree-title:has-text("E2E Test Tree")', { timeout: 5000 });
  check('tree title rendered', await page.locator('#tree-title').textContent() === 'E2E Test Tree');

  // 3. Add two skills
  async function addSkill(name, desc) {
    await page.click('#add-skill-btn');
    await page.fill('#skill-name', name);
    await page.fill('#skill-desc', desc);
    await page.click('#new-skill-form button[type=submit]');
    await page.waitForSelector('#skill-modal-overlay', { state: 'hidden', timeout: 5000 });
  }
  await addSkill('Skill A', 'The first skill');
  await page.waitForTimeout(300);
  await addSkill('Skill B', 'The second skill');
  await page.waitForTimeout(300);

  const nodeCount = await page.locator('#nodes-layer > g').count();
  check('two skill nodes rendered', nodeCount === 2);

  // 4. Link Skill A -> prerequisite of Skill B
  await page.click('#link-mode-btn');
  const nodes = page.locator('#nodes-layer > g');
  const firstNodeText = await nodes.nth(0).locator('.node-label').textContent();
  const secondNodeText = await nodes.nth(1).locator('.node-label').textContent();
  await nodes.nth(0).click();
  await page.waitForTimeout(200);
  await nodes.nth(1).click();
  await page.waitForTimeout(500);

  const edgeCount = await page.locator('#edges-layer path.edge-line:not(.hit)').count();
  check('one edge rendered after linking', edgeCount === 1);

  // link mode auto-resets source but stays in link mode; turn it off
  const linkBtnText = await page.locator('#link-mode-btn').textContent();
  if (linkBtnText.includes('Cancel')) {
    await page.click('#link-mode-btn');
  }

  // 5. Click a node to open side panel
  await page.locator('#nodes-layer > g').nth(1).click();
  await page.waitForSelector('#side-panel.open', { timeout: 3000 });
  const panelName = await page.locator('#panel-name').textContent();
  check('side panel opened with correct skill name', panelName === secondNodeText);
  const prereqText = await page.locator('#panel-prereqs').textContent();
  check('side panel shows correct prerequisite name', prereqText.includes(firstNodeText));

  await page.click('#panel-close');

  // 6. Drag a node and verify position persisted after reload
  const nodeBox = await page.locator('#nodes-layer > g').nth(0).locator('rect').boundingBox();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2 - 20, nodeBox.y + nodeBox.height / 2 - 300, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  await page.reload();
  await page.waitForSelector('#nodes-layer > g', { timeout: 5000 });
  const newBox = await page.locator('#nodes-layer > g').nth(0).locator('rect').boundingBox();
  check('node position persisted after drag + reload', newBox.x !== nodeBox.x);

  // 7. Cycle prevention: try to link Skill B back as prerequisite of Skill A (should fail silently but not crash / not add edge)
  await page.click('#link-mode-btn');
  await page.locator('#nodes-layer > g').nth(1).click();
  await page.waitForTimeout(200);
  await page.locator('#nodes-layer > g').nth(0).click();
  await page.waitForTimeout(500);
  const edgeCountAfterCycleAttempt = await page.locator('#edges-layer path.edge-line:not(.hit)').count();
  check('cycle-creating link was rejected (still only 1 edge)', edgeCountAfterCycleAttempt === 1);
  const linkBtnText2 = await page.locator('#link-mode-btn').textContent();
  if (linkBtnText2.includes('Cancel')) await page.click('#link-mode-btn');

  // 8. Delete a skill via side panel, verify edge count drops
  await page.locator('#nodes-layer > g').nth(1).click();
  await page.waitForSelector('#side-panel.open');
  page.once('dialog', (d) => d.accept());
  await page.click('#panel-delete-btn');
  await page.waitForTimeout(500);
  const nodeCountAfterDelete = await page.locator('#nodes-layer > g').count();
  check('skill deleted, 1 node remains', nodeCountAfterDelete === 1);

  // 9. Delete the whole test tree, verify redirect home and it's gone from list
  page.once('dialog', (d) => d.accept());
  await page.click('#delete-tree-btn');
  await page.waitForURL(BASE + '/', { timeout: 5000 });
  await page.waitForSelector('.tree-card', { timeout: 5000 });
  const titles = await page.locator('.tree-card h3').allTextContents();
  check('deleted tree no longer in list', !titles.includes('E2E Test Tree'));

  check('no console errors during test run', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('Console errors:', consoleErrors);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILURES:', failed.map((f) => f.label));
    process.exit(1);
  }
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
