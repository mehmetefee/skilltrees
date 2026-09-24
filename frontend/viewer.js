// Skill Tree Viewer: view unpublished trees locally in full-screen mode.

const NODE_W = 170;
const NODE_H = 56;

const svg = document.getElementById('viewer-svg');
const edgesLayer = document.getElementById('edges-layer');
const nodesLayer = document.getElementById('nodes-layer');
const viewerWrap = document.getElementById('viewer-wrap');

let currentTree = null; // { title, description, author, layout, skills: [], edges: [] }
let rawNotation = null;
let positions = new Map(); // id -> { x, y }
let routes = null; // edge index -> waypoints
let selectedSkillId = null;
let draggingSkillId = null;

let viewBox = null;
const MIN_VIEW_SIZE = 150;
const MAX_VIEW_SIZE = 8000;

// The same keyboard model as the editor — see createGraphKeyboard() in
// a11y.js. Ids here are the file's own slugs, already strings.
const graphKeys = createGraphKeyboard({
  svg,
  skills: () =>
    currentTree
      ? currentTree.skills.map((s) => {
          const p = positions.get(s.id) || { x: 0, y: 0 };
          return { id: s.id, name: s.name, x: p.x, y: p.y };
        })
      : [],
  prereqsOf: (id) => (currentTree ? currentTree.edges.filter((e) => e.to === id).map((e) => e.from) : []),
  unlocksOf: (id) => (currentTree ? currentTree.edges.filter((e) => e.from === id).map((e) => e.to) : []),
  activate: (id) => {
    const skill = currentTree && currentTree.skills.find((s) => s.id === id);
    if (!skill) return;
    selectedSkillId = skill.id;
    openSidePanel(skill);
    render();
  },
  onFocus: (id) => highlightGraphPath(id, currentTree, svg),
  onBlur: () => highlightGraphPath(selectedSkillId, currentTree, svg),
  zoomBy: (factor) => viewBox && zoomAtCenter(factor),
  fit: () => fitToContent(),
  panBy: (fx, fy) => {
    if (!viewBox) return;
    viewBox.minX += fx * viewBox.w;
    viewBox.minY += fy * viewBox.h;
    applyViewBox();
  },
  panByPixels: (dx, dy) => {
    const scale = 1 / svg.getScreenCTM().a;
    viewBox.minX += dx * scale;
    viewBox.minY += dy * scale;
    applyViewBox();
  },
  obstacles: [
    '.tree-overlay-topleft > *',
    '.tree-overlay-topright',
    '.tree-fullscreen-wrap .zoom-controls',
    '.tree-fullscreen-wrap .legend',
    '.graph-kbd-hint',
    '.toast.show',
  ],
});

let emptyModal = null;

init();

async function init() {
  emptyModal = setupModalDialog(document.getElementById('viewer-empty'));
  await loadSignedInUser();
  setupActions();
  setupZoomAndPan();
  setupSidePanel();
  setupDropZone();

  const stored = sessionStorage.getItem('viewer_tree');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      loadNotation(parsed);
      return;
    } catch (e) {
      sessionStorage.removeItem('viewer_tree');
    }
  }

  showEmptyModal();
}

function showEmptyModal() {
  document.getElementById('modal-file-input').value = '';
  document.getElementById('modal-text-input').value = '';
  document.getElementById('modal-problems').hidden = true;
  emptyModal.open();
}

// Closed from script once a tree has loaded. Focus goes to the tree's title,
// so a screen reader announces what just opened rather than nothing at all.
function hideEmptyModal() {
  const dialog = document.getElementById('viewer-empty');
  if (!dialog.open) return;
  emptyModal.close();
  document.getElementById('viewer-title').focus();
}

