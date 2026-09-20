// Skill tree viewer/editor: renders an SVG graph of skills (nodes) and
// prerequisite links (edges), and lets the owner add skills, link
// prerequisites, reposition nodes, and delete things. Anyone can read a tree;
// only the account that made it can change it, which the server enforces.

const NODE_W = 170;
const NODE_H = 56;

const params = new URLSearchParams(window.location.search);
// No id means a brand new tree. Nothing is saved until there's something worth
// saving — see ensureSaved() — so opening this page and wandering off doesn't
// leave an empty tree on the homepage.
let treeId = Number(params.get('id')) || null;

const svg = document.getElementById('graph-svg');
const edgesLayer = document.getElementById('edges-layer');
const nodesLayer = document.getElementById('nodes-layer');
const graphWrap = document.getElementById('graph-wrap');

let tree = null; // { id, title, description, skills: [], edges: [] }
// Waypoints for edges that skip a column, so they route around what's in the
// way instead of straight through it. Only auto mode has them — manual
// coordinates are wherever someone put them, so there's nothing to route.
let autoRoutes = null;
let selectedSkillId = null;
let lastPlacedSkillId = null; // most recently placed, dragged, or selected skill
let linkMode = false;
let linkSourceId = null; // prereq skill chosen first, in link mode
let draggingSkillId = null; // node currently being dragged

// The current pan/zoom window, as an SVG viewBox {minX, minY, w, h}. Distinct
// from computeContentBounds(), which is only the "fit everything" size —
// zooming/panning moves this away from that without touching node data.
let viewBox = null;
const MIN_VIEW_SIZE = 150; // most zoomed in (smallest viewBox = most zoomed)
const MAX_VIEW_SIZE = 8000; // most zoomed out

// Anyone can read a tree; only the account that made it can change it. The
// server enforces that — this just keeps the page honest about it.
let canEdit = false;

init();

async function init() {
  await loadSignedInUser();

  if (treeId) {
    await loadTree();
  } else {
    if (!signedInUser) {
      // Nothing to show a signed-out visitor here: a new tree is theirs to own.
      window.location.href = '/account.html?next=%2Ftree.html';
      return;
    }
    startDraft();
  }

  setupToolbar();
  setupModal();
  setupSidePanel();
  setupZoomAndPan();
  setupExportModal();
  if (canEdit) setupHeaderEditing();
  watchDescriptionWidth(); // read-only trees need correct sizing too
  refitOnFontLoad();
  applyPermissions();
}

// Trees made before accounts existed have no owner and nobody can edit them.
function updateCanEdit() {
  canEdit = !!signedInUser && (!treeId || (tree && tree.user_id === signedInUser.id));
}

function applyPermissions() {
  for (const id of ['add-skill-btn', 'link-mode-btn', 'delete-tree-btn']) {
    document.getElementById(id).hidden = !canEdit;
  }
  for (const id of ['tree-title', 'tree-desc', 'tree-author']) {
    const field = document.getElementById(id);
    field.readOnly = !canEdit;
    field.classList.toggle('readonly', !canEdit);
  }
  if (!canEdit) {
    document.getElementById('toolbar-hint').textContent =
      tree && tree.user_id === null
        ? 'This tree was made before accounts existed, so it is read-only.'
        : `Read-only — ${tree ? tree.author : 'someone else'} made this tree.`;
  }
}

// A new tree lives only in the browser until the first real edit.
function startDraft() {
  tree = {
    id: null,
    title: '',
    description: '',
    author: '',
    layout: 'manual',
    skills: [],
    edges: [],
  };
  document.title = 'New skill tree — Skill Trees';
  updateCanEdit();
  renderHeader();
  render();
  document.getElementById('tree-title').focus();
}

async function loadTree() {
  try {
    tree = await apiFetch(`/trees/${treeId}`);
  } catch (e) {
    document.getElementById('tree-title').value = 'Tree not found';
    showToast(e.message);
    return;
  }
  document.title = tree.title + ' — Skill Trees';
  updateCanEdit();
  renderHeader();

  // In auto mode the stored coordinates are not authoritative; the layout is
  // derived from the structure every time it's drawn.
  autoRoutes = null;
  if (isAuto()) {
    applyAutoLayout();
    // Every structural change re-flows the whole graph, so holding the old
    // viewport would just leave the person looking at the wrong place.
    // (viewBox is null on first load, where render() fits anyway.)
    if (viewBox) fitToContent();
  }

  render();
}

function isAuto() {
  return !!tree && tree.layout === 'auto';
}

// ---------- title / description / author, edited in place ----------

