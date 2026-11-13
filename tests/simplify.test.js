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
eq('She demonstrates the method and it requires evidence.', 'She shows the way and it needs proof.', 'the -s ending is carried over');
eq('They utilized it. He is utilizing it.', 'They used it. He is using it.', '-ed and -ing are carried over for regular verbs');
eq('They obtained the data.', 'They obtained the data.', 'no "getted": irregular replacements are skipped for -ed');
eq('We met Constant Lambert in Reading.', 'We met Constant Lambert in Reading.', 'capitalised words inside a sentence (names) are left alone');
eq('Approximately 40% of 1,250 samples.', 'About 40% of 1,250 samples.', 'numbers are untouched');
eq('The enzyme’s function is vital.', 'The enzyme’s job is key.', 'possessives survive');
eq('This is an enormous task.', 'This is a huge job.', 'a / an agrees with the new word');

eq('In order to win, practise.', 'To win, practise.', 'wordy phrases are shortened');
eq('It is important to note that plants need light.', 'Plants need light.', 'empty openers are dropped and the sentence re-capitalised');
eq('Due to the fact that it rained, we stayed.', 'Because it rained, we stayed.', 'phrase replacement keeps sentence case');

const long1 = 'Inside the chloroplast, chlorophyll absorbs mostly red and blue light and reflects green, which is why leaves look green to us.';
eq(long1, 'Inside the chloroplast, chlorophyll takes in mainly red and blue light and bounces back green. This is why leaves look green to us.', 'long sentence splits at ", which is"');
const long2 = 'The enzyme responsible for the first step is probably the most abundant protein on Earth, and it is famously slow and inefficient at its job.';
eq(long2, 'The enzyme responsible for the first step is likely the most common protein on Earth. It is well known to be slow and wasteful at its job.', 'long sentence splits at ", and it"');
eq('Researchers utilized numerous techniques over many years of careful work; however, the results were insufficient.',
  'Researchers used many ways over many years of careful work. But the results were not enough.', '"; however," becomes a new sentence');
eq('It rained, but we went.', 'It rained, but we went.', 'short sentences are not split');
ok(S.simplify(long1).splits === 1 && S.simplify(long1).swaps.length === 3, 'splits and swaps are reported');

for (const t of [long1, long2, 'In order to demonstrate the hypothesis, researchers utilized numerous techniques; however, the results were insufficient.']) {
  const once = S.simplify(t).text;
  ok(S.simplify(once).text === once, 'simplifying twice changes nothing more: ' + once.slice(0, 40) + '…');
  ok(once.length <= t.length * 1.15, 'result is not much longer than the original');
}
ok(Object.values(S.WORDS).every((v) => typeof v === 'string' && v.length > 0) && !Object.keys(S.WORDS).some((k) => /[^a-z]/.test(k)), 'dictionary is well formed');
ok(!Object.values(S.WORDS).some((v) => v.split(' ').some((w) => Object.prototype.hasOwnProperty.call(S.WORDS, w))), 'no replacement is itself a hard word (keeps the result stable)');

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall simplifier tests passed');
