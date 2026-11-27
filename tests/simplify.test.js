// node tests/simplify.test.js — the offline text simplifier (glider-extension/simplify/simplifier.js)
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'glider-extension', 'simplify', 'simplifier.js'));
let failed = 0;
const eq = (text, want, label) => {
  const got = S.simplify(text).text;
  if (got === want) console.log('ok  ', label); else { failed++; console.error('FAIL', label, '\n   got ', got, '\n   want', want); }
};
const ok = (c, label) => { if (c) console.log('ok  ', label); else { failed++; console.error('FAIL', label); } };

eq('The cat sat on the mat.', 'The cat sat on the mat.', 'plain text is left alone');
ok(S.simplify('The cat sat on the mat.').changed === false, 'changed is false when nothing changed');
eq('', '', 'empty text');
ok(S.simplify(null).text === '' && S.simplify(undefined).text === '' && S.simplify(42).text === '42', 'non-string input does not throw');

eq('Scientists utilize numerous techniques.', 'Scientists use many ways.', 'hard words become common words');
eq('Utilize the tool. PURCHASE it now.', 'Use the tool. BUY it now.', 'capitalisation is kept');
eq('She demonstrates the method and it requires care.', 'She shows the way and it needs care.', 'the -s ending is carried over');
eq('They utilized it. He is utilizing it.', 'They used it. He is using it.', '-ed and -ing are carried over for regular verbs');
eq('They obtained the data.', 'They obtained the data.', 'no "getted": irregular replacements are skipped for -ed');
eq('We met Constant Lambert in Reading.', 'We met Constant Lambert in Reading.', 'capitalised words inside a sentence (names) are left alone');
eq('Approximately 40% of 1,250 samples.', 'About 40% of 1,250 samples.', 'numbers are untouched');
eq('The enzyme’s technique is crucial.', 'The enzyme’s way is key.', 'possessives survive');
eq('This is an enormous task.', 'This is a huge job.', 'a / an agrees with the new word');

eq('In order to win, practise.', 'To win, practise.', 'wordy phrases are shortened');
eq('It is important to note that plants need light.', 'Plants need light.', 'empty openers are dropped and the sentence re-capitalised');
eq('Due to the fact that it rained, we stayed.', 'Because it rained, we stayed.', 'phrase replacement keeps sentence case');

const long1 = 'Inside the chloroplast, chlorophyll absorbs mostly red and blue light and reflects green, which is why leaves look green to us.';
eq(long1, 'Inside the chloroplast, chlorophyll takes in mostly red and blue light and reflects green. This is why leaves look green to us.', 'long sentence splits at ", which is"');
const long2 = 'The enzyme responsible for the first step is probably the most abundant protein on Earth, and it is famously slow and inefficient at its job.';
eq(long2, 'The enzyme responsible for the first step is likely the most abundant protein on Earth. It is famously slow and wasteful at its job.', 'long sentence splits at ", and it"');
eq('Researchers utilized numerous techniques over many years of careful work; however, the results were insufficient.',
  'Researchers used many ways over many years of careful work. But the results were insufficient.', '"; however," becomes a new sentence');
eq('It rained, but we went.', 'It rained, but we went.', 'short sentences are not split');
// Found in the 2026-11-25 review: swaps that changed the meaning or broke the grammar.
eq('It went out for a few minutes.', 'It went out for a few minutes.', '"minutes" (time) is not made "tinies"');
eq('The governor regulated the speed.', 'The governor controlled the speed.', 'control doubles its l: controlled');
eq('They stored a sufficient quantity of honey and left immediately after.', 'They stored a sufficient amount of honey and left immediately after.', 'no "an enough amount", no "at once after"');
eq('The workers were rapidly contracting their muscles.', 'The workers were quickly contracting their muscles.', 'adverbs become adverbs ("quickly", not "fast")');
eq('The impact was large and the state paid.', 'The impact was large and the state paid.', 'nouns that are also verbs are left alone (impact, state)');
eq('Once upon a time, provided that it rained, we stayed in.', 'Once upon a time, provided that it rained, we stayed in.', 'set phrases are left alone (upon, provided that)');
eq('The results, however, were good and it is therefore true.', 'The results, however, were good and it is therefore true.', 'connectives mid-sentence are left alone');
eq('She wrote that the spray reached the gallery, which stood more than thirty metres above the rocks, and that the glass rattled so hard in its frame that she feared it would shatter.',
  'She wrote that the spray reached the gallery, which stood more than thirty metres above the rocks, and that the glass rattled so hard in its frame that she feared it would shatter.', 'no split before ", and that" (it carries on the clause begun earlier)');
ok(S.simplify(long1).splits === 1 && S.simplify(long1).swaps.length === 1, 'splits and swaps are reported');

for (const t of [long1, long2, 'In order to demonstrate the hypothesis, researchers utilized numerous techniques; however, the results were insufficient.']) {
  const once = S.simplify(t).text;
  ok(S.simplify(once).text === once, 'simplifying twice changes nothing more: ' + once.slice(0, 40) + '…');
  ok(once.length <= t.length * 1.15, 'result is not much longer than the original');
}
ok(Object.values(S.WORDS).every((v) => typeof v === 'string' && v.length > 0) && !Object.keys(S.WORDS).some((k) => /[^a-z]/.test(k)), 'dictionary is well formed');
ok(!Object.values(S.WORDS).some((v) => v.split(' ').some((w) => Object.prototype.hasOwnProperty.call(S.WORDS, w))), 'no replacement is itself a hard word (keeps the result stable)');

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall simplifier tests passed');
