// "Your account", continued: the password, where you're signed in, your data
// and deleting the account — the sections of account.html from
// #account-password down. showAccountView() in app.js starts this once it
// knows who is signed in, so none of it runs for someone signed out.
//
// The server checks everything again. What this file hides or disables only
// spares someone a request that would be refused, and every message it
// shows goes in with textContent, never as markup.

// Where "Sign in again" comes back to, for each section that can need it.
const ACCOUNT_RETURN = {
  password: '/account.html#account-password',
  sessions: '/account.html#account-sessions',
  danger: '/account.html#account-danger',
};

// fetch() for the account routes. Unlike apiFetch() it keeps the status on
// the error: a 403 from these routes means "sign in again first", and the
// page answers that with a button as well as the message.
async function accountApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return accountResult(res, () => res.json());
}

async function accountResult(res, read) {
  if (res.ok) return read();
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* no body */
  }
  const err = new Error((data && (data.error || data.detail)) || `Request failed (${res.status})`);
  err.status = res.status;
  throw err;
}

// A message in a section's error box, with the fields it is about marked
// invalid. Those fields name the box in aria-describedby, so the message is
// read with them.
function showFieldError(box, message, fields = []) {
  showNotice(box, message);
  for (const field of fields) field.setAttribute('aria-invalid', 'true');
}

// Emptied as well as hidden: a hidden element is still read out when
// aria-describedby points at it, and a stale message would be.
function clearFieldError(box, fields = []) {
  box.hidden = true;
  box.textContent = '';
  for (const field of fields) field.removeAttribute('aria-invalid');
}

// A live region only speaks when its text changes, so it is emptied first
// and written a beat later — the same message twice is still read twice.
function setStatus(el, message) {
  el.textContent = '';
  clearTimeout(el._statusTimer);
  if (message) el._statusTimer = setTimeout(() => (el.textContent = message), 60);
}

// Buttons here are never disabled while their request runs; a flag stops a
// second click instead. A disabled button loses keyboard focus, which then
// falls to <body> — the reader is thrown back to the top of the page just
// as the result is announced.

// Signs out and goes to the sign-in form, which comes back to `returnTo`
// afterwards. The fresh sign-in is exactly what the refused request needed:
// the server wants one from the last ten minutes.
async function signInAgain(returnTo) {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch (e) {
    /* signing out locally either way */
  }
  window.location.href = `/account.html?next=${encodeURIComponent(returnTo)}`;
}

// "Firefox on Windows", from a user agent. Coarse on purpose: enough to tell
// your phone from your laptop, and nothing a fingerprint needs. A user agent
// is whatever the browser — or whoever holds a cookie — says it is, so the
// sign-in times beside it, which the server records, are what to trust.
// Anything unrecognised is an "Unknown device" rather than its raw text.
function deviceName(ua) {
  if (!ua) return 'Unknown device';
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
    ? 'Opera'
    : /SamsungBrowser\//.test(ua)
    ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//.test(ua)
    ? 'Firefox'
    : /Chrome\/|CriOS\/|Chromium\//.test(ua)
    ? 'Chrome'
    : /Version\/.*Safari\//.test(ua)
    ? 'Safari'
    : null;
  const system = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /CrOS/.test(ua)
    ? 'ChromeOS'
    : /Mac OS X|Macintosh/.test(ua)
    ? 'macOS'
    : /Linux/.test(ua)
    ? 'Linux'
    : null;
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `A browser on ${system}`;
  return 'Unknown device';
}

function timeElement(value) {
  const time = document.createElement('time');
  time.dateTime = value.replace(' ', 'T') + 'Z';
  time.textContent = timeAgo(value);
  return time;
}

// ---------- password ----------

