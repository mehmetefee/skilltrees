// Conversion between database records and the portable JSON notation
// described in FORMAT.md.
//
// Validation deliberately lives in tools/validate-tree.js and is reused here,
// so the rules the CLI enforces and the rules the API enforces cannot drift.

const { validate } = require('../../tools/validate-tree.js');
// Shared with the browser — see the comment at the top of that file for why
// it lives under frontend/.
const { computeLayout } = require('../../frontend/layout.js');

const LAYOUT_MODES = ['auto', 'manual'];
const DEFAULT_LAYOUT = 'manual';

// Laying a graph out is the expensive part of an import or an export, and the
// export endpoint needs no account: without this, anyone could make the
// server redo the same layout for the same tree as fast as they could ask.
// The key is the input itself — the skills and the links, in order — so a
// hit is only ever a tree that would compute to exactly this answer, and
// there is no staleness to invalidate. The positions Map is shared with
// every caller of a hit, so treat what comes back as read-only.
const LAYOUT_CACHE_LIMIT = 20;
const layoutCache = new Map();

function cachedLayout(nodes, edges) {
  const key = JSON.stringify([nodes.map((n) => n.id), edges.map((e) => [e.from, e.to])]);
  const hit = layoutCache.get(key);
  if (hit) return hit;

  const positions = computeLayout(nodes, edges);
  // Oldest out first: Map iterates in insertion order, so the first key is
  // the least recently added.
  if (layoutCache.size >= LAYOUT_CACHE_LIMIT) {
    layoutCache.delete(layoutCache.keys().next().value);
  }
  layoutCache.set(key, positions);
  return positions;
}

// ---------- slugs ----------

