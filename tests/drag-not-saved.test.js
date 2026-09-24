// Dragging a skill moves it on screen but must not reach the database for
// anyone who can't edit the tree, nor on a tree whose layout is computed
// ('auto'). Each case drags a skill, checks that the page sent no write, then
// reloads and checks that the server still has — and the page again draws —
// the original position.
//
//   - a signed-out visitor, on the example tree (made before accounts, so
//     nobody owns it);
//   - a signed-in account that doesn't own the tree;
//   - the owner, on an auto-layout tree.
//
// The owner dragging on a *manual* tree is not asserted either way: CLAUDE.md
// says "Dragging a skill never saves", while attachNodeInteractions() in
// frontend/tree.js PATCHes the owner's new position. Which one is right is an
// open decision; the suite prints a SKIP line for it until that's settled.
//
// Starts its own server on a throwaway database, seeded with the example tree
// (see tests/helpers/browser.js). BASE_URL aims it at a running server
// instead; it deletes the trees it makes either way.
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/drag-not-saved.test.js

const {
  launchBrowser,
  startTarget,
  createReporter,
  watchConsole,
  watchWrites,
  signUp,
  seededTreeId,
} = require('./helpers/browser');

const { check, skip, finish } = createReporter();

(async () => {
  const { base: BASE, srv } = await startTarget({ seed: true });
  const browser = await launchBrowser();
  const consoleErrors = [];
  const created = [];
  let owner = null;

  // A page in a context of its own (its own cookies), watched for console
  // errors and for any request that could write.
  const openAs = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = watchConsole(page);
    const writes = await watchWrites(page);
    return { context, page, errors, writes };
  };

  const serverPos = async (request, treeId, skillId) => {
    const tree = await (await request.get(`${BASE}/api/trees/${treeId}`)).json();
    const s = tree.skills.find((k) => k.id === skillId);
    return { x: s.pos_x, y: s.pos_y };
  };

  // Drags the first skill on the page and checks it never reaches the server.
  const dragAndReload = async (who, { context, page, writes }, treeId) => {
    await page.goto(`${BASE}/tree.html?id=${treeId}`);
    await page.waitForSelector('#nodes-layer > g', { timeout: 5000 });
    const skillId = Number(await page.locator('#nodes-layer > g').first().getAttribute('data-skill-id'));
    const card = page.locator(`#nodes-layer g[data-skill-id="${skillId}"] .node-card`);
    const nodeBoxBefore = await card.boundingBox();
    const serverPosBefore = await serverPos(context.request, treeId, skillId);

    const cx = nodeBoxBefore.x + nodeBoxBefore.width / 2;
    const cy = nodeBoxBefore.y + nodeBoxBefore.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 90, { steps: 10 });
    await page.mouse.up();

    const nodeBoxAfterDrag = await card.boundingBox();
    check(`${who}: node visually moved after drag`,
      Math.abs(nodeBoxAfterDrag.x - nodeBoxBefore.x) > 20 && Math.abs(nodeBoxAfterDrag.y - nodeBoxBefore.y) > 20,
      [nodeBoxBefore, nodeBoxAfterDrag]);
    // Recorded inside the page as fetch() is called, so nothing still on its
    // way out can be missed by asking now.
    const started = await writes.started();
    check(`${who}: no PATCH (or any other write) was sent during/after drag`, started.length === 0, started);

    // Reload and confirm position reverted to server value (i.e. nothing persisted)
    await page.reload();
    await page.waitForSelector('#nodes-layer > g', { timeout: 5000 });
    const serverPosAfter = await serverPos(context.request, treeId, skillId);
    check(`${who}: server-side position unchanged after drag`,
      serverPosAfter.x === serverPosBefore.x && serverPosAfter.y === serverPosBefore.y,
      [serverPosBefore, serverPosAfter]);
    const nodeBoxAfterReload = await card.boundingBox();
    check(`${who}: node visually reset to original position after reload`,
      Math.abs(nodeBoxAfterReload.x - nodeBoxBefore.x) < 5 && Math.abs(nodeBoxAfterReload.y - nodeBoxBefore.y) < 5,
      [nodeBoxBefore, nodeBoxAfterReload]);
    check(`${who}: no write request left the page at all`, writes.network.length === 0, writes.network);
  };

  try {
    // ---------- a signed-out visitor, on the unowned example tree ----------
    const visitor = await openAs();
    const seededId = await seededTreeId(visitor.context.request, BASE);
    await dragAndReload('signed-out visitor', visitor, seededId);
    consoleErrors.push(...visitor.errors);

    // ---------- trees with an owner ----------
    owner = await openAs();
    await signUp(owner.context, BASE, 'dragown');
    const importTree = async (layout) => {
      const res = await owner.context.request.post(`${BASE}/api/trees/import`, {
        data: {
          format: 'skilltree', version: 1, title: `Drag test (${layout})`, author: 'owner', layout,
          skills: [
            { id: 'first', name: 'First', position: { x: 0, y: 0 } },
            { id: 'second', name: 'Second', requires: ['first'], position: { x: 250, y: 0 } },
            { id: 'third', name: 'Third', requires: ['first'], position: { x: 250, y: 120 } },
          ],
        },
      });
      if (res.status() !== 201) throw new Error(`import failed: ${res.status()} ${await res.text()}`);
      const tree = await res.json();
      created.push(tree.id);
      return tree;
    };
    const manualTree = await importTree('manual');
    const autoTree = await importTree('auto');

    // ---------- signed in, but not the owner ----------
    const other = await openAs();
    await signUp(other.context, BASE, 'dragother');
    await dragAndReload('another account', other, manualTree.id);
    consoleErrors.push(...other.errors);

    // ---------- the owner, on an auto-layout tree ----------
    // Positions in an auto tree are computed from its structure on every
    // render, so a drag there is always session-only, owner or not.
    await dragAndReload('owner, auto layout', owner, autoTree.id);

    // ---------- the owner, on a manual tree ----------
    // Deliberately not asserted: whether this should save is the open
    // decision described at the top of this file (CLAUDE.md, "Dragging a skill
    // never saves", against the PATCH in attachNodeInteractions()).
    skip('owner, manual layout: drag is not saved',
      'pending the decision on whether an owner\'s drag saves (CLAUDE.md vs frontend/tree.js)');

    consoleErrors.push(...owner.errors);
    check('no console errors', consoleErrors.length === 0, consoleErrors);
  } catch (err) {
    check('suite ran to completion', false, err.message);
  } finally {
    if (owner) {
      for (const id of created) await owner.context.request.delete(`${BASE}/api/trees/${id}`).catch(() => {});
    }
    await browser.close();
    if (srv) await srv.stop();
  }
  finish();
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
