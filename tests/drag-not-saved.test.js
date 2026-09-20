const { chromium } = require('playwright');
const BASE = 'http://localhost:3001';

(async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage();
  const netCalls = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/') && req.method() !== 'GET') netCalls.push(`${req.method()} ${req.url()}`);
  });

  const results = [];
  const check = (label, cond) => {
    results.push({ label, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  };

  await page.goto(BASE + '/tree.html?id=1');
  await page.waitForSelector('#nodes-layer > g', { timeout: 5000 });

  const nodeBoxBefore = await page.locator('#nodes-layer > g').nth(0).locator('rect').boundingBox();
  const serverPosBefore = (await (await fetch(BASE + '/api/trees/1')).json()).skills[0];

  // Drag the node
  await page.mouse.move(nodeBoxBefore.x + nodeBoxBefore.width / 2, nodeBoxBefore.y + nodeBoxBefore.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBoxBefore.x + 120, nodeBoxBefore.y + 90, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const nodeBoxAfterDrag = await page.locator('#nodes-layer > g').nth(0).locator('rect').boundingBox();
  check('node visually moved after drag', Math.abs(nodeBoxAfterDrag.x - nodeBoxBefore.x) > 20);

  const noPatchCalls = netCalls.filter((c) => c.startsWith('PATCH'));
  check('no PATCH request was sent during/after drag', noPatchCalls.length === 0);

  // Reload and confirm position reverted to server value (i.e. nothing persisted)
  await page.reload();
  await page.waitForSelector('#nodes-layer > g', { timeout: 5000 });
  const serverPosAfter = (await (await fetch(BASE + '/api/trees/1')).json()).skills[0];
  check('server-side position unchanged after drag', serverPosAfter.pos_x === serverPosBefore.pos_x && serverPosAfter.pos_y === serverPosBefore.pos_y);

  const nodeBoxAfterReload = await page.locator('#nodes-layer > g').nth(0).locator('rect').boundingBox();
  check('node visually reset to original position after reload', Math.abs(nodeBoxAfterReload.x - nodeBoxBefore.x) < 5);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILURES:', failed.map((f) => f.label)); process.exit(1); }
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
