// "Continue with <provider>" in a real browser, against the mock provider in
// tests/helpers/mock-oidc.js. Unlike the other Playwright suites this one
// starts its own server and provider (a throwaway database, nothing shared),
// so it needs no running server:
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/oauth-browser.test.js
//
// PORT picks the server's port (default: one the OS hands out). What only a
// browser can show: the SameSite=Lax flow cookie surviving the cross-site
// redirect back from the provider, CSP letting the page reach the provider
// (fetch the start, then navigate — no form), and no console errors or CSP
// violations anywhere along the way.

const { chromium } = require('playwright');
const net = require('node:net');
const { startServer } = require('./helpers/server');
const { startMockOidc } = require('./helpers/mock-oidc');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

(async () => {
  const mock = await startMockOidc();
  const port = Number(process.env.PORT) || (await freePort());
  const srv = await startServer({
    env: {
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      OIDC_ISSUER: mock.issuer,
      OIDC_CLIENT_ID: mock.clientId,
      OIDC_CLIENT_SECRET: mock.clientSecret,
      OIDC_NAME: 'Test SSO',
    },
  });
  const BASE = srv.base;

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const context = await browser.newContext();
  // CSP violations are reported to the page as events; turn them into
  // console errors so the check below catches them with everything else.
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${page.url()} :: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror ${page.url()} :: ${e.message}`));
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    d.dismiss();
  });

  const results = [];
  const check = (label, cond) => {
    results.push({ label, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  };

  try {
    // --- signed out: the provider button sits above the password form
    await page.goto(`${BASE}/account.html`);
    const ssoButton = page.locator('#oauth-providers button', { hasText: 'Continue with Test SSO' });
    await ssoButton.waitFor({ timeout: 5000 });
    check('sign-in view shows "Continue with Test SSO"', await ssoButton.isVisible());
    check('the "or" divider is shown', await page.locator('#oauth-divider').isVisible());
    check('the password form is still there', await page.locator('#auth-form').isVisible());
    check('the account panel is hidden while signed out', !(await page.locator('#account-view').isVisible()));

    // --- sign in through the provider: out to 127.0.0.1, back to localhost
    const toProvider = page.waitForRequest((r) => r.url().startsWith(`${mock.issuer}/authorize`));
    await ssoButton.click();
    await toProvider;
    await page.waitForURL(`${BASE}/#browse`, { timeout: 5000 });
    check('lands on the default next after the provider round trip', page.url() === `${BASE}/#browse`);
    const chip = page.locator('.auth-slot .auth-name').first();
    await chip.waitFor({ timeout: 5000 });
    check('the header shows the new account', (await chip.textContent()) === 'ada');
    check('the name links to the account page', (await chip.getAttribute('href')) === '/account.html');

    // --- the account panel
    await chip.click();
    await page.waitForSelector('#account-view:not([hidden])');
    check('account page shows "Your account"', (await page.textContent('#auth-heading')) === 'Your account');
    check('username in the panel', (await page.textContent('#account-username')) === 'ada');
    check('sign-in form is hidden while signed in', !(await page.locator('#sign-in-view').isVisible()));
    const methods = page.locator('#sign-in-methods-list .sign-in-method');
    await methods.nth(1).waitFor();
    check('password row says it is not set', (await methods.nth(0).textContent()).includes('Not set'));
    check('the provider is listed as connected', (await methods.nth(1).textContent()).includes('Test SSO'));
    check(
      'its Disconnect is disabled: it is the only way in',
      await methods.nth(1).locator('button', { hasText: 'Disconnect' }).isDisabled()
    );

    // --- error codes are shown from a fixed list, as text, then cleared
    await page.goto(`${BASE}/account.html?oauth_error=identity_taken`);
    await page.waitForSelector('#oauth-error:not([hidden])');
    check(
      'a known error code shows its message',
      (await page.textContent('#oauth-error')).includes('already connected to a different')
    );
    check('the code is taken out of the address bar', !page.url().includes('oauth_error'));
    await page.goto(`${BASE}/account.html?oauth_error=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
    await page.waitForSelector('#oauth-error:not([hidden])');
    check('an unknown code gets the general message', (await page.textContent('#oauth-error')).includes('could not be completed'));
    check('and nothing from the URL becomes markup', (await page.locator('#oauth-error img').count()) === 0);

    // --- sign out from the panel
    await page.click('#account-sign-out');
    await page.waitForSelector('#sign-in-view:not([hidden])');
    check('signing out returns to the sign-in view', await page.locator('#auth-form').isVisible());

    // --- a password account connects the provider, then disconnects it
    await page.click('#auth-toggle');
    await page.fill('#auth-username', 'bella');
    await page.fill('#auth-password', 'correct horse battery staple');
    await page.click('#auth-submit');
    await page.waitForURL(`${BASE}/#browse`);
    await page.goto(`${BASE}/account.html`);
    const connect = page.locator('#sign-in-methods-list button', { hasText: 'Connect' });
    await connect.waitFor();
    mock.user = { sub: 'bella-at-sso', preferred_username: 'bella.sso' };
    await connect.click();
    await page.waitForURL(`${BASE}/account.html`, { timeout: 5000 });
    await page.waitForSelector('.toast.show');
    check('a toast confirms the connection', (await page.textContent('#toast')) === 'Connected Test SSO.');
    const connected = page.locator('#sign-in-methods-list .sign-in-method', { hasText: 'bella.sso' });
    await connected.waitFor();
    check('the connected account is listed by its name', await connected.isVisible());
    check('the account is still bella', (await page.textContent('#account-username')) === 'bella');
    const disconnect = connected.locator('button', { hasText: 'Disconnect' });
    check('with a password set, Disconnect is allowed', await disconnect.isEnabled());
    await disconnect.click();
    await page.locator('#sign-in-methods-list button', { hasText: 'Connect' }).waitFor();
    check('after disconnecting, Connect is offered again', true);

    check('no alert/confirm dialogs were raised', dialogs === 0);
    check(`no console errors or CSP violations (${problems.length})`, problems.length === 0);
    if (problems.length) console.log(problems.join('\n'));
  } finally {
    await browser.close();
    await srv.stop();
    await mock.stop();
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
