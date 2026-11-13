// node tests/worddata.test.js — definitions (WordNet) and word parts, looked up from the bundled lists.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'glider-extension');
const D = require(path.join(dir, 'content', 'wordData.js'));

let failed = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL', m); failed++; } else console.log('ok  ', m); };

const dictText = fs.readFileSync(path.join(dir, 'data', 'dictionary.txt'), 'utf8');
const dict = D.prepare(dictText);
const parts = D.prepare(fs.readFileSync(path.join(dir, 'data', 'wordparts.txt'), 'utf8'));

// Definitions.
let d = D.define(dict, 'accumulate');
assert(d && d.word === 'accumulate' && d.senses[0].posName === 'verb' && /gather/.test(d.senses[0].def), `accumulate: ${d && d.senses[0].def}`);
assert(d.senses.length >= 1 && d.senses.length <= 3, 'at most three senses');
d = D.define(dict, 'Photosynthesis');
assert(d && /energy|light/.test(d.senses[0].def), 'case does not matter');
d = D.define(dict, 'studies');
assert(d && d.word === 'study', `studies -> study (${d && d.word})`);
d = D.define(dict, 'went');
assert(d && d.word === 'go', `went -> go, an irregular form (${d && d.word})`);
d = D.define(dict, 'mice');
assert(d && d.word === 'mouse', 'mice -> mouse');
d = D.define(dict, 'running');
assert(d && (d.word === 'running' || d.word === 'run'), `running is found (${d && d.word})`);
assert(D.define(dict, 'zzxqv') === null && D.define(dict, '') === null && D.define(null, 'cat') === null, 'unknown -> null');
assert(D.define(dict, 'a'.repeat(100)) === null, 'very long input -> null');
const examples = dictText.split('\n').filter(Boolean).slice(0, 4000).filter((l) => !l.includes('\t@'));
assert(examples.every((l) => l.split('\t').slice(1).every((s) => /^[nvar]\|[^|]+\|[^|]*$/.test(s))), 'every sense is pos|definition|example');
assert(!dictText.includes('\r'), 'LF line ends');

// Word parts.
let p = D.partsOf(parts, 'unhappiness');
assert(p && p.map((x) => x.label).join(' ') === 'un- happy -ness', `unhappiness: ${p && p.map((x) => x.label).join(' ')}`);
assert(p[0].kind === 'prefix' && /not/.test(p[0].meaning) && p[1].kind === 'base word' && p[2].kind === 'suffix', 'kinds and meanings attached');
p = D.partsOf(parts, 'teachers');
assert(p && p.map((x) => x.form).join('|') === 'teach|er', `teachers uses teacher's split (${p && p.map((x) => x.form).join('|')})`);
assert(D.partsOf(parts, 'uncle') === null && D.partsOf(parts, '') === null, 'no parts -> null');

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall word data tests passed');
