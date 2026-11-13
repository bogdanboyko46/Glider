// node tests/difficulty.test.js — the reading difficulty score (Easy / Medium / Hard to read) on real words.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'glider-extension');
const D = require(path.join(dir, 'content', 'readingDifficulty.js'));
const L = require(path.join(dir, 'content', 'wordLevels.js'));
const S = require(path.join(dir, 'content', 'syllableParser.js'));
const H = require(path.join(dir, 'content', 'homophones.js'));

let failed = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL', m); failed++; } else console.log('ok  ', m); };

const levels = L.parse(fs.readFileSync(path.join(dir, 'data', 'levels.txt'), 'utf8'));
const say = new Map(fs.readFileSync(path.join(dir, 'data', 'pronounce.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')));
const split = S.split || (S.Syllables && S.Syllables.split);
const rate = (word) => {
  const lv = L.lookup(levels, word);
  return D.rate({ word, level: lv ? lv.level : null, syllables: split(word), say: say.get(word) || null, lookalike: !!H.lookupHomophone(word) });
};

// 1. The words that looked wrong with CEFR alone.
const expect = {
  easy: ['cat', 'always', 'laud', 'tame', 'information', 'garden', 'kindness'],
  medium: ['vegetable', 'comfortable', 'beautiful', 'accumulate', 'yacht', 'knowledge', 'particularly', 'temperature', 'chocolate'],
  hard: ['hypothesis', 'photosynthesis', 'epistemology', 'chrysanthemum', 'onomatopoeia'],
};
for (const [band, words] of Object.entries(expect)) {
  for (const w of words) {
    const r = rate(w);
    assert(r.band === band, `${w}: ${r.band} (${r.score.toFixed(2)}; ${r.reasons.join(', ') || 'no reasons'}) — expected ${band}`);
  }
}

// 2. Reasons say why, in plain words.
assert(rate('vegetable').reasons.some((r) => /not said|silent/i.test(r)), `vegetable: a part is not said (${rate('vegetable').reasons})`);
assert(rate('photosynthesis').reasons.some((r) => /syllables/.test(r)), 'photosynthesis: counts its syllables');
assert(rate('knowledge').reasons.some((r) => /silent k/.test(r)), `knowledge: silent k (${rate('knowledge').reasons})`);
assert(rate('through').reasons.some((r) => /ough/.test(r)), `through: the ough spelling (${rate('through').reasons})`);
assert(rate('their').reasons.some((r) => /confused/.test(r)), `their: easily confused (${rate('their').reasons})`);
assert(rate('laud').reasons.every((r) => !/syllable/.test(r)), 'laud: no length reason for a short word');
assert(rate('accumulate').reasons.length <= 2, 'at most two reasons');

// 3. Order and robustness.
assert(rate('photosynthesis').score > rate('vegetable').score && rate('vegetable').score > rate('cat').score, 'longer, rarer, trickier words score higher');
assert(D.rate({ word: 'zzz' }).band === 'easy' && D.rate({}).band === 'easy' && D.rate(null).band === 'easy', 'missing input does not throw');
assert(['easy', 'medium', 'hard'].every((b) => D.BANDS[b] && D.BANDS[b].name), 'every band has a name');

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall difficulty tests passed');
