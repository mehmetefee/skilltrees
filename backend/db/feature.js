// Sets (or clears) which tree is shown in the landing page spotlight.
// There is deliberately no HTTP endpoint for this — a public API for it could
// be flipped by anyone with an account. This is server-side only: whoever can
// run a script on the machine hosting the database.
//
// Usage:
//   node db/feature.js <tree id>       mark that tree as featured
//   node db/feature.js <exact title>   mark the tree with exactly this title
//   node db/feature.js --clear         unfeature everything
//
// At most one tree is featured at a time.
//
// Note what this script does NOT do with its argument. Titles are written by
// anyone with an account, so they are not a safe way to name a tree: matching
// on a substring and taking the newest match let someone publish "<your
// title> - remastered" and have it win the spotlight the moment an operator
// typed the real title. So the title branch demands an exact match and
// refuses when more than one tree answers to it, and the id branch is strict
// about what counts as an id. For the same reason the confirmation line below
// goes through logSafe(): a title is remote text arriving in your terminal,
// and an escape sequence in it could rewrite what you think just happened.

const { openDb } = require('./init');
const { logSafe } = require('../lib/text');

const db = openDb();
const arg = process.argv[2];

if (!arg) {
  console.error('Usage: node db/feature.js <tree id | exact title | --clear>');
  process.exit(1);
}

if (arg === '--clear') {
  const result = db.prepare('UPDATE trees SET featured = 0').run();
  console.log(`Cleared the featured flag (${result.changes} tree(s) affected).`);
  db.close();
  process.exit(0);
}

// Digits only, and not zero: Number('  12  ') and Number('') would both pass
// a Number.isInteger() check, and a falsy 0 would fall through to the title
// branch carrying whatever the operator typed.
const byId = /^[1-9][0-9]*$/.test(arg) ? Number(arg) : null;

let tree;
if (byId) {
  tree = db.prepare('SELECT id, title FROM trees WHERE id = ?').get(byId);
} else {
  const matches = db.prepare('SELECT id, title FROM trees WHERE title = ?').all(arg);
  if (matches.length > 1) {
    console.error(`"${logSafe(arg)}" matches ${matches.length} trees:`);
    for (const match of matches) console.error(`  id=${match.id}`);
    console.error('Re-run with the id of the one you mean.');
    db.close();
    process.exit(1);
  }
  tree = matches[0];
}

if (!tree) {
  console.error(`No tree found matching "${logSafe(arg)}".`);
  db.close();
  process.exit(1);
}

// One transaction: without it a failure between the two statements would
// leave the site with no featured tree at all.
db.exec('BEGIN');
try {
  db.prepare('UPDATE trees SET featured = 0').run();
  db.prepare('UPDATE trees SET featured = 1 WHERE id = ?').run(tree.id);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`Could not set the featured tree: ${e.message}`);
  db.close();
  process.exit(1);
}

// id first: it is the part nobody else can write.
console.log(`Featured id=${tree.id} ("${logSafe(tree.title)}").`);
db.close();
