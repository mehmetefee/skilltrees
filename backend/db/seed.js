// Populates the database with one example skill tree so the app isn't
// empty on first run. Safe to run multiple times (skips if data exists).

const { openDb } = require('./init');

const db = openDb();

const existing = db.prepare('SELECT COUNT(*) AS n FROM trees').get();
if (existing.n > 0) {
  console.log('Database already has data, skipping seed.');
  process.exit(0);
}

const insertTree = db.prepare(
  'INSERT INTO trees (title, description, author) VALUES (?, ?, ?)'
);
const insertSkill = db.prepare(
  'INSERT INTO skills (tree_id, name, description, pos_x, pos_y) VALUES (?, ?, ?, ?, ?)'
);
const insertPrereq = db.prepare(
  'INSERT INTO prereqs (tree_id, skill_id, prereq_skill_id) VALUES (?, ?, ?)'
);

const treeId = insertTree.run(
  'Home Bread Baking',
  'From flour and water to a full sourdough loaf.',
  'Claude'
).lastInsertRowid;

const skills = {
  measure: ['Measure ingredients by weight', 'Use a kitchen scale for accurate ratios.', 0, 0],
  knead: ['Knead dough', 'Develop gluten by hand-kneading for 10 minutes.', 200, 0],
  windowpane: ['Windowpane test', 'Check gluten development by stretching dough thin.', 400, -80],
  shape: ['Shape a boule', 'Form a tight, round loaf.', 400, 80],
  starter: ['Maintain a sourdough starter', 'Feed and keep a starter alive and active.', 200, 200],
  bulk_ferment: ['Bulk fermentation', 'Let dough rise as a whole mass before shaping.', 600, 40],
  score: ['Score a loaf', 'Cut the surface so it expands predictably in the oven.', 800, -40],
  dutch_oven: ['Bake in a dutch oven', 'Use steam-trapping to get an artisan crust.', 800, 120],
  sourdough_loaf: ['Bake a full sourdough loaf', 'Combine everything into a finished artisan loaf.', 1000, 40],
};

const ids = {};
for (const [key, [name, description, pos_x, pos_y]] of Object.entries(skills)) {
  ids[key] = insertSkill.run(treeId, name, description, pos_x, pos_y).lastInsertRowid;
}

const edges = [
  ['knead', 'measure'],
  ['windowpane', 'knead'],
  ['shape', 'knead'],
  ['bulk_ferment', 'shape'],
  ['bulk_ferment', 'starter'],
  ['score', 'bulk_ferment'],
  ['dutch_oven', 'bulk_ferment'],
  ['sourdough_loaf', 'score'],
  ['sourdough_loaf', 'dutch_oven'],
];

for (const [skill, prereq] of edges) {
  insertPrereq.run(treeId, ids[skill], ids[prereq]);
}

console.log(`Seeded tree "Home Bread Baking" (id=${treeId}) with ${Object.keys(skills).length} skills.`);
db.close();
