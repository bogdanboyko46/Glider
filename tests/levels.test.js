// node tests/levels.test.js — word level lookup (CEFR A1..C2) and the bundled list.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'glider-extension');
const L = require(path.join(dir, 'content', 'wordLevels.js'));

let failed = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL', m); failed++; } else console.log('ok  ', m); };

const text = fs.readFileSync(path.join(dir, 'data', 'levels.txt'), 'utf8');
const table = L.parse(text);
const level = (w) => { const r = L.lookup(table, w); return r ? r.level : null; };

// 1. The list itself.
assert(table.size > 8000, `list has ${table.size} words`);
assert(/^[a-z][^\t\r\n]*\t(A1|A2|B1|B2|C1|C2)\n/.test(text) && !text.includes('\r'), 'every line is word<TAB>level with LF ends');
assert(level('cat') === 'A1' && level('beautiful') === 'A1', 'everyday words are A1');
assert(level('yacht') === 'B2', 'yacht is B2 (CEFR-J)');
assert(level('hypothesis') === 'C2' && level('exterior') === 'C1', 'C1/C2 words come from Octanove');
assert(level('colour') === level('color') && level('colour') !== null, 'British and American spellings both listed');

// 2. Inflected forms find their base word.
for (const [form, base] of [['studies', 'study'], ['watches', 'watch'], ['cats', 'cat'], ['studied', 'study'], ['hoped', 'hope'],
  ['stopped', 'stop'], ['making', 'make'], ['hoping', 'hope'], ['chatting', 'chat'], ['jogged', 'jog'], ['talking', 'talk'],
  ["cat's", 'cat'], ['Hypotheses', null]]) {
  const r = L.lookup(table, form);
  if (base === null) assert(r === null || r.base !== form.toLowerCase(), `${form}: no false match`);
  else assert(r && r.base === base && r.level === level(base), `${form} -> ${base} (${r && r.level})`);
}

// 3. Exact words win over stripped forms, and unknown words are null.
assert(L.lookup(table, 'news').base === 'news', 'news is its own word, not new + s');
assert(L.lookup(table, 'running').base === 'running' && L.lookup(table, 'running').level === 'A2', 'a form listed in its own right keeps its own level');
assert(L.lookup(table, 'thing').base === 'thing', 'thing is not th + ing');
assert(L.lookup(table, 'Beautiful').base === 'beautiful', 'case does not matter');
assert(L.lookup(table, 'it’s') !== undefined, 'curly apostrophes are handled');
assert(L.lookup(table, 'zzxqv') === null && L.lookup(table, '') === null && L.lookup(table, null) === null, 'unknown or empty -> null');
assert(L.lookup(table, 'x'.repeat(200)) === null, 'very long input -> null');

// 4. Labels for people.
assert(L.LEVELS.length === 6 && L.LEVELS.every((l) => L.INFO[l] && L.INFO[l].name), 'every level has a plain name');
assert(L.INFO.B1.name === 'Intermediate', 'B1 is Intermediate');

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall level tests passed');