function renderHeader() {
  const title = document.getElementById('tree-title');
  const desc = document.getElementById('tree-desc');
  const author = document.getElementById('tree-author');

  // Never overwrite a field someone is in the middle of typing into: this also
  // runs after adding a skill, which reloads the whole tree.
  if (document.activeElement !== title) title.value = tree.title || '';
  if (document.activeElement !== desc) desc.value = tree.description || '';
  if (document.activeElement !== author) author.value = tree.author || '';
  growDescription();
  fitAuthorWidth();

  const count = tree.skills.length;
  document.getElementById('tree-meta-count').textContent =
    `${count} skill${count === 1 ? '' : 's'} ·`;
  document.getElementById('tree-meta-time').textContent = tree.created_at
    ? `· ${timeAgo(tree.created_at)}${isAuto() ? ' · auto-arranged' : ''}`
    : '· not saved yet';
}

// The right height depends on the text *and* the width it wraps at, so it
// can't be settled by one measurement at load: taken before the column has
// its final width, a one-line description wraps into dozens of lines and that
// height gets frozen into the inline style. watchDescriptionWidth() below
// re-derives it whenever the width actually changes, so the result no longer
// depends on when this first runs.
let lastDescWidth = null;

function growDescription() {
  const desc = document.getElementById('tree-desc');
  if (!desc) return;
  desc.style.height = 'auto';
  // scrollHeight covers the content and padding but not the borders, and the
  // box is border-box — so assigning it straight across leaves the field a
  // border's worth too short and shaves the last line.
  const styles = getComputedStyle(desc);
  const borders =
    parseFloat(styles.borderTopWidth || 0) + parseFloat(styles.borderBottomWidth || 0);
  desc.style.height = `${desc.scrollHeight + borders}px`;
  lastDescWidth = desc.clientWidth;
}

// Both fields size themselves from text they have measured, and the web font
// arrives after the first paint (font-display: swap). Measuring against the
// fallback face and keeping that answer leaves the author box the wrong width
// and can clip the last line of the description, and the width-only observer
// below never sees it, because swapping a font changes neither field's width.
function refitOnFontLoad() {
  if (!document.fonts || !document.fonts.ready) return;
  document.fonts.ready.then(() => {
    growDescription();
    fitAuthorWidth();
  });
}

function watchDescriptionWidth() {
  const desc = document.getElementById('tree-desc');
  if (!desc || typeof ResizeObserver === 'undefined') return;
  // Width changes only. This callback writes the element's height, so
  // reacting to height too would retrigger it in a loop.
  const observer = new ResizeObserver(() => {
    if (desc.clientWidth !== lastDescWidth) growDescription();
  });
  observer.observe(desc);
}

// Measured rather than counted. The `size` attribute is in characters, and a
// browser turns that into a width using the font's *average* character
// advance — which in a proportional face is much wider than the lowercase
// letters people actually type. "Claude" asked for six average characters
// and got a box 29px wider than the word in it, which is the gap that used
// to sit between the author and the date. So measure the string itself.
let authorRuler = null;
function fitAuthorWidth() {
  const author = document.getElementById('tree-author');
  const text = author.value || author.placeholder;
  const styles = getComputedStyle(author);
  try {
    if (!authorRuler) authorRuler = document.createElement('canvas').getContext('2d');
    authorRuler.font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
    const frame =
      parseFloat(styles.paddingLeft || 0) + parseFloat(styles.paddingRight || 0) +
      parseFloat(styles.borderLeftWidth || 0) + parseFloat(styles.borderRightWidth || 0);
    // Two pixels of slack so the caret at the end of the text has somewhere
    // to sit rather than straddling the edge.
    author.style.width = `${Math.ceil(authorRuler.measureText(text).width + frame) + 2}px`;
  } catch (e) {
    // No canvas: the old approximation is still better than a full-width box.
    author.size = Math.max(text.length, 4);
  }
}

function showSaveStatus(text) {
  const status = document.getElementById('save-status');
  status.textContent = text;
  clearTimeout(showSaveStatus._t);
  if (text === 'Saved') {
    showSaveStatus._t = setTimeout(() => (status.textContent = ''), 2000);
  }
}

// Creates the tree if this is still a draft, so anything that needs a tree on
// the server can await it first. Concurrent callers share one create.
let pendingCreate = null;
function ensureSaved() {
  if (treeId) return Promise.resolve(treeId);
  if (!pendingCreate) {
    pendingCreate = apiFetch('/trees', {
      method: 'POST',
      body: JSON.stringify({
        title: document.getElementById('tree-title').value.trim() || 'Untitled skill tree',
        description: document.getElementById('tree-desc').value.trim(),
        author: document.getElementById('tree-author').value.trim(),
      }),
    })
      .then((created) => {
        treeId = created.id;
        tree.id = created.id;
        tree.user_id = created.user_id;
        tree.created_at = created.created_at;
        // Reloading now lands on the saved tree rather than a blank draft.
        history.replaceState(null, '', `/tree.html?id=${created.id}`);
        return created.id;
      })
      .catch((e) => {
        pendingCreate = null; // let the next edit try again
        throw e;
      });
  }
  return pendingCreate;
}

