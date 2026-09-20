// Confirms the validator accepts valid trees and rejects each documented
// failure mode. Each case asserts on the *substance* of the error, not just
// that some error appeared.
const { validate } = require('../tools/validate-tree.js');

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`PASS - ${label}`); }
  else { fail++; console.log(`FAIL - ${label}${detail ? '\n        got: ' + JSON.stringify(detail) : ''}`); }
};

const base = (skills, extra = {}) => ({
  format: 'skilltree', version: 1, title: 'T', skills, ...extra,
});
const s = (id, requires) => ({ id, name: id, ...(requires ? { requires } : {}) });
const has = (probs, substr) => probs.some((p) => p.includes(substr));

// --- valid cases ---
check('minimal valid tree', validate(base([s('a')])).length === 0, validate(base([s('a')])));
check('empty skills array is valid', validate(base([])).length === 0);
check('chain a<-b<-c valid', validate(base([s('a'), s('b', ['a']), s('c', ['b'])])).length === 0);
check('diamond (two paths rejoin) valid',
  validate(base([s('a'), s('b', ['a']), s('c', ['a']), s('d', ['b', 'c'])])).length === 0);
check('anyOf accepted',
  validate(base([s('a'), s('b'), s('c', [{ anyOf: ['a', 'b'] }])])).length === 0,
  validate(base([s('a'), s('b'), s('c', [{ anyOf: ['a', 'b'] }])])));
check('unknown + x- fields ignored',
  validate(base([{ id: 'a', name: 'A', 'x-color': '#fff', futureField: 1 }], { futureTop: true })).length === 0);
check('position optional / partial',
  validate(base([s('a'), { id: 'b', name: 'B', position: { x: 1, y: 2 } }])).length === 0);

// --- top-level shape ---
check('wrong format rejected', has(validate({ ...base([]), format: 'nope' }), '"format"'));
check('missing version rejected', has(validate({ format: 'skilltree', title: 'T', skills: [] }), '"version"'));
check('future version rejected', has(validate({ ...base([]), version: 99 }), 'Unsupported version'));
check('empty title rejected', has(validate({ ...base([]), title: '   ' }), '"title"'));
check('missing skills rejected', has(validate({ format: 'skilltree', version: 1, title: 'T' }), '"skills"'));
check('non-object top level rejected', has(validate([]), 'Top level'));

// --- skill shape ---
check('bad id charset rejected', has(validate(base([{ id: 'Not Valid', name: 'x' }])), '"id"'));
check('id with underscores rejected', has(validate(base([{ id: 'bulk_ferment', name: 'x' }])), '"id"'));
check('duplicate ids rejected', has(validate(base([s('a'), s('a')])), 'duplicate id'));
check('missing name rejected', has(validate(base([{ id: 'a' }])), '"name"'));
check('bad position rejected', has(validate(base([{ id: 'a', name: 'A', position: { x: 'far', y: 0 } }])), '"position"'));
check('requires as string rejected', has(validate(base([{ id: 'a', name: 'A', requires: 'b' }])), '"requires"'));

// --- references ---
check('dangling reference rejected',
  has(validate(base([s('a', ['ghost'])])), 'not a skill in this tree'));
check('dangling reference inside anyOf rejected',
  has(validate(base([s('a'), s('b', [{ anyOf: ['a', 'ghost'] }])])), 'not a skill in this tree'));
check('empty anyOf rejected', has(validate(base([s('a', [{ anyOf: [] }])])), 'at least one id'));
check('non-string anyOf member rejected',
  has(validate(base([s('a'), s('b', [{ anyOf: [{ anyOf: ['a'] }] }])])), 'id strings'));
check('malformed requires entry rejected',
  has(validate(base([s('a', [123])])), 'must be an id string'));

