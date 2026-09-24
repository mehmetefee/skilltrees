// Passkeys in a real browser: Chromium with a virtual authenticator attached
// over the DevTools protocol (WebAuthn.addVirtualAuthenticator — a CTAP2
// platform authenticator that holds discoverable credentials and verifies
// the user without a prompt). Like oauth-browser.test.js it starts its own
// server on a throwaway database, so it needs no running server:
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/passkeys-browser.test.js
//
// WebAuthn needs the page's origin to be the RP's, so the server's
// PUBLIC_ORIGIN is http://localhost:<port> (localhost is a secure context
// over plain http) and the port is chosen before the server starts. What
// only a browser can show: the options JSON parsed and the credential
// serialised by the browser itself, autofill's pending request being
// aborted cleanly when a button or the password form is used, the CSP and
// Permissions-Policy letting all of it through, and no console errors.

const { chromium } = require('playwright');
const crypto = require('node:crypto');
const net = require('node:net');
const { startServer } = require('./helpers/server');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const AUTHENTICATOR = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

(async () => {
  const port = Number(process.env.PORT) || (await freePort());
  const srv = await startServer({ env: { PORT: String(port), PUBLIC_ORIGIN: `http://localhost:${port}` } });
  const BASE = srv.base;

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );

  const results = [];
  const check = (label, cond) => {
    results.push({ label, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  };

  // A fresh browser profile with a virtual authenticator, watching for
  // console errors and CSP violations. Setting `allow` to a pattern lets a
  // step cause console errors on purpose (a refused sign-in logs its 401)
  // without their being mistaken for real ones; `allowed` counts them.
  async function openBrowser({ initScript } = {}) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`);
      });
      // A switch for one step: with it set, this page load reports no
      // autofill support, so the virtual authenticator (which answers a
      // pending conditional request at once) can't sign in before a click.
      if (localStorage.getItem('test:no-autofill') === '1' && window.PublicKeyCredential) {
        PublicKeyCredential.isConditionalMediationAvailable = async () => false;
        const caps = PublicKeyCredential.getClientCapabilities;
        if (caps) {
          PublicKeyCredential.getClientCapabilities = async () => ({ ...(await caps.call(PublicKeyCredential)), conditionalGet: false });
        }
      }
    });
    if (initScript) await context.addInitScript(initScript);
    const page = await context.newPage();
    const problems = [];
    const state = { allow: null, allowed: 0 };
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = `${m.text()} @ ${m.location().url || ''}`;
      if (state.allow && state.allow.test(text)) state.allowed++;
      else problems.push(`${page.url()} :: ${text}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror ${page.url()} :: ${e.message}`));
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      d.dismiss();
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const addAuthenticator = async () =>
      (await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR })).authenticatorId;
    const authenticatorId = await addAuthenticator();
    return {
      context,
      page,
      cdp,
      problems,
      dialogs: () => dialogs,
      authenticatorId,
      addAuthenticator,
      get allowed() {
        return state.allowed;
      },
      set allow(re) {
        state.allow = re;
      },
    };
  }

  const credentialsOn = async (cdp, authenticatorId) =>
    (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;

  try {
    const b = await openBrowser();
    const { page, cdp } = b;

    // --- signed out: the passkey button, and autofill asking for options
    const onLoadOptions = page.waitForRequest((r) => r.url().endsWith('/api/auth/passkeys/login/options'), { timeout: 5000 }).catch(() => null);
    await page.goto(`${BASE}/account.html`);
    const signInButton = page.locator('#passkey-sign-in-button');
    await signInButton.waitFor({ state: 'visible', timeout: 5000 });
    check('the sign-in view offers "Sign in with a passkey"', (await signInButton.textContent()) === 'Sign in with a passkey');
    check('the username field offers passkeys in autofill', (await page.getAttribute('#auth-username', 'autocomplete')) === 'username webauthn');
    check('autofill asked for sign-in options as the page loaded', !!(await onLoadOptions));
    check('the "or" divider separates the passkey button from the form', await page.locator('#oauth-divider').isVisible());
    check('the sign-up passkey option is hidden while signing in', !(await page.locator('#passkey-sign-up').isVisible()));

    // --- sign up with a passkey
    await page.click('#auth-toggle');
    check('creating an account shows "Create account with a passkey"', await page.locator('#passkey-sign-up-button').isVisible());
    check('and hides the sign-in passkey button', !(await signInButton.isVisible()));
    check('and takes passkeys out of the username autofill', (await page.getAttribute('#auth-username', 'autocomplete')) === 'username');
    await page.click('#passkey-sign-up-button');
    await page.waitForSelector('#auth-error:not([hidden])');
    check('no username yet: asks for one first', (await page.textContent('#auth-error')).includes('Pick a username first'));

    await page.fill('#auth-username', 'grace');
    await page.click('#passkey-sign-up-button');
    await page.waitForURL(`${BASE}/#browse`, { timeout: 10000 });
    const chip = page.locator('.auth-slot .auth-name').first();
    await chip.waitFor({ timeout: 5000 });
    check('signed up and signed in as grace', (await chip.textContent()) === 'grace');
    const stored = await credentialsOn(cdp, b.authenticatorId);
    check('the authenticator holds one discoverable credential', stored.length === 1 && stored[0].isResidentCredential);
    check('with a 64-byte user handle, not the account id', Buffer.from(stored[0].userHandle, 'base64').length === 64);

    // --- the account panel
    await page.goto(`${BASE}/account.html`);
    await page.waitForSelector('#account-passkeys:not([hidden])');
    const rows = page.locator('#passkey-list .passkey-item');
    await rows.first().waitFor();
    check('the Passkeys section lists the passkey', (await rows.count()) === 1);
    check('its details say it was just added', (await rows.first().textContent()).includes('added just now'));
    check(
      'its Remove is disabled: it is the only way in',
      await rows.first().locator('[data-action="remove"]').isDisabled()
    );
    const methods = page.locator('#sign-in-methods-list');
    await methods.locator('.sign-in-method', { hasText: 'Passkeys' }).waitFor();
    check('Sign-in methods counts the passkey', (await methods.textContent()).includes('1 passkey'));
    check('and says there is no password', (await methods.textContent()).includes('Not set — you sign in with a passkey'));

    // --- adding one the authenticator already holds for this account
    await page.click('#passkey-add');
    await page.waitForSelector('#passkey-error:not([hidden])', { timeout: 10000 });
    check(
      'a second passkey on the same authenticator is explained, not an error dump',
      (await page.textContent('#passkey-error')).includes('already has a passkey for your account')
    );

    // --- another authenticator: add, rename, remove. The first one's
    // credential is kept aside, to sign in with later.
    const [graceKey] = await credentialsOn(cdp, b.authenticatorId);
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: b.authenticatorId });
    const second = await b.addAuthenticator();
    await page.click('#passkey-add');
    await page.waitForSelector('#toast.show');
    check('adding a passkey is confirmed', (await page.textContent('#toast')).startsWith('Added a passkey'));
    await page.waitForFunction(() => document.querySelectorAll('#passkey-list .passkey-item').length === 2);
    check('both passkeys are listed', (await rows.count()) === 2);
    check(
      'with two, either can be removed',
      (await rows.nth(0).locator('[data-action="remove"]').isEnabled()) &&
        (await rows.nth(1).locator('[data-action="remove"]').isEnabled())
    );
    check('Sign-in methods now says 2 passkeys', (await methods.textContent()).includes('2 passkeys'));
    check('focus went to the new passkey’s Rename', await page.evaluate(() => document.activeElement?.dataset.action === 'rename'));

    await rows.nth(0).locator('[data-action="rename"]').click();
    const nameField = page.locator('.passkey-rename input');
    check('Rename turns the name into a field, focused', await nameField.evaluate((el) => el === document.activeElement));
    await nameField.fill('Work laptop');
    await nameField.press('Enter');
    await page.waitForFunction(() => document.querySelector('#passkey-list .passkey-item .sign-in-method-name')?.textContent === 'Work laptop');
    check('the passkey is renamed', (await rows.nth(0).locator('.sign-in-method-name').textContent()) === 'Work laptop');

    await rows.nth(1).locator('[data-action="rename"]').click();
    await page.locator('.passkey-rename input').press('Escape');
    check('Escape cancels a rename', (await page.locator('.passkey-rename').count()) === 0);

    await rows.nth(1).locator('[data-action="remove"]').click();
    const confirm = rows.nth(1).locator('button', { hasText: 'Confirm remove' });
    check('Remove asks for confirmation in place, without a dialog', await confirm.isVisible());
    await confirm.click();
    await page.waitForFunction(() => document.querySelectorAll('#passkey-list .passkey-item').length === 1);
    check('the passkey is removed', (await rows.count()) === 1);
    check('the last one cannot be removed again', await rows.first().locator('[data-action="remove"]').isDisabled());

    // --- the Signal API after a removal: the page tells the password manager
    // which credentials are still good (signalAllAcceptedCredentials), and
    // Chromium's authenticator drops the one that was removed.
    let left = [];
    for (let i = 0; i < 30; i++) {
      left = await credentialsOn(cdp, second);
      if (left.length === 0) break;
      await page.waitForTimeout(100);
    }
    check('the removed passkey is gone from the authenticator too (signalAllAcceptedCredentials)', left.length === 0);
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: second });

    // --- autofill offering a passkey this site doesn't know. The virtual
    // authenticator answers a pending conditional request at once, as if the
    // passkey had been picked from the list: refused with a message, and the
    // password manager told to forget it (signalUnknownCredential).
    const stray = await b.addAuthenticator();
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId: stray,
      credential: {
        credentialId: crypto.randomBytes(16).toString('base64'),
        isResidentCredential: true,
        rpId: 'localhost',
        privateKey: crypto
          .generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .privateKey.export({ format: 'der', type: 'pkcs8' })
          .toString('base64'),
        // Another handle than grace's, so the Signal API call the account
        // page makes for grace's passkeys leaves this one alone.
        userHandle: crypto.randomBytes(64).toString('base64'),
        signCount: 0,
      },
    });
    b.allow = /status of 401/;
    await page.click('#account-sign-out');
    await page.waitForSelector('#auth-error:not([hidden])', { timeout: 10000 });
    const refusal = await page.textContent('#auth-error');
    check(`an unknown passkey is refused with a clear message ("${refusal}")`, refusal.includes('not registered here'));
    check('and nobody got signed in', (await page.textContent('#auth-heading')) === 'Sign in');
    for (let i = 0; i < 30; i++) {
      left = await credentialsOn(cdp, stray);
      if (left.length === 0) break;
      await page.waitForTimeout(100);
    }
    check('and the authenticator was told to forget it (signalUnknownCredential)', left.length === 0);
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: stray });
    b.allow = null;

    // --- the button, with autofill switched off for this page load so the
    // authenticator can't answer before the click.
    await page.evaluate(() => localStorage.setItem('test:no-autofill', '1'));
    await page.reload();
    await signInButton.waitFor({ state: 'visible' });
    await page.waitForLoadState('networkidle');
    const third = await b.addAuthenticator();
    await cdp.send('WebAuthn.addCredential', { authenticatorId: third, credential: graceKey });
    await Promise.all([page.waitForURL(`${BASE}/#browse`, { timeout: 10000 }), signInButton.click()]);
    await chip.waitFor({ timeout: 5000 });
    check('signed back in with the passkey button', (await chip.textContent()) === 'grace');
    await page.evaluate(() => localStorage.removeItem('test:no-autofill'));

    // --- and through autofill: signed out, the page's pending request is
    // answered and signs straight back in.
    await page.locator('.auth-slot [data-sign-out]').first().click();
    await page.waitForFunction(() => !document.querySelector('.auth-slot .auth-name'));
    await page.goto(`${BASE}/account.html`);
    await page.waitForURL(`${BASE}/#browse`, { timeout: 10000 });
    await chip.waitFor({ timeout: 5000 });
    check('autofill (conditional mediation) signs in with the passkey', (await chip.textContent()) === 'grace');

    // --- a password account: the form aborts autofill, and an upgrade
    // attempt never holds up the sign-in. An authenticator with nothing on
    // it from here on, so autofill stays pending with nothing to answer.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: third });
    await b.addAuthenticator();
    await page.locator('.auth-slot [data-sign-out]').first().click();
    await page.waitForFunction(() => !document.querySelector('.auth-slot .auth-name'));
    await page.goto(`${BASE}/account.html`);
    await page.click('#auth-toggle');
    await page.fill('#auth-username', 'hopper');
    await page.fill('#auth-password', 'correct horse battery staple');
    await page.click('#auth-submit');
    await page.waitForURL(`${BASE}/#browse`, { timeout: 10000 });
    await page.locator('.auth-slot [data-sign-out]').first().click();
    await page.waitForFunction(() => !document.querySelector('.auth-slot .auth-name'));
    const onLoad = page.waitForRequest((r) => r.url().endsWith('/api/auth/passkeys/login/options'));
    await page.goto(`${BASE}/account.html`);
    await onLoad;
    await page.fill('#auth-username', 'hopper');
    await page.fill('#auth-password', 'correct horse battery staple');
    const started = Date.now();
    await page.click('#auth-submit');
    await page.waitForURL(`${BASE}/#browse`, { timeout: 10000 });
    await chip.waitFor({ timeout: 5000 });
    check('a password sign-in with autofill pending goes through', (await chip.textContent()) === 'hopper');
    check(`and the passkey-upgrade attempt didn't hold it up (${Date.now() - started} ms)`, Date.now() - started < 7000);

    check('no alert/confirm dialogs were raised', b.dialogs() === 0);
    check(`no unexpected console errors or CSP violations (${b.problems.length})`, b.problems.length === 0);
    if (b.problems.length) console.log(b.problems.join('\n'));
    check(`the refused sign-in's 401 was the only console error allowed (${b.allowed})`, b.allowed >= 1);
    await b.context.close();

    // --- a browser without the Level 3 JSON helpers: the base64url fallback
    const old = await openBrowser({
      initScript: () => {
        delete PublicKeyCredential.parseCreationOptionsFromJSON;
        delete PublicKeyCredential.parseRequestOptionsFromJSON;
        delete PublicKeyCredential.prototype.toJSON;
        delete PublicKeyCredential.getClientCapabilities;
      },
    });
    await old.page.goto(`${BASE}/account.html`);
    await old.page.click('#auth-toggle');
    await old.page.fill('#auth-username', 'lovelace');
    await old.page.click('#passkey-sign-up-button');
    await old.page.waitForURL(`${BASE}/#browse`, { timeout: 10000 });
    check('without parse*FromJSON/toJSON: signing up still works', true);
    // Signed out, autofill (found through isConditionalMediationAvailable,
    // since getClientCapabilities is gone too) signs straight back in.
    await old.page.goto(`${BASE}/account.html`);
    await old.page.click('#account-sign-out');
    await old.page.waitForURL(`${BASE}/#browse`, { timeout: 10000 });
    const oldChip = old.page.locator('.auth-slot .auth-name').first();
    await oldChip.waitFor({ timeout: 5000 });
    check('and so does signing in', (await oldChip.textContent()) === 'lovelace');
    check(`no console errors there either (${old.problems.length})`, old.problems.length === 0);
    if (old.problems.length) console.log(old.problems.join('\n'));
    await old.context.close();
  } finally {
    await browser.close();
    await srv.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILURES:', failed.map((f) => f.label));
    process.exit(1);
  }
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
