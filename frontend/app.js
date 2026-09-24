// Shared helpers + logic for the browse/home page.

const API = '/api';

// The toast is also the page's polite live region (role="status"), so every
// result shown here — link added, skill deleted, save failed — is read out.
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const write = () => {
    toast.textContent = msg;
    toast.classList.remove('toast-top');
    toast.classList.add('show');
    // Never on top of whatever has focus (WCAG 2.4.11): along the bottom edge
    // it can land squarely on a focused skill or button, so in that case it
    // shows at the top instead.
    const focused = document.activeElement;
    if (focused && focused !== document.body && !toast.contains(focused)) {
      const a = focused.getBoundingClientRect();
      const b = toast.getBoundingClientRect();
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        toast.classList.add('toast-top');
      }
    }
  };
  // A live region only speaks when its text changes, so the same message
  // twice in a row is cleared first and written a beat later.
  if (toast.textContent === msg) {
    toast.textContent = '';
    setTimeout(write, 50);
  } else {
    write();
  }
  clearTimeout(showToast._t);
  // Long enough to read, and longer for longer messages (an error with its
  // reason attached is more than a glance).
  showToast._t = setTimeout(() => toast.classList.remove('show'), Math.max(3000, msg.length * 70));
}

async function apiFetch(path, opts = {}) {
  // Headers are merged, not replaced: a caller that passes a header of its
  // own must not silently lose the Content-Type, which the server insists on
  // for any request with a body (415 otherwise).
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

// --- theme switch ---
//
// The theme is whatever the switch says — the OS preference is not consulted
// anywhere. theme.js applies the stored choice before the first paint; this
// only handles flipping it. Both icons are already in the button, so nothing
// here builds markup.

function setupThemeToggle() {
  // Website is permanently set to light mode.
}

// --- accounts ---
//
// Trees are public to read and private to edit: only the account that made a
// tree can change it, which the server enforces (this is just the UI half).

let signedInUser = null;

async function loadSignedInUser() {
  try {
    signedInUser = (await apiFetch('/auth/me')).user;
  } catch (e) {
    signedInUser = null;
  }
  renderAuthSlots();
  return signedInUser;
}

// Every page has a spot for "Sign in" / "you · Sign out".
function renderAuthSlots() {
  const slots = document.querySelectorAll('.auth-slot');
  if (!slots.length) return;

  for (const slot of slots) {
    const isBrowse = !!slot.closest('#browse, .page-header-actions, .site-header-actions');
    const targetPath = isBrowse
      ? '/#browse'
      : (location.pathname + location.search + (location.hash || ''));
    const next = encodeURIComponent(targetPath);

    slot.innerHTML = signedInUser
      ? `<div class="user-chip" title="Signed in as ${escapeHtml(signedInUser.username)}" aria-label="Signed in as ${escapeHtml(signedInUser.username)}">` +
        `<span class="user-avatar" aria-hidden="true">${escapeHtml(signedInUser.username.charAt(0).toUpperCase())}</span>` +
        `<a class="auth-name" href="/account.html" title="Your account">${escapeHtml(signedInUser.username)}</a>` +
        `<button type="button" class="user-signout-btn" data-sign-out title="Sign out" aria-label="Sign out of ${escapeHtml(signedInUser.username)}">Sign out</button>` +
        `</div>`
      : `<a href="/account.html?next=${next}" class="btn btn-signin">Sign in</a>`;
  }

  for (const btn of document.querySelectorAll('[data-sign-out]')) {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch('/auth/logout', { method: 'POST' });
      } catch (e) {
        /* signing out locally either way */
      }
      window.location.reload();
    });
  }
}

// Where a "next" parameter is allowed to send someone after they sign in.
// Anything that resolves off this origin — and anything carrying a control
// character, which the URL parser would silently remove and change the
// meaning of — falls back to the homepage.
function sameSitePath(next) {
  const fallback = '/#browse';
  if (typeof next !== 'string' || next === '') return fallback;
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return fallback;
  }
  // Absolute paths only, as before — a bare "somewhere" was never a
  // destination this app offered, and keeping the rule means the only
  // behaviour that changes here is the bypass.
  if (next[0] !== '/') return fallback;
  let url;
  try {
    url = new URL(next, location.origin);
  } catch (e) {
    return fallback;
  }
  if (url.origin !== location.origin) return fallback;
  return url.pathname + url.search + url.hash;
}

// Why a sign-in through another provider came back without finishing. The
// server only ever sends one of these codes — never the provider's own words
// — and anything unrecognised gets the general line rather than being shown.
const OAUTH_ERROR_MESSAGES = {
  cancelled: 'Sign-in was cancelled at the provider, so nothing changed.',
  expired:
    'That sign-in expired, was already used, or was started in a different browser. Please start again from this page.',
  failed: 'That sign-in could not be completed. Please try again.',
  unavailable: 'That sign-in provider is not available right now. Please try again later.',
  identity_taken:
    'That account is already connected to a different Skill Trees account. Sign in to that one to disconnect it first.',
  link_session: 'You were signed out before the connection finished. Sign in and try connecting again.',
};