// --- cycles ---
check('self-reference rejected', has(validate(base([s('a', ['a'])])), 'requires itself'));
const twoCycle = validate(base([s('a', ['b']), s('b', ['a'])]));
check('2-cycle rejected', has(twoCycle, 'Cycle in prerequisites'), twoCycle);
check('2-cycle reported once', twoCycle.filter((p) => p.includes('Cycle')).length === 1, twoCycle);
const threeCycle = validate(base([s('a', ['c']), s('b', ['a']), s('c', ['b'])]));
check('3-cycle rejected', has(threeCycle, 'Cycle in prerequisites'), threeCycle);
check('3-cycle reported once', threeCycle.filter((p) => p.includes('Cycle')).length === 1, threeCycle);
check('cycle reachable only from a root is caught',
  has(validate(base([s('root'), s('a', ['b']), s('b', ['a']), s('leaf', ['a', 'root'])])), 'Cycle'));

// --- limits (FORMAT.md "Limits") ---
// The size ones matter beyond tidiness: laying a tree out costs more than
// linear time in its skills and links, and the import endpoint runs that on
// the thread serving every other request.
const many = (n) => Array.from({ length: n }, (_, i) => s('s' + i));
check('1000 skills accepted', validate(base(many(1000))).length === 0);
check('1001 skills rejected', has(validate(base(many(1001))), 'the limit is 1000'));
const atLinkLimit = base([
  ...Array.from({ length: 20 }, (_, i) => s('r' + i)),
  ...Array.from({ length: 250 }, (_, i) => s('d' + i, Array.from({ length: 20 }, (_, j) => 'r' + j))),
]);
check('5000 prerequisite links accepted', validate(atLinkLimit).length === 0, validate(atLinkLimit));
const denseTree = base([
  ...Array.from({ length: 60 }, (_, i) => s('r' + i)),
  ...Array.from({ length: 90 }, (_, i) => s('d' + i, Array.from({ length: 60 }, (_, j) => 'r' + j))),
]);
check('5400 prerequisite links rejected', has(validate(denseTree), 'the limit is 5000'), validate(denseTree));
check('long title rejected', has(validate({ ...base([]), title: 'x'.repeat(121) }), 'the limit is 120'));
check('title at the limit accepted', validate({ ...base([]), title: 'x'.repeat(120) }).length === 0);
check('long tree description rejected',
  has(validate({ ...base([]), description: 'x'.repeat(1001) }), 'the limit is 1000'));
check('long author rejected', has(validate({ ...base([]), author: 'x'.repeat(81) }), 'the limit is 80'));
check('long skill name rejected',
  has(validate(base([{ id: 'a', name: 'x'.repeat(121) }])), 'the limit is 120'));
check('long skill description rejected',
  has(validate(base([{ id: 'a', name: 'A', description: 'x'.repeat(1001) }])), 'the limit is 1000'));

// --- control characters (they reach logs and the operator's terminal) ---
const ESC = String.fromCharCode(27), NL = String.fromCharCode(10), TAB = String.fromCharCode(9);
check('escape sequence in title rejected',
  has(validate({ ...base([]), title: 'Sourdough' + ESC + '[2K' }), 'control character'));
check('newline in title rejected',
  has(validate({ ...base([]), title: 'A' + NL + '[AUTH] login success user=admin' }), 'control character'));
check('newline in author rejected', has(validate({ ...base([]), author: 'A' + NL + 'B' }), 'control character'));
check('escape sequence in skill name rejected',
  has(validate(base([{ id: 'a', name: 'Knead' + ESC + '[2K' }])), 'control character'));
check('newlines and tabs allowed in a description',
  validate({ ...base([{ id: 'a', name: 'A', description: 'line one' + NL + TAB + 'line two' }]),
    description: 'para one' + NL + NL + 'para two' }).length === 0);
check('escape sequence in a description still rejected',
  has(validate({ ...base([]), description: 'x' + ESC + 'y' }), 'control character'));

// --- multiple problems reported together ---
const messy = validate(base([{ id: 'Bad Id' }, s('a', ['ghost'])]));
check('multiple problems all reported', messy.length >= 3, messy);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
