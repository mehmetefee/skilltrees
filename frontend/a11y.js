// Accessibility plumbing shared by the three pages that draw a graph (the
// editor, the viewer and the homepage's featured hero): modal dialogs, a
// polite announcer for screen readers, and the keyboard model for the graph.
//
// Loaded before app.js on those pages. account.html doesn't load it, so
// nothing in app.js may call into this file from code that runs everywhere.

// ---------- typing guard ----------

// Single-key shortcuts (Escape, +, -, 0, arrows) must never fire while
// someone is typing: "0" in a title is a zero, not "fit to screen".
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'reset', 'submit', 'file', 'image', 'range', 'color'].includes(type);
}

// ---------- announcer ----------

// One visually hidden live region per page for things a screen reader user
// needs to hear but that have no visible message of their own (link mode's
// steps, "no prerequisites"). It exists from load, because a live region
// created at the moment it's written to is often not announced at all.
const srAnnouncer = (() => {
  const el = document.createElement('div');
  el.id = 'sr-announcer';
  el.className = 'visually-hidden';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
})();

function announce(message) {
  // Cleared first and written a beat later, so the same sentence twice in a
  // row is still read twice — a live region only speaks when it changes.
  srAnnouncer.textContent = '';
  clearTimeout(announce._t);
  announce._t = setTimeout(() => (srAnnouncer.textContent = message), 60);
}

// ---------- skip links ----------

// Following a skip link by default only moves the scroll position and the
// sequential-navigation starting point; focusing the target outright is what
// screen readers and every browser agree on. It also keeps "#main" out of the
// address bar, where the homepage reads the hash for its own scrolling.
document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a.skip-link');
  if (!link) return;
  const target = document.querySelector(link.getAttribute('href'));
  if (!target) return;
  e.preventDefault();
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus();
});

// ---------- dialogs ----------