async function loadProviders() {
  try {
    const list = await apiFetch('/auth/providers');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

// Sends the browser to a provider. The start is a same-origin POST (the
// server's Origin check guards it) and the page navigates to the URL it gets
// back — a form posting here would be stopped by CSP form-action 'self' the
// moment the answer redirected to another site.
async function startOAuth(providerId, intent, next) {
  const data = await apiFetch(`/auth/oauth/${encodeURIComponent(providerId)}/start`, {
    method: 'POST',
    body: JSON.stringify({ intent, next }),
  });
  // This string is about to become a navigation, so it must be a web URL.
  const url = new URL(data.authorization_url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The sign-in provider sent an address this page will not open.');
  }
  window.location.assign(url.href);
}

function showNotice(box, message) {
  box.textContent = '';
  const strong = document.createElement('strong');
  strong.textContent = message;
  box.appendChild(strong);
  box.hidden = false;
}

// Reads ?oauth_error= (and ?connected=) once, then takes them out of the
// address bar so a reload doesn't show the message again. Keeps ?next=.
function takeOAuthOutcome() {
  const params = new URLSearchParams(location.search);
  const error = params.get('oauth_error');
  const connected = params.get('connected');
  if (error === null && connected === null) return { error: null, connected: null };
  params.delete('oauth_error');
  params.delete('connected');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  return { error, connected };
}

async function setupAccountPage() {
  const form = document.getElementById('auth-form');
  if (!form) return;

  const heading = document.getElementById('auth-heading');
  const intro = document.getElementById('auth-intro');
  const submit = document.getElementById('auth-submit');
  const toggle = document.getElementById('auth-toggle');
  const errorBox = document.getElementById('auth-error');
  const username = document.getElementById('auth-username');
  const password = document.getElementById('auth-password');
  const oauthError = document.getElementById('oauth-error');

  let mode = 'login';

  const showError = (message) => showNotice(errorBox, message);

  const applyMode = () => {
    const signup = mode === 'signup';
    heading.textContent = submit.textContent = signup ? 'Create an account' : 'Sign in';
    document.title = `${heading.textContent} — Skill Trees`;
    intro.textContent = signup
      ? 'Pick a name and a password. Your trees stay yours — nobody else can edit them.'
      : 'Trees can be browsed by anyone, but only the account that made a tree can change it.';
    toggle.textContent = signup ? 'I already have an account' : 'Create an account instead';
    password.autocomplete = signup ? 'new-password' : 'current-password';
    errorBox.hidden = true;
  };

  toggle.addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    applyMode();
  });

  let submitting = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    errorBox.hidden = true;

    submitting = true;
    submit.disabled = true;
    try {
      await apiFetch(`/auth/${mode === 'signup' ? 'signup' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify({ username: username.value.trim(), password: password.value }),
      });
      // Only ever back to a path on this site, decided by the URL parser
      // rather than by a pattern. A regex cannot be trusted here: the
      // browser strips ASCII tab and newline from a URL *after* any check
      // we run, so a percent-encoded tab in "/%09/evil.example" passes a
      // "slash, then not a slash" test and then resolves as
      // protocol-relative. Resolving it ourselves and comparing origins is
      // the check that cannot be spelled around.
      const next = new URLSearchParams(location.search).get('next') || '';
      window.location.href = sameSitePath(next);
    } catch (err) {
      showError(err.message);
      submitting = false;
      submit.disabled = false;
    }
  });

  applyMode();

  const outcome = takeOAuthOutcome();
  if (outcome.error !== null) {
    showNotice(oauthError, OAUTH_ERROR_MESSAGES[outcome.error] || OAUTH_ERROR_MESSAGES.failed);
  }

  const [user, providers] = await Promise.all([loadSignedInUser(), loadProviders()]);
  if (user) {
    showAccountView(user, providers, outcome.connected);
  } else {
    showSignInView(providers);
  }
}

// Signed out: "Continue with <provider>" for each configured one, above the
// password form. With none configured the page is just the form, as before.
function showSignInView(providers) {
  const view = document.getElementById('sign-in-view');
  const list = document.getElementById('oauth-providers');
  const divider = document.getElementById('oauth-divider');
  const oauthError = document.getElementById('oauth-error');

  list.textContent = '';
  for (const provider of providers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-provider';
    button.dataset.provider = provider.id;
    button.textContent = `Continue with ${provider.name}`;
    button.addEventListener('click', async () => {
      for (const b of list.querySelectorAll('button')) b.disabled = true;
      oauthError.hidden = true;
      try {
        // The server checks next again; this is the same rule as the form's.
        const next = new URLSearchParams(location.search).get('next') || '';
        await startOAuth(provider.id, 'login', sameSitePath(next));
      } catch (err) {
        showNotice(oauthError, err.message);
        for (const b of list.querySelectorAll('button')) b.disabled = false;
      }
    });
    list.appendChild(button);
  }
  list.hidden = divider.hidden = providers.length === 0;
  view.hidden = false;
}

// Signed in: the "Your account" panel.
function showAccountView(user, providers, connected) {
  const heading = document.getElementById('auth-heading');
  heading.textContent = 'Your account';
  document.title = 'Your account — Skill Trees';
  document.getElementById('account-username').textContent = user.username;
  document.getElementById('account-avatar').textContent = user.username.charAt(0).toUpperCase();

  const signOut = document.getElementById('account-sign-out');
  signOut.addEventListener('click', async () => {
    signOut.disabled = true;
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch (e) {
      /* signing out locally either way */
    }
    window.location.href = '/account.html';
  });

  document.getElementById('account-view').hidden = false;

  if (connected) {
    const provider = providers.find((p) => p.id === connected);
    if (provider) showToast(`Connected ${provider.name}.`);
  }
  renderSignInMethods(user, providers);
  // The password, sessions, your data and deleting the account live in
  // account-settings.js, which only account.html loads.
  if (typeof setupAccountSettings === 'function') setupAccountSettings(user, providers);
}

// "Sign-in methods": the password, each connected provider with Disconnect,
// and a Connect for every configured provider not connected yet. The server
// refuses to remove the last way in; the page only mirrors that so the
// button doesn't invite a click that will be refused.
async function renderSignInMethods(user, providers) {
  const list = document.getElementById('sign-in-methods-list');
  const errorBox = document.getElementById('sign-in-methods-error');

  let identities = [];
  try {
    identities = await apiFetch('/auth/identities');
  } catch (err) {
    showNotice(errorBox, err.message);
    return;
  }

  const usable = (user.has_password ? 1 : 0) + identities.filter((i) => i.enabled).length;

  const row = (name, detail, action) => {
    const li = document.createElement('li');
    li.className = 'sign-in-method';
    const text = document.createElement('div');
    text.className = 'sign-in-method-text';
    const title = document.createElement('span');
    title.className = 'sign-in-method-name';
    title.textContent = name;
    const sub = document.createElement('span');
    sub.className = 'sign-in-method-detail';
    sub.textContent = detail;
    text.append(title, sub);
    li.appendChild(text);
    if (action) li.appendChild(action);
    list.appendChild(li);
  };

  const button = (label, className, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', async () => {
      b.disabled = true;
      errorBox.hidden = true;
      try {
        await onClick();
      } catch (err) {
        showNotice(errorBox, err.message);
        b.disabled = false;
      }
    });
    return b;
  };

  list.textContent = '';

  // Changing or setting it happens in its own section further down the page.
  const toPassword = document.createElement('a');
  toPassword.className = 'btn btn-small';
  toPassword.href = '#account-password';
  toPassword.textContent = user.has_password ? 'Change' : 'Set a password';
  row('Password', user.has_password ? 'Set' : 'Not set — you sign in through a provider below', toPassword);

  for (const identity of identities) {
    const detail = [identity.display_name, `connected ${timeAgo(identity.created_at)}`];
    if (!identity.enabled) detail.push('this provider is switched off here');
    const last = identity.enabled && usable <= 1;
    const disconnect = button('Disconnect', 'btn btn-small btn-danger', async () => {
      await apiFetch(`/auth/identities/${encodeURIComponent(identity.id)}`, { method: 'DELETE' });
      showToast(`Disconnected ${identity.provider_name}.`);
      renderSignInMethods(user, providers);
    });
    if (last) {
      disconnect.disabled = true;
      disconnect.title = 'This is your only way to sign in. Connect another first.';
    }
    row(identity.provider_name, detail.filter(Boolean).join(' · '), disconnect);
  }

  const connectedIds = new Set(identities.filter((i) => i.enabled).map((i) => i.provider));
  for (const provider of providers) {
    if (connectedIds.has(provider.id)) continue;
    const connect = button('Connect', 'btn btn-small', () =>
      startOAuth(provider.id, 'link', `/account.html?connected=${encodeURIComponent(provider.id)}`)
    );
    row(provider.name, 'Not connected', connect);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// An SVG path through a list of points, curved rather than kinked. Edges that
// skip a column come with waypoints from layout.js routing them around what
// sits in between; short ones are just the two endpoints and curve as before.
// The curve itself lives in layout.js, with the clearance checks that have to
// test the same shape the screen gets. This stays because all three renderers
// call it by this name.
function edgePath(points) {
  return SkillTreeLayout.edgeCurve(points);
}

// Color palette for separate prerequisite paths
const PREREQ_PATH_COLORS = [
  '#2563eb', // Path 0: Royal Blue
  '#e11d48', // Path 1: Vivid Rose
  '#ea580c', // Path 2: Tangerine Orange
  '#0891b2', // Path 3: Deep Cyan
  '#d97706', // Path 4: Amber Gold
];

function hexToRgb(hex) {
  const c = hex.replace('#', '');
  const num = parseInt(c, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function blendHexColors(hexList) {
  if (!hexList || hexList.length === 0) return PREREQ_PATH_COLORS[0];
  if (hexList.length === 1) return hexList[0];

  // Specific high-vibrancy pairings
  const sorted = hexList.slice().sort();
  const key = sorted.join('+');
  if (key === `${PREREQ_PATH_COLORS[0]}+${PREREQ_PATH_COLORS[1]}`) {
    return '#8b5cf6'; // Blue + Rose = Vibrant Violet / Purple
  }
  if (key === `${PREREQ_PATH_COLORS[0]}+${PREREQ_PATH_COLORS[2]}`) {
    return '#6366f1'; // Blue + Orange = Indigo
  }
  if (key === `${PREREQ_PATH_COLORS[1]}+${PREREQ_PATH_COLORS[2]}`) {
    return '#f43f5e'; // Rose + Orange = Coral Red
  }

  // Quadratic gamma-corrected color mixing for vibrant blends
  let rSq = 0, gSq = 0, bSq = 0;
  for (const hex of hexList) {
    const [r, g, b] = hexToRgb(hex);
    rSq += r * r;
    gSq += g * g;
    bSq += b * b;
  }
  const n = hexList.length;
  return rgbToHex(Math.sqrt(rSq / n), Math.sqrt(gSq / n), Math.sqrt(bSq / n));
}

function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function ensureArrowheadMarker(containerEl, colorHex) {
  const svg = containerEl.tagName && containerEl.tagName.toLowerCase() === 'svg'
    ? containerEl
    : containerEl.querySelector('svg');
  if (!svg) return 'url(#arrowhead-accent)';

  const cleanHex = String(colorHex).replace(/[^a-zA-Z0-9]/g, '');
  const markerId = `arrowhead-dyn-${cleanHex}`;

  let marker = svg.querySelector(`#${markerId}`);
  if (!marker) {
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', markerId);
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('refX', '6');
    marker.setAttribute('refY', '3.5');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerUnits', 'userSpaceOnUse');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', '0 0, 7 3.5, 0 7');
    poly.setAttribute('fill', colorHex);
    marker.appendChild(poly);
    defs.appendChild(marker);
  }
  return `url(#${markerId})`;
}

// Highlights upstream prerequisites and downstream unlocks on hover/selection
// ---------- path analysis (pure graph work, no DOM) ----------

// Hovering down a list of prerequisites asks about a dozen different skills
// over the same unchanged graph, and every question used to rebuild the
// adjacency index and re-run four traversals before touching the DOM. That
// work is cached here, at the two rates it goes stale: the index depends
// only on the tree, the traversals also on which skill is being asked about.
//
// The cache key is the tree object itself. Every structural edit in tree.js
// goes through loadTree(), which replaces that object wholesale, so a changed
// graph is always a new object and gets a new entry. The edge-array check is
// a second line of defence, in case something later edits a tree in place.
const pathAnalysisCache = new WeakMap();

function analyzeGraphPath(targetStr, treeData) {
  let entry = pathAnalysisCache.get(treeData);
  if (!entry || entry.edges !== treeData.edges || entry.edgeCount !== treeData.edges.length) {
    entry = {
      edges: treeData.edges,
      edgeCount: treeData.edges.length,
      index: buildEdgeIndex(treeData),
      byTarget: new Map(),
    };
    pathAnalysisCache.set(treeData, entry);
  }

  let analysis = entry.byTarget.get(targetStr);
  if (!analysis) {
    analysis = computePathAnalysis(targetStr, treeData, entry.index);
    entry.byTarget.set(targetStr, analysis);
  }
  return analysis;
}

// Shared with every caller that asks about the same skill, so the sets and
// maps that come back are read-only: the DOM pass below only ever queries
// them.
function buildEdgeIndex(treeData) {
  // 1. Build adjacency list for graph traversal
  const inEdges = new Map();  // toId -> [{ fromId, toId, edgeKey, edgeIdx }]
  const outEdges = new Map(); // fromId -> [{ fromId, toId, edgeKey, edgeIdx }]

  treeData.edges.forEach((edge, idx) => {
    const to = String(edge.skill_id !== undefined ? edge.skill_id : edge.to);
    const from = String(edge.prereq_skill_id !== undefined ? edge.prereq_skill_id : edge.from);
    if (!from || !to || from === 'undefined' || to === 'undefined') return;

    const edgeKey = `${from}->${to}`;
    const edgeObj = { fromId: from, toId: to, edgeKey, edgeIdx: idx };

    if (!inEdges.has(to)) inEdges.set(to, []);
    inEdges.get(to).push(edgeObj);

    if (!outEdges.has(from)) outEdges.set(from, []);
    outEdges.get(from).push(edgeObj);
  });
  return { inEdges, outEdges };
}

function computePathAnalysis(targetStr, treeData, index) {
  const { inEdges, outEdges } = index;

  // 2. Identify all upstream nodes and edges leading to targetStr (reverse BFS)
  const upstreamNodes = new Set();
  const upstreamEdgeKeys = new Set();
  const queueUp = [targetStr];
  const visitedUp = new Set([targetStr]);

  while (queueUp.length > 0) {
    const curr = queueUp.shift();
    const incoming = inEdges.get(curr) || [];
    for (const { fromId, edgeKey } of incoming) {
      upstreamEdgeKeys.add(edgeKey);
      if (!visitedUp.has(fromId)) {
        visitedUp.add(fromId);
        upstreamNodes.add(fromId);
        queueUp.push(fromId);
      }
    }
  }

  // 3. Identify distinct prerequisite path streams
  // In the upstream subgraph, find all source nodes (nodes in upstreamNodes with in-degree 0 in upstreamEdgeKeys)
  let rootNodes = [];
  for (const node of upstreamNodes) {
    const incoming = inEdges.get(node) || [];
    const hasIncomingInUpstream = incoming.some(({ edgeKey }) => upstreamEdgeKeys.has(edgeKey));
    if (!hasIncomingInUpstream) {
      rootNodes.push(node);
    }
  }

  // If cycle detected (rootNodes empty but upstreamNodes not empty), pick deterministic node
  if (rootNodes.length === 0 && upstreamNodes.size > 0) {
    const skillOrder = new Map();
    if (treeData.skills) {
      treeData.skills.forEach((s, i) => skillOrder.set(String(s.id), i));
    }
    const sorted = Array.from(upstreamNodes).sort((a, b) => (skillOrder.get(a) || 0) - (skillOrder.get(b) || 0));
    rootNodes.push(sorted[0]);
  } else {
    // Sort root nodes deterministically
    const skillOrder = new Map();
    if (treeData.skills) {
      treeData.skills.forEach((s, i) => skillOrder.set(String(s.id), i));
    }
    rootNodes.sort((a, b) => (skillOrder.get(a) || 0) - (skillOrder.get(b) || 0));
  }

  // Define distinct path streams:
  // - If there are >= 2 root nodes: each root is a distinct stream origin.
  // - If there is 1 root node:
  //   Check if the root (or subsequent nodes in the chain) branches into >= 2 paths before reaching targetStr.
  //   If it branches, each branch is a distinct stream origin!
  const streams = []; // [{ id: number, startNode: string, startEdgeKey?: string, branchPoint?: string }]

  if (rootNodes.length >= 2) {
    rootNodes.forEach((root, idx) => {
      streams.push({ id: idx, startNode: root });
    });
  } else if (rootNodes.length === 1) {
    const root = rootNodes[0];
    // Find the first node in the upstream subgraph with out-degree >= 2 in upstreamEdgeKeys
    let branchPoint = null;
    const qFind = [root];
    const visitedFind = new Set([root]);

    while (qFind.length > 0) {
      const curr = qFind.shift();
      const outgoing = (outEdges.get(curr) || []).filter(({ edgeKey }) => upstreamEdgeKeys.has(edgeKey));
      if (outgoing.length >= 2) {
        branchPoint = curr;
        break;
      }
      for (const { toId } of outgoing) {
        if (toId !== targetStr && !visitedFind.has(toId)) {
          visitedFind.add(toId);
          qFind.push(toId);
        }
      }
    }

    if (branchPoint) {
      // Each outgoing edge from branchPoint is a separate stream
      const branchEdges = (outEdges.get(branchPoint) || []).filter(({ edgeKey }) => upstreamEdgeKeys.has(edgeKey));
      branchEdges.forEach((bEdge, idx) => {
        streams.push({ id: idx, startNode: bEdge.toId, startEdgeKey: bEdge.edgeKey, branchPoint });
      });
    } else {
      // Single linear path
      streams.push({ id: 0, startNode: root });
    }
  }

  // 4. Trace each stream forward through upstreamEdgeKeys
  const nodeOrigins = new Map(); // nodeId -> Set of stream IDs
  const edgeOrigins = new Map(); // edgeKey -> Set of stream IDs

  streams.forEach((stream) => {
    const streamId = stream.id;

    if (stream.startEdgeKey) {
      // Branching case: mark the branch edge
      if (!edgeOrigins.has(stream.startEdgeKey)) edgeOrigins.set(stream.startEdgeKey, new Set());
      edgeOrigins.get(stream.startEdgeKey).add(streamId);
    }

    const q = [stream.startNode];
    const visited = new Set([stream.startNode]);

    if (!nodeOrigins.has(stream.startNode)) nodeOrigins.set(stream.startNode, new Set());
    nodeOrigins.get(stream.startNode).add(streamId);

    while (q.length > 0) {
      const curr = q.shift();
      const outgoing = outEdges.get(curr) || [];
      for (const { toId, edgeKey } of outgoing) {
        if (upstreamEdgeKeys.has(edgeKey)) {
          if (!edgeOrigins.has(edgeKey)) edgeOrigins.set(edgeKey, new Set());
          edgeOrigins.get(edgeKey).add(streamId);

          if (toId !== targetStr && !visited.has(toId)) {
            visited.add(toId);
            if (!nodeOrigins.has(toId)) nodeOrigins.set(toId, new Set());
            nodeOrigins.get(toId).add(streamId);
            q.push(toId);
          }
        }
      }
    }
  });

  // If a branchPoint was used, mark the trunk before the branchPoint with the base color (Path 0)
  if (streams.length > 0 && streams[0].branchPoint) {
    const bp = streams[0].branchPoint;
    const trunkQ = [rootNodes[0]];
    const trunkVisited = new Set([rootNodes[0]]);

    while (trunkQ.length > 0) {
      const curr = trunkQ.shift();
      if (!nodeOrigins.has(curr) || nodeOrigins.get(curr).size === 0) {
        nodeOrigins.set(curr, new Set([0]));
      }
      if (curr === bp) break;

      const outgoing = (outEdges.get(curr) || []).filter(({ edgeKey }) => upstreamEdgeKeys.has(edgeKey));
      for (const { toId, edgeKey } of outgoing) {
        if (!edgeOrigins.has(edgeKey) || edgeOrigins.get(edgeKey).size === 0) {
          edgeOrigins.set(edgeKey, new Set([0]));
        }
        if (!trunkVisited.has(toId)) {
          trunkVisited.add(toId);
          trunkQ.push(toId);
        }
      }
    }
  }

  // 5. Traverse downstream (unlocks via forward BFS from targetStr)
  const downstreamNodes = new Set();
  const downstreamEdgeKeys = new Set();
  const queueDown = [targetStr];
  const visitedDown = new Set([targetStr]);

  while (queueDown.length > 0) {
    const curr = queueDown.shift();
    const outgoing = outEdges.get(curr) || [];
    for (const { toId, edgeKey } of outgoing) {
      downstreamEdgeKeys.add(edgeKey);
      if (!visitedDown.has(toId)) {
        visitedDown.add(toId);
        downstreamNodes.add(toId);
        queueDown.push(toId);
      }
    }
  }

  return {
    upstreamNodes,
    upstreamEdgeKeys,
    nodeOrigins,
    edgeOrigins,
    downstreamNodes,
    downstreamEdgeKeys,
  };
}

// Which colour a node or edge takes from the streams that reach it.
  function getColorForOrigins(originsSet) {
    if (!originsSet || originsSet.size === 0) {
      return { color: PREREQ_PATH_COLORS[0], isMerged: false };
    }
    if (originsSet.size === 1) {
      const idx = Array.from(originsSet)[0];
      return {
        color: PREREQ_PATH_COLORS[idx % PREREQ_PATH_COLORS.length],
        isMerged: false,
      };
    }
    const hexList = Array.from(originsSet).map((idx) => PREREQ_PATH_COLORS[idx % PREREQ_PATH_COLORS.length]);
    return {
      color: blendHexColors(hexList),
      isMerged: true,
    };
  }

function highlightGraphPath(targetSkillId, treeData, containerEl) {
  if (!containerEl) return;

  function clearAllHighlights() {
    containerEl.classList.remove('graph-has-highlight');
    containerEl.querySelectorAll('.node-card').forEach((el) => {
      el.classList.remove('highlight-focus', 'highlight-upstream', 'highlight-downstream', 'highlight-merged');
      el.style.stroke = '';
      el.style.filter = '';
    });
    containerEl.querySelectorAll('path.edge-line').forEach((el) => {
      el.classList.remove('path-upstream', 'path-downstream', 'path-merged');
      el.style.stroke = '';
      el.style.markerEnd = '';
    });
    containerEl.querySelectorAll('.highlight-node').forEach((el) => el.classList.remove('highlight-node'));
  }

  if (!targetSkillId || !treeData || !Array.isArray(treeData.edges)) {
    clearAllHighlights();
    return;
  }

  const targetStr = String(targetSkillId);

  // Check if target node exists in skills
  if (Array.isArray(treeData.skills) && treeData.skills.length > 0) {
    const exists = treeData.skills.some((s) => String(s.id) === targetStr);
    if (!exists) {
      clearAllHighlights();
      return;
    }
  }

  const {
    upstreamNodes,
    upstreamEdgeKeys,
    nodeOrigins,
    edgeOrigins,
    downstreamNodes,
    downstreamEdgeKeys,
  } = analyzeGraphPath(targetStr, treeData);

  containerEl.classList.add('graph-has-highlight');

  // Mark nodes in DOM
  const nodeGroups = containerEl.querySelectorAll('g[data-skill-id]');
  nodeGroups.forEach((g) => {
    const sid = String(g.dataset.skillId);
    const rect = g.querySelector('.node-card');
    if (!rect) return;
    rect.classList.remove('highlight-focus', 'highlight-upstream', 'highlight-downstream', 'highlight-merged');
    rect.style.stroke = '';
    rect.style.filter = '';
    g.classList.remove('highlight-node');

    if (sid === targetStr) {
      rect.classList.add('highlight-focus');
      g.classList.add('highlight-node');
    } else if (upstreamNodes.has(sid)) {
      const { color, isMerged } = getColorForOrigins(nodeOrigins.get(sid));
      rect.classList.add('highlight-upstream');
      if (isMerged) rect.classList.add('highlight-merged');
      rect.style.stroke = color;
      rect.style.filter = `drop-shadow(0 2px 8px ${hexToRgba(color, 0.45)})`;
      g.classList.add('highlight-node');
    } else if (downstreamNodes.has(sid)) {
      rect.classList.add('highlight-downstream');
      rect.style.stroke = 'var(--unlocks)';
      rect.style.filter = 'drop-shadow(0 2px 8px rgba(16, 185, 129, 0.4))';
      g.classList.add('highlight-node');
    }
  });

  // Mark edges in DOM
  const edgePaths = containerEl.querySelectorAll('path.edge-line:not(.hit)');
  edgePaths.forEach((path, idx) => {
    path.classList.remove('path-upstream', 'path-downstream', 'path-merged');
    path.style.stroke = '';
    path.style.markerEnd = '';

    // Primary lookup by data-from and data-to; fallback to treeData.edges[idx]
    let edgeKey = null;
    if (path.dataset.from && path.dataset.to) {
      edgeKey = `${path.dataset.from}->${path.dataset.to}`;
    } else if (treeData.edges[idx]) {
      const e = treeData.edges[idx];
      const from = String(e.prereq_skill_id !== undefined ? e.prereq_skill_id : e.from);
      const to = String(e.skill_id !== undefined ? e.skill_id : e.to);
      edgeKey = `${from}->${to}`;
    }

    if (!edgeKey) return;

    if (upstreamEdgeKeys.has(edgeKey)) {
      const origins = edgeOrigins.get(edgeKey);
      const { color, isMerged } = getColorForOrigins(origins);
      path.classList.add('path-upstream');
      if (isMerged) path.classList.add('path-merged');
      path.style.stroke = color;
      path.style.markerEnd = ensureArrowheadMarker(containerEl, color);
    } else if (downstreamEdgeKeys.has(edgeKey)) {
      path.classList.add('path-downstream');
      path.style.stroke = 'var(--unlocks)';
      path.style.markerEnd = 'url(#arrowhead-green)';
    }
  });
}

function timeAgo(isoLike) {
  // sqlite datetime('now') gives "YYYY-MM-DD HH:MM:SS" (UTC, no offset marker)
  const d = new Date(isoLike.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

// --- Home page logic (only runs if these elements exist) ---

let allTrees = []; // cached for the search dropdown; refreshed by loadTrees()

async function loadTrees() {
  const grid = document.getElementById('tree-grid');
  const empty = document.getElementById('empty-state');
  if (!grid) return;

  try {
    const trees = await apiFetch('/trees');
    allTrees = trees;
    grid.innerHTML = '';
    if (trees.length === 0) {
      empty.hidden = false;
      await loadFeatured(null);
      scrollToHashTarget();
      return;
    }
    empty.hidden = true;
    for (let i = 0; i < trees.length; i++) {
      const tree = trees[i];
      const card = document.createElement('a');
      card.className = 'tree-card';
      card.style.animationDelay = `${Math.min(i * 35, 350)}ms`;
      card.href = `/tree.html?id=${tree.id}`;
      card.innerHTML = `
        <h3>${escapeHtml(tree.title)}</h3>
        <p>${escapeHtml(tree.description || 'No description yet.')}</p>
        <div class="meta">
          <span>${tree.skill_count} skill${tree.skill_count === 1 ? '' : 's'}</span>
          <span>by ${escapeHtml(tree.author)} &middot; ${timeAgo(tree.created_at)}</span>
        </div>
      `;
      grid.appendChild(card);
    }
    await loadFeatured(trees.find((t) => t.featured) || null);
    scrollToHashTarget();
  } catch (e) {
    showToast('Could not load skill trees: ' + e.message);
  }
}

// The featured hero's height isn't known until its own data finishes
// loading, so a deep link straight to #browse (e.g. "← All trees" from the
// tree editor) can land in the wrong place if the browser's automatic
// anchor-jump happens first, before the hero has expanded. Re-settle once
// the layout is final.
function scrollToHashTarget() {
  if (location.hash === '#browse') {
    // Explicit "auto" — this is a layout correction, not a user gesture, and
    // it would otherwise inherit the page's CSS scroll-behavior: smooth.
    document.getElementById('browse')?.scrollIntoView({ behavior: 'auto' });
  } else if (location.hash === '#featured') {
    document.getElementById('featured')?.scrollIntoView({ behavior: 'auto' });
  }
}

// --- Featured tree spotlight ---
//
// Which tree is featured is set server-side only (see backend/db/feature.js)
// — there is no API endpoint for it, so nothing here ever writes `featured`.
// This reads whichever tree already has the flag and puts it on display
// full-screen at the top of the landing page, with the same zoom/pan/drag
// interactions as the real editor in tree.js (drag here is the same
// session-only repositioning — it never touches the database).

let featuredTree = null;       // raw tree data for whichever tree is featured
let featuredPositions = null;  // Map(skillId -> {x,y}), mutated in place while dragging
let featuredRoutes = null;     // Map(edge index -> waypoints) for column-skipping edges
let featuredViewBox = null;    // {minX, minY, w, h}
const FEATURED_MIN_VIEW = 150;
const FEATURED_MAX_VIEW = 8000;

let updateScrollHint = null;

async function loadFeatured(summary) {
  const hero = document.getElementById('featured-hero');
  if (!hero) return;
  if (!summary) {
    hero.hidden = true;
    featuredTree = null;
    if (updateScrollHint) updateScrollHint();
    return;
  }

  try {
    const tree = await apiFetch(`/trees/${summary.id}`);
    featuredTree = tree;
    document.getElementById('featured-link').href = `/tree.html?id=${tree.id}`;
    document.getElementById('featured-title').textContent = tree.title;
    document.getElementById('featured-desc').textContent =
      tree.description || 'No description yet.';
    document.getElementById('featured-meta').textContent =
      `${tree.skills.length} skill${tree.skills.length === 1 ? '' : 's'} · by ${tree.author} · ${timeAgo(tree.created_at)}`;
    document.getElementById('featured-svg').setAttribute(
      'aria-label',
      `${tree.title}: graph of ${tree.skills.length} skill${tree.skills.length === 1 ? '' : 's'}`
    );

    if (tree.layout === 'auto') {
      const laidOut = SkillTreeLayout.computeRoutes(
        tree.skills.map((s) => ({ id: s.id })),
        tree.edges.map((e) => ({ from: e.prereq_skill_id, to: e.skill_id }))
      );
      featuredPositions = laidOut.positions;
      featuredRoutes = laidOut.routes;
    } else {
      featuredPositions = new Map(tree.skills.map((s) => [s.id, { x: s.pos_x, y: s.pos_y }]));
      featuredRoutes = null; // manual coordinates are routed per render below
    }

    featuredViewBox = computeFeaturedBounds();
    renderFeatured();
    hero.hidden = false;
    if (updateScrollHint) updateScrollHint();
  } catch (e) {
    hero.hidden = true;
    if (updateScrollHint) updateScrollHint();
  }
}

// The bounding box that contains every node, with padding — same idea as
// computeContentBounds() in tree.js, used both for the initial fit and the
// "Fit" button.
function computeFeaturedBounds() {
  const { NODE_W, NODE_H } = SkillTreeLayout;
  if (!featuredTree || featuredTree.skills.length === 0) {
    return { minX: 0, minY: 0, w: 800, h: 400 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of featuredTree.skills) {
    const p = featuredPositions.get(s.id);
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + NODE_H);
  }
  const pad = 60;
  return {
    minX: minX - pad,
    minY: minY - pad,
    w: Math.max(maxX - minX + pad * 2, 400),
    h: Math.max(maxY - minY + pad * 2, 300),
  };
}

function applyFeaturedViewBox() {
  document
    .getElementById('featured-svg')
    .setAttribute(
      'viewBox',
      `${featuredViewBox.minX} ${featuredViewBox.minY} ${featuredViewBox.w} ${featuredViewBox.h}`
    );
}

function toFeaturedSvgPoint(evt) {
  const svg = document.getElementById('featured-svg');
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

let featuredDraggingSkillId = null;
let featuredKeys = null; // keyboard model for the hero graph, see setupFeaturedHero()

// Full-screen rendering of the featured tree's graph. It's a display, not
// the real editor (no add/link/delete), but zoom, pan, and node dragging all
// work the same way they do in tree.js.
function renderFeatured() {
  const svg = document.getElementById('featured-svg');
  if (!svg || !featuredTree) return;
  const { NODE_W, NODE_H } = SkillTreeLayout;
  const hadFocus = featuredKeys ? featuredKeys.focusedId() : null;

  applyFeaturedViewBox();
  svg.innerHTML = '';
  if (featuredTree.skills.length === 0) return;

  const ns = 'http://www.w3.org/2000/svg';

  // Marker definitions for arrowheads
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `
    <marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
      <polygon points="0 0.5, 6.5 3.5, 0 6.5" fill="var(--locked)"></polygon>
    </marker>
    <marker id="arrowhead-accent" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
      <polygon points="0 0.5, 6.5 3.5, 0 6.5" fill="var(--accent)"></polygon>
    </marker>
    <marker id="arrowhead-green" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
      <polygon points="0 0.5, 6.5 3.5, 0 6.5" fill="var(--unlocks)"></polygon>
    </marker>
  `;
  svg.appendChild(defs);

  const edgesLayer = document.createElementNS(ns, 'g');
  const nodesLayer = document.createElementNS(ns, 'g');

  // Auto layouts already reserved a row for every edge that skips a column.
  // Manual coordinates are wherever the author left them — or wherever the
  // hero's own drag has moved them — so their detours are worked out here.
  const edgeRoutes =
    featuredTree.layout === 'auto'
      ? featuredRoutes
      : SkillTreeLayout.routeAroundNodes(
          featuredPositions,
          featuredTree.edges.map((e) => ({ from: e.prereq_skill_id, to: e.skill_id }))
        );

  featuredTree.edges.forEach((edge, index) => {
    const from = featuredPositions.get(edge.prereq_skill_id);
    const to = featuredPositions.get(edge.skill_id);
    if (!from || !to) return;
    const line = document.createElementNS(ns, 'path');
    line.setAttribute(
      'd',
      edgePath([
        { x: from.x + NODE_W, y: from.y + NODE_H / 2 },
        ...((edgeRoutes && edgeRoutes.get(index)) || []),
        { x: to.x, y: to.y + NODE_H / 2 },
      ])
    );
    line.setAttribute('class', 'edge-line');
    line.dataset.from = String(edge.prereq_skill_id);
    line.dataset.to = String(edge.skill_id);
    edgesLayer.appendChild(line);
  });

  const hasPrereq = new Set(featuredTree.edges.map((e) => e.skill_id));
  const sortedSkills = featuredTree.skills.slice().sort((a, b) => {
    if (a.id === featuredDraggingSkillId) return 1;
    if (b.id === featuredDraggingSkillId) return -1;
    return 0;
  });

  for (const skill of sortedSkills) {
    const p = featuredPositions.get(skill.id);
    if (!p) continue;
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', `translate(${p.x}, ${p.y})`);
    g.dataset.skillId = skill.id;

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', 10);
    let cls = 'node-card ' + (hasPrereq.has(skill.id) ? 'locked' : 'unlocked');
    if (skill.id === featuredDraggingSkillId) cls += ' is-dragging';
    rect.setAttribute('class', cls);
    g.appendChild(rect);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', 12);
    label.setAttribute('y', NODE_H / 2 + 5);
    label.setAttribute('class', 'node-label');
    label.textContent = skill.name.length > 20 ? skill.name.slice(0, 19) + '…' : skill.name;
    g.appendChild(label);

    g.addEventListener('mouseenter', () => {
      highlightGraphPath(skill.id, featuredTree, svg);
    });
    g.addEventListener('mouseleave', () => {
      highlightGraphPath(null, featuredTree, svg);
    });

    if (featuredKeys) featuredKeys.decorate(g, skill);
    attachFeaturedNodeDrag(g, skill, p);
    nodesLayer.appendChild(g);
  }

  svg.appendChild(edgesLayer);
  svg.appendChild(nodesLayer);
  if (featuredKeys) featuredKeys.sync(hadFocus);
}

// Dragging a node repositions it on screen only — same as tree.js, nothing
// here is ever saved. A plain click (no movement) opens the real tree page.
function attachFeaturedNodeDrag(g, skill, pos) {
  let dragging = false;
  let moved = false;
  let startPt, startPos;

  g.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the background pan handler
    dragging = true;
    featuredDraggingSkillId = skill.id;
    moved = false;
    startPt = toFeaturedSvgPoint(e);
    startPos = { x: pos.x, y: pos.y };
    g.querySelector('.node-card')?.classList.add('is-dragging');

    const onMove = (ev) => {
      if (!dragging) return;
      const p = toFeaturedSvgPoint(ev);
      const dx = p.x - startPt.x;
      const dy = p.y - startPt.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      pos.x = startPos.x + dx;
      pos.y = startPos.y + dy;
      renderFeatured();
    };
    const onUp = () => {
      dragging = false;
      featuredDraggingSkillId = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      renderFeatured();
      if (!moved) window.location.href = `/tree.html?id=${featuredTree.id}`;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function zoomFeaturedAtPoint(pt, scaleFactor) {
  let newW = featuredViewBox.w * scaleFactor;
  let newH = featuredViewBox.h * scaleFactor;
  newW = Math.min(Math.max(newW, FEATURED_MIN_VIEW), FEATURED_MAX_VIEW);
  newH = Math.min(Math.max(newH, FEATURED_MIN_VIEW), FEATURED_MAX_VIEW);
  const actualScale = newW / featuredViewBox.w;
  featuredViewBox = {
    minX: pt.x - (pt.x - featuredViewBox.minX) * actualScale,
    minY: pt.y - (pt.y - featuredViewBox.minY) * actualScale,
    w: newW,
    h: newH,
  };
  applyFeaturedViewBox();
}

function zoomFeaturedAtCenter(scaleFactor) {
  const center = {
    x: featuredViewBox.minX + featuredViewBox.w / 2,
    y: featuredViewBox.minY + featuredViewBox.h / 2,
  };
  zoomFeaturedAtPoint(center, scaleFactor);
}

// Wired up once at page load — the data (featuredTree/featuredPositions) can
// change underneath as loadFeatured() re-runs, but the listeners stay put.
function setupFeaturedHero() {
  const hero = document.getElementById('featured-hero');
  const svg = document.getElementById('featured-svg');
  if (!hero || !svg) return;

  hero.addEventListener(
    'wheel',
    (e) => {
      if (!featuredViewBox) return;
      e.preventDefault();
      const pt = toFeaturedSvgPoint(e);
      zoomFeaturedAtPoint(pt, e.deltaY < 0 ? 0.9 : 1.1);
    },
    { passive: false }
  );

  let panState = null;
  svg.addEventListener('mousedown', (e) => {
    if (e.target !== svg || !featuredViewBox) return; // bare background only
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    panState = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startBox: { ...featuredViewBox },
      scaleX: featuredViewBox.w / rect.width,
      scaleY: featuredViewBox.h / rect.height,
    };
    svg.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!panState) return;
    const dx = (e.clientX - panState.startClientX) * panState.scaleX;
    const dy = (e.clientY - panState.startClientY) * panState.scaleY;
    featuredViewBox = {
      ...panState.startBox,
      minX: panState.startBox.minX - dx,
      minY: panState.startBox.minY - dy,
    };
    applyFeaturedViewBox();
  });
  window.addEventListener('mouseup', () => {
    if (panState) {
      panState = null;
      svg.classList.remove('panning');
    }
  });

  const fitFeatured = () => {
    featuredViewBox = computeFeaturedBounds();
    applyFeaturedViewBox();
  };
  document.getElementById('featured-zoom-in').addEventListener('click', () => zoomFeaturedAtCenter(0.8));
  document.getElementById('featured-zoom-out').addEventListener('click', () => zoomFeaturedAtCenter(1.25));
  document.getElementById('featured-zoom-fit').addEventListener('click', fitFeatured);

  // The same keyboard model as the editor (see a11y.js). A skill here is a
  // link — Enter does what a click does, which is open the tree.
  const edgeIds = (key, id, other) =>
    featuredTree ? featuredTree.edges.filter((e) => String(e[key]) === id).map((e) => e[other]) : [];
  featuredKeys = createGraphKeyboard({
    svg,
    role: 'link',
    skills: () =>
      featuredTree
        ? featuredTree.skills.map((s) => {
            const p = featuredPositions.get(s.id) || { x: 0, y: 0 };
            return { id: s.id, name: s.name, x: p.x, y: p.y };
          })
        : [],
    prereqsOf: (id) => edgeIds('skill_id', id, 'prereq_skill_id'),
    unlocksOf: (id) => edgeIds('prereq_skill_id', id, 'skill_id'),
    activate: () => {
      if (featuredTree) window.location.href = `/tree.html?id=${featuredTree.id}`;
    },
    onFocus: (id) => highlightGraphPath(id, featuredTree, svg),
    onBlur: () => highlightGraphPath(null, featuredTree, svg),
    zoomBy: (f) => featuredViewBox && zoomFeaturedAtCenter(f),
    fit: () => featuredViewBox && fitFeatured(),
    panBy: (fx, fy) => {
      if (!featuredViewBox) return;
      featuredViewBox.minX += fx * featuredViewBox.w;
      featuredViewBox.minY += fy * featuredViewBox.h;
      applyFeaturedViewBox();
    },
    panByPixels: (dx, dy) => {
      const scale = 1 / svg.getScreenCTM().a;
      featuredViewBox.minX += dx * scale;
      featuredViewBox.minY += dy * scale;
      applyFeaturedViewBox();
    },
    obstacles: [
      '.featured-hero-overlay > *',
      '.featured-hero .zoom-controls',
      '.featured-hero .graph-kbd-hint',
      '.featured-scroll-hint',
      '.site-header-actions > *',
    ],
  });

  const scrollHint = document.getElementById('scroll-hint-btn');
  if (scrollHint) {
    updateScrollHint = () => {
      if (hero.hidden) {
        scrollHint.style.display = 'none';
        return;
      }
      scrollHint.style.display = '';
      const heroBottom = hero.offsetTop + hero.offsetHeight;
      const isPastHero = window.scrollY >= heroBottom - 120;
      // Only touch the DOM when the state flips: this runs on every scroll
      // event, and rewriting a focused link's contents drops its focus ring.
      if (isPastHero === scrollHint.classList.contains('is-fixed')) return;
      if (isPastHero) {
        scrollHint.classList.add('is-fixed');
        scrollHint.innerHTML = '<span aria-hidden="true">&uarr;</span> Featured tree';
        scrollHint.setAttribute('href', '#featured');
      } else {
        scrollHint.classList.remove('is-fixed');
        scrollHint.innerHTML = 'Browse all trees <span aria-hidden="true">&darr;</span>';
        scrollHint.setAttribute('href', '#browse');
      }
    };

    window.addEventListener('scroll', updateScrollHint, { passive: true });
    updateScrollHint();

    scrollHint.addEventListener('click', (e) => {
      if (scrollHint.classList.contains('is-fixed')) {
        e.preventDefault();
        triggerScrollToFeatured();
      }
    });
  }

  // --- Auto-scroll up to #featured when scrolling up on #browse ---
  let isAutoScrolling = false;
  let autoScrollTimeout = null;

  function triggerScrollToFeatured(e) {
    if (e && e.cancelable) e.preventDefault();
    if (isAutoScrolling) return;

    isAutoScrolling = true;
    clearTimeout(autoScrollTimeout);

    if (history.replaceState && location.hash !== '#featured') {
      history.replaceState(null, '', '#featured');
    }

    const featured = document.getElementById('featured') || hero;
    featured.scrollIntoView({ behavior: 'smooth' });

    autoScrollTimeout = setTimeout(() => {
      isAutoScrolling = false;
    }, 850);
  }

  function shouldAutoScrollUp(target) {
    if (hero.hidden || window.scrollY <= 20) return false;
    if (target && target.closest && target.closest('#featured-hero')) return false;

    const onBrowse = !!(target && target.closest && target.closest('#browse'));
    if (onBrowse) return true;

    const heroBottom = hero.offsetTop + hero.offsetHeight;
    const browseEl = document.getElementById('browse');
    if (!browseEl) return false;

    const browseRect = browseEl.getBoundingClientRect();
    const inBrowseZone = (
      (browseRect.top >= -80 && browseRect.top <= window.innerHeight * 0.65) ||
      (window.scrollY >= heroBottom - 120 && window.scrollY <= heroBottom + 220)
    );

    return inBrowseZone;
  }

  window.addEventListener(
    'wheel',
    (e) => {
      if (hero.hidden) return;

      if (e.deltaY > 15 && isAutoScrolling) {
        isAutoScrolling = false;
        clearTimeout(autoScrollTimeout);
        return;
      }

      if (isAutoScrolling && e.deltaY <= 0) {
        if (e.cancelable) e.preventDefault();
        return;
      }

      if (e.deltaY < -3 && shouldAutoScrollUp(e.target)) {
        triggerScrollToFeatured(e);
      }
    },
    { passive: false }
  );

  let touchStartY = 0;
  let touchStartX = 0;
  let touchTarget = null;

  window.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
        touchTarget = e.target;
      }
    },
    { passive: true }
  );

  window.addEventListener(
    'touchmove',
    (e) => {
      if (!touchStartY || e.touches.length !== 1) return;
      const currentY = e.touches[0].clientY;
      const currentX = e.touches[0].clientX;
      const deltaY = currentY - touchStartY;
      const deltaX = currentX - touchStartX;

      if (deltaY > 25 && Math.abs(deltaY) > Math.abs(deltaX) * 1.5) {
        if (shouldAutoScrollUp(touchTarget || e.target)) {
          touchStartY = 0;
          triggerScrollToFeatured(e);
        }
      }
    },
    { passive: false }
  );

  window.addEventListener(
    'scroll',
    () => {
      if (window.scrollY <= 10) {
        isAutoScrolling = false;
        clearTimeout(autoScrollTimeout);
      }
    },
    { passive: true }
  );
}

// --- Live search: an ARIA 1.2 combobox ---
//
// Focus never leaves the text field. The results are a listbox beside it,
// and the one the arrow keys have reached is named by aria-activedescendant
// rather than focused — so typing can carry on at any point, and a screen
// reader hears the highlighted result as if it had focus.
//
//   Down / Up   open the list, then move through it (wrapping at the ends)
//   Enter       open the highlighted tree
//   Escape      close the list; pressed again, clear the field

function setupSearch() {
  const input = document.getElementById('tree-search');
  const listbox = document.getElementById('search-dropdown');
  const status = document.getElementById('search-status');
  if (!input) return;

  let activeIndex = -1;
  let matches = [];

  const optionId = (i) => `search-option-${i}`;

  const setOpen = (open) => {
    listbox.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) input.removeAttribute('aria-activedescendant');
  };

  const close = () => {
    setOpen(false);
    listbox.innerHTML = '';
    activeIndex = -1;
    matches = [];
  };

  const renderMatches = () => {
    listbox.innerHTML = '';
    matches.forEach((tree, i) => {
      const item = document.createElement('div');
      item.id = optionId(i);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      item.className = 'search-item' + (i === activeIndex ? ' active' : '');
      item.innerHTML = `
        <span class="search-item-title">${escapeHtml(tree.title)}</span>
        <span class="search-item-meta">${tree.skill_count} skill${tree.skill_count === 1 ? '' : 's'}</span>
      `;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't let the input lose focus/blur-close before navigation
        window.location.href = `/tree.html?id=${tree.id}`;
      });
      listbox.appendChild(item);
    });
    setOpen(matches.length > 0);
    if (activeIndex >= 0) {
      input.setAttribute('aria-activedescendant', optionId(activeIndex));
      listbox.children[activeIndex].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  // How many results there are is said once typing pauses, not per key.
  let statusTimer = null;
  const reportCount = () => {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (!input.value.trim()) status.textContent = '';
      else if (matches.length === 0) status.textContent = 'No skill trees match.';
      else status.textContent = `${matches.length} skill tree${matches.length === 1 ? '' : 's'} found.`;
    }, 500);
  };

  const search = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      close();
      reportCount();
      return;
    }
    matches = allTrees
      .filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q)
      )
      .slice(0, 8);
    activeIndex = -1;
    renderMatches();
    reportCount();
  };

  input.addEventListener('input', search);

  input.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const open = !listbox.hidden && matches.length > 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        search();
        if (matches.length === 0) return;
        activeIndex = e.key === 'ArrowDown' ? 0 : matches.length - 1;
      } else if (e.key === 'ArrowDown') {
        activeIndex = (activeIndex + 1) % matches.length;
      } else {
        activeIndex = activeIndex <= 0 ? matches.length - 1 : activeIndex - 1;
      }
      renderMatches();
    } else if (e.key === 'Enter') {
      if (open && activeIndex >= 0) {
        e.preventDefault();
        window.location.href = `/tree.html?id=${matches[activeIndex].id}`;
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close();
      } else if (input.value) {
        e.preventDefault();
        input.value = '';
        reportCount();
      }
    }
  });

  input.addEventListener('blur', () => {
    // Delayed so a click on a dropdown item (mousedown, above) still fires.
    setTimeout(close, 100);
  });
}

