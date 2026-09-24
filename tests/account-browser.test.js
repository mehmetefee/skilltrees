// The account page's own sections in a real browser: changing a password,
// ending another session, downloading your data and deleting the account
// through the confirmation dialog — plus the "sign in again" path for an
// account without a password. Starts its own server on a throwaway database,
// so it needs no running server:
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/account-browser.test.js
//
// PORT picks the server's port (default: one the OS hands out). Fails on any
// console error or CSP violation, apart from the failed requests the checks
// below make on purpose (a wrong password is a 401 in the console).

const { chromium } = require('playwright');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { startServer, cookieFrom } = require('./helpers/server');

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'an entirely new passphrase';
const FIREFOX_ON_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

(async () => {
  const srv = await startServer({ env: process.env.PORT ? { PORT: process.env.PORT } : {} });
  const BASE = srv.base;

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const context = await browser.newContext({ acceptDownloads: true });
  // CSP violations are reported to the page as events; turn them into
  // console errors so the check below catches them with everything else.
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });

  const problems = [];
  let expectFailedRequest = false; // set around the steps that fail on purpose
  const watch = (page) => {
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (expectFailedRequest && /Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) return;
      problems.push(`${page.url()} :: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror ${page.url()} :: ${e.message}`));
    page.on('dialog', (d) => {
      problems.push(`unexpected ${d.type()} dialog: ${d.message()}`);
      d.dismiss();
    });
  };
  const page = await context.newPage();
  watch(page);

  const results = [];
  const check = (label, cond) => {
    results.push({ label, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  };
  const me = async (cookie) => (await srv.request('/api/auth/me', { cookie })).data.user;
  const loginStatus = async (password) =>
    (await srv.request('/api/auth/login', { method: 'POST', body: { username: 'alice', password } })).status;
  const focusedId = () => page.evaluate(() => document.activeElement && document.activeElement.id);

  try {
    // --- alice has two trees, a session from signing up, and a phone
    const alice = await srv.signup('alice');
    await alice.fetch('/api/trees', { method: 'POST', body: { title: 'Sourdough' } });
    await alice.fetch('/api/trees', { method: 'POST', body: { title: 'Pasta' } });
    const phoneLogin = await srv.request('/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: PASSWORD },
      headers: { 'User-Agent': FIREFOX_ON_WINDOWS },
    });
    const phone = cookieFrom(phoneLogin);

    // --- and signs in here, through the form
    await page.goto(`${BASE}/account.html`);
    await page.waitForSelector('#sign-in-view:not([hidden])');
    await page.fill('#auth-username', 'alice');
    await page.fill('#auth-password', PASSWORD);
    await page.click('#auth-submit');
    await page.waitForURL(`${BASE}/#browse`);
    await page.goto(`${BASE}/account.html`);
    await page.waitForSelector('#account-view:not([hidden])');

    // --- sessions: three, this one first and marked
    const rows = page.locator('#session-list .session');
    await rows.nth(2).waitFor();
    check('three sessions are listed', (await rows.count()) === 3);
    const first = await rows.nth(0).textContent();
    check('this browser is first, marked "This device"', first.includes('This device') && first.includes('Chrome on Linux'));
    check('this device has no sign-out button of its own', (await rows.nth(0).locator('button').count()) === 0);
    const firefoxRow = rows.filter({ hasText: 'Firefox on Windows' });
    check('the other device is named from its user agent', (await firefoxRow.count()) === 1);
    const endButton = firefoxRow.locator('button', { hasText: 'Sign out' });
    check(
      'its button says which session it ends',
      /^Sign out Firefox on Windows, signed in /.test(await endButton.getAttribute('aria-label'))
    );

    // --- end the other device's session
    await endButton.click();
    await page.waitForFunction(() => document.querySelectorAll('#session-list .session').length === 2);
    check('ending it removes it from the list', (await rows.filter({ hasText: 'Firefox' }).count()) === 0);
    await page.waitForFunction(() => document.getElementById('sessions-status').textContent !== '');
    check('the result is announced', (await page.textContent('#sessions-status')) === 'Signed out Firefox on Windows.');
    check('that device really is signed out', (await me(phone)) === null);
    check('focus moved to the next button, not the page', (await page.evaluate(() => document.activeElement.tagName)) === 'BUTTON');

    // --- sign out everywhere else
    await page.click('#sessions-revoke-others');
    await page.waitForFunction(() => document.querySelectorAll('#session-list .session').length === 1);
    check('"Sign out everywhere else" leaves only this device', (await me(alice.cookie)) === null);
    check('and then hides itself', await page.locator('#sessions-revoke-others').isHidden());
    check('focus lands on the section heading', (await focusedId()) === 'account-sessions-heading');

    // --- change password: a wrong current one first
    check('the password row links to the password section', (await page.getAttribute('#sign-in-methods-list a', 'href')) === '#account-password');
    check('fields carry the autocomplete hints password managers use',
      (await page.getAttribute('#current-password', 'autocomplete')) === 'current-password' &&
      (await page.getAttribute('#new-password', 'autocomplete')) === 'new-password' &&
      (await page.getAttribute('#new-password', 'minlength')) === '8');
    await page.check('#show-passwords');
    check('"Show passwords" shows them', (await page.getAttribute('#new-password', 'type')) === 'text');
    await page.uncheck('#show-passwords');
    expectFailedRequest = true;
    await page.fill('#current-password', 'not the password');
    await page.fill('#new-password', NEW_PASSWORD);
    await page.click('#password-submit');
    await page.waitForSelector('#password-error:not([hidden])');
    expectFailedRequest = false;
    check('a wrong current password is reported', (await page.textContent('#password-error')).includes('not your current password'));
    check('the field is marked invalid and focused',
      (await page.getAttribute('#current-password', 'aria-invalid')) === 'true' && (await focusedId()) === 'current-password');
    check('the error is described to the fields',
      (await page.getAttribute('#current-password', 'aria-describedby')).includes('password-error'));

    await page.fill('#current-password', PASSWORD);
    await page.click('#password-submit');
    await page.waitForFunction(() => document.getElementById('password-status').textContent.startsWith('Password changed'));
    check('the change is confirmed', true);
    check('focus stays on the button that was pressed', (await focusedId()) === 'password-submit');
    check('the error is gone', await page.locator('#password-error').isHidden());
    check('the fields are emptied', (await page.inputValue('#new-password')) === '' && (await page.inputValue('#current-password')) === '');
    check('the old password no longer signs in', (await loginStatus(PASSWORD)) === 401);
    check('the new one does', (await loginStatus(NEW_PASSWORD)) === 200);
    await page.reload();
    await page.waitForSelector('#account-view:not([hidden])');
    check('this browser is still signed in, on its rotated cookie', (await page.textContent('#account-username')) === 'alice');

    // --- download my data
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#data-download')]);
    check('the download is named after the account', download.suggestedFilename() === 'skilltrees-alice.json');
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    check('it holds the account and both trees',
      exported.account.username === 'alice' &&
      exported.trees.map((t) => t.notation.title).sort().join() === 'Pasta,Sourdough');
    await page.waitForFunction(() => document.getElementById('data-status').textContent !== '');
    check('the download is confirmed', (await page.textContent('#data-status')) === 'Downloaded skilltrees-alice.json.');

    // --- arriving at a section by its address
    await page.goto(`${BASE}/account.html#account-password`);
    await page.waitForSelector('#account-view:not([hidden])');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'current-password');
    check('#account-password focuses the first password field', true);

    // --- delete, through the dialog
    await page.waitForFunction(() => /2 trees/.test(document.getElementById('delete-summary').textContent));
    check('the section says how many trees will go', true);
    await page.click('#delete-open');
    await page.waitForSelector('#delete-dialog[open]');
    check('the dialog opens with the tree count', (await page.textContent('#delete-help')).includes('alice and its 2 trees'));
    check('focus starts in the username field', (await focusedId()) === 'delete-confirm-username');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('delete-dialog').open);
    check('Escape closes it and focus returns to the button', (await focusedId()) === 'delete-open');

    await page.click('#delete-open');
    await page.waitForSelector('#delete-dialog[open]');
    await page.fill('#delete-confirm-username', 'alicia');
    await page.fill('#delete-password', NEW_PASSWORD);
    await page.click('#delete-submit');
    await page.waitForSelector('#delete-error:not([hidden])');
    check('a wrong username is caught before anything is sent',
      (await page.textContent('#delete-error')).includes('Type your username, alice, to confirm.') &&
      (await page.getAttribute('#delete-confirm-username', 'aria-invalid')) === 'true');

    expectFailedRequest = true;
    await page.fill('#delete-confirm-username', 'Alice');
    await page.fill('#delete-password', 'not the password');
    await page.click('#delete-submit');
    await page.waitForFunction(() => document.getElementById('delete-error').textContent.includes('password'));
    expectFailedRequest = false;
    check('a wrong password is refused, and focus goes to it', (await focusedId()) === 'delete-password');
    check('the dialog stays open', await page.locator('#delete-dialog').evaluate((d) => d.open));

    await page.fill('#delete-password', NEW_PASSWORD);
    await Promise.all([page.waitForURL(`${BASE}/`), page.click('#delete-submit')]);
    check('deleting goes to the homepage', page.url() === `${BASE}/`);
    check('the account is gone', (await loginStatus(NEW_PASSWORD)) === 401);
    const titles = (await srv.request('/api/trees')).data.map((t) => t.title);
    check('and so are its trees', !titles.includes('Sourdough') && !titles.includes('Pasta'));
    const cookies = await context.cookies(BASE);
    check('the session cookie is gone from the browser', !cookies.some((c) => c.name === 'skilltree_session'));

    // --- an account with no password, signed in a while ago
    const db = new DatabaseSync(srv.dbPath);
    const userId = Number(db.prepare("INSERT INTO users (username, password_hash) VALUES ('ada', '')").run().lastInsertRowid);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, public_id, user_agent)
       VALUES (?, ?, datetime('now', '-20 minutes'), datetime('now', '+1 day'), ?, '')`
    ).run(crypto.createHash('sha256').update(token).digest('hex'), userId, crypto.randomBytes(16).toString('hex'));
    db.close();
    await context.addCookies([{ name: 'skilltree_session', value: token, url: BASE }]);
    await page.goto(`${BASE}/account.html`);
    await page.waitForSelector('#account-view:not([hidden])');
    check('the password section offers to set one', (await page.textContent('#password-submit')) === 'Set password');
    check('with no current-password field', await page.locator('#current-password-field').isHidden());
    check('and the sign-in methods link says so', (await page.textContent('#sign-in-methods-list a')) === 'Set a password');
    expectFailedRequest = true;
    await page.fill('#new-password', NEW_PASSWORD);
    await page.click('#password-submit');
    await page.waitForSelector('#password-reauth:not([hidden])');
    expectFailedRequest = false;
    check('an old sign-in is told to sign in again', (await page.textContent('#password-error')).includes('sign in again'));
    check('with a button for it, focused', (await focusedId()) === 'password-reauth');
    await page.click('#password-reauth');
    await page.waitForSelector('#sign-in-view:not([hidden])');
    check('which signs out and returns to the sign-in form',
      new URL(page.url()).searchParams.get('next') === '/account.html#account-password');

    check(`no console errors or CSP violations (${problems.length})`, problems.length === 0);
    if (problems.length) console.log(problems.join('\n'));
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
