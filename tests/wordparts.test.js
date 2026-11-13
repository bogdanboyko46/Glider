// node tests/wordparts.test.js — prefixes, roots and suffixes: the splitter's rules and the bundled data.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'glider-extension');
const P = require(path.join(dir, 'content', 'wordParts.js'));

let failed = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL', m); failed++; } else console.log('ok  ', m); };
const show = (parts) => (parts ? parts.map((p) => (p.type === 'w' ? `[${p.base}]` : p.form)).join(' + ') : '-');

// 1. The rules, on a tiny made-up dictionary.
{
  const lex = { happy: 'a', unhappy: 'a', kind: 'an', teach: 'v', write: 'v', late: 'ar', cle: '', care: 'nv', careful: 'a', numb: 'av', port: 'nv', sect: 'n', correct: 'av' };
  const links = new Set(['teacher|teach', 'careful|care', 'carefully|careful', 'happiness|happy']);
  const posOf = (w) => lex[w] || '';
  const related = (a, b) => links.has(a + '|' + b) || links.has(b + '|' + a);
  const s = (w) => show(P.split(w, posOf, related));
  assert(s('unhappy') === 'un + [happy]', `un + happy (${s('unhappy')})`);
  assert(s('rewrite') === 're + [write]', `re + write (${s('rewrite')})`);
  assert(s('kindness') === '[kind] + ness', `kind + ness (${s('kindness')})`);
  assert(s('teacher') === '[teach] + er', `teach + er, linked in the dictionary (${s('teacher')})`);
  assert(s('carefully') === '[care] + ful + ly', `care + ful + ly (${s('carefully')})`);
  assert(s('unhappiness') === 'un + [happy] + ness', `un + happi(ness), respelled base (${s('unhappiness')})`);
  assert(s('relate') === '-', 're + late is refused: late is not a verb');
  assert(s('number') === '-', 'numb + er is refused: number is not linked to numb');
  assert(s('uncle') === '-', 'uncle is refused');
  assert(s('incorrect') === 'in + [correct]' && P.split('incorrect', posOf, related)[0].id === 'in.not', 'in- before an adjective means "not"');
  assert(s('inspect') === 'in + spect' && P.split('inspect', posOf, related)[0].id === 'in.into', 'in- before a root means "into"');
  assert(s('insect') === '-', 'in + sect is refused: sect is a noun and not a root');
  assert(s('transport') === 'trans + port' && P.split('transport', posOf, related)[1].type === 'r', 'a word that is also a root shows as the root (port: carry)');
  assert(s('biology') === 'bio + logy', `bio + logy, not bi + ology (${s('biology')})`);
  assert(s('geography') === 'geo + graphy', `geo + graphy (${s('geography')})`);
  assert(s('thermometer') === 'therm + meter', `therm-o-meter with a connecting vowel (${s('thermometer')})`);
  assert(P.split('', posOf) === null && P.split('cat', posOf) === null && P.split('x'.repeat(40), posOf) === null && P.split(null, posOf) === null, 'empty, short and long input -> null');
  const parts = P.split('unhappiness', posOf, related);
  assert(parts.map((p) => 'unhappiness'.slice(p.start, p.end)).join('') === 'unhappiness', 'parts cover the word exactly');
  const flat = (ps) => ps.map((p) => [p.type, p.id, p.start, p.end, p.form, p.base || ''].join(':')).join(' ');
  assert(flat(P.decode(P.encode(parts), 'unhappiness')) === flat(parts), 'encode and decode round-trip');
  const thermo = P.split('thermometer', posOf, related);
  assert(thermo && thermo[0].end === thermo[1].start && 'thermometer'.slice(thermo[0].start, thermo[0].end) === 'thermo', 'a connecting vowel joins the part before it (thermo + meter)');
}

// 2. Meanings.
assert(P.describe({ type: 'p', id: 'un' }).label === 'un-' && /not/.test(P.describe({ type: 'p', id: 'un' }).meaning), 'un- means not');
assert(P.describe({ type: 's', id: 'ness' }).label === '-ness' && P.describe({ type: 's', id: 'ness' }).kind === 'suffix', '-ness is a suffix');
assert(P.describe({ type: 'r', id: 'spect' }).meaning === 'look', 'spect means look');
assert(P.describe({ type: 'p', id: 'in.into' }).meaning !== P.describe({ type: 'p', id: 'in.not' }).meaning, 'the two in- have different meanings');
assert(P.describe({ type: 'w', id: 'happy', base: 'happy' }).kind === 'base word', 'base words are labelled');
assert(P.PARTS.every((p) => p.meaning && p.example && /^[a-z]+$/.test(p.form)), `all ${P.PARTS.length} parts have a meaning and an example`);
assert(new Set(P.PARTS.map((p) => p.type + ':' + p.id)).size === P.PARTS.length, 'part ids are unique');

// 3. The bundled data (built from WordNet by tools/make-wordparts.js).
{
  const text = fs.readFileSync(path.join(dir, 'data', 'wordparts.txt'), 'utf8');
  const table = new Map(text.split('\n').filter(Boolean).map((l) => { const t = l.indexOf('\t'); return [l.slice(0, t), l.slice(t + 1)]; }));
  const got = (w) => (table.has(w) ? show(P.decode(table.get(w), w)) : '-');
  assert(table.size > 5000 && !text.includes('\r'), `data has ${table.size} words, LF ends`);
  for (const [w, want] of [['unhappiness', 'un + [happy] + ness'], ['teacher', '[teach] + er'], ['carefully', '[care] + ful + ly'],
    ['information', '[inform] + ation'], ['transport', 'trans + port'], ['inspect', 'in + spect'], ['biology', 'bio + logy'],
    ['telephone', 'tele + phone'], ['hypothesis', 'hypo + thesis'], ['structure', 'struct + ure'], ['impossible', 'im + [possible]'],
    ['international', 'inter + [national]'], ['extension', 'ex + tens + ion'], ['export', 'ex + port'], ['photosynthesis', 'photo + [synthesis]']]) {
    assert(got(w) === want, `${w}: ${got(w)}`);
  }
  for (const w of ['uncle', 'relate', 'number', 'reason', 'present', 'insect', 'accumulate', 'preachy', 'explosion', 'mother', 'island']) {
    assert(!table.has(w), `${w} is not split`);
  }
  let bad = 0;
  for (const [w, enc] of table) {
    const parts = P.decode(enc, w);
    if (parts.map((p) => w.slice(p.start, p.end)).join('') !== w || parts.some((p) => !P.describe(p))) bad++;
  }
  assert(bad === 0, `every entry covers its word and every part has a meaning (${bad} bad)`);
}

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall word part tests passed');