async function saveHeader() {
  const title = document.getElementById('tree-title').value.trim();
  const description = document.getElementById('tree-desc').value.trim();
  const author = document.getElementById('tree-author').value.trim();

  // Nothing typed and nothing built yet: there is no tree to save.
  if (!treeId && !title && !description && !author && tree.skills.length === 0) return;

  showSaveStatus('Saving…');
  try {
    const existed = !!treeId;
    await ensureSaved();
    if (existed) {
      await apiFetch(`/trees/${treeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, description, author }),
      });
    }
    tree.title = title || tree.title;
    tree.description = description;
    tree.author = author || 'Anonymous';
    document.title = `${tree.title} — Skill Trees`;
    renderHeader();
    showSaveStatus('Saved');
  } catch (e) {
    showSaveStatus('');
    showToast('Could not save: ' + e.message);
  }
}

function setupHeaderEditing() {
  const fields = ['tree-title', 'tree-desc', 'tree-author'].map((id) => document.getElementById(id));
  let timer = null;

  for (const field of fields) {
    field.addEventListener('input', () => {
      if (field.id === 'tree-desc') growDescription();
      if (field.id === 'tree-author') fitAuthorWidth();
      showSaveStatus('Saving…');
      clearTimeout(timer);
      timer = setTimeout(saveHeader, 700); // settle before hitting the server
    });
    field.addEventListener('blur', () => {
      clearTimeout(timer);
      saveHeader();
    });
    // Enter commits the title rather than inserting a newline nobody wants.
    if (field.tagName === 'INPUT') {
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') field.blur();
      });
    }
  }
}

// Overwrites the in-memory positions with ones computed from the structure,
// using the same algorithm the importer uses (shared in layout.js) so a tree
// looks identical whether it was just imported or just drawn.
function applyAutoLayout() {
  const { positions, routes } = SkillTreeLayout.computeRoutes(
    tree.skills.map((s) => ({ id: s.id })),
    tree.edges.map((e) => ({ from: e.prereq_skill_id, to: e.skill_id }))
  );
  // Keyed by position in tree.edges, which is the order they were handed over.
  autoRoutes = routes;
  for (const skill of tree.skills) {
    const p = positions.get(skill.id);
    if (p) {
      skill.pos_x = p.x;
      skill.pos_y = p.y;
    }
  }
}

function skillsWithPrereqs() {
  const withPrereq = new Set(tree.edges.map((e) => e.skill_id));
  return withPrereq;
}

function prereqsOf(skillId) {
  return tree.edges.filter((e) => e.skill_id === skillId).map((e) => e.prereq_skill_id);
}
function unlocksOf(skillId) {
  return tree.edges.filter((e) => e.prereq_skill_id === skillId).map((e) => e.skill_id);
}
function skillById(id) {
  return tree.skills.find((s) => s.id === id);
}

// ---------- rendering ----------

// The bounding box that contains every node, with padding — used to set the
// initial view and for the "Fit" button. Not the same as the live viewBox,
// which the person can zoom/pan away from freely.
function computeContentBounds() {
  if (!tree || tree.skills.length === 0) return { minX: 0, minY: 0, w: 800, h: 400 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of tree.skills) {
    minX = Math.min(minX, s.pos_x);
    minY = Math.min(minY, s.pos_y);
    maxX = Math.max(maxX, s.pos_x + NODE_W);
    maxY = Math.max(maxY, s.pos_y + NODE_H);
  }
  const pad = 60;
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const w = Math.max(contentW + pad * 2, 400);
  const h = Math.max(contentH + pad * 2, 300);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return {
    minX: Math.round(midX - w / 2),
    minY: Math.round(midY - h / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

function applyViewBox() {
  svg.setAttribute('viewBox', `${viewBox.minX} ${viewBox.minY} ${viewBox.w} ${viewBox.h}`);
}

function fitToContent() {
  viewBox = computeContentBounds();
  applyViewBox();
}

function render() {
  if (!viewBox) fitToContent(); // only auto-fit on the very first render
  else applyViewBox();

  const hasPrereq = skillsWithPrereqs();

  // Edges
  edgesLayer.innerHTML = '';
  tree.edges.forEach((edge, index) => {
    const from = skillById(edge.prereq_skill_id);
    const to = skillById(edge.skill_id);
    if (!from || !to) return;

    const d = edgePath([
      { x: from.pos_x + NODE_W, y: from.pos_y + NODE_H / 2 },
      ...((autoRoutes && autoRoutes.get(index)) || []),
      { x: to.pos_x, y: to.pos_y + NODE_H / 2 },
    ]);

    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    visible.setAttribute('d', d);
    visible.setAttribute('class', 'edge-line');
    visible.dataset.from = String(from.id);
    visible.dataset.to = String(to.id);
    edgesLayer.appendChild(visible);

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'edge-line hit');
    hit.dataset.from = String(from.id);
    hit.dataset.to = String(to.id);
    hit.addEventListener('click', (e) => {
      e.stopPropagation();
      handleEdgeClick(edge);
    });
    edgesLayer.appendChild(hit);
  });

  // Nodes
  nodesLayer.innerHTML = '';
  // Keep the dragging node rendered last so it floats above other nodes
  const sortedSkills = tree.skills.slice().sort((a, b) => {
    if (a.id === draggingSkillId) return 1;
    if (b.id === draggingSkillId) return -1;
    return 0;
  });

  for (const skill of sortedSkills) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${skill.pos_x}, ${skill.pos_y})`);
    g.dataset.skillId = skill.id;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', 10);
    let cls = 'node-card ' + (hasPrereq.has(skill.id) ? 'locked' : 'unlocked');
    if (skill.id === selectedSkillId) cls += ' selected';
    if (skill.id === linkSourceId) cls += ' selected';
    if (skill.id === draggingSkillId) cls += ' is-dragging';
    rect.setAttribute('class', cls);
    g.appendChild(rect);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', 12);
    label.setAttribute('y', 24);
    label.setAttribute('class', 'node-label');
    label.textContent = truncate(skill.name, 22);
    g.appendChild(label);

    const nPrereq = prereqsOf(skill.id).length;
    const nUnlock = unlocksOf(skill.id).length;
    const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    sub.setAttribute('x', 12);
    sub.setAttribute('y', 42);
    sub.setAttribute('class', 'node-sublabel');
    sub.textContent = nPrereq === 0 ? '✦ Start here' : `Needs ${nPrereq} · Unlocks ${nUnlock}`;
    g.appendChild(sub);

    attachNodeInteractions(g, skill);
    nodesLayer.appendChild(g);
  }

  if (selectedSkillId) {
    highlightGraphPath(selectedSkillId, tree, svg);
  }
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// Where to put a newly added skill. Pops up near the middle of the screen
// if the way isn't blocked. If the middle is blocked, places it next to the
// skill most recently placed (or selected). If the view is completely full,
// drops it below the tree and lets the caller refit the view.
function findFreeSpot() {
  const GAP = 28; // clearance required around an existing node
  const vb = viewBox || computeContentBounds();

  const collides = (x, y) =>
    tree.skills.some(
      (s) =>
        x < s.pos_x + NODE_W + GAP &&
        x + NODE_W + GAP > s.pos_x &&
        y < s.pos_y + NODE_H + GAP &&
        y + NODE_H + GAP > s.pos_y
    );

  const stepX = NODE_W + GAP;
  const stepY = NODE_H + GAP;

  // 1. Middle of the visible screen
  const midX = Math.round(vb.minX + (vb.w - NODE_W) / 2);
  const midY = Math.round(vb.minY + (vb.h - NODE_H) / 2);

  if (!collides(midX, midY)) {
    return { x: midX, y: midY, inView: true };
  }

  // 2. If blocked, place it by the skill most recently placed
  const refSkill =
    (lastPlacedSkillId && skillById(lastPlacedSkillId)) ||
    (selectedSkillId && skillById(selectedSkillId)) ||
    (tree.skills.length > 0 ? tree.skills[tree.skills.length - 1] : null);

  if (refSkill) {
    const rx = refSkill.pos_x;
    const ry = refSkill.pos_y;

    // Search around refSkill in expanding rings (right/down/up prioritized)
    for (let ring = 1; ring <= 10; ring++) {
      const candidates = [
        { x: rx + ring * stepX, y: ry },
        { x: rx + ring * stepX, y: ry + stepY },
        { x: rx + ring * stepX, y: ry - stepY },
        { x: rx, y: ry + ring * stepY },
        { x: rx, y: ry - ring * stepY },
        { x: rx + ring * stepX, y: ry + ring * stepY },
        { x: rx + ring * stepX, y: ry - ring * stepY },
        { x: rx - ring * stepX, y: ry },
        { x: rx - ring * stepX, y: ry + ring * stepY },
        { x: rx - ring * stepX, y: ry - ring * stepY },
      ];

      for (const cand of candidates) {
        if (!collides(cand.x, cand.y)) {
          const inView =
            cand.x >= vb.minX - 20 &&
            cand.x + NODE_W <= vb.minX + vb.w + 20 &&
            cand.y >= vb.minY - 20 &&
            cand.y + NODE_H <= vb.minY + vb.h + 20;
          return { x: Math.round(cand.x), y: Math.round(cand.y), inView };
        }
      }
    }
  }

  // 3. Outwards from the center
  for (let ring = 1; ring <= 12; ring++) {
    const candidates = [
      { x: midX + ring * stepX, y: midY },
      { x: midX - ring * stepX, y: midY },
      { x: midX, y: midY + ring * stepY },
      { x: midX, y: midY - ring * stepY },
      { x: midX + ring * stepX, y: midY + ring * stepY },
      { x: midX - ring * stepX, y: midY + ring * stepY },
      { x: midX + ring * stepX, y: midY - ring * stepY },
      { x: midX - ring * stepX, y: midY - ring * stepY },
    ];
    for (const cand of candidates) {
      if (!collides(cand.x, cand.y)) {
        return { x: Math.round(cand.x), y: Math.round(cand.y), inView: true };
      }
    }
  }

  // 4. Fallback: drop beneath everything and let the caller refit.
  let minX = 0;
  let maxY = 0;
  if (tree.skills.length > 0) {
    minX = Math.min(...tree.skills.map((s) => s.pos_x));
    maxY = Math.max(...tree.skills.map((s) => s.pos_y + NODE_H));
  }
  return { x: Math.round(minX), y: Math.round(maxY + GAP), inView: false };
}

// ---------- node interaction: click, drag, link mode ----------

function toSvgPoint(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

let linkWireEl = null;

function updateLinkWire(targetPt) {
  if (!linkMode || linkSourceId === null || !targetPt) {
    if (linkWireEl) {
      linkWireEl.remove();
      linkWireEl = null;
    }
    return;
  }
  const source = skillById(linkSourceId);
  if (!source) return;

  if (!linkWireEl) {
    linkWireEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    linkWireEl.setAttribute('id', 'link-preview-wire');
    linkWireEl.setAttribute('class', 'link-wire-preview');
    edgesLayer.appendChild(linkWireEl);
  }

  const fromX = source.pos_x + NODE_W;
  const fromY = source.pos_y + NODE_H / 2;
  const toX = targetPt.x;
  const toY = targetPt.y;
  const midX = (fromX + toX) / 2;
  const d = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
  linkWireEl.setAttribute('d', d);
}

function attachNodeInteractions(g, skill) {
  let dragging = false;
  let moved = false;
  let startPt, startPos;

  g.addEventListener('mouseenter', () => {
    if (linkMode && linkSourceId !== null && linkSourceId !== skill.id) {
      updateLinkWire({ x: skill.pos_x, y: skill.pos_y + NODE_H / 2 });
      g.querySelector('.node-card')?.classList.add('link-candidate-snap');
    } else if (!dragging && !linkMode) {
      highlightGraphPath(skill.id, tree, svg);
    }
  });

  g.addEventListener('mouseleave', (e) => {
    g.querySelector('.node-card')?.classList.remove('link-candidate-snap');
    if (linkMode && linkSourceId !== null) {
      const pt = toSvgPoint(e);
      updateLinkWire(pt);
    } else if (!dragging && !linkMode) {
      highlightGraphPath(selectedSkillId, tree, svg);
    }
  });

  g.addEventListener('mousedown', (e) => {
    if (linkMode) {
      e.preventDefault();
      handleNodeClick(skill);
      return; // no dragging while linking
    }
    e.preventDefault();
    dragging = true;
    draggingSkillId = skill.id;
    moved = false;
    startPt = toSvgPoint(e);
    startPos = { x: skill.pos_x, y: skill.pos_y };
    g.querySelector('.node-card')?.classList.add('is-dragging');

    const onMove = (ev) => {
      if (!dragging) return;
      const p = toSvgPoint(ev);
      const dx = p.x - startPt.x;
      const dy = p.y - startPt.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      skill.pos_x = startPos.x + dx;
      skill.pos_y = startPos.y + dy;
      render();
    };
    const onUp = async () => {
      dragging = false;
      draggingSkillId = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      render();
      if (!moved) {
        handleNodeClick(skill);
      } else {
        lastPlacedSkillId = skill.id;
        if (canEdit && skill.id && !isAuto()) {
          try {
            await apiFetch(`/skills/${skill.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ pos_x: Math.round(skill.pos_x), pos_y: Math.round(skill.pos_y) }),
            });
          } catch (err) {
            console.error('Failed to save skill position', err);
          }
        }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  g.addEventListener('touchstart', () => handleNodeClick(skill), { passive: true });
}

async function handleNodeClick(skill) {
  lastPlacedSkillId = skill.id;
  if (linkMode) {
    if (linkSourceId === null) {
      linkSourceId = skill.id;
      document.getElementById('toolbar-hint').textContent =
        `"${skill.name}" selected as prerequisite. Now click the skill it unlocks.`;
      render();
      updateLinkWire({ x: skill.pos_x + NODE_W, y: skill.pos_y + NODE_H / 2 });
    } else if (linkSourceId === skill.id) {
      linkSourceId = null;
      updateLinkWire(null);
      document.getElementById('toolbar-hint').textContent = 'Click the prerequisite skill first.';
      render();
    } else {
      updateLinkWire(null);
      const sourceId = linkSourceId;
      linkSourceId = null;
      await createLink(sourceId, skill.id);
      // Automatically switch back to dragging mode after linking two skills
      setLinkMode(false);
    }
    return;
  }
  selectedSkillId = skill.id;
  openSidePanel(skill);
  render();
}

async function createLink(prereqId, skillId) {
  try {
    const prereq = skillById(prereqId);
    const target = skillById(skillId);

    // If both skills or target skill are at the top-left corner (<= 40, <= 40),
    // adjust them to the middle of the screen / by the prerequisite.
    let needsReposition = false;
    const GAP = 28;
    const vb = viewBox || computeContentBounds();
    const midX = Math.round(vb.minX + (vb.w - NODE_W) / 2);
    const midY = Math.round(vb.minY + (vb.h - NODE_H) / 2);

    if (prereq && target && !isAuto()) {
      if (prereq.pos_x <= 40 && prereq.pos_y <= 40 && target.pos_x <= 250 && target.pos_y <= 40) {
        // Both at top-left: move prereq to middle, target to its right
        prereq.pos_x = midX - Math.round((NODE_W + GAP) / 2);
        prereq.pos_y = midY;
        target.pos_x = prereq.pos_x + NODE_W + GAP;
        target.pos_y = midY;
        needsReposition = true;
      } else if (target.pos_x <= 40 && target.pos_y <= 40 && (prereq.pos_x > 40 || prereq.pos_y > 40)) {
        // Target was at top-left, place it by prereq
        target.pos_x = prereq.pos_x + NODE_W + GAP;
        target.pos_y = prereq.pos_y;
        needsReposition = true;
      }

      if (needsReposition) {
        await Promise.all([
          apiFetch(`/skills/${prereq.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ pos_x: Math.round(prereq.pos_x), pos_y: Math.round(prereq.pos_y) }),
          }),
          apiFetch(`/skills/${target.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ pos_x: Math.round(target.pos_x), pos_y: Math.round(target.pos_y) }),
          }),
        ]);
      }
    }

    await apiFetch(`/trees/${treeId}/prereqs`, {
      method: 'POST',
      body: JSON.stringify({ skill_id: skillId, prereq_skill_id: prereqId }),
    });
    lastPlacedSkillId = skillId;
    await loadTree();
    if (tree.skills.length <= 2 || needsReposition) {
      fitToContent();
    }
    showToast(`Prerequisite link added: "${prereq ? prereq.name : 'Prerequisite'}" → "${target ? target.name : 'Skill'}".`);
  } catch (e) {
    showToast(e.message);
    render();
  }
}

async function handleEdgeClick(edge) {
  if (!canEdit) return;
  const from = skillById(edge.prereq_skill_id);
  const to = skillById(edge.skill_id);
  const label = from && to ? `"${from.name}" → "${to.name}"` : 'this link';
  if (!confirm(`Remove the prerequisite link ${label}?`)) return;
  try {
    await apiFetch(`/prereqs/${edge.id}`, { method: 'DELETE' });
    await loadTree();
    showToast('Link removed.');
  } catch (e) {
    showToast(e.message);
  }
}

// ---------- toolbar ----------

function setLinkMode(enabled) {
  linkMode = enabled;
  linkSourceId = null;
  selectedSkillId = null;
  closeSidePanel();
  updateLinkWire(null);
  highlightGraphPath(null, tree, svg);
  svg.classList.toggle('linking', linkMode);
  const linkBtn = document.getElementById('link-mode-btn');
  if (linkBtn) {
    linkBtn.textContent = linkMode ? 'Cancel linking' : 'Link prerequisite';
    linkBtn.classList.toggle('btn-primary', linkMode);
    linkBtn.classList.toggle('linking-active', linkMode);
  }
  document.getElementById('toolbar-hint').textContent = linkMode
    ? 'Click the prerequisite skill first.'
    : 'Click a skill for details, drag to move it. Scroll to zoom, drag the background to pan.';
  render();
}

function setupToolbar() {
  const linkBtn = document.getElementById('link-mode-btn');
  linkBtn.addEventListener('click', () => {
    setLinkMode(!linkMode);
  });

  document.getElementById('delete-tree-btn').addEventListener('click', async () => {
    if (!tree) return;
    if (!treeId) {
      window.location.href = '/#browse'; // nothing was ever saved
      return;
    }
    if (!confirm(`Delete the entire tree "${tree.title}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/trees/${treeId}`, { method: 'DELETE' });
      window.location.href = '/';
    } catch (e) {
      showToast(e.message);
    }
  });

  document.getElementById('toolbar-hint').textContent =
    tree && tree.skills.length === 0
      ? 'Name it above, then add your first skill.'
      : 'Click a skill for details, drag to move it. Scroll to zoom, drag the background to pan.';
}

// ---------- zoom & pan ----------

function zoomAtPoint(userPt, scaleFactor) {
  let newW = viewBox.w * scaleFactor;
  let newH = viewBox.h * scaleFactor;
  newW = Math.min(Math.max(newW, MIN_VIEW_SIZE), MAX_VIEW_SIZE);
  newH = Math.min(Math.max(newH, MIN_VIEW_SIZE), MAX_VIEW_SIZE);
  const actualScale = newW / viewBox.w; // may differ from scaleFactor once clamped

  viewBox = {
    minX: userPt.x - (userPt.x - viewBox.minX) * actualScale,
    minY: userPt.y - (userPt.y - viewBox.minY) * actualScale,
    w: newW,
    h: newH,
  };
  applyViewBox();
}

function zoomAtCenter(scaleFactor) {
  const center = { x: viewBox.minX + viewBox.w / 2, y: viewBox.minY + viewBox.h / 2 };
  zoomAtPoint(center, scaleFactor);
}

function setupZoomAndPan() {
  // Scroll wheel: zoom in/out, centered on the cursor.
  graphWrap.addEventListener(
    'wheel',
    (e) => {
      if (!viewBox) return;
      e.preventDefault();
      const pt = toSvgPoint(e);
      const scaleFactor = e.deltaY < 0 ? 0.9 : 1.1;
      zoomAtPoint(pt, scaleFactor);
    },
    { passive: false }
  );

  // Drag on empty background (not a node or edge) to pan.
  let panState = null;
  svg.addEventListener('mousedown', (e) => {
    if (e.target !== svg || linkMode) return; // only the bare background, and not while linking
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    panState = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startBox: { ...viewBox },
      scaleX: viewBox.w / rect.width,
      scaleY: viewBox.h / rect.height,
    };
    svg.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!panState) return;
    const dx = (e.clientX - panState.startClientX) * panState.scaleX;
    const dy = (e.clientY - panState.startClientY) * panState.scaleY;
    viewBox = {
      ...panState.startBox,
      minX: panState.startBox.minX - dx,
      minY: panState.startBox.minY - dy,
    };
    applyViewBox();
  });
  window.addEventListener('mouseup', () => {
    if (panState) {
      panState = null;
      svg.classList.remove('panning');
    }
  });

  svg.addEventListener('mousemove', (e) => {
    if (linkMode && linkSourceId !== null) {
      const pt = toSvgPoint(e);
      updateLinkWire(pt);
    }
  });

  document.getElementById('zoom-in-btn').addEventListener('click', () => zoomAtCenter(0.8));
  document.getElementById('zoom-out-btn').addEventListener('click', () => zoomAtCenter(1.25));
  document.getElementById('zoom-fit-btn').addEventListener('click', fitToContent);
}

// ---------- add-skill modal ----------

function setupModal() {
  const overlay = document.getElementById('skill-modal-overlay');
  const openBtn = document.getElementById('add-skill-btn');
  const cancelBtn = document.getElementById('skill-cancel-btn');
  const form = document.getElementById('new-skill-form');
  const submitBtn = form.querySelector('button[type="submit"]');

  openBtn.addEventListener('click', () => {
    overlay.hidden = false;
    document.getElementById('skill-name').focus();
  });
  cancelBtn.addEventListener('click', () => (overlay.hidden = true));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });

  // Guards against a second submit firing (double-click, double-Enter)
  // before the first request's response has updated `tree.skills` — without
  // it, findFreeSpot() below would compute against the same stale skill
  // list twice and place both new skills at the same spot.
  let submitting = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    const name = document.getElementById('skill-name').value.trim();
    const description = document.getElementById('skill-desc').value.trim();
    if (!name) return;

    // In auto mode the position is recomputed on load, so picking one here
    // would be wasted work.
    const spot = isAuto() ? { x: 0, y: 0, inView: true } : findFreeSpot();

    submitting = true;
    submitBtn.disabled = true;
    try {
      await ensureSaved(); // a draft tree becomes real as soon as it has a skill
      const createdSkill = await apiFetch(`/trees/${treeId}/skills`, {
        method: 'POST',
        body: JSON.stringify({ name, description, pos_x: spot.x, pos_y: spot.y }),
      });
      lastPlacedSkillId = createdSkill.id;
      overlay.hidden = true;
      form.reset();
      await loadTree();
      // If it had to go below/outside the tree or this is an early skill, make sure it's centered and on screen.
      if (!spot.inView || tree.skills.length <= 2) fitToContent();
      showToast('Skill added.');
    } catch (err) {
      showToast('Could not add skill: ' + err.message);
    } finally {
      submitting = false;
      submitBtn.disabled = false;
    }
  });
}

