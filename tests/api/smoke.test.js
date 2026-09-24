// Baseline API behaviour every later change has to keep: public reads,
// signed-in writes, and owner-only changes. Run with `npm test` from backend/
// or `node --test "tests/api/*.test.js"` from the project root.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers/server');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  await srv.stop();
});

test('reading is public', async () => {
  const res = await srv.request('/api/trees');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data));
});

test('writing needs an account', async () => {
  const res = await srv.request('/api/trees', { method: 'POST', body: { title: 'Nope' } });
  assert.equal(res.status, 401);
});

test('only the owner can change a tree', async () => {
  const alice = await srv.signup('alice');
  const bob = await srv.signup('bob');

  const created = await alice.fetch('/api/trees', { method: 'POST', body: { title: 'Bread' } });
  assert.equal(created.status, 201);
  const id = created.data.id;

  const byBob = await bob.fetch(`/api/trees/${id}`, { method: 'PATCH', body: { title: 'Mine' } });
  assert.equal(byBob.status, 403);

  const byAlice = await alice.fetch(`/api/trees/${id}`, { method: 'PATCH', body: { title: 'Rye' } });
  assert.equal(byAlice.status, 200);
  assert.equal(byAlice.data.title, 'Rye');
});

test('a cross-site write is refused', async () => {
  const carol = await srv.signup('carol');
  const res = await carol.fetch('/api/trees', {
    method: 'POST',
    body: { title: 'Forged' },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
});
