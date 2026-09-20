const { chromium } = require('playwright');
const BASE = 'http://localhost:3001';

(async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  const results = [];
  const check = (label, cond) => {
    results.push({ label, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  };

  await page.goto(BASE + '/tree.html?id=1');
  await page.waitForSelector('#nodes-layer > g', { timeout: 5000 });

  // 1. Arrowhead marker size
  const markerW = await page.locator('#arrowhead').getAttribute('markerWidth');
  const markerH = await page.locator('#arrowhead').getAttribute('markerHeight');
  check('arrowhead marker is small (<=8 user units)', Number(markerW) <= 8 && Number(markerH) <= 8);

  // 2. Initial viewBox (fit to content)
  const initialVB = await page.locator('#graph-svg').getAttribute('viewBox');
  console.log('Initial viewBox:', initialVB);
  const [ivX, ivY, ivW, ivH] = initialVB.split(' ').map(Number);

  // 3. Scroll to zoom in over the graph
  const wrapBox = await page.locator('#graph-wrap').boundingBox();
  const cx = wrapBox.x + wrapBox.width / 2;
  const cy = wrapBox.y + wrapBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -300); // scroll up = zoom in
  await page.waitForTimeout(200);
  const zoomedInVB = await page.locator('#graph-svg').getAttribute('viewBox');
  const [, , zwW] = zoomedInVB.split(' ').map(Number);
  check('scroll wheel zoomed in (viewBox width shrank)', zwW < ivW);

  await page.mouse.wheel(0, 600); // scroll down = zoom out past original
  await page.waitForTimeout(200);
  const zoomedOutVB = await page.locator('#graph-svg').getAttribute('viewBox');
  const [, , zoW] = zoomedOutVB.split(' ').map(Number);
  check('scroll wheel zoomed out (viewBox width grew again)', zoW > zwW);

  // 4. Zoom buttons
  await page.click('#zoom-in-btn');
  await page.waitForTimeout(150);
  const afterBtnZoomIn = await page.locator('#graph-svg').getAttribute('viewBox');
  const [, , btnW] = afterBtnZoomIn.split(' ').map(Number);
  check('zoom-in button shrinks viewBox', btnW < zoW);

  await page.click('#zoom-fit-btn');
  await page.waitForTimeout(150);
  const afterFit = await page.locator('#graph-svg').getAttribute('viewBox');
  check('fit button restores original-ish viewBox', afterFit === initialVB);

  // 5. Drag on background pans (not on a node)
  const beforePanVB = await page.locator('#graph-svg').getAttribute('viewBox');
  const [bpX, bpY] = beforePanVB.split(' ').map(Number);
  // find empty space: top-left corner of graph-wrap, away from nodes
  await page.mouse.move(wrapBox.x + 15, wrapBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(wrapBox.x + 115, wrapBox.y + 65, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterPanVB = await page.locator('#graph-svg').getAttribute('viewBox');
  const [apX, apY] = afterPanVB.split(' ').map(Number);
  check('dragging background panned the view (viewBox origin moved)', apX !== bpX || apY !== bpY);

  // 6. Node dragging still works (not confused with panning)
  await page.click('#zoom-fit-btn');
  await page.waitForTimeout(150);
  const nodeBoxBefore = await page.locator('#nodes-layer > g').nth(0).locator('rect').boundingBox();
  await page.mouse.move(nodeBoxBefore.x + nodeBoxBefore.width / 2, nodeBoxBefore.y + nodeBoxBefore.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBoxBefore.x + 40, nodeBoxBefore.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const nodeBoxAfter = await page.locator('#nodes-layer > g').nth(0).locator('rect').boundingBox();
  check('node drag still moves the node (not intercepted by pan)', Math.abs(nodeBoxAfter.x - nodeBoxBefore.x) > 5);

  // Revert that drag via reload without saving check (informational only, skip)

  check('no console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('Console errors:', consoleErrors);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILURES:', failed.map((f) => f.label));
    process.exit(1);
  }
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