// Change it (the current one is required), or set a first one on an account
// made through a provider (a sign-in from the last ten minutes is required
// instead). Either way the server signs out every other browser and gives
// this one a fresh cookie.
function setupPasswordSection(user, onChanged) {
  const form = document.getElementById('password-form');
  const intro = document.getElementById('account-password-intro');
  const currentField = document.getElementById('current-password-field');
  const current = document.getElementById('current-password');
  const next = document.getElementById('new-password');
  const show = document.getElementById('show-passwords');
  const errorBox = document.getElementById('password-error');
  const submit = document.getElementById('password-submit');
  const reauth = document.getElementById('password-reauth');
  const status = document.getElementById('password-status');
  document.getElementById('password-form-username').value = user.username;

  const render = () => {
    const has = user.has_password;
    intro.textContent = has
      ? 'Change the password you sign in with. Every other browser signed in to this account will be signed out.'
      : 'This account has no password: you sign in through a provider. Add one to sign in with your username too. ' +
        'For your security, that needs a sign-in from the last 10 minutes.';
    // Disabled as well as hidden, so it is neither required nor sent.
    currentField.hidden = !has;
    current.disabled = !has;
    submit.textContent = has ? 'Change password' : 'Set password';
  };

  // ASVS V2.1.12: let people check what they typed, rather than asking for
  // everything twice.
  const setVisible = (visible) => {
    current.type = next.type = visible ? 'text' : 'password';
  };
  show.addEventListener('change', () => setVisible(show.checked));
  reauth.addEventListener('click', () => signInAgain(ACCOUNT_RETURN.password));

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    clearFieldError(errorBox, [current, next]);
    reauth.hidden = true;
    setStatus(status, '');

    const wasSet = user.has_password;
    try {
      const body = { new_password: next.value };
      if (wasSet) body.current_password = current.value;
      const result = await accountApi('/auth/password', { method: 'POST', body });
      current.value = next.value = '';
      show.checked = false;
      setVisible(false);
      user.has_password = true;
      render();
      const others = result.other_sessions_ended;
      setStatus(
        status,
        wasSet
          ? `Password changed.${others ? ` ${others} other browser${others === 1 ? ' was' : 's were'} signed out.` : ''}`
          : 'Password set. You can now also sign in with your username and this password.'
      );
      onChanged();
    } catch (err) {
      if (err.status === 403) {
        showFieldError(errorBox, err.message);
        reauth.hidden = false;
        reauth.focus();
      } else if (err.status === 401 && wasSet) {
        showFieldError(errorBox, err.message, [current]);
        current.focus();
        current.select();
      } else {
        showFieldError(errorBox, err.message, [next]);
        next.focus();
      }
    } finally {
      busy = false;
    }
  });

  render();
}

// ---------- sessions ----------