function setupActions() {
  const fileInput = document.getElementById('viewer-file-input');
  const openBtn = document.getElementById('viewer-open-btn');
  const publishBtn = document.getElementById('viewer-publish-btn');
  const exportBtn = document.getElementById('viewer-export-btn');

  openBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      sessionStorage.setItem('viewer_tree', text);
      loadNotation(parsed);
      showToast(`Loaded ${file.name}`);
    } catch (err) {
      showToast('Could not load file: ' + err.message);
    }
  });

  publishBtn.addEventListener('click', async () => {
    if (!rawNotation) {
      showToast('No tree to publish.');
      return;
    }
    if (!signedInUser) {
      showToast('Sign in first to publish this tree.');
      setTimeout(() => {
        window.location.href = '/account.html?next=%2Fviewer.html';
      }, 800);
      return;
    }

    try {
      publishBtn.disabled = true;
      publishBtn.textContent = 'Publishing…';
      const res = await fetch('/api/trees/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rawNotation),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Publish failed');
      }
      sessionStorage.removeItem('viewer_tree');
      showToast('Tree published successfully!');
      window.location.href = `/tree.html?id=${data.id}`;
    } catch (err) {
      showToast('Could not publish: ' + err.message);
      publishBtn.disabled = false;
      publishBtn.textContent = 'Publish to site';
    }
  });

  exportBtn.addEventListener('click', () => {
    if (!currentTree || !rawNotation) {
      showToast('Nothing to export yet.');
      return;
    }

    const exportData = {
      ...rawNotation,
      layout: currentTree.layout,
      skills: currentTree.skills.map((skill) => {
        const out = { id: skill.id, name: skill.name };
        if (skill.description) out.description = skill.description;
        out.requires = currentTree.edges
          .filter((e) => e.to === skill.id)
          .map((e) => e.from);
        if (currentTree.layout !== 'auto') {
          const p = positions.get(skill.id) || { x: skill.pos_x, y: skill.pos_y };
          out.position = { x: Math.round(p.x), y: Math.round(p.y) };
        }
        return out;
      }),
    };

    const body = JSON.stringify(exportData, null, 2) + '\n';
    const blob = new Blob([body], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(currentTree.title || 'skill-tree').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Exported ' + a.download);
  });

  // Modal actions
  const modalFileInput = document.getElementById('modal-file-input');
  const modalTextInput = document.getElementById('modal-text-input');
  const modalLoadBtn = document.getElementById('modal-load-btn');
  const modalProblems = document.getElementById('modal-problems');

  modalFileInput.addEventListener('change', async () => {
    const file = modalFileInput.files && modalFileInput.files[0];
    if (!file) return;
    try {
      modalTextInput.value = await file.text();
    } catch (e) {
      modalProblems.textContent = e.message;
      modalProblems.hidden = false;
    }
  });

  // Dismissed without loading anything: say so where the title would be,
  // and point at the ways that are left.
  document.getElementById('viewer-empty').addEventListener('close', () => {
    if (currentTree) return;
    document.getElementById('viewer-title').textContent = 'No skill tree loaded';
    document.getElementById('viewer-hint').textContent =
      'Use "Open JSON" to choose a skill tree file, or drop one anywhere on this page.';
  });

  modalLoadBtn.addEventListener('click', () => {
    modalProblems.hidden = true;
    const text = modalTextInput.value.trim();
    if (!text) {
      modalProblems.textContent = 'Please choose a file or paste JSON.';
      modalProblems.hidden = false;
      return;
    }
    try {
      const parsed = JSON.parse(text);
      sessionStorage.setItem('viewer_tree', text);
      loadNotation(parsed);
      hideEmptyModal();
      showToast('Tree loaded in viewer.');
    } catch (err) {
      modalProblems.textContent = 'Invalid JSON: ' + err.message;
      modalProblems.hidden = false;
    }
  });
}

