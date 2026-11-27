/*
 * simplifier.js — the offline text simplifier. Pure: no DOM, no Chrome APIs, no network.
 * Classic script in the browser (globalThis.GliderSimplify), require()-able in Node.
 *
 * It makes a passage easier to read without changing what it says:
 *   1. wordy phrases become short ones          ("in order to" -> "to")
 *   2. hard words become common ones            ("utilize" -> "use", keeping case and endings)
 *   3. long sentences are split at safe joints  ("...; ..." / ", but ..." / ", which ...")
 * It never rephrases. When an Anthropic API key is set, simplify/bridge.js replaces this
 * result with a real rewrite from Claude; this one is what shows instantly and offline.
 */
(function (root) {
  'use strict';

  /* Wordy phrase -> plain phrase. Matched case-insensitively on word boundaries. */
  const PHRASES = [
    ['in order to', 'to'], ['so as to', 'to'], ['due to the fact that', 'because'], ['owing to the fact that', 'because'],
    ['in spite of the fact that', 'although'], ['despite the fact that', 'although'], ['in the event that', 'if'],
    ['with regard to', 'about'], ['with respect to', 'about'], ['in regard to', 'about'], ['pertaining to', 'about'],
    ['a large number of', 'many'], ['a great deal of', 'much'], ['the majority of', 'most'], ['a majority of', 'most'],
    ['a variety of', 'many'], ['a wide range of', 'many'], ['at this point in time', 'now'], ['at the present time', 'now'],
    ['prior to', 'before'], ['subsequent to', 'after'], ['in addition to', 'besides'], ['in addition,', 'also,'],
    ['as a result of', 'because of'], ['as a consequence of', 'because of'], ['for the purpose of', 'for'],
    ['in the vicinity of', 'near'], ['in close proximity to', 'near'], ['is able to', 'can'], ['are able to', 'can'],
    ['was able to', 'could'], ['were able to', 'could'], ['has the ability to', 'can'], ['have the ability to', 'can'],
    ['is responsible for', 'handles'], ['on the other hand', 'but'], ['for the most part', 'mostly'], ['in most cases', 'usually'],
    ['it is important to note that', ''], ['it should be noted that', ''], ['it is worth noting that', ''],
    ['often called', 'also called'], ['commonly referred to as', 'called'], ['referred to as', 'called'], ['known as', 'called'],
    ['by means of', 'by'], ['in terms of', 'in'], ['on a regular basis', 'regularly'], ['take into account', 'consider'],
    ['give rise to', 'cause'], ['gives rise to', 'causes'], ['gave rise to', 'caused'], ['make use of', 'use'], ['makes use of', 'uses'],
  ];

  /* Hard word -> common word, base forms. Endings (-s, -ed, -ing, -ly) are carried over by inflect().
     The swap knows neither the part of speech nor the sense, so a word is here only when its replacement
     reads right in every common use. Left out on purpose (2026-11-25 review) are words that are also a
     noun or verb the replacement does not fit ("the impact" / "the affect", "the state" / "the say",
     "an increase" / "a raise", "provided that" / "gave that"), that have a second sense ("a few minutes",
     "a chemical element", "electric current", "a solution"), whose replacement says something else
     ("several" / "a few", "evidence" / "proof", "vehicle" / "car"), or that sit mid-sentence as a
     connective ("however", "therefore", "thus", "upon"), or whose replacement cannot stand where the
     word stood ("a sufficient amount" / "an enough amount", "immediately after" / "at once after"). */
  const WORDS = {
    utilize: 'use', utilise: 'use', obtain: 'get', acquire: 'get', attain: 'reach', purchase: 'buy',
    commence: 'start', initiate: 'start', terminate: 'end', conclude: 'end', cease: 'stop', halt: 'stop',
    demonstrate: 'show', illustrate: 'show', indicate: 'show', exhibit: 'show', reveal: 'show', depict: 'show',
    assist: 'help', enable: 'let', permit: 'let', require: 'need', necessitate: 'need',
    attempt: 'try', endeavor: 'try', endeavour: 'try', construct: 'build', fabricate: 'make', manufacture: 'make',
    generate: 'make', create: 'make', modify: 'change', alter: 'change', transform: 'change',
    convert: 'turn', examine: 'study', investigate: 'study', analyze: 'study', analyse: 'study',
    comprehend: 'understand', perceive: 'see', observe: 'see', identify: 'find', locate: 'find', detect: 'find', discover: 'find',
    determine: 'find out', ascertain: 'find out', establish: 'set up', retain: 'keep', preserve: 'keep',
    possess: 'have', contain: 'hold', comprise: 'include', incorporate: 'include', consume: 'use up', absorb: 'take in',
    emit: 'give off', accumulate: 'build up', decrease: 'drop', diminish: 'shrink',
    reduce: 'cut', expand: 'grow', enhance: 'improve', accelerate: 'speed up',     evolve: 'develop', occur: 'happen', emerge: 'appear', vanish: 'disappear', reside: 'live', inhabit: 'live in',
    depart: 'leave', arrive: 'come', respond: 'answer', reply: 'answer',
    inquire: 'ask', inform: 'tell', notify: 'tell', declare: 'say', assert: 'say',     propose: 'suggest', recommend: 'suggest', contemplate: 'think about',     resemble: 'look like', differ: 'vary', combine: 'join', connect: 'join', attach: 'join',
    divide: 'split', distribute: 'spread', transmit: 'send', transport: 'carry', convey: 'carry', deliver: 'bring',
    contribute: 'add', receive: 'get', accept: 'take', reject: 'refuse', prevent: 'stop',
    prohibit: 'ban', restrict: 'limit', regulate: 'control',     approximately: 'about', roughly: 'about', numerous: 'many', multiple: 'many', additional: 'more',
    excessive: 'too much',     substantial: 'large', enormous: 'huge', immense: 'huge',     fundamental: 'basic', crucial: 'key',     ultimate: 'last', previous: 'earlier', prior: 'earlier', subsequent: 'later',     ancient: 'very old', frequently: 'often', regularly: 'often', occasionally: 'sometimes',
    rapidly: 'quickly', rapid: 'fast', swiftly: 'quickly', gradually: 'slowly',     eventually: 'in the end', ultimately: 'in the end', initially: 'at first', primarily: 'mainly',     entirely: 'fully', completely: 'fully', partially: 'partly', extremely: 'very', particularly: 'especially',
    probably: 'likely', perhaps: 'maybe', obviously: 'clearly',
    evidently: 'clearly', typically: 'usually', generally: 'usually', commonly: 'often', normally: 'usually',
    furthermore: 'also', moreover: 'also',
    additionally: 'also', nevertheless: 'still', nonetheless: 'still', although: 'though', whereas: 'while', whilst: 'while',
    regarding: 'about', via: 'through', amongst: 'among',     component: 'part', portion: 'part', segment: 'part', fragment: 'piece', quantity: 'amount', majority: 'most',
    method: 'way', technique: 'way', procedure: 'steps', strategy: 'plan', objective: 'goal', purpose: 'aim',
    task: 'job', outcome: 'result', consequence: 'result', origin: 'start',
    location: 'place', region: 'area', vicinity: 'area', habitat: 'home', dwelling: 'home',
    residence: 'home', individuals: 'people', inhabitant: 'resident', beverage: 'drink',
    physician: 'doctor', ailment: 'illness', remedy: 'cure', assistance: 'help', requirement: 'need', capability: 'ability',
    concept: 'idea', notion: 'idea', error: 'mistake', difficulty: 'trouble',
    obstacle: 'barrier', response: 'answer', inquiry: 'question',
    opportunity: 'chance', disadvantage: 'downside', abundance: 'plenty', shortage: 'lack',     workaround: 'fix', workarounds: 'fixes', inefficient: 'wasteful',     complicated: 'hard', difficult: 'hard', challenging: 'hard', identical: 'the same',     distinct: 'different', diverse: 'varied', various: 'different', accurate: 'correct',
    precise: 'exact', evident: 'clear', obvious: 'clear', apparent: 'clear', feasible: 'possible',
    beneficial: 'helpful', detrimental: 'harmful', hazardous: 'dangerous', perilous: 'dangerous',     fragile: 'easily broken', robust: 'strong', rigid: 'stiff', flexible: 'bendy', transparent: 'clear', opaque: 'not see-through',
    arid: 'dry', humid: 'damp', frigid: 'very cold', tepid: 'lukewarm', vast: 'huge', scarce: 'rare',
  };

  const VOWEL = /[aeiou]/;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  /** Carry the capitalisation of the original word over to its replacement. */
  function matchCase(from, to) {
    if (from.length > 1 && from === from.toUpperCase()) return to.toUpperCase();
    return from.charAt(0) === from.charAt(0).toUpperCase() && from.charAt(0) !== from.charAt(0).toLowerCase() ? cap(to) : to;
  }
  /** Put an ending on the first word of a replacement ("find out" + ed -> "found out" is avoided: irregulars are left alone). */
  const IRREGULAR = new Set(['get', 'buy', 'build', 'make', 'find', 'find out', 'keep', 'have', 'hold', 'see', 'tell', 'say', 'think about',
    'give', 'take', 'take in', 'give off', 'let', 'let out', 'send', 'bring', 'cut', 'grow', 'go on', 'keep going', 'come', 'leave',
    'understand', 'choose', 'set up', 'speed up', 'build up', 'use up', 'bounce back', 'split', 'spread', 'stop', 'hint', 'drop', 'plan']);
  /** Replacements whose last consonant doubles before -ed / -ing. */
  const DOUBLE = new Set(['control', 'ban', 'trap', 'chat']);
  function inflect(base, ending) {
    if (!ending) return base;
    const parts = base.split(' ');
    let w = parts[0];
    if (ending === 's') w += /(s|x|z|ch|sh)$/.test(w) ? 'es' : /[^aeiou]y$/.test(w) ? w.slice(0, -1) && 'ies'.replace(/^/, '') : 's';
    if (ending === 's' && /[^aeiou]y$/.test(parts[0])) w = parts[0].slice(0, -1) + 'ies';
    if (DOUBLE.has(w) && (ending === 'ed' || ending === 'ing')) w += w.slice(-1);   // control -> controlled
    if (ending === 'ed') w = /e$/.test(w) ? w + 'd' : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ied' : w + 'ed';
    if (ending === 'ing') w = /[^e]e$/.test(w) ? w.slice(0, -1) + 'ing' : w + 'ing';
    parts[0] = w;
    return parts.join(' ');
  }
  /** The replacement for one word, or null. Tries the word itself, then its base form with the ending carried over. */
  function swap(word) {
    const lower = word.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(WORDS, lower)) return WORDS[lower];
    const tries = [];
    if (lower.endsWith('ies')) tries.push([lower.slice(0, -3) + 'y', 's']);
    if (lower.endsWith('es')) tries.push([lower.slice(0, -2), 's']);
    if (lower.endsWith('s')) tries.push([lower.slice(0, -1), 's']);
    if (lower.endsWith('ied')) tries.push([lower.slice(0, -3) + 'y', 'ed']);
    if (lower.endsWith('ed')) tries.push([lower.slice(0, -2), 'ed'], [lower.slice(0, -1), 'ed']);
    if (lower.endsWith('ing')) tries.push([lower.slice(0, -3), 'ing'], [lower.slice(0, -3) + 'e', 'ing']);
    for (const [base, ending] of tries) {
      if (base.length < 3 || !VOWEL.test(base) || !Object.prototype.hasOwnProperty.call(WORDS, base)) continue;
      const to = WORDS[base];
      // Only verbs take -ed / -ing, and irregular replacements ("find" -> "finded") are left as the original word.
      if (ending !== 's' && IRREGULAR.has(to)) return null;
      if (ending === 's' && / /.test(to) && !IRREGULAR.has(to)) return null;
      return inflect(to, ending);
    }
    return null;
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const PHRASE_RES = PHRASES.map(([from, to]) => [new RegExp('\\b' + escapeRe(from) + '\\b' + (to === '' ? '\\s*' : ''), 'gi'), to]);
  const countWords = (s) => (s.match(/[A-Za-z0-9’'-]+/g) || []).length;

  /** Split one long sentence at joints where both halves can stand alone. */
  function splitSentence(sentence, maxWords) {
    if (countWords(sentence) <= maxWords) return sentence;
    const joints = [
      [/;\s+/, '. ', null],
      [/,\s+but\s+/i, '. ', 'But '],
      [/,\s+so\s+/i, '. ', 'So '],
      [/,\s+which\s+(?=(is|are|was|were|has|have|had|can|could|will|would|makes?|made|means?|meant|gives?|gave|lets?|helps?|causes?|allows?)\b)/i, '. ', 'This '],
      // (not before "that": ", and that ..." usually carries on a clause begun earlier, "she wrote that ..., and that ...")
      [/,\s+and\s+(?=(it|they|he|she|we|this|these|those|the|its|their|a|an)\b)/i, '. ', null],
    ];
    for (const [re, sep, lead] of joints) {
      const m = re.exec(sentence);
      if (!m) continue;
      const left = sentence.slice(0, m.index).trim(), right = sentence.slice(m.index + m[0].length).trim();
      if (countWords(left) < 5 || countWords(right) < 4) continue;
      const head = /[.!?]$/.test(left) ? left : left + '.';
      const tail = (lead || '') + (lead ? right : cap(right));
      return splitSentence(head, maxWords) + sep.slice(1) + splitSentence(tail, maxWords);
    }
    return sentence;
  }

  /**
   * @param text  one paragraph of plain text
   * @param opts  { maxSentenceWords = 20 }
   * @returns {{ text: string, changed: boolean, swaps: [{from, to}], splits: number }}
   */
  function simplify(text, opts = {}) {
    const input = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!input) return { text: '', changed: false, swaps: [], splits: 0 };
    const maxWords = Number.isFinite(opts.maxSentenceWords) ? opts.maxSentenceWords : 20;
    const swaps = [];
    let out = input;
    for (const [re, to] of PHRASE_RES) {
      out = out.replace(re, (m) => { swaps.push({ from: m.trim(), to }); return to === '' ? '' : matchCase(m, to); });
    }
    // Connectives are swapped only where they open a clause ("However, ..." / "; however, ..."): mid-sentence
    // ("The results, however, were ...", "is therefore true") a plain word would not read right.
    out = out.replace(/(^|[.!?;]\s+)(however),\s+/gi, (m, lead, w) => { swaps.push({ from: w, to: 'but' }); return (lead.trim() === ';' ? '. ' : lead) + 'But '; })
      .replace(/(^|[.!?;]\s+)(therefore|consequently|thus|hence),\s+/gi, (m, lead, w) => { swaps.push({ from: w, to: 'so' }); return (lead.trim() === ';' ? '. ' : lead) + 'So '; });
    out = out.replace(/[A-Za-z][A-Za-z’']*/g, (word, at, whole) => {
      // Leave names alone: a capitalised word that does not start a sentence.
      const startsSentence = at === 0 || /[.!?]["”’)]?\s+$/.test(whole.slice(0, at));
      if (!startsSentence && word.charAt(0) !== word.charAt(0).toLowerCase()) return word;
      const to = swap(word.replace(/[’']s$/, ''));
      if (!to) return word;
      const possessive = /[’']s$/.test(word) ? word.slice(-2) : '';
      swaps.push({ from: word, to });
      return matchCase(word, to) + possessive;
    });
    out = out.replace(/\ba ([aeiou])/gi, (m, v) => (m.charAt(0) === 'A' ? 'An ' : 'an ') + v)
      .replace(/\ban ([^aeiouAEIOU\s])/g, (m, c) => (m.charAt(0) === 'A' ? 'A ' : 'a ') + c);
    // "…; however, the results" has become "…; but, the results": make it a new sentence
    out = out.replace(/;\s+(but|so|still|also),?\s+/gi, (m, w) => '. ' + cap(w.toLowerCase()) + ' ')
      .replace(/(^|[.!?]\s+)(But|So),\s+/g, '$1$2 ');
    // sentence case after a dropped opener ("It is important to note that plants..." -> "Plants...")
    out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, lead, ch) => lead + ch.toUpperCase());
    const sentences = out.match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g) || [out];
    let splits = 0;
    out = sentences.map((s) => {
      const core = s.trim();
      if (!core) return '';
      const done = splitSentence(core, maxWords);
      if (done !== core) splits += (done.match(/[.!?](?=\s)/g) || []).length - (core.match(/[.!?](?=\s)/g) || []).length;
      return done;
    }).filter(Boolean).join(' ');
    out = out.replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
    return { text: out, changed: out !== input, swaps, splits };
  }

  const api = { simplify, WORDS, PHRASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderSimplify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
