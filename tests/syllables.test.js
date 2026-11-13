// Accuracy check for the syllable splitter.  node tests/syllables.test.js
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'glider-extension', 'content', 'syllableParser.js'));

// word:expected syllable count
const LIST = `
a:1 the:1 be:1 make:1 time:1 there:1 walked:1 jumped:1 played:1 called:1 smiled:1 strengths:1 queue:1 through:1
thought:1 blue:1 true:1 tree:1 boat:1 read:1 teach:1 friend:1 field:1 fruit:1 suit:1 build:1 guess:1 guide:1
quick:1 judge:1 bridge:1 makes:1 times:1 rules:1 names:1 hopes:1 lines:1 world:1 curled:1 bowled:1 showed:1
wanted:2 added:2 needed:2 started:2 boxes:2 changes:2 places:2 wishes:2 houses:2 table:2 little:2 simple:2
handled:2 settled:2 tables:2 create:2 science:2 poem:2 quiet:2 diet:2 being:2 doing:2 going:2 seeing:2
paper:2 letter:2 basket:2 secret:2 monster:2 pumpkin:2 instruct:2 complete:2 father:2 pocket:2 exam:2
power:2 flower:2 away:2 reward:2 drawing:2 lawyer:2 player:2 beyond:2 royal:2 value:2 argue:2 fluent:2
nation:2 action:2 mission:2 question:2 region:2 special:2 patient:2 ancient:2 million:2 onion:2
lovely:2 movement:2 statement:2 careful:2 homeless:2 something:2 sometimes:2 therefore:2 baseball:2
didn't:2 isn't:2 don't:1 can't:1 they're:1 student's:2 it's:1 couldn't:2
dryer:2 flying:2 trying:2 studied:2 happy:2 rhythm:2 people:2 business:2 language:2 unique:2 college:2
window:2 follow:2 enjoyed:2 picture:2 nature:2 structure:2 measure:2 purpose:2 native:2 active:2
example:3 article:3 idea:3 area:3 radio:3 video:3 period:3 theory:3 media:3 serious:3 various:3 curious:3
audience:3 musician:3 delicious:3 religious:3 opinion:3 companion:3 reaction:3 creation:3 creative:3
studying:3 easier:3 happiest:3 beautiful:3 different:3 family:3 library:3 history:3 memory:3 energy:3
important:3 remember:3 understand:3 paragraph:3 principle:3 principal:3 hospital:3 separate:3 continue:3
continued:3 discipline:3 argument:3 employee:3 heroic:3 chaotic:3 coexist:3 reopen:3 react:2 reuse:2
definite:3 completely:3 excitement:3 management:3 implement:3 element:3 increment:3 difference:3
influence:3 genuine:3 gradual:3 visual:3 usual:3 actual:3 manual:3 annual:3 violin:3 piano:3 museum:3
nucleus:3 nuclear:3 linear:3 theater:3 probably:3 chemistry:3 molecule:3 analyze:3 summarize:3
reality:4 society:4 variety:4 anxiety:4 experience:4 material:4 hypothesis:4 analysis:4 psychology:4
philosophy:4 biology:4 technology:4 geography:4 economy:4 democracy:4 significant:4 environment:4
literature:4 temperature:4 phenomenon:4 definitely:4 necessary:4 situation:4 evaluate:4 appreciate:4
intuition:4 ambiguous:4 continuous:4 spontaneous:4 obedient:4 convenient:4 ingredient:4 political:4
community:4 activity:4 ability:4 specific:3 scientific:4 academic:4 economic:4 information:4 education:4
population:4 independent:4 particular:4 understanding:4 interesting:3 comfortable:4 vegetable:4
immediately:5 approximately:5 university:5 opportunity:5 communication:5 characteristic:5 methodology:5
bibliography:5 photosynthesis:5 organization:5 vocabulary:5 individual:5 misunderstanding:5 uncomfortable:5
particularly:5 pronunciation:5 examination:5 investigation:5 justification:5 curiosity:5 electricity:5
epistemology:6 responsibility:6 interdisciplinary:7 availability:6 biological:5 psychological:5
observation:4 thermometer:4 instrument:3 philosophers:4 traditional:4 requirement:3 justified:3 accident:3
accidental:4 adequate:3 difficulty:4 deciding:3 assumptions:3 procedure:3 discipline:3 researcher:3
prediction:3 sincerely:3 willingness:3 refuted:3 separates:3 pseudoscience:4 contradicted:4 expectations:4
concluded:3 empirical:4 complicated:4 abandon:3 framework:2 auxiliary:4 anomalies:4 accumulate:4
revolution:4 paradigm:3 irrational:4 interpreted:4 perspective:3 measurements:3 indefinitely:5
quantity:3 universal:4 identified:4 eighteenth:2 satisfying:4 solution:3 statisticians:4 probability:5
hypothesis:4 surprising:3 interpretive:4 confusion:3 correlation:4 explanation:4 knowledge:2 investigates:4
`.trim().split(/\s+/).map((pair) => { const [w, n] = pair.split(':'); return [w, Number(n)]; });

let ok = 0;
const wrong = [];
for (const [word, expected] of LIST) {
  const parts = S.split(word);
  if (parts.join('') !== word) throw new Error('join invariant broken for ' + word);
  if (parts.length === expected) ok += 1;
  else wrong.push(`${word}: ${parts.join('·')} (${parts.length}, want ${expected})`);
}

// Invariant on awkward input.
for (const word of ['', 'A', 'EPISTEMOLOGY', 'Epistemology', 'they’re', "o'clock", 'naïve', 'x', '123', 'co-op', 'İstanbul', 'straße', 'ÉCOLE']) {
  const parts = S.split(word);
  if (parts.join('') !== word) throw new Error('join invariant broken for ' + JSON.stringify(word));
}

console.log(wrong.join('\n'));
console.log(`\n${ok}/${LIST.length} correct (${((ok / LIST.length) * 100).toFixed(1)}%)`);
console.log(['epistemology', 'university', 'photosynthesis', 'characteristic', 'approximately', 'communication', 'environment',
  'interdisciplinary', 'uncomfortable', 'responsibility', 'organization', 'particularly', 'misunderstanding', 'table',
  'strengths', "they're", 'falsification', 'thermometer', 'investigates', 'accumulate', 'statisticians', 'indefinitely',
  'electricity', 'availability', 'instrument', 'requirement', 'observation', 'Wikipedia', 'encyclopedia', 'knowledgeable']
  .map((word) => S.split(word).join('·')).join('  '));
process.exit(ok / LIST.length >= 0.95 ? 0 : 1);