function loadNotation(notation) {
  rawNotation = notation;
  const skills = (notation.skills || []).map((s, i) => ({
    id: s.id || `skill-${i + 1}`,
    name: s.name || 'Unnamed skill',
    description: s.description || '',
    pos_x: s.position && Number.isFinite(s.position.x) ? s.position.x : 0,
    pos_y: s.position && Number.isFinite(s.position.y) ? s.position.y : 0,
    requires: Array.isArray(s.requires) ? s.requires : [],
  }));

  const edges = [];
  for (const skill of skills) {
    for (const req of skill.requires) {
      if (typeof req === 'string') {
        edges.push({ from: req, to: skill.id });
      }
    }
  }

  currentTree = {
    title: notation.title || 'Untitled skill tree',
    description: notation.description || '',
    author: notation.author || 'Anonymous',
    layout: notation.layout === 'auto' ? 'auto' : 'manual',
    skills,
    edges,
  };

  document.title = `${currentTree.title} — Skill Tree Viewer`;
  document.getElementById('viewer-title').textContent = currentTree.title;
  document.getElementById('viewer-hint').textContent = 'Click a skill to see details. Drag to reposition.';
  document.getElementById('viewer-desc').textContent = currentTree.description || 'No description.';
  document.getElementById('viewer-meta').textContent =
    `${skills.length} skill${skills.length === 1 ? '' : 's'} · by ${currentTree.author} · ${currentTree.layout} layout`;

  if (currentTree.layout === 'auto') {
    const laidOut = SkillTreeLayout.computeRoutes(
      skills.map((s) => ({ id: s.id })),
      edges
    );
    positions = laidOut.positions;
    routes = laidOut.routes;
  } else {
    positions = new Map();
    // Use stored coordinates where available, or compute fallback
    const hasAnyPos = skills.some((s) => s.pos_x !== 0 || s.pos_y !== 0);
    if (!hasAnyPos && skills.length > 0) {
      const auto = SkillTreeLayout.computeLayout(skills.map((s) => ({ id: s.id })), edges);
      skills.forEach((s) => positions.set(s.id, auto.get(s.id) || { x: 0, y: 0 }));
    } else {
      skills.forEach((s) => positions.set(s.id, { x: s.pos_x, y: s.pos_y }));
    }
    routes = null; // manual coordinates are routed per render, see render()
  }

  viewBox = null;
  fitToContent();
  render();
  hideEmptyModal();
}

