#!/usr/bin/env node
// Validates a skill tree JSON file against the v1 format (see FORMAT.md).
//
//   node tools/validate-tree.js examples/home-bread-baking.json
//
// Exits 0 when valid, 1 when not, printing one line per problem.
// Also usable as a module: require('./validate-tree').validate(obj) -> string[]

const SUPPORTED_VERSIONS = [1];
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LAYOUT_MODES = ['auto', 'manual'];

// Text limits, matching what clean() already enforces on every field the API
// writes; without them an imported tree was the one way to store text no
// form would accept, and the homepage serves every title and description to
// every visitor in one response.
const MAX_LENGTHS = {
  title: 120,
  description: 1000,
  author: 80,
  skillName: 120,
  skillDescription: 1000,
};

// Size limits. A tree is laid out by a pass whose cost climbs steeply with
// the number of skills and links (see ORDER_BUDGET in frontend/layout.js),
// and the drawing stops being readable long before these numbers: they are
// here to keep a tree something a person could publish rather than something
// aimed at the machine drawing it.
const MAX_SKILLS = 1000;
const MAX_PREREQS = 5000;

// Control characters in stored text. A title or a name ends up in a log
// line and in the operator's terminal, where an escape sequence is a way to
// rewrite what a person sees — so single-line fields carry none at all, and
// a description carries only the whitespace that makes it a paragraph.
function controlCharProblem(value, { keepWhitespace = false } = {}) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if (code < 0x20 || code === 0x7f) {
      if (keepWhitespace && isWhitespace) continue;
      return `contains a control character (0x${code.toString(16).padStart(2, '0')})`;
    }
  }
  return null;
}