// Every browser signed in to the account, this one first. Ending another
// needs a recent sign-in (the server says so with a 403, and the section
// offers "Sign in again"); this browser signs out with the button at the top.
function setupSessionsSection() {
  const heading = document.getElementById('account-sessions-heading');
  const list = document.getElementById('session-list');
  const errorBox = document.getElementById('sessions-error');
  const revokeOthers = document.getElementById('sessions-revoke-others');
  const reauth = document.getElementById('sessions-reauth');
  const status = document.getElementById('sessions-status');

  reauth.addEventListener('click', () => signInAgain(ACCOUNT_RETURN.sessions));

  const clear = () => {
    clearFieldError(errorBox);
    reauth.hidden = true;
  };
  const fail = (err) => {
    showNotice(errorBox, err.message);
    reauth.hidden = err.status !== 403;
    if (!reauth.hidden) reauth.focus();
  };

  const item = (session) => {
    const device = deviceName(session.user_agent);
    const li = document.createElement('li');
    li.className = 'session';

    const text = document.createElement('div');
    text.className = 'session-text';
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = device;
    if (session.current) {
      const badge = document.createElement('span');
      badge.className = 'session-badge';
      badge.textContent = 'This device';
      name.append(' ', badge);
    }
    const detail = document.createElement('span');
    detail.className = 'session-detail';
    detail.append('Signed in ', timeElement(session.created_at), ' · last active ', timeElement(session.last_used_at));
    text.append(name, detail);
    li.appendChild(text);

    if (!session.current) {
      const end = document.createElement('button');
      end.type = 'button';
      end.className = 'btn btn-small btn-danger';
      end.textContent = 'Sign out';
      // Starts with the visible label (WCAG 2.5.3), then says which one.
      end.setAttribute('aria-label', `Sign out ${device}, signed in ${timeAgo(session.created_at)}`);
      let ending = false;
      end.addEventListener('click', async () => {
        if (ending) return;
        ending = true;
        const index = [...list.querySelectorAll('button')].indexOf(end);
        clear();
        try {
          await accountApi(`/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
          setStatus(status, `Signed out ${device}.`);
          await load(index);
        } catch (err) {
          ending = false;
          fail(err);
        }
      });
      li.appendChild(end);
    }
    return li;
  };

  // `focusIndex`: after a row is removed, focus goes to the button that
  // took its place (or the one before it), not to <body>.
  async function load(focusIndex = null) {
    let sessions;
    try {
      sessions = await accountApi('/auth/sessions');
    } catch (err) {
      fail(err);
      return;
    }
    sessions.sort((a, b) => Number(b.current) - Number(a.current));
    list.textContent = '';
    for (const session of sessions) list.appendChild(item(session));
    revokeOthers.hidden = !sessions.some((s) => !s.current);
    if (focusIndex !== null) {
      const buttons = list.querySelectorAll('button');
      const target = buttons[Math.min(focusIndex, buttons.length - 1)];
      (target || (revokeOthers.hidden ? heading : revokeOthers)).focus();
    }
  }

  let revoking = false;
  revokeOthers.addEventListener('click', async () => {
    if (revoking) return;
    revoking = true;
    clear();
    try {
      const { ended } = await accountApi('/auth/sessions/revoke-others', { method: 'POST' });
      setStatus(status, `Signed out ${ended} other browser${ended === 1 ? '' : 's'}.`);
      await load();
      // The button has just gone; the heading is the nearest place to land.
      heading.focus();
    } catch (err) {
      fail(err);
    } finally {
      revoking = false;
    }
  });

  load();
  return { reload: () => load() };
}

// ---------- your data ----------

// GDPR Art. 15/20: one JSON file, saved through a temporary link — the same
// way a single tree is exported on the tree page.
function setupDataSection() {
  const button = document.getElementById('data-download');
  const errorBox = document.getElementById('data-error');
  const status = document.getElementById('data-status');

  let busy = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    clearFieldError(errorBox);
    setStatus(status, '');
    try {
      const res = await fetch(API + '/auth/export');
      const blob = await accountResult(res, () => res.blob());
      const match = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const filename = match ? match[1] : 'skilltrees-data.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(status, `Downloaded ${filename}.`);
    } catch (err) {
      showNotice(errorBox, err.message);
    } finally {
      busy = false;
    }
  });
}

// ---------- deleting the account ----------

// GDPR Art. 17. The account and every tree it made go, for everyone, so the
// section says how many trees that is and points at the export first. The
// confirmation is a native <dialog> (setupModalDialog() in a11y.js): type
// the username, and the password when there is one.
function setupDangerSection(user) {
  const summary = document.getElementById('delete-summary');
  const openButton = document.getElementById('delete-open');
  const dialog = document.getElementById('delete-dialog');
  const help = document.getElementById('delete-help');
  const form = document.getElementById('delete-form');
  const confirmInput = document.getElementById('delete-confirm-username');
  const passwordField = document.getElementById('delete-password-field');
  const password = document.getElementById('delete-password');
  const errorBox = document.getElementById('delete-error');
  const cancel = document.getElementById('delete-cancel');
  const reauth = document.getElementById('delete-reauth');
  const submit = document.getElementById('delete-submit');
  const modal = setupModalDialog(dialog);
  document.getElementById('delete-username').textContent = user.username;

  let treeCount = null;
  const trees = (n) => `${n} tree${n === 1 ? '' : 's'}`;
  const describe = () => {
    if (treeCount === null) return;
    summary.textContent = treeCount
      ? `Deleting your account also deletes the ${trees(treeCount)} it made, for everyone, straight away. It can’t be undone.`
      : 'Deleting your account removes it for good, straight away. It hasn’t made any trees. It can’t be undone.';
    help.textContent = treeCount
      ? `This deletes ${user.username} and its ${trees(treeCount)}, for everyone, straight away. It can’t be undone.`
      : `This deletes ${user.username}, straight away. It can’t be undone.`;
    submit.textContent = treeCount ? 'Delete account and trees' : 'Delete account';
  };
  const countTrees = async () => {
    try {
      treeCount = (await accountApi('/auth/account')).tree_count;
    } catch (e) {
      /* the general wording stays */
    }
    describe();
  };

  // The dialog sends focus back to this button when it closes, so it must
  // still have it when the dialog opens (see the note on flags above).
  let opening = false;
  openButton.addEventListener('click', async () => {
    if (opening) return;
    opening = true;
    // A fresh count, since trees may have been made in another tab.
    await countTrees();
    opening = false;
    clearFieldError(errorBox, [confirmInput, password]);
    reauth.hidden = true;
    confirmInput.value = password.value = '';
    passwordField.hidden = !user.has_password;
    password.disabled = !user.has_password;
    modal.open();
    confirmInput.focus();
  });
  cancel.addEventListener('click', () => modal.close());
  reauth.addEventListener('click', () => signInAgain(ACCOUNT_RETURN.danger));

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    clearFieldError(errorBox, [confirmInput, password]);
    reauth.hidden = true;

    // Checked here too, so a slip costs no request; the server compares the
    // same way (case doesn't matter in a username).
    const typed = confirmInput.value.trim();
    if (typed.toLowerCase() !== user.username.toLowerCase()) {
      showFieldError(errorBox, `Type your username, ${user.username}, to confirm.`, [confirmInput]);
      confirmInput.focus();
      return;
    }

    busy = true;
    try {
      const body = { confirm_username: typed };
      if (user.has_password) body.password = password.value;
      await accountApi('/auth/account', { method: 'DELETE', body });
      // The session is gone and the cookie cleared; nothing here is theirs now.
      window.location.href = '/';
    } catch (err) {
      busy = false;
      if (err.status === 403) {
        showFieldError(errorBox, err.message);
        reauth.hidden = false;
        reauth.focus();
      } else if (err.status === 401 && user.has_password) {
        showFieldError(errorBox, err.message, [password]);
        password.focus();
        password.select();
      } else {
        showFieldError(errorBox, err.message);
      }
    }
  });

  countTrees();
}

// ---------- arriving at a section ----------

// /account.html#account-password — where "Sign in again" returns and where
// a password manager's "change password" lands — only scrolls if the
// section is on screen when the page loads, and these are shown later, once
// the page knows who is signed in. So: scroll there now, and move focus in,
// to the first field of the password form or to the section's heading.
function revealAccountSection() {
  let id = '';
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch (e) {
    return;
  }
  const section = id ? document.getElementById(id) : null;
  if (!section || !section.classList.contains('account-section') || section.closest('[hidden]')) return;
  section.scrollIntoView({ block: 'start' });
  const field = id === 'account-password' ? section.querySelector('input:not([disabled]):not([hidden])') : null;
  const heading = section.querySelector('h2');
  (field || heading).focus({ preventScroll: true });
}

function setupAccountSettings(user, providers) {
  const sessions = setupSessionsSection();
  setupPasswordSection(user, () => {
    // "Password: Set" in the sign-in methods, and the other browsers gone.
    renderSignInMethods(user, providers);
    sessions.reload();
  });
  setupDataSection();
  setupDangerSection(user);
  revealAccountSection();
  window.addEventListener('hashchange', revealAccountSection);
}
