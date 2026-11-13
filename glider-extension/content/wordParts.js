/*
 * wordParts.js — prefixes, roots and suffixes, and a careful word splitter.
 *
 * PARTS is a hand-written list of the parts most often taught in school, each with a plain
 * meaning (Glider's own list, MIT like the rest of the code). split() finds them in a word,
 * but only when the split can be trusted:
 *   - un-, re-, dis- ... count when the rest is a real word of the right kind (re + a verb: "rewrite").
 *   - A suffix after a real word counts when the dictionary says the longer word is formed
 *     from it (teach -> teacher, happy -> happiness); a few unmistakable suffixes (-ness, -less,
 *     -ful, -ment, -ship ...) only need the right kind of word (kind + ness).
 *   - Greek and Latin roots (port, spect, graph) count only when known parts cover the whole
 *     word: in + spect, bio + logy, photo + syn + thesis.
 * So "uncle", "relate", "number" and "reason" are left alone.
 *
 * The extension does not split at run time: tools/make-wordparts.js runs split() over the word
 * lists with WordNet's word classes and links, and writes data/wordparts.txt.
 *
 * Classic script (globalThis.GliderParts), require()-able in Node.
 */
(function (root) {
  'use strict';

  /* [type, form, meaning, example, attach, id]
     type: p prefix, r root, s suffix.
     attach (prefixes): the word classes the rest must have to count on its own (n noun, v verb,
       a adjective, r adverb); a prefix without one only counts inside a full cover of roots.
     attach (suffixes): the word classes the base word must have.
     id: only where one spelling has two meanings (in- "not" / in- "into"). */
  const LIST = [
    // ---- prefixes that make a new word from a real word
    ['p', 'un', 'not, or the opposite of', 'unhappy', 'avr'],
    ['p', 're', 'again, or back', 'rewrite', 'v'],
    ['p', 'dis', 'not, or the opposite of', 'dislike', 'vna'],
    ['p', 'mis', 'wrongly', 'misread', 'vn'],
    ['p', 'pre', 'before', 'preview', 'vn'],
    ['p', 'post', 'after', 'postwar', 'n'],
    ['p', 'non', 'not', 'nonstop', 'nav'],
    ['p', 'in', 'not', 'incorrect', 'a', 'in.not'],
    ['p', 'im', 'not', 'impossible', 'a', 'im.not'],
    ['p', 'il', 'not', 'illegal', 'a'],
    ['p', 'ir', 'not', 'irregular', 'a'],
    ['p', 'over', 'too much, or above', 'overcook', 'vna'],
    ['p', 'under', 'below, or not enough', 'underline', 'vna'],
    ['p', 'out', 'more than, or outside', 'outrun', 'vn'],
    ['p', 'sub', 'under, or below', 'subway', 'nva'],
    ['p', 'super', 'above, or more than', 'superstar', 'nva'],
    ['p', 'inter', 'between', 'international', 'navr'],
    ['p', 'trans', 'across', 'transport', 'vna'],
    ['p', 'anti', 'against', 'antibody', 'na'],
    ['p', 'counter', 'against, or opposite', 'counterattack', 'nv'],
    ['p', 'auto', 'self', 'autograph', 'n'],
    ['p', 'co', 'together, or with', 'coworker', 'nv'],
    ['p', 'de', 'down, away, or undo', 'defrost', 'v'],
    ['p', 'fore', 'before, or in front', 'forecast', 'nv'],
    ['p', 'mid', 'middle', 'midnight', 'n'],
    ['p', 'semi', 'half', 'semicircle', 'na'],
    ['p', 'bi', 'two', 'bicycle', 'na'],
    ['p', 'tri', 'three', 'triangle', 'na'],
    ['p', 'multi', 'many', 'multicolored', 'na'],
    ['p', 'mono', 'one', 'monorail', 'n'],
    ['p', 'uni', 'one', 'uniform', 'n'],
    ['p', 'en', 'make, or put into', 'enlarge', 'an'],
    ['p', 'em', 'make, or put into', 'empower', 'n'],
    ['p', 'extra', 'beyond, or more than usual', 'extraordinary', 'a'],
    ['p', 'hyper', 'over, or too much', 'hyperactive', 'a'],
    ['p', 'micro', 'very small', 'microscope', 'n'],
    ['p', 'tele', 'far', 'telephone', 'n'],
    ['p', 'photo', 'light', 'photograph', 'n'],
    ['p', 'bio', 'life', 'biology', 'n'],
    ['p', 'geo', 'earth', 'geography', ''],
    // ---- Latin and Greek prefixes: only inside a full cover of known parts
    ['p', 'in', 'in, or into', 'inspect', '', 'in.into'],
    ['p', 'im', 'in, or into', 'import', '', 'im.into'],
    ['p', 'ex', 'out, or out of', 'export', ''],
    ['p', 'com', 'together, or with', 'compress', ''],
    ['p', 'con', 'together, or with', 'connect', ''],
    ['p', 'col', 'together, or with', 'collect', ''],
    ['p', 'syn', 'together', 'synthesis', ''],
    ['p', 'sym', 'together', 'symphony', ''],
    ['p', 'pro', 'forward, or in favor of', 'produce', ''],
    ['p', 'ab', 'away from', 'absent', ''],
    ['p', 'ad', 'to, or toward', 'advance', ''],
    ['p', 'ac', 'to, or toward', 'accept', ''],
    ['p', 'per', 'through, or completely', 'perfect', ''],
    ['p', 'circum', 'around', 'circumference', ''],
    ['p', 'poly', 'many', 'polygon', ''],
    ['p', 'astro', 'star', 'astronaut', ''],
    ['p', 'hydro', 'water', 'hydroplane', ''],
    ['p', 'therm', 'heat', 'thermometer', ''],
    ['p', 'chrono', 'time', 'chronological', ''],
    ['p', 'psych', 'mind', 'psychology', ''],
    ['p', 'dia', 'across, or through', 'diagram', ''],
    ['p', 'hypo', 'under, or less than', 'hypothesis', ''],
    ['p', 'epi', 'on, or upon', 'epidemic', ''],
    // ---- roots
    ['r', 'port', 'carry', 'transport'],
    ['r', 'struct', 'build', 'construct'],
    ['r', 'dict', 'say, or tell', 'predict'],
    ['r', 'rupt', 'break', 'interrupt'],
    ['r', 'spect', 'look', 'inspect'],
    ['r', 'scrib', 'write', 'describe'],
    ['r', 'scribe', 'write', 'describe'],
    ['r', 'script', 'write', 'manuscript'],
    ['r', 'graph', 'write, or draw', 'paragraph'],
    ['r', 'gram', 'something written or drawn', 'diagram'],
    ['r', 'tract', 'pull, or drag', 'tractor'],
    ['r', 'ject', 'throw', 'project'],
    ['r', 'vis', 'see', 'vision'],
    ['r', 'vid', 'see', 'video'],
    ['r', 'aud', 'hear', 'audience'],
    ['r', 'phon', 'sound', 'phonics'],
    ['r', 'phone', 'sound, or voice', 'microphone'],
    ['r', 'duct', 'lead', 'conduct'],
    ['r', 'duce', 'lead', 'reduce'],
    ['r', 'fer', 'carry', 'transfer'],
    ['r', 'form', 'shape', 'transform'],
    ['r', 'mit', 'send', 'transmit'],
    ['r', 'miss', 'send', 'mission'],
    ['r', 'mot', 'move', 'motion'],
    ['r', 'mov', 'move', 'movement'],
    ['r', 'ped', 'foot', 'pedal'],
    ['r', 'pod', 'foot', 'tripod'],
    ['r', 'pend', 'hang', 'pendant'],
    ['r', 'sci', 'know', 'science'],
    ['r', 'sens', 'feel', 'sensitive'],
    ['r', 'sent', 'feel', 'sentence'],
    ['r', 'terr', 'land, or earth', 'territory'],
    ['r', 'vers', 'turn', 'reverse'],
    ['r', 'verse', 'turn', 'reverse'],
    ['r', 'vert', 'turn', 'convert'],
    ['r', 'voc', 'voice, or call', 'vocal'],
    ['r', 'manu', 'hand', 'manual'],
    ['r', 'mem', 'remember', 'memory'],
    ['r', 'nat', 'born', 'native'],
    ['r', 'path', 'feeling, or disease', 'sympathy'],
    ['r', 'cred', 'believe', 'incredible'],
    ['r', 'chron', 'time', 'synchronize'],
    ['r', 'cycl', 'circle, or wheel', 'bicycle'],
    ['r', 'cycle', 'circle, or wheel', 'recycle'],
    ['r', 'meter', 'measure', 'thermometer'],
    ['r', 'scope', 'a tool for looking', 'telescope'],
    ['r', 'thesis', 'putting, or placing', 'synthesis'],
    ['r', 'gen', 'birth, or kind', 'generate'],
    ['r', 'loc', 'place', 'location'],
    ['r', 'cept', 'take', 'accept'],
    ['r', 'ceive', 'take', 'receive'],
    ['r', 'press', 'push', 'pressure'],
    ['r', 'pos', 'put, or place', 'position'],
    ['r', 'pose', 'put, or place', 'expose'],
    ['r', 'tain', 'hold', 'contain'],
    ['r', 'vent', 'come', 'invent'],
    ['r', 'dic', 'say', 'indicate'],
    ['r', 'log', 'word, or study', 'dialog'],
    ['r', 'lect', 'choose, or read', 'select'],
    ['r', 'leg', 'law, or read', 'legal'],
    ['r', 'fect', 'make, or do', 'perfect'],
    ['r', 'flect', 'bend', 'reflect'],
    ['r', 'flex', 'bend', 'flexible'],
    ['r', 'grad', 'step', 'gradual'],
    ['r', 'gress', 'step, or go', 'progress'],
    ['r', 'mort', 'death', 'mortal'],
    ['r', 'plic', 'fold', 'complicate'],
    ['r', 'popul', 'people', 'population'],
    ['r', 'spir', 'breathe', 'inspire'],
    ['r', 'temp', 'time', 'temporary'],
    ['r', 'tend', 'stretch', 'extend'],
    ['r', 'tens', 'stretch', 'tension'],
    ['r', 'vac', 'empty', 'vacant'],
    ['r', 'vict', 'win, or conquer', 'victory'],
    ['r', 'viv', 'live', 'survive'],
    ['r', 'aqua', 'water', 'aquarium'],
    ['r', 'hydr', 'water', 'hydrant'],
    // ---- suffixes
    ['s', 'able', 'can be done', 'readable', 'v'],
    ['s', 'ible', 'can be done', 'flexible', 'v'],
    ['s', 'er', 'a person or thing that does something', 'teacher', 'v'],
    ['s', 'or', 'a person or thing that does something', 'actor', 'v'],
    ['s', 'ist', 'a person who does or believes something', 'artist', 'n'],
    ['s', 'ian', 'a person who does something', 'musician', 'n'],
    ['s', 'ness', 'the state of being', 'kindness', 'a'],
    ['s', 'ment', 'the act or result of', 'movement', 'v'],
    ['s', 'ation', 'the act or result of', 'information', 'v'],
    ['s', 'ition', 'the act or result of', 'addition', 'v'],
    ['s', 'tion', 'the act or result of', 'invention', 'v'],
    ['s', 'sion', 'the act or result of', 'confusion', 'v'],
    ['s', 'ion', 'the act or result of', 'creation', 'v'],
    ['s', 'ful', 'full of', 'helpful', 'nv'],
    ['s', 'less', 'without', 'careless', 'nv'],
    ['s', 'ly', 'in a way that is', 'quickly', 'a'],
    ['s', 'ous', 'full of, or having', 'dangerous', 'n'],
    ['s', 'ious', 'full of, or having', 'curious', 'n'],
    ['s', 'ive', 'tending to', 'creative', 'v'],
    ['s', 'al', 'about, or related to', 'natural', 'n'],
    ['s', 'ial', 'about, or related to', 'facial', 'n'],
    ['s', 'ic', 'about, or related to', 'historic', 'n'],
    ['s', 'ical', 'about, or related to', 'musical', 'n'],
    ['s', 'ish', 'a bit, or like', 'childish', 'na'],
    ['s', 'ity', 'the state of being', 'electricity', 'a'],
    ['s', 'ize', 'to make', 'modernize', 'na'],
    ['s', 'ise', 'to make', 'modernise', 'na'],
    ['s', 'ify', 'to make', 'simplify', 'a'],
    ['s', 'ism', 'a belief or practice', 'heroism', 'na'],
    ['s', 'logy', 'the study of', 'geology', ''],
    ['s', 'graphy', 'writing about, or drawing', 'geography', ''],
    ['s', 'ship', 'the state, skill or group of', 'friendship', 'n'],
    ['s', 'hood', 'the state or time of', 'childhood', 'n'],
    ['s', 'dom', 'the state or place of', 'freedom', 'na'],
    ['s', 'ward', 'in the direction of', 'homeward', 'nr'],
    ['s', 'wards', 'in the direction of', 'backwards', 'nr'],
    ['s', 'en', 'to make, or made of', 'brighten', 'an'],
    ['s', 'ance', 'the act or state of', 'appearance', 'v'],
    ['s', 'ence', 'the act or state of', 'difference', 'va'],
    ['s', 'ant', 'a person or thing that', 'assistant', 'v'],
    ['s', 'ent', 'a person or thing that', 'student', 'v'],
    ['s', 'ary', 'about, or a place for', 'dictionary', ''],
    ['s', 'ory', 'about, or a place for', 'factory', ''],
    ['s', 'ure', 'the act or result of', 'structure', 'v'],
    ['s', 'ate', 'to make, or having', 'activate', 'na'],
    ['s', 'y', 'full of, or like', 'rainy', 'n'],
    ['s', 'cracy', 'rule by', 'democracy', ''],
    ['s', 'cide', 'killing', 'insecticide', 'n'],
  ];

  const PARTS = LIST.map(([type, form, meaning, example, attach, id]) => ({ type, form, meaning, example, attach: attach || '', id: id || form }));
  const KIND = { p: 'prefix', r: 'root', s: 'suffix', w: 'base word' };
  const byKey = new Map(PARTS.map((p) => [p.type + ':' + p.id, p]));
  // Longest first, so "bio" is tried before "bi" and "ation" before "ion".
  const ordered = (type) => PARTS.filter((p) => p.type === type).sort((a, b) => b.form.length - a.form.length);
  const PREFIXES = ordered('p'), ROOTS = ordered('r'), SUFFIXES = ordered('s');

  // Suffixes clear enough to need only the right kind of base word, not a dictionary link.
  const PLAIN_SUFFIX = new Set(['ness', 'ment', 'less', 'ful', 'ship', 'hood', 'able', 'ible', 'ward', 'wards']);
  // Negative prefixes whose "into" twin is listed separately.
  const NEGATIVE = new Set(['in.not', 'im.not', 'il', 'ir', 'un', 'non']);

  // Real words that only look built from parts (checked against the whole word).
  const STOP = new Set(('present prepare preach preachy preacher relate realize realise repeat repair reside remark resent resort discuss display disease ' +
    'pretty united reader recent regard record remain retire reserve refuse deliver design decent desert detail defeat delight ' +
    'debate decrease demean finish police polish promise country cover company comfort concern consider content contest corner ' +
    'coward expert entrance entire encore island listen mother never number offer order other paper power proper rather sister ' +
    'water winter wonder after butter letter matter better bitter hammer ladder ocean season reason lesson person prison poison ' +
    'potion ration station mention invaluable infamous inflammable inside insect index infant income install instant insist ' +
    'image impact illness mischief mister outrage postage trivial uncle union until unite unity begin between button cotton often ' +
    'open oven seven eleven heaven garden golden hidden kitten mitten women children linen chicken kitchen citizen dozen frozen ' +
    'token spoken broken normal animal metal petal medal total hospital capital final royal loyal signal rival basic magic music ' +
    'panic topic public traffic garlic picnic plastic elastic fantastic happy early family army city pity party duty beauty body ' +
    'copy story study candy ready carry marry hurry worry sorry penny funny belly bully jelly silly rally').split(' '));

  const LINK = /^[aeio]$/;   // connecting vowel: therm-o-meter, bi-o-logy

  /** Spellings the base word may have had before a suffix was added. */
  function stems(s) {
    const out = [s, s + 'e'];                                            // creat-ion -> create
    if (/i$/.test(s)) out.push(s.slice(0, -1) + 'y');                    // happi-ness -> happy
    if (/([b-df-hj-np-tv-z])\1$/.test(s)) out.push(s.slice(0, -1));      // runn-er -> run
    return out;
  }
  const fits = (pos, attach) => !attach || [...attach].some((c) => String(pos).includes(c));

  /**
   * Split a word into parts, or null when no trustworthy split exists.
   *   posOf(w)        word classes of a real word ("nv", "a") or '' when w is not a word
   *   related(a, b)   true when the dictionary says one is formed from the other (teacher, teach)
   *   common(w)       true for everyday words; only those count as base words (optional: all words)
   * Returns [{ type: 'p'|'r'|'s'|'w', id, form, start, end, base? }] covering the word, in order.
   */
  function split(raw, posOf, related, common) {
    const w = String(raw || '').toLowerCase();
    if (w.length < 5 || w.length > 30 || !/^[a-z]+$/.test(w) || STOP.has(w)) return null;
    // Long words (8+ letters) are rarely ambiguous, so they count as base words even when not everyday ones.
    const isCommon = (s) => typeof common !== 'function' || !!common(s) || s.length >= 8;
    // A base word must be a real, everyday word.
    const pos = (s) => (typeof posOf === 'function' && isCommon(s) ? posOf(s) || '' : '');
    const linked = (a, b) => typeof related === 'function' && !!related(a, b);
    let best = null;

    /* Prefixes and suffixes are worth showing (un + happy + ness over unhappy + ness), but fewer,
       longer parts win among roots (geo + graphy over geo + graph + y); a real base word is worth
       most; each connecting vowel costs a little (bio + logy over bi + o + logy). */
    const consider = (parts, links) => {
      if (parts.length < 2 || parts.every((p) => p.type === 'w')) return;
      const score = parts.reduce((s, p) => s + (p.type === 'w' ? 4.5 + 0.15 * p.form.length : (p.type === 'r' ? 1.5 : 2.5) + 0.25 * p.form.length), 0) - parts.length * 2 - links * 0.3;
      if (!best || score > best.score) best = { score, parts };
    };
    const part = (p, start) => ({ type: p.type, id: p.id, form: p.form, start, end: start + p.form.length });
    // A base word that is also a listed root or suffix is shown as that part: tele + phone (sound), trans + port (carry).
    const AS_PART = new Map(ROOTS.concat(SUFFIXES).map((p) => [p.form, p]));
    const baseWord = (form, start, base) => (AS_PART.has(form) && form === base
      ? part(AS_PART.get(form), start)
      : { type: 'w', id: base, form, start, end: start + form.length, base });

    /* Suffixes from position `at`. When they follow a real word, `word` is that word as the
       dictionary spells it (care, then careful) and `wordPos` its classes; each suffix must suit
       it, and (unless it is unmistakable) the longer word must be linked to it in the dictionary.
       `stemStart` is where that word begins in `w`. After roots, `word` is null: anything goes. */
    function suffixes(at, parts, links, stemStart, word, wordPos) {
      if (at === w.length) { consider(parts, links); return; }
      const rest = w.slice(at);
      for (const p of SUFFIXES) {
        if (!rest.startsWith(p.form)) continue;
        const end = at + p.form.length;
        const next = parts.concat(part(p, at));
        if (word === null) { suffixes(end, next, links, stemStart, null, ''); continue; }
        const derived = w.slice(stemStart, end);
        if (!fits(wordPos, p.attach)) continue;
        if (!PLAIN_SUFFIX.has(p.form) && !linked(derived, word)) continue;
        if (end === w.length) { consider(next, links); continue; }
        // a further suffix needs the longer word to be a real word itself: care + ful (careful) + ly
        const dp = pos(derived);
        if (dp) suffixes(end, next, links, stemStart, derived, dp);
      }
    }

    /* Greek and Latin cover: prefixes (at most two, at the start), roots, then suffixes. */
    function cover(at, parts, links, prefixesLeft) {
      if (at === w.length) { consider(parts, links); return; }
      const rest = w.slice(at);
      const last = parts[parts.length - 1];
      // A connecting vowel after a Greek or Latin part of 3+ letters joins that part: thermo + meter.
      if (last && last.type !== 'w' && last.form.length >= 3 && LINK.test(rest[0]) && rest.length > 3) {
        coverFrom(at + 1, parts.slice(0, -1).concat({ ...last, end: last.end + 1 }), links + 1, prefixesLeft);
      }
      coverFrom(at, parts, links, prefixesLeft);
    }
    function coverFrom(at, parts, links, prefixesLeft) {
      const rest = w.slice(at);
      if (prefixesLeft > 0 && parts.every((p) => p.type === 'p')) {
        for (const p of PREFIXES) {
          if (!rest.startsWith(p.form) || NEGATIVE.has(p.id) || rest.length - p.form.length < 3) continue;
          cover(at + p.form.length, parts.concat(part(p, at)), links, prefixesLeft - 1);
        }
      }
      // roots: after other parts, or first when long and clear (struct-ure, spect-acle)
      for (const p of ROOTS) {
        if (rest.startsWith(p.form) && (parts.length || p.form.length >= 5)) cover(at + p.form.length, parts.concat(part(p, at)), links, 0);
      }
      if (!parts.length) return;
      const last = parts[parts.length - 1];
      // a real word after one clear Greek or Latin prefix: photo + copy, micro + wave
      if (parts.length === 1 && last.type === 'p' && last.form.length >= 3 && !links && rest.length >= 3 && pos(rest)) {
        consider(parts.concat(baseWord(rest, at, rest)), links);
      }
      if (last.type === 'r') suffixes(at, parts, links, at, null, '');
      // straight after a prefix, only a clear Greek ending: geo + graphy, bio + logy
      else for (const p of SUFFIXES) {
        if (!p.attach && p.form.length >= 4 && rest === p.form) consider(parts.concat(part(p, at)), links);
      }
    }

    // 1. prefix + real word (+ suffixes): un + happy, re + write, un + kind + ness
    for (const p of PREFIXES) {
      if (!p.attach || !w.startsWith(p.form)) continue;
      const after = w.slice(p.form.length);
      if (after.length < 3) continue;
      const head = [part(p, 0)];
      // After a prefix the rest must be an everyday word: ex + "tension" or ex + "planation" would mislead.
      const whole = typeof common !== 'function' || common(after) ? pos(after) : '';
      if (whole && fits(whole, p.attach)) consider(head.concat(baseWord(after, p.form.length, after)), 0);
      // un + happy + ness only when "unhappy" is itself a word (so not ex + tense + ion for "extension")
      for (let cut = after.length - 1; cut >= 3; cut--) {
        const form = after.slice(0, cut);
        for (const b of stems(form)) {
          const bp = pos(b);
          if (bp && fits(bp, p.attach) && typeof posOf === 'function' && posOf(p.form + b)) {
            suffixes(p.form.length + cut, head.concat(baseWord(form, p.form.length, b)), 0, p.form.length, b, bp);
          }
        }
      }
    }
    // 2. real word + suffixes: kind + ness, teach + er, care + ful + ly
    for (let cut = w.length - 2; cut >= 3; cut--) {
      const form = w.slice(0, cut);
      for (const b of stems(form)) {
        const bp = pos(b);
        if (bp) suffixes(cut, [baseWord(form, 0, b)], 0, 0, b, bp);
      }
    }
    // 3. Greek and Latin parts covering the whole word: in + spect, bio + logy, photo + syn + thesis
    cover(0, [], 0, 2);

    if (!best) return null;
    return best.parts.map((p) => (p.type === 'w'
      ? { type: 'w', id: p.base, form: p.form, start: p.start, end: p.end, base: p.base }
      : { type: p.type, id: p.id, form: p.form, start: p.start, end: p.end }));
  }

  /* Encoded for data/wordparts.txt: "p:un:0:2 w:happy:2:7 s:ness:7:11" (w carries the base word,
     which may be spelled differently in the word: "w:happy:2:7" over "happi"). */
  const encode = (parts) => parts.map((p) => `${p.type}:${p.id}:${p.start}:${p.end}`).join(' ');
  function decode(text, word) {
    const w = String(word || '');
    return String(text || '').trim().split(' ').filter(Boolean).map((t) => {
      const [type, id, start, end] = t.split(':');
      const s = Number(start), e = Number(end);
      return { type, id, start: s, end: e, form: w ? w.slice(s, e).toLowerCase() : id, base: type === 'w' ? id : undefined };
    }).filter((p) => KIND[p.type] && Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);
  }

  /** What to show for one part: { kind: 'prefix', label: 'un-', meaning, example }. Base words get their meaning from the dictionary. */
  function describe(p) {
    if (!p) return null;
    if (p.type === 'w') return { kind: KIND.w, label: p.base || p.form, meaning: '', example: '' };
    const e = byKey.get(p.type + ':' + p.id);
    if (!e) return null;
    const label = e.type === 'p' ? e.form + '-' : e.type === 's' ? '-' + e.form : e.form;
    return { kind: KIND[e.type], label, meaning: e.meaning, example: e.example };
  }

  const api = { PARTS, KIND, STOP, split, encode, decode, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderParts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
