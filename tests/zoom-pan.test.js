// Zoom and pan on the tree page with a mouse: the scroll wheel, the zoom
// buttons and Fit, dragging the background to pan, and dragging a skill still
// moving the skill rather than the view. (The keyboard equivalents are in
// a11y-keyboard.test.js.)
//
// Starts its own server on a throwaway database, seeded with the example tree
// (see tests/helpers/browser.js); BASE_URL aims it at a running server
// instead. Reading a tree is public and nothing here writes, so it runs
// signed out and spends none of the signups an address is allowed.
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/zoom-pan.test.js

const {
  launchBrowser,
  startTarget,
  createReporter,
  watchConsole,
  seededTreeId,
} = require('./helpers/browser');

const { check, finish } = createReporter();

(async () => {
  const { base: BASE, srv } = await startTarget({ seed: true });
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = watchConsole(page);

  const viewBox = () => page.locator('#graph-svg').getAttribute('viewBox');
  const parse = (vb) => vb.split(/\s+/).map(Number);
  // Wheel and click handlers update the viewBox synchronously, but input
  // events reach the page asynchronously; wait for the change, not a time.
  const viewBoxAfter = async (previous) => {
    await page
      .waitForFunction((vb) => document.getElementById('graph-svg').getAttribute('viewBox') !== vb, previous, { timeout: 2000 })
      .catch(() => {});
    return viewBox();
  };

  try {
    const treeId = await seededTreeId(context.request, BASE);
    await page.goto(`${BASE}/tree.html?id=${treeId}`);
    await page.waitForSelector('#nodes-layer > g', { timeout: 5000 });

    // 1. Arrowhead marker size
    const markerW = await page.locator('#arrowhead').getAttribute('markerWidth');
    const markerH = await page.locator('#arrowhead').getAttribute('markerHeight');
    check('arrowhead marker is small (<=8 user units)', Number(markerW) <= 8 && Number(markerH) <= 8, [markerW, markerH]);

    // 2. Initial viewBox (fit to content)
    const initialVB = await viewBox();
    const [, , ivW] = parse(initialVB);

    // 3. Scroll to zoom in over the graph
    const wrapBox = await page.locator('#graph-wrap').boundingBox();
    const cx = wrapBox.x + wrapBox.width / 2;
    const cy = wrapBox.y + wrapBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -300); // scroll up = zoom in
    const zoomedInVB = await viewBoxAfter(initialVB);
    const [, , zwW] = parse(zoomedInVB);
    check('scroll wheel zoomed in (viewBox width shrank)', zwW < ivW, [initialVB, zoomedInVB]);

    await page.mouse.wheel(0, 600); // scroll down = zoom out
    const zoomedOutVB = await viewBoxAfter(zoomedInVB);
    const [, , zoW] = parse(zoomedOutVB);
    check('scroll wheel zoomed out (viewBox width grew again)', zoW > zwW, [zoomedInVB, zoomedOutVB]);

    // 4. Zoom buttons
    await page.click('#zoom-in-btn');
    const afterBtnZoomIn = await viewBoxAfter(zoomedOutVB);
    const [, , btnW] = parse(afterBtnZoomIn);
    check('zoom-in button shrinks viewBox', btnW < zoW, [zoomedOutVB, afterBtnZoomIn]);

    await page.click('#zoom-out-btn');
    const afterBtnZoomOut = await viewBoxAfter(afterBtnZoomIn);
    check('zoom-out button grows it again', parse(afterBtnZoomOut)[2] > btnW, [afterBtnZoomIn, afterBtnZoomOut]);

    await page.click('#zoom-fit-btn');
    const afterFit = await viewBoxAfter(afterBtnZoomOut);
    check('fit button restores the original viewBox', afterFit === initialVB, [initialVB, afterFit]);

    // 5. Drag on background pans (not on a node, and not on the floating
    // chrome over the canvas — the title, toolbar, legend and zoom buttons).
    const empty = await page.evaluate(() => {
      const svg = document.getElementById('graph-svg');
      const r = svg.getBoundingClientRect();
      for (let y = r.top + 20; y < r.bottom - 120; y += 20) {
        for (let x = r.left + 20; x < r.right - 120; x += 20) {
          if (document.elementFromPoint(x, y) === svg) return { x, y };
        }
      }
      return null;
    });
    check('found bare background to drag', !!empty);
    const beforePanVB = await viewBox();
    const [bpX, bpY, bpW, bpH] = parse(beforePanVB);
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x + 100, empty.y + 60, { steps: 8 });
    await page.mouse.up();
    const afterPanVB = await viewBoxAfter(beforePanVB);
    const [apX, apY, apW, apH] = parse(afterPanVB);
    check('dragging background panned the view (viewBox origin moved)', apX !== bpX || apY !== bpY, [beforePanVB, afterPanVB]);
    check('...with the drag: dragging right and down shows what was up and left',
      apX < bpX && apY < bpY, [beforePanVB, afterPanVB]);
    check('...without zooming', apW === bpW && apH === bpH, [beforePanVB, afterPanVB]);

    // 6. Node dragging still works (not confused with panning)
    await page.click('#zoom-fit-btn');
    await viewBoxAfter(afterPanVB);
    const vbBeforeNodeDrag = await viewBox();
    const card = page.locator('#nodes-layer > g').first().locator('.node-card');
    const nodeBoxBefore = await card.boundingBox();
    await page.mouse.move(nodeBoxBefore.x + nodeBoxBefore.width / 2, nodeBoxBefore.y + nodeBoxBefore.height / 2);
    await page.mouse.down();
    await page.mouse.move(nodeBoxBefore.x + nodeBoxBefore.width / 2 + 40, nodeBoxBefore.y + nodeBoxBefore.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    const nodeBoxAfter = await card.boundingBox();
    check('node drag still moves the node (not intercepted by pan)',
      Math.abs(nodeBoxAfter.x - nodeBoxBefore.x) > 5 && Math.abs(nodeBoxAfter.y - nodeBoxBefore.y) > 5,
      [nodeBoxBefore, nodeBoxAfter]);
    check('...and leaves the view where it was', (await viewBox()) === vbBeforeNodeDrag, [vbBeforeNodeDrag, await viewBox()]);

    check('no console errors', consoleErrors.length === 0, consoleErrors);
  } catch (err) {
    check('suite ran to completion', false, err.message);
  } finally {
    await browser.close();
    if (srv) await srv.stop();
  }
  finish();
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
