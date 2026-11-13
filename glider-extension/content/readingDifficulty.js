/*
 * readingDifficulty.js — how hard a word is to READ: Easy, Medium or Hard, with a short reason.
 *
 * The CEFR level (A1..C2) says how common a word is for learners, not how hard it is to
 * decode: "vegetable" is A1 but has a silent part, "laud" is C2 but easy to sound out. This
 * score weighs what makes decoding hard:
 *   - length: syllables to hold together                                 (38%)
 *   - commonness: the CEFR level; an unlisted long word counts as rare   (25%)
 *   - spelling that does not match the sound: silent letters, -ough,
 *     ph, a part that is not said ("vegetable" says VEJ-tuh-bul)         (30%)
 *   - a look-alike word it is easily confused with                       (+12%)
 * The weights are a first estimate, meant to be tuned against how long readers actually
 * spend on words once eye tracking is calibrated.
 *
 *   rate({ word, level, syllables, say, lookalike }) -> { band: 'easy'|'medium'|'hard', score: 0..1, reasons: [..] }
 *     level: 'A1'..'C2' or null;  syllables: written parts (["veg","e","ta","ble"]);  say: "VEJ-tuh-bul" or null
 *
 * Classic script (globalThis.GliderDifficulty), require()-able in Node.
 */
(function (root) {
  'use strict';

  const BANDS = Object.freeze({
    easy: { name: 'Easy to read', short: 'Easy' },
    medium: { name: 'Medium to read', short: 'Medium' },
    hard: { name: 'Hard to read', short: 'Hard' },
  });
  const LEVEL = { A1: 0, A2: 0.15, B1: 0.35, B2: 0.55, C1: 0.75, C2: 0.9 };
  const LENGTH = [0, 0, 0.15, 0.35, 0.55, 0.8, 1];   // by syllable count (6+ = 1)

  /* Spellings that do not sound the way they look. Each matched pattern adds to the
     spelling part of the score; the label is what the reader is told. */
  const TRICKY = [
    [/^kn/, 'silent k'],
    [/^wr/, 'silent w'],
    [/^gn|gn$|ign(?=[^aeiou]|$)/, 'silent g'],
    [/mb$|mbs$/, 'silent b'],
    [/bt/, 'silent b'],
    [/^ps/, 'silent p'],
    [/^(ho(nest|nour|nor|ur))/, 'silent h'],
    [/(st|s)(le|en)$|stle/, 'silent t'],
    [/^is(l|land)|aisle/, 'silent s'],
    [/(al|ol)(k|m|f)/, 'silent l'],
    [/ough|augh/, 'the "ough" spelling'],
    [/igh|eigh/, 'the "igh" spelling'],
    [/ph/, '"ph" says f'],
    [/^(chem|chor|chao|chara|chrom|chron|chrys|sch|archi|orch|psych|tech|stomach|mech|ache)/, '"ch" says k'],
    [/eau|ieu/, 'an unusual vowel spelling'],
    [/oeia|oea|eue/, 'an unusual vowel spelling'],
    [/acht|onel|ueue|oir$/, 'an unusual spelling'],
    [/(^|[^aeiou])y(?=[^aeiouy]|$)(?!$)/, '"y" says i'],
  ];

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function rate(input) {
    const o = input && typeof input === 'object' ? input : {};
    const word = String(o.word || '').toLowerCase().replace(/’/g, "'");
    if (!word) return { band: 'easy', score: 0, reasons: [] };

    const syl = Array.isArray(o.syllables) && o.syllables.length ? o.syllables.length : Math.max(1, (word.match(/[aeiouy]+/g) || []).length);
    const lengthPart = LENGTH[Math.min(syl, LENGTH.length - 1)];

    const listed = Object.prototype.hasOwnProperty.call(LEVEL, o.level);
    const commonPart = listed ? LEVEL[o.level] : word.length >= 7 ? 0.8 : 0.3;

    const tricks = [];
    for (const [re, label] of TRICKY) if (re.test(word) && !tricks.includes(label)) tricks.push(label);
    // A written part that is not said: four written syllables, three said ("veg-e-ta-ble").
    const said = typeof o.say === 'string' && o.say ? o.say.split('-').filter(Boolean).length : 0;
    const swallowed = said > 0 && said < syl;
    const spellPart = clamp01(0.55 * tricks.length + (swallowed ? 0.45 : 0));

    const look = o.lookalike ? 0.12 : 0;
    const score = clamp01(0.38 * lengthPart + 0.25 * commonPart + 0.30 * spellPart + look);
    const band = score >= 0.5 ? 'hard' : score >= 0.24 ? 'medium' : 'easy';

    // The two biggest reasons, in plain words.
    const reasons = [];
    if (syl >= 3) reasons.push([0.38 * lengthPart, `${syl} syllables`]);
    if (listed && LEVEL[o.level] >= 0.55) reasons.push([0.25 * commonPart, `a less common word (${o.level})`]);
    if (!listed && word.length >= 7) reasons.push([0.25 * commonPart, 'not an everyday word']);
    if (swallowed) reasons.push([0.135 + 0.001, 'one part is not said']);
    for (const t of tricks) reasons.push([0.165, t]);
    if (o.lookalike) reasons.push([0.12, 'easily confused with another word']);
    reasons.sort((a, b) => b[0] - a[0]);
    return { band, score, reasons: reasons.slice(0, 2).map((r) => r[1]) };
  }

  const api = { BANDS, rate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderDifficulty = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