function computeContentBounds() {
  if (!currentTree || currentTree.skills.length === 0) {
    return { minX: 0, minY: 0, w: 800, h: 400 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of currentTree.skills) {
    const p = positions.get(s.id) || { x: 0, y: 0 };
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + NODE_H);
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
  if (!viewBox) fitToContent();
  else applyViewBox();

  if (!currentTree) return;

  const hasPrereq = new Set(currentTree.edges.map((e) => e.to));

  // Auto layouts already reserved a row for every edge that skips a column.
  // Manual coordinates are wherever the file put them — or wherever they have
  // just been dragged to — so their detours are worked out here, per render.
  const edgeRoutes =
    currentTree.layout === 'auto'
      ? routes
      : SkillTreeLayout.routeAroundNodes(positions, currentTree.edges);

  edgesLayer.innerHTML = '';
  currentTree.edges.forEach((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return;

    const d = edgePath([
      { x: from.x + NODE_W, y: from.y + NODE_H / 2 },
      ...((edgeRoutes && edgeRoutes.get(index)) || []),
      { x: to.x, y: to.y + NODE_H / 2 },
    ]);

    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    visible.setAttribute('d', d);
    visible.setAttribute('class', 'edge-line');
    visible.dataset.from = String(edge.from);
    visible.dataset.to = String(edge.to);
    edgesLayer.appendChild(visible);
  });

  // Rebuilding the layer destroys whichever node had focus; note it first.
  const refocusId = graphKeys.focusedId();
  nodesLayer.innerHTML = '';
  const sortedSkills = currentTree.skills.slice().sort((a, b) => {
    if (a.id === draggingSkillId) return 1;
    if (b.id === draggingSkillId) return -1;
    return 0;
  });

  for (const skill of sortedSkills) {
    const p = positions.get(skill.id) || { x: 0, y: 0 };
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${p.x}, ${p.y})`);
    g.dataset.skillId = skill.id;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', 10);
    let cls = 'node-card ' + (hasPrereq.has(skill.id) ? 'locked' : 'unlocked');
    if (skill.id === selectedSkillId) cls += ' selected';
    if (skill.id === draggingSkillId) cls += ' is-dragging';
    rect.setAttribute('class', cls);
    g.appendChild(rect);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', 12);
    label.setAttribute('y', 24);
    label.setAttribute('class', 'node-label');
    label.textContent = skill.name.length > 22 ? skill.name.slice(0, 21) + '…' : skill.name;
    g.appendChild(label);

    const nPrereq = currentTree.edges.filter((e) => e.to === skill.id).length;
    const nUnlock = currentTree.edges.filter((e) => e.from === skill.id).length;
    const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    sub.setAttribute('x', 12);
    sub.setAttribute('y', 42);
    sub.setAttribute('class', 'node-sublabel');
    sub.textContent = nPrereq === 0 ? '✦ Start here' : `Needs ${nPrereq} · Unlocks ${nUnlock}`;
    g.appendChild(sub);

    graphKeys.decorate(g, skill, { expanded: skill.id === selectedSkillId });
    attachNodeInteractions(g, skill, p);
    nodesLayer.appendChild(g);
  }

  const count = currentTree.skills.length;
  svg.setAttribute('aria-label', `Skill graph: ${count} skill${count === 1 ? '' : 's'}`);
  graphKeys.sync(refocusId);

  if (selectedSkillId) {
    highlightGraphPath(selectedSkillId, currentTree, svg);
  }
}

function toSvgPoint(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function attachNodeInteractions(g, skill, pos) {
  let dragging = false;
  let moved = false;
  let startPt, startPos;

  g.addEventListener('mouseenter', () => {
    if (!dragging) {
      highlightGraphPath(skill.id, currentTree, svg);
    }
  });

  g.addEventListener('mouseleave', () => {
    if (!dragging) {
      highlightGraphPath(selectedSkillId, currentTree, svg);
    }
  });

  g.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    draggingSkillId = skill.id;
    moved = false;
    startPt = toSvgPoint(e);
    startPos = { x: pos.x, y: pos.y };
    g.querySelector('.node-card')?.classList.add('is-dragging');

    const onMove = (ev) => {
      if (!dragging) return;
      const p = toSvgPoint(ev);
      const dx = p.x - startPt.x;
      const dy = p.y - startPt.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      pos.x = startPos.x + dx;
      pos.y = startPos.y + dy;
      render();
    };

    const onUp = () => {
      dragging = false;
      draggingSkillId = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      render();
      if (!moved) {
        selectedSkillId = skill.id;
        openSidePanel(skill);
        render(); // so the node shows (and reports, via aria-expanded) that it's the one open
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function setupZoomAndPan() {
  viewerWrap.addEventListener(
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

  let panState = null;
  svg.addEventListener('mousedown', (e) => {
    if (e.target !== svg || !viewBox) return;
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

  document.getElementById('viewer-zoom-in').addEventListener('click', () => zoomAtCenter(0.8));
  document.getElementById('viewer-zoom-out').addEventListener('click', () => zoomAtCenter(1.25));
  document.getElementById('viewer-zoom-fit').addEventListener('click', fitToContent);
}

function zoomAtPoint(userPt, scaleFactor) {
  let newW = viewBox.w * scaleFactor;
  let newH = viewBox.h * scaleFactor;
  newW = Math.min(Math.max(newW, MIN_VIEW_SIZE), MAX_VIEW_SIZE);
  newH = Math.min(Math.max(newH, MIN_VIEW_SIZE), MAX_VIEW_SIZE);
  const actualScale = newW / viewBox.w;

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

function panToSkill(skill) {
  if (!viewBox || !skill) return;
  const p = positions.get(skill.id) || { x: 0, y: 0 };
  const startX = viewBox.minX;
  const startY = viewBox.minY;
  const targetX = p.x + NODE_W / 2 - viewBox.w / 2;
  const targetY = p.y + NODE_H / 2 - viewBox.h / 2;
  const startTime = performance.now();
  // No glide for anyone who has asked for less motion.
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280;

  function step(now) {
    const elapsed = now - startTime;
    const progress = duration ? Math.min(elapsed / duration, 1) : 1;
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

function setupSidePanel() {
  document.getElementById('panel-close').addEventListener('click', closeSidePanel);

  // Escape closes the details panel — but not while a dialog is open (it
  // closes itself) or while someone is typing.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('dialog[open]') || isTypingTarget(e.target)) return;
    if (document.getElementById('side-panel').classList.contains('open')) {
      e.preventDefault();
      closeSidePanel();
    }
  });
}

// Focus that was inside the panel goes back to the skill it described, never
// left behind in a panel that's no longer on screen.
function closeSidePanel() {
  const panel = document.getElementById('side-panel');
  const focusWasInside = panel.contains(document.activeElement);
  const shown = selectedSkillId;
  selectedSkillId = null;
  highlightGraphPath(null, currentTree, svg);
  panel.classList.remove('open');
  render();
  if (focusWasInside && !(shown !== null && graphKeys.focusNode(shown))) graphKeys.focusGraph();
}

// A row of the Requires / Unlocks lists: a button that jumps to that skill.
function panelLinkRow(skill, otherId) {
  const other = currentTree.skills.find((x) => x.id === otherId);
  const li = document.createElement('li');
  li.className = 'interactive';
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'panel-jump';
  jump.textContent = other ? other.name : otherId;
  if (other) {
    jump.title = 'Show this skill';
    const preview = () => highlightGraphPath(other.id, currentTree, svg);
    const unpreview = () => highlightGraphPath(skill.id, currentTree, svg);
    jump.addEventListener('mouseenter', preview);
    jump.addEventListener('mouseleave', unpreview);
    jump.addEventListener('focus', preview);
    jump.addEventListener('blur', unpreview);
    jump.addEventListener('click', () => {
      panToSkill(other);
      selectedSkillId = other.id;
      openSidePanel(other);
      render();
    });
  } else {
    jump.disabled = true;
  }
  li.appendChild(jump);
  return li;
}

function openSidePanel(skill) {
  highlightGraphPath(skill.id, currentTree, svg);
  document.getElementById('panel-name').textContent = skill.name;
  document.getElementById('panel-desc').textContent = skill.description || 'No description.';

  const prereqList = document.getElementById('panel-prereqs');
  prereqList.innerHTML = '';
  const prereqEdges = currentTree.edges.filter((e) => e.to === skill.id);
  if (prereqEdges.length === 0) {
    prereqList.innerHTML = '<li class="panel-empty">None — this is a starting skill.</li>';
  } else {
    for (const edge of prereqEdges) prereqList.appendChild(panelLinkRow(skill, edge.from));
  }

  const unlockList = document.getElementById('panel-unlocks');
  unlockList.innerHTML = '';
  const unlockEdges = currentTree.edges.filter((e) => e.from === skill.id);
  if (unlockEdges.length === 0) {
    unlockList.innerHTML = '<li class="panel-empty">Nothing yet.</li>';
  } else {
    for (const edge of unlockEdges) unlockList.appendChild(panelLinkRow(skill, edge.to));
  }

  document.getElementById('side-panel').classList.add('open');
  // Into the panel at its heading, so a screen reader starts with the skill's
  // name; Escape or the close button brings focus back to the graph.
  document.getElementById('panel-name').focus();
}

function setupDropZone() {
  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'drop-zone-overlay';
  // Feedback for a drag in progress, which only a pointer can start; the same
  // file can be opened by keyboard with "Open JSON" or the dialog.
  dropOverlay.setAttribute('aria-hidden', 'true');
  dropOverlay.innerHTML = `
    <div class="drop-zone-box">
      <div style="font-size: 36px; margin-bottom: 12px;">📂</div>
      <div>Drop skill tree JSON to open</div>
      <div style="font-size: 13px; color: var(--text-muted); font-weight: normal; margin-top: 6px;">
        Supports valid Skill Tree JSON files
      </div>
    </div>
  `;
  document.body.appendChild(dropOverlay);

  let dragCounter = 0;

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.add('active');
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove('active');
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('active');

    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      sessionStorage.setItem('viewer_tree', text);
      hideEmptyModal();
      loadNotation(parsed);
      showToast(`Loaded ${file.name}`);
    } catch (err) {
      showToast('Could not load file: ' + err.message);
    }
  });
}
