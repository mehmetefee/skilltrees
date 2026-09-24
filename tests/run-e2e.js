// Runs every browser (Playwright) suite in tests/, one after another, and
// prints a summary table. Exits non-zero if any suite failed.
//
//   NODE_PATH=$(npm root -g) CHROMIUM_PATH=/path/to/chrome node tests/run-e2e.js
//   node tests/run-e2e.js core-crud zoom-pan     # only these suites
//
// Suites are found by pattern — every tests/*.test.js except the pure ones in
// PURE below — so a new browser suite is picked up by adding the file. They
// run in sequence, not in parallel: each starts a server and a Chromium of its
// own, and several at once make timing-sensitive checks flaky. The
// environment is passed through unchanged, so NODE_PATH (where Playwright is
// installed), CHROMIUM_PATH (which browser to launch) and BASE_URL reach every
// suite. E2E_TIMEOUT_MS caps each suite (default ten minutes).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Suites that need no browser; they run with `node tests/<name>` on their own.
const PURE = new Set(['validator.test.js']);
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 10 * 60 * 1000;
const ROOT = path.join(__dirname, '..');

function discover(wanted) {
  const all = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js') && !PURE.has(f))
    .sort();
  if (!wanted.length) return all;
  const byName = (n) => all.find((f) => f === n || f === `${n}.test.js` || f === path.basename(n));
  const unknown = wanted.filter((n) => !byName(n));
  if (unknown.length) {
    console.error(`No browser suite named ${unknown.join(', ')}. Found: ${all.map((f) => f.replace(/\.test\.js$/, '')).join(', ')}`);
    process.exit(2);
  }
  return [...new Set(wanted.map(byName))];
}

// Fail once, clearly, rather than once per suite with a stack trace.
function checkPlaywright() {
  try {
    require.resolve('playwright');
  } catch {
    console.error(
      'Playwright is not installed where Node can find it. Install it outside backend/ ' +
        '(`npm install playwright` from the project root), or point Node at a global install:\n\n' +
        '  NODE_PATH=$(npm root -g) node tests/run-e2e.js\n'
    );
    process.exit(2);
  }
}

let current = null; // the running suite's child process

// Each suite runs in a process group of its own, so a timeout or Ctrl-C can
// stop the server and browser it started along with it.
function stopGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}

function runSuite(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    current = child;
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n${file}: no result after ${TIMEOUT_MS / 1000}s, stopping it`);
      stopGroup(child, 'SIGTERM');
      setTimeout(() => stopGroup(child, 'SIGKILL'), 5000).unref();
    }, TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      current = null;
      const count = (tag) => (out.match(new RegExp(`^${tag} - `, 'gm')) || []).length;
      const passed = count('PASS');
      const failed = count('FAIL');
      const skipped = count('SKIP');
      let result = 'pass';
      if (timedOut) result = 'TIMEOUT';
      else if (code !== 0 || signal) result = failed ? 'FAIL' : 'CRASH';
      else if (failed) result = 'FAIL'; // a suite that printed FAIL but exited 0 still failed
      resolve({
        name: file.replace(/\.test\.js$/, ''),
        result,
        passed,
        failed,
        skipped,
        seconds: (Date.now() - started) / 1000,
      });
    });
  });
}

function printSummary(rows) {
  const header = ['Suite', 'Result', 'Checks', 'Failed', 'Skipped', 'Time'];
  const lines = rows.map((r) => [
    r.name,
    r.result,
    r.passed + r.failed ? `${r.passed}/${r.passed + r.failed}` : '-',
    String(r.failed),
    String(r.skipped),
    `${r.seconds.toFixed(1)}s`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => (i >= 2 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  console.log('\n' + fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const l of lines) console.log(fmt(l));
}

async function main() {
  const suites = discover(process.argv.slice(2));
  if (!suites.length) {
    console.error('No browser suites found in tests/.');
    process.exit(2);
  }
  checkPlaywright();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (current) stopGroup(current, 'SIGTERM');
      process.exit(130);
    });
  }

  const target = process.env.BASE_URL ? `against ${process.env.BASE_URL}` : 'each on a server of its own';
  const browser = process.env.CHROMIUM_PATH ? `, Chromium at ${process.env.CHROMIUM_PATH}` : '';
  console.log(`Running ${suites.length} browser suites ${target}${browser}.`);

  const rows = [];
  for (const [i, file] of suites.entries()) {
    console.log(`\n=== ${file} (${i + 1}/${suites.length}) ===`);
    rows.push(await runSuite(file));
  }

  printSummary(rows);
  const bad = rows.filter((r) => r.result !== 'pass');
  console.log(bad.length ? `\n${bad.length} of ${rows.length} suites failed: ${bad.map((r) => r.name).join(', ')}` : `\nAll ${rows.length} suites passed.`);
  process.exit(bad.length ? 1 : 0);
}

main();