function setupImportModal() {
  const openBtns = document.querySelectorAll('[data-open="import"]');
  const dialog = document.getElementById('import-overlay');
  const cancelBtn = document.getElementById('import-cancel-btn');
  const form = document.getElementById('import-form');
  const fileInput = document.getElementById('import-file');
  const textInput = document.getElementById('import-text');
  const problemsBox = document.getElementById('import-problems');
  const viewerBtn = document.getElementById('import-viewer-btn');
  if (!openBtns.length || !dialog) return;
  const modal = setupModalDialog(dialog);

  const showProblems = (heading, list) => {
    problemsBox.innerHTML =
      `<strong>${escapeHtml(heading)}</strong><ul>` +
      list.map((p) => `<li>${escapeHtml(p)}</li>`).join('') +
      '</ul>';
    problemsBox.hidden = false;
  };
  const clearProblems = () => {
    problemsBox.hidden = true;
    problemsBox.innerHTML = '';
  };

  // However it closes — Cancel, Escape, a click on the backdrop — it opens
  // blank next time.
  dialog.addEventListener('close', () => {
    clearProblems();
    form.reset();
  });

  openBtns.forEach((btn) =>
    btn.addEventListener('click', () => {
      clearProblems();
      modal.open();
      textInput.focus();
    })
  );
  cancelBtn.addEventListener('click', () => modal.close());

  // Choosing a file fills the textarea, so what gets imported is always
  // exactly what the person can see.
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    clearProblems();
    try {
      textInput.value = await file.text();
    } catch (e) {
      showProblems('Could not read that file.', [e.message]);
    }
  });

  if (viewerBtn) {
    viewerBtn.addEventListener('click', () => {
      clearProblems();
      const raw = textInput.value.trim();
      if (!raw) {
        showProblems('Nothing to view.', ['Paste a skill tree, or choose a file.']);
        return;
      }
      try {
        JSON.parse(raw);
      } catch (err) {
        showProblems('That is not valid JSON.', [err.message]);
        return;
      }
      sessionStorage.setItem('viewer_tree', raw);
      window.location.href = '/viewer.html';
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearProblems();

    const raw = textInput.value.trim();
    if (!raw) {
      showProblems('Nothing to import.', ['Paste a skill tree, or choose a file.']);
      return;
    }

    // Parse here as well as on the server so a typo gets an immediate,
    // specific message instead of a generic rejection.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      showProblems('That is not valid JSON.', [err.message]);
      return;
    }

    try {
      const res = await fetch(API + '/trees/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (!res.ok) {
        showProblems(data.error || 'Import failed.', data.problems || []);
        return;
      }
      window.location.href = `/tree.html?id=${data.id}`;
    } catch (err) {
      showProblems('Import failed.', [err.message]);
    }
  });

  // /#import opens the dialog straight away: it is the installed app's
  // "Import" shortcut (manifest.webmanifest), and a link anyone can share.
  // Through the button, so focus goes back to it on close. The hash is
  // dropped once used, so a reload or Back doesn't open it again.
  const openFromHash = () => {
    if (location.hash !== '#import') return;
    history.replaceState(null, '', location.pathname + location.search);
    openBtns[0].click();
  };
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
}

setupThemeToggle(); // every page carries the switch
setupAccountPage(); // no-ops unless this is account.html

if (document.getElementById('tree-grid')) {
  setupImportModal();
  setupSearch();
  setupFeaturedHero();
  loadSignedInUser();
  loadTrees();
}