// Turns a display name into an id candidate. Accented Latin is transliterated
// rather than stripped, so "Hamur yoğurmak" becomes "hamur-yogurmak" instead
// of "hamur-yourmak". Scripts with no Latin equivalent (Japanese, Cyrillic,
// ...) reduce to "" and get a positional fallback from uniqueSlug().
function slugify(name) {
  return String(name == null ? '' : name)
    .normalize('NFD')                      // ö -> o + combining diaeresis
    .replace(/[̀-ͯ]/g, '')       // ...then drop the combining marks
    .replace(/ı/g, 'i')                    // dotless i does not decompose
    .replace(/İ/g, 'i')
    .replace(/ß/g, 'ss')
    .replace(/ø/gi, 'o')
    .replace(/đ/gi, 'd')
    .replace(/ł/gi, 'l')
    .replace(/æ/gi, 'ae')
    .replace(/œ/gi, 'oe')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Ids must be unique within a tree, but names need not be — two skills called
// "Practice" must still export to distinct ids.
function uniqueSlug(base, used, fallbackIndex) {
  let candidate = base || `skill-${fallbackIndex}`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let n = 2;
  while (used.has(`${candidate}-${n}`)) n++;
  const result = `${candidate}-${n}`;
  used.add(result);
  return result;
}

// ---------- database -> notation ----------

// `tree` is a row from `trees`; `skills` and `edges` are its rows.
//
// `layout` picks what the exported file says about positions:
//   'manual' - the file carries coordinates and importers must honor them
//   'auto'   - the file carries no coordinates at all; importers arrange it
//
// `positions` optionally overrides the stored coordinates with a Map (or plain
// object) of skill id -> {x, y}. The browser passes its current on-screen
// arrangement this way, since dragging is session-only and never reaches the
// database.
function treeToNotation({ tree, skills, edges }, { layout = DEFAULT_LAYOUT, positions = null } = {}) {
  const mode = LAYOUT_MODES.includes(layout) ? layout : DEFAULT_LAYOUT;
  const used = new Set();
  const slugById = new Map();
  skills.forEach((skill, i) => {
    slugById.set(skill.id, uniqueSlug(slugify(skill.name), used, i + 1));
  });

  const lookup = (id) => {
    if (!positions) return null;
    const p = positions instanceof Map ? positions.get(id) : positions[id];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  };

  // A tree stored as auto has meaningless coordinates in the database, so
  // exporting it as manual has to compute them rather than emit zeroes.
  let computed = null;
  if (mode === 'manual' && tree.layout === 'auto' && !positions) {
    computed = cachedLayout(
      skills.map((s) => ({ id: s.id })),
      edges.map((e) => ({ from: e.prereq_skill_id, to: e.skill_id }))
    );
  }

  const notation = {
    format: 'skilltree',
    version: 1,
    title: tree.title,
    description: tree.description || '',
    author: tree.author || 'Anonymous',
    layout: mode,
    skills: skills.map((skill) => {
      const out = {
        id: slugById.get(skill.id),
        name: skill.name,
      };
      if (skill.description) out.description = skill.description;
      out.requires = edges
        .filter((e) => e.skill_id === skill.id)
        .map((e) => slugById.get(e.prereq_skill_id));

      if (mode === 'manual') {
        const p = lookup(skill.id) || (computed && computed.get(skill.id)) || {
          x: skill.pos_x,
          y: skill.pos_y,
        };
        // Rounded: sub-pixel precision is noise in a hand-editable file, and
        // rounding keeps export -> import -> export byte-identical.
        out.position = { x: Math.round(p.x), y: Math.round(p.y) };
      }
      return out;
    }),
  };

  return notation;
}

// ---------- notation -> database ----------

// Flat list of prerequisite ids for a skill. Assumes the tree has already
// passed validate(); anyOf is rejected separately by findUnsupported().
function prereqIdsOf(skill) {
  if (!Array.isArray(skill.requires)) return [];
  return skill.requires.filter((r) => typeof r === 'string');
}

// The notation can express trees this application cannot store. Rather than
// silently flattening them (which would change what the tree means), import
// refuses them and says so.
function findUnsupported(notation) {
  const problems = [];
  for (const skill of notation.skills) {
    if (!Array.isArray(skill.requires)) continue;
    for (const entry of skill.requires) {
      if (entry && typeof entry === 'object' && Array.isArray(entry.anyOf)) {
        problems.push(
          `"${skill.id}" uses "anyOf". Alternative prerequisites are part of the notation but are not supported by this site yet, and importing it as a plain list of requirements would change the tree's meaning.`
        );
        break;
      }
    }
  }
  return problems;
}

// Positions for a notation tree, using the layout algorithm shared with the
// browser so an imported tree looks the same as a rendered one.
function autoLayout(notation) {
  const nodes = notation.skills.map((s) => ({ id: s.id }));
  const edges = [];
  for (const skill of notation.skills) {
    for (const prereq of prereqIdsOf(skill)) {
      edges.push({ from: prereq, to: skill.id });
    }
  }
  return cachedLayout(nodes, edges);
}

// A tree's layout mode, normalized. Absent means "manual", which keeps every
// file written before this field existed behaving exactly as it did.
function layoutModeOf(notation) {
  return LAYOUT_MODES.includes(notation.layout) ? notation.layout : DEFAULT_LAYOUT;
}

// Turns a validated notation object into rows ready for insertion.
// Returns { tree, skills, edges } where skills/edges reference notation ids;
// the caller maps those to database ids as it inserts.
function notationToRecords(notation) {
  const mode = layoutModeOf(notation);
  const layout = autoLayout(notation);

  const skills = notation.skills.map((skill) => {
    const fallback = layout.get(skill.id) || { x: 0, y: 0 };
    // In auto mode the file's coordinates (if any) are not authoritative —
    // the computed layout is what the tree means.
    const given = mode === 'auto' ? null : skill.position;
    return {
      slug: skill.id,
      name: skill.name,
      description: typeof skill.description === 'string' ? skill.description : '',
      pos_x: given && typeof given.x === 'number' ? given.x : fallback.x,
      pos_y: given && typeof given.y === 'number' ? given.y : fallback.y,
    };
  });

  const edges = [];
  for (const skill of notation.skills) {
    for (const prereq of prereqIdsOf(skill)) {
      edges.push({ skillSlug: skill.id, prereqSlug: prereq });
    }
  }

  return {
    tree: {
      title: notation.title,
      description: typeof notation.description === 'string' ? notation.description : '',
      author:
        typeof notation.author === 'string' && notation.author.trim()
          ? notation.author
          : 'Anonymous',
      layout: mode,
    },
    skills,
    edges,
  };
}

// Full import check: format rules first, then what this app can actually
// store. Returns an array of problems; empty means importable.
function checkImportable(notation) {
  const problems = validate(notation);
  if (problems.length > 0) return problems;
  return findUnsupported(notation);
}

module.exports = {
  slugify,
  uniqueSlug,
  treeToNotation,
  notationToRecords,
  findUnsupported,
  checkImportable,
  autoLayout,
  layoutModeOf,
  LAYOUT_MODES,
  DEFAULT_LAYOUT,
};
