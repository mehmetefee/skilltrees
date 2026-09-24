// Passkeys on account.html: signing in and signing up with one, and the
// "Passkeys" section of "Your account". W3C Web Authentication Level 3 in
// the browser; the server half is the passkeys section of server.js.
//
// Loaded before app.js, and driven by the events app.js sends as it decides
// what the page shows:
//   account:mode        the sign-in form switched between "login" and "signup"
//   account:signed-out  the sign-in view is up
//   account:signed-in   the account view is up ({ user })
//   account:methods-changed   a way in was added or removed (either section
//                       sends it; both redraw from the server)
// and one call back the other way: SkillTreePasskeys.afterPasswordSignIn(),
// which app.js awaits after a password sign-in, before it navigates away.
// Helpers from app.js (showNotice, showToast, timeAgo, sameSitePath) are
// only called from handlers, by which time app.js has run.
//
// Everything user-facing is written with textContent; nothing a server or an
// authenticator says is ever parsed as markup.

(function () {
  'use strict';

  const API = '/api/auth/passkeys';
  // What the page offers: a browser without WebAuthn (or a page not in a
  // secure context, where PublicKeyCredential doesn't exist) gets nothing.
  const supported =
    typeof window.PublicKeyCredential === 'function' &&
    !!navigator.credentials &&
    typeof navigator.credentials.create === 'function';

  // The server's challenges live five minutes; the autofill request is
  // renewed a little before that, so a page left open still works.
  const CONDITIONAL_REFRESH_MS = 4 * 60 * 1000;
  // An automatic upgrade either happens at once or not at all; this only
  // stops a browser that never answers from holding up the sign-in.
  const UPGRADE_TIMEOUT_MS = 5000;
  const USERNAME = /^[a-zA-Z0-9_-]{3,40}$/;

  // ---------- encoding ----------
  //
  // Level 3 browsers turn the server's JSON into options, and credentials
  // back into JSON, themselves (parseCreationOptionsFromJSON,
  // parseRequestOptionsFromJSON, toJSON). For the rest, the same by hand:
  // the binary members are base64url (RFC 4648 §5, unpadded) in the JSON.

  function b64urlToBytes(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bytesToB64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const withIds = (list) => (list || []).map((c) => ({ ...c, id: b64urlToBytes(c.id) }));

  function creationOptionsFromJSON(json) {
    if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') {
      return PublicKeyCredential.parseCreationOptionsFromJSON(json);
    }
    return {
      ...json,
      challenge: b64urlToBytes(json.challenge),
      user: { ...json.user, id: b64urlToBytes(json.user.id) },
      excludeCredentials: withIds(json.excludeCredentials),
    };
  }

  function requestOptionsFromJSON(json) {
    if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function') {
      return PublicKeyCredential.parseRequestOptionsFromJSON(json);
    }
    return { ...json, challenge: b64urlToBytes(json.challenge), allowCredentials: withIds(json.allowCredentials) };
  }

  function credentialToJSON(credential) {
    if (typeof credential.toJSON === 'function') {
      try {
        return credential.toJSON();
      } catch (e) {
        /* some early implementations throw on extension results; do it by hand */
      }
    }
    const r = credential.response;
    const response = { clientDataJSON: bytesToB64url(r.clientDataJSON) };
    if ('attestationObject' in r) {
      response.attestationObject = bytesToB64url(r.attestationObject);
      response.transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
    } else {
      response.authenticatorData = bytesToB64url(r.authenticatorData);
      response.signature = bytesToB64url(r.signature);
      if (r.userHandle) response.userHandle = bytesToB64url(r.userHandle);
    }
    return {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      response,
      authenticatorAttachment: credential.authenticatorAttachment || null,
      clientExtensionResults:
        typeof credential.getClientExtensionResults === 'function' ? credential.getClientExtensionResults() : {},
    };
  }

  // ---------- the server ----------

  // Like apiFetch in app.js, but the error keeps the status and the body:
  // a refused sign-in says unknown_credential when the passkey isn't known.
  async function call(path, { method = 'POST', body } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(API + path, init);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* no body */
    }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.detail)) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  let configPromise = null;
  function loadConfig() {
    if (!configPromise) {
      configPromise = call('/config', { method: 'GET' }).catch(() => ({ enabled: false }));
    }
    return configPromise;
  }

  // What this browser can do (Level 3 getClientCapabilities), with the older
  // isConditionalMediationAvailable() standing in for autofill where the new
  // call is missing or doesn't say.
  let capsPromise = null;
  function capabilities() {
    if (!capsPromise) {
      capsPromise = (async () => {
        if (!supported) return {};
        let caps = {};
        try {
          if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
            caps = { ...(await PublicKeyCredential.getClientCapabilities()) };
          }
        } catch (e) {
          caps = {};
        }
        if (typeof caps.conditionalGet !== 'boolean') {
          try {
            caps.conditionalGet =
              typeof PublicKeyCredential.isConditionalMediationAvailable === 'function' &&
              (await PublicKeyCredential.isConditionalMediationAvailable()) === true;
          } catch (e) {
            caps.conditionalGet = false;
          }
        }
        return caps;
      })();
    }
    return capsPromise;
  }

  // The Signal API (Level 3): tells the password manager what the server
  // knows, so it stops offering passkeys that no longer work here. Best
  // effort by design — missing in most browsers, and a refusal changes
  // nothing for the person — so it is never awaited and never reported.
  function signal(method, details) {
    try {
      if (!supported || typeof PublicKeyCredential[method] !== 'function') return;
      Promise.resolve(PublicKeyCredential[method](details)).catch(() => {});
    } catch (e) {
      /* not available here */
    }
  }

  function timeoutSignal(ms) {
    if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }

  // What a failed ceremony means, in words. The browser's own messages are
  // written for developers, so the common DOMExceptions get sentences of
  // their own; anything from the server is already a sentence.
  function describeError(err, ceremony) {
    switch (err && err.name) {
      case 'AbortError':
        return null; // we stopped it ourselves
      case 'NotAllowedError':
        return ceremony === 'create'
          ? 'No passkey was made: the request was cancelled or timed out.'
          : 'Signing in with a passkey was cancelled or timed out.';
      case 'InvalidStateError':
        return 'This device or password manager already has a passkey for your account. Use that one, or pick somewhere else to save a new one.';
      case 'NotSupportedError':
        return "This device can't make a passkey of a kind this site accepts.";
      case 'SecurityError':
        return "Passkeys only work at this site's own address. Open it there and try again.";
      case 'ConstraintError':
        return "This device can't check it's you (with a screen lock, fingerprint or face), which a passkey here needs.";
      default:
        return (err && err.message) || 'Something went wrong with the passkey. Please try again.';
    }
  }

  function goNext() {
    const next = new URLSearchParams(location.search).get('next') || '';
    window.location.href = sameSitePath(next);
  }

  // ---------- signed out: sign in, or sign up ----------

  const form = document.getElementById('auth-form');
  const usernameInput = document.getElementById('auth-username');
  const authError = document.getElementById('auth-error');
  const signInBlock = document.getElementById('passkey-sign-in');
  const signInButton = document.getElementById('passkey-sign-in-button');
  const signUpBlock = document.getElementById('passkey-sign-up');
  const signUpButton = document.getElementById('passkey-sign-up-button');
  const oauthList = document.getElementById('oauth-providers');
  const oauthDivider = document.getElementById('oauth-divider');

  let mode = 'login';
  let offered = false; // the sign-in view is up, and passkeys are on here
  let busy = false; // a ceremony the person started is under way

  // Autofill (conditional mediation): a get() with mediation "conditional"
  // left pending while the page is up, which the browser answers when
  // someone picks a passkey from the username field's suggestions. It has to
  // be stopped before any other ceremony starts — a browser runs one at a
  // time — and renewed before its challenge expires.
  const conditional = { controller: null, done: null, timer: null, failures: 0 };

  async function startConditional() {
    if (!offered || mode !== 'login' || busy || conditional.controller) return;
    const caps = await capabilities();
    if (!caps.conditionalGet || !offered || mode !== 'login' || busy || conditional.controller) return;

    const controller = new AbortController();
    conditional.controller = controller;
    conditional.done = (async () => {
      let options;
      try {
        options = await call('/login/options', { body: {} });
      } catch (e) {
        return; // no autofill this time; the button still works
      }
      try {
        if (controller.signal.aborted) return;
        const credential = await navigator.credentials.get({
          mediation: 'conditional',
          publicKey: requestOptionsFromJSON(options),
          signal: controller.signal,
        });
        if (!credential || controller.signal.aborted) return;
        busy = true;
        await finishSignIn(credential, options.rpId);
      } catch (err) {
        if (controller.signal.aborted || (err && err.name === 'AbortError')) return;
        busy = false;
        // Nobody clicked anything to start this, so the browser giving up
        // (NotAllowedError: a prompt dismissed, or nothing to offer) is not
        // worth a message. What the server refused is: someone did pick a
        // passkey, and it didn't work.
        if (!(err && err.name === 'NotAllowedError')) {
          const message = describeError(err, 'get');
          if (message) showNotice(authError, message);
        }
        // Offer autofill again, on a fresh challenge — but not forever if
        // something keeps failing the same way.
        if (++conditional.failures < 3) setTimeout(startConditional, 0);
      } finally {
        if (conditional.controller === controller) {
          conditional.controller = null;
          clearTimeout(conditional.timer);
        }
      }
    })();

    clearTimeout(conditional.timer);
    conditional.timer = setTimeout(async () => {
      if (conditional.controller !== controller) return;
      await stopConditional();
      startConditional();
    }, CONDITIONAL_REFRESH_MS);
  }

  // Aborts the pending autofill request and waits for it to settle (its
  // promise never rejects), so the next ceremony starts on a clean slate.
  async function stopConditional() {
    clearTimeout(conditional.timer);
    const { controller, done } = conditional;
    if (!controller) return;
    conditional.controller = null;
    controller.abort();
    await done;
  }

  async function finishSignIn(credential, rpId) {
    const body = credentialToJSON(credential);
    try {
      await call('/login/verify', { body });
    } catch (err) {
      // The server doesn't know this passkey (removed, or its account
      // deleted): tell the password manager to stop offering it.
      if (err.data && err.data.unknown_credential === true) {
        signal('signalUnknownCredential', { rpId, credentialId: body.id });
      }
      throw err;
    }
    goNext();
  }

  // The divider under the provider buttons also separates the passkey
  // button from the form, so it shows when either is there.
  function syncDivider() {
    oauthDivider.hidden = oauthList.hidden && signInBlock.hidden;
  }

  function applyMode() {
    if (!offered) return;
    const login = mode === 'login';
    signInBlock.hidden = !login;
    signUpBlock.hidden = login;
    // Passkeys in the autofill of a form that is making a new account would
    // be an offer to sign in to an existing one instead.
    usernameInput.autocomplete = login ? 'username webauthn' : 'username';
    syncDivider();
    if (login) startConditional();
    else stopConditional();
  }

  document.addEventListener('account:mode', (e) => {
    mode = e.detail && e.detail.mode === 'signup' ? 'signup' : 'login';
    applyMode();
  });

  document.addEventListener('account:signed-out', async () => {
    const cfg = await loadConfig();
    if (!cfg.enabled || !supported) return;
    offered = true;
    applyMode();
  });

  // The password form is the other way in; the autofill request must not be
  // pending when it signs someone in (an automatic upgrade follows it).
  form.addEventListener('submit', () => {
    stopConditional();
  });

  signInButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    signInButton.disabled = true;
    authError.hidden = true;
    await stopConditional();
    try {
      const options = await call('/login/options', { body: {} });
      const credential = await navigator.credentials.get({ publicKey: requestOptionsFromJSON(options) });
      await finishSignIn(credential, options.rpId);
    } catch (err) {
      const message = describeError(err, 'get');
      if (message) showNotice(authError, message);
      busy = false;
      signInButton.disabled = false;
      conditional.failures = 0;
      startConditional();
    }
  });

  signUpButton.addEventListener('click', async () => {
    if (busy) return;
    authError.hidden = true;
    const username = usernameInput.value.trim();
    if (!USERNAME.test(username)) {
      showNotice(authError, 'Pick a username first: 3-40 letters, numbers, dashes or underscores.');
      usernameInput.focus();
      return;
    }
    busy = true;
    signUpButton.disabled = true;
    await stopConditional();
    try {
      const options = await call('/signup/options', { body: { username } });
      const credential = await navigator.credentials.create({ publicKey: creationOptionsFromJSON(options) });
      await call('/signup/verify', { body: credentialToJSON(credential) });
      goNext();
    } catch (err) {
      const message = describeError(err, 'create');
      if (message) showNotice(authError, message);
      busy = false;
      signUpButton.disabled = false;
    }
  });

  // Automatic passkey upgrade (conditional create): straight after a
  // password sign-in, a browser that supports it may save a passkey in the
  // password manager that just filled the password, with no dialog — or
  // decline, which it does at once. Silent either way: this is an offer the
  // browser makes, not something the person asked for.
  async function afterPasswordSignIn() {
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !supported) return;
      const caps = await capabilities();
      if (caps.conditionalCreate !== true) return;
      await stopConditional();
      const options = await call('/register/options', { body: { mediation: 'conditional' } });
      const credential = await navigator.credentials.create({
        mediation: 'conditional',
        publicKey: creationOptionsFromJSON(options),
        signal: timeoutSignal(UPGRADE_TIMEOUT_MS),
      });
      if (credential) await call('/register/verify', { body: credentialToJSON(credential) });
    } catch (e) {
      /* no upgrade this time */
    }
  }

  // ---------- signed in: the Passkeys section ----------

  const section = document.getElementById('account-passkeys');
  const list = document.getElementById('passkey-list');
  const emptyNote = document.getElementById('passkey-empty');
  const sectionError = document.getElementById('passkey-error');
  const addButton = document.getElementById('passkey-add');
  const reauthButton = document.getElementById('passkey-reauth');
  let account = null;

  const button = (label, className) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    return b;
  };

  // Runs a button's action, showing any failure in the section's error box.
  // A flag, not `disabled`, stops a second click while it runs: a disabled
  // button drops keyboard focus to the page body just as the result is
  // announced (the account settings do the same). A 403 means the server
  // wants a recent sign-in first, so it comes with "Sign in again".
  const act = (b, action) => {
    let running = false;
    b.addEventListener('click', async () => {
      if (running) return;
      running = true;
      sectionError.hidden = true;
      reauthButton.hidden = true;
      try {
        await action();
      } catch (err) {
        const message = describeError(err, 'create');
        if (message) showNotice(sectionError, message);
        if (err.status === 403) {
          reauthButton.hidden = false;
          reauthButton.focus();
        }
      } finally {
        running = false;
      }
    });
  };

  function describePasskey(passkey) {
    const parts = [`added ${timeAgo(passkey.created_at)}`];
    parts.push(passkey.last_used_at ? `last used ${timeAgo(passkey.last_used_at)}` : 'not used to sign in yet');
    // BE and BS (§6.1.3): whether it is kept in sync across devices.
    parts.push(passkey.backed_up ? 'synced' : passkey.backup_eligible ? 'not synced yet' : 'on one device only');
    if (!passkey.enabled) parts.push("made for another address of this site, so it can't sign in here");
    return parts.join(' · ');
  }

  function passkeyRow(passkey, onlyWayIn) {
    const li = document.createElement('li');
    li.className = 'sign-in-method passkey-item';
    li.dataset.passkeyId = String(passkey.id);

    const text = document.createElement('div');
    text.className = 'sign-in-method-text';
    const name = document.createElement('span');
    name.className = 'sign-in-method-name';
    name.textContent = passkey.name;
    const detail = document.createElement('span');
    detail.className = 'sign-in-method-detail';
    detail.textContent = describePasskey(passkey);
    text.append(name, detail);

    const actions = document.createElement('div');
    actions.className = 'passkey-row-actions';
    const rename = button('Rename', 'btn btn-small');
    rename.dataset.action = 'rename';
    rename.setAttribute('aria-label', `Rename ${passkey.name}`);
    const remove = button('Remove', 'btn btn-small btn-danger');
    remove.dataset.action = 'remove';
    remove.setAttribute('aria-label', `Remove ${passkey.name}`);
    if (onlyWayIn) {
      remove.disabled = true;
      remove.title = 'This is your only way to sign in. Add another first.';
    }
    actions.append(rename, remove);
    li.append(text, actions);

    rename.addEventListener('click', () => startRename(li, passkey));

    // Two steps, without a dialog: Remove turns into "Confirm remove",
    // with Cancel beside it.
    remove.addEventListener('click', () => {
      sectionError.hidden = true;
      const confirm = button('Confirm remove', 'btn btn-small btn-danger');
      confirm.setAttribute('aria-label', `Confirm removing ${passkey.name}`);
      const cancel = button('Cancel', 'btn btn-small');
      actions.replaceChildren(confirm, cancel);
      confirm.focus();
      cancel.addEventListener('click', () => {
        actions.replaceChildren(rename, remove);
        remove.focus();
      });
      act(confirm, async () => {
        await call(`/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
        showToast(`Removed the passkey "${passkey.name}".`);
        pendingFocus = 'add';
        document.dispatchEvent(new CustomEvent('account:methods-changed'));
      });
    });
    return li;
  }

  function startRename(li, passkey) {
    sectionError.hidden = true;
    const renameForm = document.createElement('form');
    renameForm.className = 'passkey-rename';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.required = true;
    input.value = passkey.name;
    input.setAttribute('aria-label', 'Passkey name');
    const save = button('Save', 'btn btn-small');
    save.type = 'submit';
    const cancel = button('Cancel', 'btn btn-small');
    renameForm.append(input, save, cancel);

    const original = [...li.childNodes];
    li.replaceChildren(renameForm);
    input.focus();
    input.select();

    const restore = () => {
      li.replaceChildren(...original);
      li.querySelector('[data-action="rename"]').focus();
    };
    cancel.addEventListener('click', restore);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        restore();
      }
    });
    renameForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        const updated = await call(`/${encodeURIComponent(passkey.id)}`, { method: 'PATCH', body: { name: input.value } });
        showToast(`Renamed to "${updated.name}".`);
        pendingFocus = `rename-${passkey.id}`;
        renderPasskeys();
      } catch (err) {
        showNotice(sectionError, describeError(err, 'rename'));
        save.disabled = false;
      }
    });
  }

  // Where focus goes after the list is redrawn, so it isn't dropped on the
  // page body when the row that had it is replaced.
  let pendingFocus = null;

  async function renderPasskeys() {
    let data;
    try {
      data = await call('', { method: 'GET' });
    } catch (err) {
      showNotice(sectionError, err.message);
      return;
    }
    const onlyWayIn = data.sign_in_methods <= 1;
    list.replaceChildren(...data.passkeys.map((p) => passkeyRow(p, p.enabled && onlyWayIn)));
    list.hidden = data.passkeys.length === 0;
    emptyNote.hidden = data.passkeys.length > 0;

    if (pendingFocus) {
      const [kind, id] = pendingFocus.split('-');
      const target =
        kind === 'rename' ? list.querySelector(`[data-passkey-id="${id}"] [data-action="rename"]`) : addButton;
      (target || addButton).focus();
      pendingFocus = null;
    }

    // Keep the password manager in step: exactly these credentials are
    // valid for this account (any others it holds for it get hidden), and
    // this is the account's name. Only passkeys usable here, and only once
    // the account has a user handle — which every passkey carries.
    if (data.user_handle && account) {
      signal('signalAllAcceptedCredentials', {
        rpId: data.rp_id,
        userId: data.user_handle,
        allAcceptedCredentialIds: data.passkeys.filter((p) => p.enabled).map((p) => p.credential_id),
      });
      signal('signalCurrentUserDetails', {
        rpId: data.rp_id,
        userId: data.user_handle,
        name: account.username,
        displayName: account.username,
      });
    }
  }

  act(addButton, async () => {
    const options = await call('/register/options', { body: {} });
    const credential = await navigator.credentials.create({ publicKey: creationOptionsFromJSON(options) });
    const added = await call('/register/verify', { body: credentialToJSON(credential) });
    showToast(`Added a passkey: ${added.name}. You can rename it below.`);
    pendingFocus = `rename-${added.id}`;
    document.dispatchEvent(new CustomEvent('account:methods-changed'));
  });

  // Signs out and comes back here, with the fresh sign-in adding a passkey
  // needs. signInAgain() is the account settings' (account-settings.js).
  reauthButton.addEventListener('click', () => {
    if (typeof signInAgain === 'function') signInAgain('/account.html#account-passkeys');
  });

  document.addEventListener('account:signed-in', async (e) => {
    account = e.detail && e.detail.user;
    const cfg = await loadConfig();
    if (!cfg.enabled) return;
    section.hidden = false;
    if (!supported) {
      addButton.disabled = true;
      showNotice(sectionError, "This browser can't create passkeys. You can still rename or remove the ones you have.");
    }
    renderPasskeys();
    // /account.html#account-passkeys, where a password manager's "manage
    // passkeys" link lands: the section was still hidden when the page
    // looked for it, so it is brought into view now.
    if (location.hash === '#account-passkeys' && typeof revealAccountSection === 'function') {
      revealAccountSection();
    }
  });

  document.addEventListener('account:methods-changed', () => {
    if (!section.hidden) renderPasskeys();
  });

  window.SkillTreePasskeys = { afterPasswordSignIn };
})();