// Returns an array of human-readable problems. Empty array means valid.
function validate(tree) {
  const problems = [];
  const fail = (msg) => problems.push(msg);

  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) {
    return ['Top level must be a JSON object.'];
  }

  // --- top level ---
  if (tree.format !== 'skilltree') {
    fail(`"format" must be "skilltree" (got ${JSON.stringify(tree.format)}).`);
  }
  if (!Number.isInteger(tree.version)) {
    fail(`"version" must be an integer (got ${JSON.stringify(tree.version)}).`);
  } else if (!SUPPORTED_VERSIONS.includes(tree.version)) {
    fail(`Unsupported version ${tree.version}; this validator knows ${SUPPORTED_VERSIONS.join(', ')}.`);
  }
  if (typeof tree.title !== 'string' || tree.title.trim() === '') {
    fail('"title" must be a non-empty string.');
  }
  for (const [field, type] of [['description', 'string'], ['author', 'string']]) {
    if (tree[field] !== undefined && typeof tree[field] !== type) {
      fail(`"${field}", when present, must be a ${type}.`);
    }
  }
  if (tree.layout !== undefined && !LAYOUT_MODES.includes(tree.layout)) {
    fail(`"layout", when present, must be ${LAYOUT_MODES.map((m) => `"${m}"`).join(' or ')} (got ${JSON.stringify(tree.layout)}).`);
  }
  for (const field of ['title', 'description', 'author']) {
    if (typeof tree[field] !== 'string') continue;
    if (tree[field].length > MAX_LENGTHS[field]) {
      fail(`"${field}" is ${tree[field].length} characters; the limit is ${MAX_LENGTHS[field]}.`);
    }
    const control = controlCharProblem(tree[field], { keepWhitespace: field === 'description' });
    if (control) fail(`"${field}" ${control}.`);
  }
  if (!Array.isArray(tree.skills)) {
    // Without a skills array there is nothing further to check.
    fail('"skills" must be an array.');
    return problems;
  }
  if (tree.skills.length > MAX_SKILLS) {
    // Everything below is per-skill, so stop here rather than reporting a
    // thousand more problems about a tree that is already refused.
    fail(`"skills" has ${tree.skills.length} entries; the limit is ${MAX_SKILLS}.`);
    return problems;
  }

  // --- per-skill shape, and id collection ---
  const ids = new Set();
  tree.skills.forEach((skill, i) => {
    const where = `skills[${i}]`;
    if (skill === null || typeof skill !== 'object' || Array.isArray(skill)) {
      fail(`${where} must be an object.`);
      return;
    }
    const label = typeof skill.id === 'string' ? `"${skill.id}"` : where;

    if (typeof skill.id !== 'string' || !ID_PATTERN.test(skill.id)) {
      fail(`${where}: "id" must be lowercase letters, digits and hyphens (got ${JSON.stringify(skill.id)}).`);
    } else if (ids.has(skill.id)) {
      fail(`${where}: duplicate id ${label}.`);
    } else {
      ids.add(skill.id);
    }

    if (typeof skill.name !== 'string' || skill.name.trim() === '') {
      fail(`${label}: "name" must be a non-empty string.`);
    } else if (skill.name.length > MAX_LENGTHS.skillName) {
      fail(`${label}: "name" is ${skill.name.length} characters; the limit is ${MAX_LENGTHS.skillName}.`);
    } else {
      const control = controlCharProblem(skill.name);
      if (control) fail(`${label}: "name" ${control}.`);
    }
    if (skill.description !== undefined && typeof skill.description !== 'string') {
      fail(`${label}: "description", when present, must be a string.`);
    } else if (typeof skill.description === 'string' && skill.description.length > MAX_LENGTHS.skillDescription) {
      fail(`${label}: "description" is ${skill.description.length} characters; the limit is ${MAX_LENGTHS.skillDescription}.`);
    } else if (typeof skill.description === 'string') {
      const control = controlCharProblem(skill.description, { keepWhitespace: true });
      if (control) fail(`${label}: "description" ${control}.`);
    }
    if (skill.requires !== undefined && !Array.isArray(skill.requires)) {
      fail(`${label}: "requires", when present, must be an array.`);
    }
    if (skill.position !== undefined) {
      const p = skill.position;
      if (p === null || typeof p !== 'object' || Array.isArray(p) ||
          typeof p.x !== 'number' || typeof p.y !== 'number' ||
          !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        fail(`${label}: "position", when present, must be an object with finite numeric x and y.`);
      }
    }
  });

  // --- prerequisite references ---
  // Collects the flat list of prerequisite ids for a skill, reporting
  // malformed entries. Used for both reference checking and cycle detection.
  const prereqIdsOf = (skill, report) => {
    const label = typeof skill.id === 'string' ? `"${skill.id}"` : '(unnamed skill)';
    const out = [];
    if (!Array.isArray(skill.requires)) return out;

    for (const entry of skill.requires) {
      if (typeof entry === 'string') {
        out.push(entry);
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.anyOf)) {
        if (entry.anyOf.length === 0 && report) {
          fail(`${label}: "anyOf" must list at least one id.`);
        }
        for (const member of entry.anyOf) {
          if (typeof member !== 'string') {
            if (report) fail(`${label}: "anyOf" members must be id strings (got ${JSON.stringify(member)}).`);
          } else {
            out.push(member);
          }
        }
      } else if (report) {
        fail(`${label}: each "requires" entry must be an id string or an {"anyOf": [...]} object (got ${JSON.stringify(entry)}).`);
      }
    }
    return out;
  };

  // Counted before the references are walked: a tree this big is refused on
  // size alone, and the checks below are per-link.
  let prereqCount = 0;
  for (const skill of tree.skills) {
    if (skill && Array.isArray(skill.requires)) prereqCount += skill.requires.length;
  }
  if (prereqCount > MAX_PREREQS) {
    fail(`This tree has ${prereqCount} prerequisite links; the limit is ${MAX_PREREQS}.`);
    return problems;
  }

  const prereqMap = new Map(); // id -> [prereq ids]
  for (const skill of tree.skills) {
    if (typeof skill !== 'object' || skill === null) continue;
    const refs = prereqIdsOf(skill, true);
    if (typeof skill.id === 'string') prereqMap.set(skill.id, refs);

    const label = typeof skill.id === 'string' ? `"${skill.id}"` : '(unnamed skill)';
    for (const ref of refs) {
      if (!ids.has(ref)) {
        fail(`${label}: requires "${ref}", which is not a skill in this tree.`);
      }
      if (ref === skill.id) {
        fail(`${label}: requires itself.`);
      }
    }
  }

  // --- cycles ---
  // Depth-first search over prerequisite edges; a back edge means a cycle.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map([...ids].map((id) => [id, WHITE]));
  const reported = new Set();

  const visit = (id, stack) => {
    color.set(id, GREY);
    stack.push(id);
    for (const next of prereqMap.get(id) || []) {
      if (!ids.has(next)) continue; // already reported as a bad reference
      const c = color.get(next);
      if (c === GREY) {
        // Found a cycle: report it once, normalized so the same loop
        // discovered from different entry points isn't reported twice.
        const loop = stack.slice(stack.indexOf(next)).concat(next);
        const key = [...loop].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          fail(`Cycle in prerequisites: ${loop.map((s) => `"${s}"`).join(' -> ')}.`);
        }
      } else if (c === WHITE) {
        visit(next, stack);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const id of ids) {
    if (color.get(id) === WHITE) visit(id, []);
  }

  return problems;
}

module.exports = { validate };

// --- CLI ---
if (require.main === module) {
  const fs = require('node:fs');
  const path = process.argv[2];

  if (!path) {
    console.error('Usage: node tools/validate-tree.js <file.json>');
    process.exit(1);
  }

  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`Could not read ${path}: ${e.message}`);
    process.exit(1);
  }

  let tree;
  try {
    tree = JSON.parse(raw);
  } catch (e) {
    console.error(`${path} is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  const problems = validate(tree);
  if (problems.length === 0) {
    const n = Array.isArray(tree.skills) ? tree.skills.length : 0;
    const roots = (tree.skills || []).filter(
      (s) => !Array.isArray(s.requires) || s.requires.length === 0
    ).length;
    console.log(`${path}: valid — ${n} skill${n === 1 ? '' : 's'}, ${roots} starting point${roots === 1 ? '' : 's'}.`);
    process.exit(0);
  }

  console.error(`${path}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