// ---------- export ----------

function setupExportModal() {
  const overlay = document.getElementById('export-overlay');
  const openBtn = document.getElementById('export-btn');
  const cancelBtn = document.getElementById('export-cancel-btn');
  const form = document.getElementById('export-form');

  openBtn.addEventListener('click', () => {
    if (!treeId) {
      showToast('Add a skill first — there is nothing to export yet.');
      return;
    }
    // Default the dialog to whatever the tree already is, so exporting an
    // auto tree doesn't silently pin it into a fixed layout.
    const mode = tree && tree.layout === 'auto' ? 'auto' : 'manual';
    const radio = form.querySelector(`input[value="${mode}"]`);
    if (radio) radio.checked = true;
    overlay.hidden = false;
  });
  cancelBtn.addEventListener('click', () => (overlay.hidden = true));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const layout = form.querySelector('input[name="export-layout"]:checked').value;

    // Dragging never reaches the database, so the current arrangement has to
    // travel with the request or it would be lost.
    const positions = {};
    for (const skill of tree.skills) {
      positions[skill.id] = { x: skill.pos_x, y: skill.pos_y };
    }

    try {
      const res = await fetch(`${API}/trees/${treeId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout, positions: layout === 'manual' ? positions : null }),
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : 'skill-tree.json';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      overlay.hidden = true;
      showToast('Exported ' + filename);
    } catch (err) {
      showToast('Could not export: ' + err.message);
    }
  });
}

// ---------- side panel ----------

function setupSidePanel() {
  document.getElementById('panel-close').addEventListener('click', closeSidePanel);
}

function closeSidePanel() {
  selectedSkillId = null;
  highlightGraphPath(null, tree, svg);
  document.getElementById('side-panel').classList.remove('open');
  render();
}

function panToSkill(skill) {
  if (!viewBox || !skill) return;
  const startX = viewBox.minX;
  const startY = viewBox.minY;
  const targetX = skill.pos_x + NODE_W / 2 - viewBox.w / 2;
  const targetY = skill.pos_y + NODE_H / 2 - viewBox.h / 2;
  const startTime = performance.now();
  const duration = 280;

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    viewBox.minX = startX + (targetX - startX) * ease;
    viewBox.minY = startY + (targetY - startY) * ease;
    applyViewBox();
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  }
  requestAnimationFrame(step);
}

function openSidePanel(skill) {
  highlightGraphPath(skill.id, tree, svg);
  document.getElementById('panel-name').textContent = skill.name;
  document.getElementById('panel-desc').textContent = skill.description || 'No description.';

  const prereqList = document.getElementById('panel-prereqs');
  prereqList.innerHTML = '';
  const prereqIds = prereqsOf(skill.id);
  if (prereqIds.length === 0) {
    prereqList.innerHTML = '<li style="color:var(--text-muted)">None — this is a starting skill.</li>';
  } else {
    for (const id of prereqIds) {
      const s = skillById(id);
      const li = document.createElement('li');
      li.className = 'interactive';
      li.textContent = s ? s.name : '(unknown)';
      if (s) {
        li.title = 'Click to jump to this skill';
        li.addEventListener('mouseenter', () => highlightGraphPath(s.id, tree, svg));
        li.addEventListener('mouseleave', () => highlightGraphPath(skill.id, tree, svg));
        li.addEventListener('click', () => {
          panToSkill(s);
          openSidePanel(s);
        });
      }
      prereqList.appendChild(li);
    }
  }

  const unlockList = document.getElementById('panel-unlocks');
  unlockList.innerHTML = '';
  const unlockIds = unlocksOf(skill.id);
  if (unlockIds.length === 0) {
    unlockList.innerHTML = '<li style="color:var(--text-muted)">Nothing yet.</li>';
  } else {
    for (const id of unlockIds) {
      const s = skillById(id);
      const li = document.createElement('li');
      li.className = 'interactive';
      li.textContent = s ? s.name : '(unknown)';
      if (s) {
        li.title = 'Click to jump to this skill';
        li.addEventListener('mouseenter', () => highlightGraphPath(s.id, tree, svg));
        li.addEventListener('mouseleave', () => highlightGraphPath(skill.id, tree, svg));
        li.addEventListener('click', () => {
          panToSkill(s);
          openSidePanel(s);
        });
      }
      unlockList.appendChild(li);
    }
  }

  const deleteBtn = document.getElementById('panel-delete-btn');
  deleteBtn.hidden = !canEdit;
  deleteBtn.onclick = async () => {
    if (!confirm(`Delete "${skill.name}"? This also removes its links.`)) return;
    try {
      await apiFetch(`/skills/${skill.id}`, { method: 'DELETE' });
      closeSidePanel();
      await loadTree();
      showToast('Skill deleted.');
    } catch (e) {
      showToast(e.message);
    }
  };

  document.getElementById('side-panel').classList.add('open');
}
