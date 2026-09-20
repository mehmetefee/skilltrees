// Database setup for the Skill Tree site.
// Uses Node's built-in `node:sqlite` module (no external dependencies needed).
//
// Data model:
//   trees      - a named, public skill tree (e.g. "Learn Bread Baking")
//   skills     - a node in a tree (e.g. "Knead dough")
//   prereqs    - a directed edge: learning `prereq_skill_id` makes you
//                eligible to learn `skill_id`. A skill can have several
//                prerequisites (all must be "learned" to unlock it) and can
//                itself unlock several other skills.

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = __dirname;
const DB_PATH = path.join(DB_DIR, 'skilltree.db');

function openDb() {
  const isNew = !fs.existsSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  restrictPermissions();

  db.exec(`
    CREATE TABLE IF NOT EXISTS trees (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      author      TEXT DEFAULT 'Anonymous',
      -- 'manual': pos_x/pos_y are authoritative.
      -- 'auto':   they are ignored and the layout is computed from structure.
      layout      TEXT NOT NULL DEFAULT 'manual',
      -- At most one tree has featured=1 at a time; enforced in server.js,
      -- not the schema, since sqlite has no easy "unique among true values".
      featured    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One row per signed-in browser. Deleting a row signs that browser out.
    -- Only the SHA-256 of the token is kept: a leaked database then gives an
    -- attacker no usable session cookies. Sessions expire both absolutely
    -- (expires_at) and after a stretch of inactivity (last_used_at).
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash   TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tree_id     INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      pos_x       REAL DEFAULT 0,
      pos_y       REAL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prereqs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tree_id          INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
      skill_id         INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      prereq_skill_id  INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      UNIQUE(skill_id, prereq_skill_id)
    );

    -- Persisted rate-limit counters. Survives restarts so brute-force
    -- progress isn't lost on a redeploy or crash.
    CREATE TABLE IF NOT EXISTS rate_limits (
      key       TEXT PRIMARY KEY,
      count     INTEGER NOT NULL DEFAULT 1,
      first_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_skills_tree ON skills(tree_id);
    CREATE INDEX IF NOT EXISTS idx_prereqs_tree ON prereqs(tree_id);
    CREATE INDEX IF NOT EXISTS idx_prereqs_skill ON prereqs(skill_id);
  `);

  migrate(db);

  if (isNew) {
    console.log(`Created new database at ${DB_PATH}`);
  }

  return db;
}

// Brings an already-existing database up to date. CREATE TABLE IF NOT EXISTS
// above only covers fresh databases, so columns added later need adding here
// too. Each step checks first, so this is safe to run on every startup.
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(trees)').all().map((c) => c.name);

  if (!columns.includes('layout')) {
    db.exec("ALTER TABLE trees ADD COLUMN layout TEXT NOT NULL DEFAULT 'manual'");
    console.log("Migrated: added trees.layout (existing trees default to 'manual').");
  }

  if (!columns.includes('featured')) {
    db.exec('ALTER TABLE trees ADD COLUMN featured INTEGER NOT NULL DEFAULT 0');
    console.log('Migrated: added trees.featured (existing trees default to unfeatured).');
  }

  // Who may edit a tree. NULL means it was made before accounts existed, which
  // the API treats as read-only for everyone — there is no way to tell who
  // made it, so handing it to anyone would be a guess.
  if (!columns.includes('user_id')) {
    db.exec('ALTER TABLE trees ADD COLUMN user_id INTEGER REFERENCES users(id)');
    console.log('Migrated: added trees.user_id (existing trees become read-only).');
  }

  // Sessions used to store the raw token and never expire. Rebuilding the
  // table is the migration: it signs everyone out, which is the right thing to
  // do when the way sessions are secured changes.
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (sessionColumns.length > 0 && !sessionColumns.includes('token_hash')) {
    db.exec(`
      DROP TABLE sessions;
      CREATE TABLE sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at   TEXT NOT NULL
      );
    `);
    console.log('Migrated: sessions are now stored hashed and expiring (everyone signed out).');
  }
}

// This file holds users.password_hash. SQLite creates it — and the -wal/-shm
// sidecars it makes later — as 0644 masked by the umask, which on a default
// POSIX host leaves the password hashes readable by every other local
// account. Narrowing the whole directory covers the sidecars too.
//
// Best effort on purpose: chmod is a no-op on Windows, where the directory
// ACL is what applies, and a database owned by another user must not stop the
// server from starting, so a failure is reported rather than thrown.
function restrictPermissions() {
  for (const target of [DB_DIR, DB_PATH]) {
    try {
      fs.chmodSync(target, target === DB_DIR ? 0o700 : 0o600);
    } catch (e) {
      if (process.platform !== 'win32') {
        console.warn('Could not restrict permissions on ' + target + ': ' + e.message);
      }
    }
  }
}

module.exports = { openDb, DB_PATH };