// Every modal on the site is a native <dialog> opened with showModal(). That
// buys, from the browser rather than from us: the top layer (nothing can sit
// above it), an inert page behind it (clicks and Tab can't reach what's
// covered), Escape to close, focus moved in on open, and — because a closed
// dialog is display:none — no invisible overlay left swallowing clicks, which
// is a bug this project has already had once.
//
// Clicking the backdrop closes it too. closedby="any" in the markup does that
// natively where supported; the fallback here covers browsers that don't know
// the attribute yet. It only counts a press that *started* on the backdrop, so
// selecting text in a field and releasing outside doesn't throw the form away.
function setupModalDialog(dialog) {
  if (!dialog) return null;
  let opener = null;

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = e.target === dialog && outside(e);
    });
    dialog.addEventListener('click', (e) => {
      if (pressedOutside && e.target === dialog && outside(e)) dialog.close();
      pressedOutside = false;
    });
  }

  // Browsers return focus to whatever opened a modal, but not every one does
  // it when the opener was re-rendered or the dialog was opened from script.
  // Only step in when focus would otherwise be lost to <body>.
  dialog.addEventListener('close', () => {
    const lost = !document.activeElement || document.activeElement === document.body ||
      dialog.contains(document.activeElement);
    if (lost && opener && opener.isConnected) opener.focus();
    opener = null;
  });

  return {
    open() {
      if (dialog.open) return;
      opener = document.activeElement !== document.body ? document.activeElement : null;
      dialog.showModal();
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}

// ---------- the graph, by keyboard ----------

// Nodes are SVG <g> elements the renderers rebuild on every render(), so this
// can't hang state on them. It keeps the few things that must outlive a
// render (which node is in the tab order, where the arrows came from) and
// re-applies them afterwards: renderers call focusedId() before clearing the
// layer and sync() after drawing it.
//
// The model, which the on-screen hint repeats:
//   - The canvas itself is one tab stop: arrow keys pan, + and - zoom, 0 fits.
//     This is the keyboard alternative to dragging the background (WCAG 2.5.7).
//   - The skills are one more tab stop (a roving tabindex, so a 1000-skill
//     tree doesn't cost a thousand presses of Tab to get past):
//       Left / Right   follow a link to a prerequisite / to a skill it unlocks
//       Up / Down      the previous / next skill, column by column, top to
//                      bottom — every skill is reachable this way, linked or not
//       Home / End     the first / last skill in that order
//       Enter / Space  what a click does (details, or a choice in link mode)
//   - With several links to choose from, Left/Right take the one drawn
//     nearest level, and going back the way you came returns where you were.
function createGraphKeyboard(opts) {
  const { svg } = opts;
  const role = opts.role || 'button';
  const NS = 'http://www.w3.org/2000/svg';
  const { NODE_W, NODE_H } = SkillTreeLayout;

  let activeId = null; // the node currently holding tabindex="0"
  let restoring = false; // focus being put back after a re-render, not moved by a person
  const cameFrom = new Map(); // node id -> id it was reached from along a link

  const nodes = () => Array.from(svg.querySelectorAll('g[data-skill-id]'));
  const nodeEl = (id) => nodes().find((g) => g.dataset.skillId === String(id)) || null;
  const skillMap = () => new Map(opts.skills().map((s) => [String(s.id), s]));

  // Column by column, top to bottom — the order a sighted reader takes in a
  // left-to-right graph. Columns are clusters of x rather than exact matches,
  // so a hand-dragged tree that is almost in columns reads as if it were.
  function readingOrder() {
    const skills = opts.skills().slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const columns = [];
    for (const s of skills) {
      const col = columns[columns.length - 1];
      if (col && s.x - col.x < NODE_W / 2) col.items.push(s);
      else columns.push({ x: s.x, items: [s] });
    }
    return columns.flatMap((c) => c.items.sort((a, b) => a.y - b.y)).map((s) => String(s.id));
  }

  function alongLinks(fromId, forward) {
    const ids = (forward ? opts.unlocksOf(fromId) : opts.prereqsOf(fromId)).map(String);
    if (ids.length === 0) return null;
    const back = cameFrom.get(fromId);
    if (back && ids.includes(back)) return back;
    const map = skillMap();
    const here = map.get(fromId);
    if (!here) return ids[0];
    const dist = (id) => {
      const s = map.get(id);
      return s ? Math.abs(s.y - here.y) * 4 + Math.abs(s.x - here.x) : Infinity;
    };
    return ids.slice().sort((a, b) => dist(a) - dist(b))[0];
  }

  function describe(skill, note) {
    const id = String(skill.id);
    const nPre = opts.prereqsOf(id).length;
    const nUn = opts.unlocksOf(id).length;
    const parts = [skill.name];
    parts.push(nPre === 0 ? 'starting point, no prerequisites' : `needs ${nPre} prerequisite${nPre === 1 ? '' : 's'}`);
    parts.push(nUn === 0 ? 'unlocks nothing yet' : `unlocks ${nUn} skill${nUn === 1 ? '' : 's'}`);
    if (note) parts.push(note);
    return parts.join(', ');
  }

  function setActive(id) {
    activeId = id == null ? null : String(id);
    for (const g of nodes()) g.tabIndex = g.dataset.skillId === activeId ? 0 : -1;
  }

  // Everything that floats over the canvas can hide a node behind it. A node
  // that gains focus under one of them, or outside the visible part of the
  // canvas, is panned to the middle of what's left (WCAG 2.4.11).
  function visibleArea() {
    const r = svg.getBoundingClientRect();
    const area = {
      left: Math.max(r.left, 0),
      top: Math.max(r.top, 0),
      right: Math.min(r.right, window.innerWidth),
      bottom: Math.min(r.bottom, window.innerHeight),
    };
    const panel = document.querySelector('.side-panel.open');
    if (panel) area.right = Math.min(area.right, panel.getBoundingClientRect().left);
    return area;
  }

  function reveal(id) {
    const g = nodeEl(id);
    if (!g || !opts.panByPixels) return;
    let area = visibleArea();
    // The hero scrolls with the page; bring the canvas itself on screen
    // first, or there is nowhere to pan the node to.
    if (area.bottom - area.top < NODE_H * 2) {
      svg.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      area = visibleArea();
    }
    const r = g.getBoundingClientRect();
    const inside = r.left >= area.left && r.right <= area.right && r.top >= area.top && r.bottom <= area.bottom;
    const covered = (opts.obstacles || [])
      .flatMap((sel) => Array.from(document.querySelectorAll(sel)))
      .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed')
      .map((el) => el.getBoundingClientRect())
      // (More than a pixel: visually hidden text is a 1px box and hides nothing.)
      .some((b) => b.width > 1 && b.height > 1 &&
        b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top);
    if (inside && !covered) return;
    opts.panByPixels(
      r.left + r.width / 2 - (area.left + area.right) / 2,
      r.top + r.height / 2 - (area.top + area.bottom) / 2
    );
  }

  function focusNode(id) {
    const g = nodeEl(id);
    if (!g) return false;
    setActive(id);
    g.focus({ preventScroll: true });
    return true;
  }

  function moveTo(toId, fromId, viaLink) {
    if (toId == null) return false;
    if (viaLink) cameFrom.set(String(toId), String(fromId));
    return focusNode(toId);
  }

  svg.addEventListener('focusin', (e) => {
    const g = e.target.closest && e.target.closest('g[data-skill-id]');
    if (!g) return;
    setActive(g.dataset.skillId);
    if (restoring) return;
    // Only keyboard focus lights the path and pans: focus handed back to a
    // node after a mouse click shouldn't leave its path lit or move the view.
    if (g.matches(':focus-visible')) {
      if (opts.onFocus) opts.onFocus(g.dataset.skillId);
      reveal(g.dataset.skillId);
    }
  });
  svg.addEventListener('focusout', (e) => {
    const g = e.target.closest && e.target.closest('g[data-skill-id]');
    if (g && !restoring && opts.onBlur) opts.onBlur(g.dataset.skillId);
  });

  svg.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const key = e.key;

    if (key === '+' || key === '=') {
      e.preventDefault();
      opts.zoomBy(0.8);
      return;
    }
    if (key === '-' || key === '_' || key === '−') {
      e.preventDefault();
      opts.zoomBy(1.25);
      return;
    }
    if (key === '0') {
      e.preventDefault();
      opts.fit();
      return;
    }

    const g = e.target.closest && e.target.closest('g[data-skill-id]');
    if (!g) {
      if (e.target !== svg) return;
      const step = e.shiftKey ? 0.3 : 0.1;
      const pans = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (pans[key]) {
        e.preventDefault();
        opts.panBy(pans[key][0], pans[key][1]);
      }
      return;
    }

    const id = g.dataset.skillId;
    const order = readingOrder();
    const at = order.indexOf(id);
    const skill = skillMap().get(id);
    const name = skill ? skill.name : 'This skill';
    switch (key) {
      case 'Enter':
      case ' ':
        if (key === ' ' && role === 'link') return; // links don't answer to Space
        e.preventDefault();
        opts.activate(id);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!moveTo(alongLinks(id, true), id, true)) announce(`${name} doesn't unlock anything yet.`);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (!moveTo(alongLinks(id, false), id, true)) announce(`${name} has no prerequisites.`);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (at < order.length - 1) moveTo(order[at + 1]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (at > 0) moveTo(order[at - 1]);
        break;
      case 'Home':
        e.preventDefault();
        moveTo(order[0]);
        break;
      case 'End':
        e.preventDefault();
        moveTo(order[order.length - 1]);
        break;
    }
  });

  return {
    // Role, name, state and a focus ring for a freshly drawn node. The ring is
    // drawn in SVG rather than left to `outline`, which browsers draw
    // inconsistently (or not at all) around SVG elements.
    decorate(g, skill, { note, expanded } = {}) {
      g.setAttribute('role', role);
      g.setAttribute('tabindex', String(skill.id) === activeId ? '0' : '-1');
      g.setAttribute('aria-label', describe(skill, note));
      if (expanded !== undefined) {
        g.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        g.setAttribute('aria-controls', 'side-panel');
      }
      const ring = document.createElementNS(NS, 'rect');
      ring.setAttribute('class', 'node-focus-ring');
      ring.setAttribute('x', -6);
      ring.setAttribute('y', -6);
      ring.setAttribute('width', NODE_W + 12);
      ring.setAttribute('height', NODE_H + 12);
      ring.setAttribute('rx', 15);
      ring.setAttribute('aria-hidden', 'true');
      g.insertBefore(ring, g.firstChild);
    },

    // The id of the node holding focus, if any. Call before clearing the layer.
    focusedId() {
      const el = document.activeElement;
      if (!el || !svg.contains(el) || !el.closest) return null;
      const g = el.closest('g[data-skill-id]');
      return g ? g.dataset.skillId : null;
    },

    // After drawing: exactly one node in the tab order, and focus put back on
    // the node that had it (or, if that skill is gone, the first one — never
    // dropped on <body>, where the next Tab would start from the top).
    sync(refocusId) {
      const all = nodes();
      if (all.length === 0) {
        activeId = null;
        if (refocusId != null) svg.focus({ preventScroll: true });
        return;
      }
      if (!all.some((g) => g.dataset.skillId === activeId)) activeId = readingOrder()[0] || all[0].dataset.skillId;
      setActive(activeId);
      if (refocusId != null) {
        const back = nodeEl(refocusId) || nodeEl(activeId);
        restoring = true;
        try {
          back.focus({ preventScroll: true });
        } finally {
          restoring = false;
        }
      }
    },

    // Focus into the graph at its tab stop: the active node, or the canvas
    // when there are no skills to land on.
    focusGraph() {
      if (!(activeId !== null && focusNode(activeId))) {
        const first = readingOrder()[0];
        if (!(first !== undefined && focusNode(first))) svg.focus({ preventScroll: true });
      }
    },

    focusNode,
    reveal,
  };
}
