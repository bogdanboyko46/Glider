// node tests/adapt.test.js — the pure parts of "Adapt ahead" (glider-extension/adapt/):
// where a long sentence divides (splitter.js), main clause first (reorder.js), and when a rule applies (profile.js).
const path = require('node:path');
const dir = path.join(__dirname, '..', 'glider-extension', 'adapt');
const S = require(path.join(dir, 'splitter.js'));
const R = require(path.join(dir, 'reorder.js'));
const P = require(path.join(dir, 'profile.js'));

let failed = 0;
const ok = (c, label, detail = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -> ' + detail : ''}`); if (!c) failed += 1; };
const same = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label, JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ------------------------------------------------------------------ splitter
const LEASE = 'Deductions shall be proportionate to the dilapidation attributable to the Tenant, excluding deterioration attributable to ordinary wear; provided, however, that where the Tenant disputes the apportionment, the burden of substantiating that the dilapidation predated the tenancy shall be borne by the Tenant, who shall be obliged to do so through thorough photographic documentation.';
same(S.parts(LEASE), [
  'Deductions shall be proportionate to the dilapidation attributable to the Tenant, ',
  'excluding deterioration attributable to ordinary wear; ',
  'provided, however, that where the Tenant disputes the apportionment, ',
  'the burden of substantiating that the dilapidation predated the tenancy shall be borne by the Tenant, ',
  'who shall be obliged to do so through thorough photographic documentation.',
], 'the lease sentence divides into its five parts');
ok(S.hasTrait(LEASE) && S.analyse(LEASE).points.length === 4, 'it has the trait: long and multi-clause');

const SHORT = ['The cat sat on the mat.', 'She mixes flour, water and a little salt, then leaves the dough to rest.', 'We came, we saw, and we left.', ''];
for (const s of SHORT) ok(!S.hasTrait(s), 'short sentence does not have the trait', s || '(empty)');
same(S.splitPoints('The cat sat on the mat.'), [], 'a sentence with no clause punctuation has no split points');
same(S.parts('We came, we saw, and we left.'), ['We came, we saw, ', 'and we left.'], 'a comma divides only before a joining word');
same(S.parts('Bring apples, and pears, or plums to the party tonight.'), ['Bring apples, and pears, ', 'or plums to the party tonight.'], 'parts of a word or two are joined to a neighbour');
same(S.parts('It cost 1,250 pounds at 10:30 today.'), ['It cost 1,250 pounds at 10:30 today.'], 'commas and colons inside numbers are not boundaries');
same(S.parts('There is one rule: nobody leaves before the bell rings.'), ['There is one rule: ', 'nobody leaves before the bell rings.'], 'a colon divides');
same(S.parts('When the rain finally stopped, the children ran outside.'), ['When the rain finally stopped, ', 'the children ran outside.'], 'the comma closing an opening clause divides');
same(S.splitPoints(null), [], 'non-string input does not throw');
ok(S.hasTrait('The committee met on Tuesday and talked for a very long time about the budget for the coming year without ever reaching any agreement that every single member present could accept.'), 'thirty words with no punctuation still have the trait');
ok(!S.hasTrait('Red, and green, or blue, but not grey.'), 'a short list with many commas does not');

const SAMPLES = [
  LEASE, ...SHORT,
  'Photosynthesis is the process plants use to turn light into chemical energy.',
  'Inside the chloroplast, chlorophyll absorbs mostly red and blue light and reflects green, which is why leaves look green to us.',
  'The enzyme responsible for the first step, ribulose-1,5-bisphosphate carboxylase-oxygenase, is probably the most abundant protein on Earth, and it is famously slow and inefficient at its job.',
  'If you disagree, you must prove the damage was already there.',
  'Although the Landlord may enter, he must give notice; unless there is an emergency, when no notice is needed, which is rare.',
  '  odd   spacing ,  and\nline breaks ;  but still   the same text  ',
  'Wait: what? No; never, and that is final.',
  '“Quoted, and split,” she said, “because it was long.”',
];
ok(SAMPLES.every((s) => S.parts(s).join('') === s), 'joining the parts always gives back the exact sentence');
ok(SAMPLES.every((s) => { const p = S.splitPoints(s); return p.every((at, i) => at > 0 && at < s.length && (i === 0 || at > p[i - 1])); }), 'split points are inside the sentence and in order');
ok(SAMPLES.every((s) => { const p = S.parts(s); return p.length === 1 || p.every((x) => S.wordCount(x) >= S.THRESHOLDS.MIN_PART_WORDS); }), 'no part is shorter than three words');
ok(SAMPLES.every((s) => S.splitPoints(s).every((at) => /\s/.test(s[at - 1]) && /\S/.test(s[at]))), 'every part after the first starts on a word');

const PARA = 'Dr. Smith arrived at 9 a.m. on Monday. He was late!  "Why?" asked J. K. Rowling. Nobody knew, e.g. the porter. It cost 3.50 pounds.';
same(S.sentences(PARA).map((s) => s.text), ['Dr. Smith arrived at 9 a.m. on Monday.', 'He was late!', '"Why?" asked J. K. Rowling.', 'Nobody knew, e.g. the porter.', 'It cost 3.50 pounds.'], 'a paragraph is cut into sentences; abbreviations, initials and decimals do not end one');
ok(S.sentences(PARA).every((s) => PARA.slice(s.start, s.end) === s.text), 'each sentence is an exact slice of the paragraph');
same(S.sentences(''), [], 'empty text has no sentences');

// ------------------------------------------------------------------- reorder
const moved = (a, b, label) => { const r = R.reorder(a); ok(r.changed && r.text === b, label, r.text); };
const kept = (a, label) => { const r = R.reorder(a); ok(!r.changed && r.text === a, label, r.text); };

moved('If you disagree, you must prove the damage was already there.', 'You must prove the damage was already there if you disagree.', 'the example: main clause first');
moved('When the rain stops, we will walk to the station.', 'We will walk to the station when the rain stops.', 'When ...');
moved('Provided that the rent is paid, the Tenant may stay in the flat.', 'The Tenant may stay in the flat provided that the rent is paid.', 'a two-word opener loses only its capital');
moved('In the event that the boiler fails, the Landlord must repair it within a week.', 'The Landlord must repair it within a week in the event that the boiler fails.', 'In the event that ...');
moved('Although Maria was tired, Paris still amazed her.', 'Paris still amazed her although Maria was tired.', 'names keep their capitals');
moved('Unless I hear from you, I will send the letter on Friday.', 'I will send the letter on Friday unless I hear from you.', '"I" stays a capital');
ok(R.hasTrait('If you disagree, you must prove the damage was already there.') && !R.hasTrait('You must prove the damage was already there.'), 'hasTrait: opens with a subordinate clause');

kept('You must prove the damage was already there.', 'no opening clause: untouched');
kept('The cat sat on the mat, and the dog slept.', 'does not start with a subordinator: untouched');
kept('If you disagree, you must prove it, and you must do so in writing.', 'more than one comma: untouched');
kept('If you disagree you must prove the damage was already there.', 'no comma: untouched');
kept('If you disagree, must you prove the damage was already there?', 'a question: untouched');
kept('If you disagree (and many do), you must prove the damage.', 'brackets: untouched');
kept('If she says "no", you must prove the damage was there.', 'quotes: untouched');
kept("If the tenants' claim fails, the deposit goes back to them.", 'a quote-like apostrophe: untouched');
kept('When Ann arrived, she sat down at once.', 'main clause starts with a pronoun that points back: untouched');
kept('If it rains, then we will stay at home.', 'main clause starts with "then": untouched');
kept('If the Tenant, having been told in writing of the damage and of the cost of putting it right by the agent, does nothing, we act.', 'several commas in a long opening clause: untouched');
kept('Because the storm had torn the roof off the old barn behind the farmhouse during the night, we left early.', 'opening clause far longer than the main clause: untouched');
kept('If Mr. Jones disagrees, you must prove the damage was there.', 'a full stop inside: untouched');
kept('IF YOU DISAGREE, YOU MUST PROVE IT WAS THERE.', 'not sentence case: untouched');
kept('If so, we leave.', 'main clause too short: untouched');
kept('', 'empty: untouched');
ok(R.reorder(null).text === '' && R.reorder(undefined).changed === false, 'non-string input does not throw');

ok(R.sameWords('If you disagree, you must prove it.', 'You must prove it if you disagree.'), 'sameWords: same words in another order');
ok(!R.sameWords('You must prove it.', 'You must not prove it.') && !R.sameWords('you you must', 'you must must'), 'sameWords: an added word or a changed count is caught');

const REORDER_SAMPLES = [
  ...SAMPLES,
  'If you disagree, you must prove the damage was already there.',
  'When the rain stops, we will walk to the station.',
  'Once the dough has risen, the baker shapes the loaves by hand.',
  'Since 2019, 1,250 people have moved to the town.',
  'While the kettle boils, the tea-leaves wait in the pot.',
  'Until the Tenant’s keys are returned, the Landlord keeps the deposit.',
  'Where the path divides, walkers should keep to the left-hand track.',
  'Though he was tired, he kept going.',
  'Because it rained, because it poured, we stayed.',
  'If A, B.',
  'If you  disagree,\n   you must prove   the damage was there.',
  'Provided that, we go on and on and on.',
  'In the event that I am late, I will telephone the office.',
];
ok(REORDER_SAMPLES.every((s) => R.sameWords(s, R.reorder(s).text)), 'property: the words, and how many of each, never change');
ok(REORDER_SAMPLES.every((s) => { const r = R.reorder(s); return r.changed === (r.text !== s); }), 'property: untouched means identical text');
ok(REORDER_SAMPLES.filter((s) => R.reorder(s).changed).length >= 6, 'the sample list does exercise the reordering', String(REORDER_SAMPLES.filter((s) => R.reorder(s).changed).length));
ok(REORDER_SAMPLES.every((s) => !R.reorder(R.reorder(s).text).changed), 'a reordered sentence is not reordered again');

// ------------------------------------------------------------------- profile
const rule = (plain, trait, adapted = [0, 0]) => ({ plain: { read: plain[0], struggled: plain[1] }, trait: { read: trait[0], struggled: trait[1] }, adapted: { read: adapted[0], struggled: adapted[1] } });
const why = (r, mode) => { const d = P.decide(r, mode); return `${d.active} ${d.why}`; };

ok(why(null, 'learn') === 'false not-enough-read' && why(undefined) === 'false not-enough-read', 'nothing learned yet: inactive (learn is the default mode)');
ok(why(rule([40, 4], [11, 9]), 'learn') === 'false not-enough-read', 'too few trait sentences read: inactive');
ok(why(rule([5, 0], [30, 20]), 'learn') === 'false not-enough-read', 'too few other sentences to compare with: inactive');
ok(why(rule([40, 0], [12, 2]), 'learn') === 'false few-struggles', 'one or two struggles are not evidence');
ok(why(rule([40, 4], [20, 10]), 'learn') === 'true trait-is-harder', 'struggles clearly more often on trait sentences: active');
ok(why(rule([40, 12], [20, 8]), 'learn') === 'false no-clear-difference', 'a reader who struggles everywhere: inactive (30% against 40%)');
ok(why(rule([40, 16], [20, 11]), 'learn') === 'false no-clear-difference', 'higher by the margin but not by the ratio: inactive');
ok(why(rule([40, 4], [20, 10], [11, 11]), 'learn') === 'true trait-is-harder', 'adapted sentences are not judged before enough were read');
ok(why(rule([40, 4], [20, 10], [12, 6]), 'learn') === 'false no-benefit', 'adapting did not lower the struggle rate: backs off');
ok(why(rule([40, 4], [20, 10], [12, 7]), 'learn') === 'false no-benefit', 'adapting made it worse: backs off');
ok(why(rule([40, 4], [20, 10], [12, 2]), 'learn') === 'true trait-is-harder', 'adapting helps: stays active');
ok(why(rule([0, 0], [0, 0]), 'on') === 'true on' && why(rule([40, 4], [20, 10], [12, 12]), 'on') === 'true on', "mode 'on': always active");
ok(why(rule([40, 4], [20, 10]), 'off') === 'false off', "mode 'off': never active");
ok(why(rule([40, 4], [20, 10]), 'banana') === 'true trait-is-harder', 'an unknown mode means learn');

const p0 = P.sanitize({ mode: 'on', split: { trait: { read: 3, struggled: 9 }, plain: { read: -2 }, undone: 'x' }, reorder: 7, text: 'never kept' });
ok(p0.mode === 'on' && p0.split.trait.read === 3 && p0.split.trait.struggled === 3 && p0.split.plain.read === 0 && p0.split.undone === 0 && p0.reorder.trait.read === 0 && !('text' in p0), 'sanitize: any stored shape becomes a well-formed profile, counters only');
ok(Object.keys(P.empty()).sort().join() === 'mode,reorder,split,v' && P.empty().mode === 'learn', 'an empty profile: mode learn, one set of counters per rule');
const d1 = P.empty();
P.record(d1.split, 'trait', true); P.record(d1.split, 'trait', false); P.record(d1.reorder, 'adapted', true); d1.reorder.undone += 1;
const p1 = P.add({ mode: 'on', split: rule([5, 1], [2, 1]) }, d1);
ok(p1.mode === 'on' && p1.split.trait.read === 4 && p1.split.trait.struggled === 2 && p1.split.plain.read === 5 && p1.reorder.adapted.read === 1 && p1.reorder.undone === 1, 'add: counts from a page are added per rule; the stored mode is kept');
const late = P.add(p1, { split: { trait: { read: 0, struggled: 1 } } });
ok(late.split.trait.struggled === 3 && late.split.trait.read === 4, 'add: a struggle that arrives after its sentence was counted');
const capped = P.add({ split: rule([399, 100], [0, 0]) }, { split: { plain: { read: 1, struggled: 0 } } });
ok(capped.split.plain.read === 200 && capped.split.plain.struggled === 50, 'add: a full counter is halved, so old reading fades');

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nadapt checks passed');
