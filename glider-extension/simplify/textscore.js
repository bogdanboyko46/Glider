/*
 * textscore.js — what the text alone says about whether simplifying a paragraph is worthwhile.
 * Pure: no DOM (except the optional domMeta helper), no Chrome APIs, no network, no dictionary file.
 * Classic script in the browser (globalThis.GliderTextScore), require()-able in Node.
 *
 *   difficulty(text)                 -> { score 0..1, level (grade-like), band, fkGrade, features }
 *   gain(original, simplified)       -> { gain 0..1, difficultyBefore, difficultyAfter, changedShare, lengthRatio }
 *   suitability(text, opts)          -> { verdict, auto, offer, vetoes[], flags[], llmCouldHelp, difficulty, gain }
 *   evidenceMultiplier(score)        -> m: multiply the gaze threshold (tau) by this for the block
 *   domMeta(el)                      -> { links, linkChars, inline, media } for suitability(text, { meta })
 */
(function (root) {
  'use strict';

  /* ~480 very common English words (function words + the most frequent content words).
   * Inflected forms are matched by stripping -s/-es/-ed/-ing/-ly/-er/-est. About 3 KB. */
  const COMMON = new Set((
    'a about above across after again against ago air all almost alone along already also always am among an and animal another answer any ' +
    'are area arm around as ask at away baby back bad ball bank be bear beat because bed been before began begin behind being believe below ' +
    'best better between big bird bit black blue boat body book both bottom box boy bread bring brother brown build burn bus busy but buy by ' +
    'call came can car care carry cat catch cause change child children city class clean clear close cold color colour come cook cool could ' +
    'country course cover cross cry cut dark day dad dead deep did die do does dog done door down draw dream dress drink drive drop dry ' +
    'during each ear early earth east easy eat egg eight end enough even ever every eye face fact fall family far farm fast father feel feet ' +
    'few field fight fill find fine fire first fish five floor fly follow food foot for form found four free friend from front full fun game ' +
    'gave get girl give glad go god goes gold gone good got great green ground group grow had hair half hand happen happy hard has hat have ' +
    'he head hear heard heart heat help her here high hill him his hit hold hole home hope horse hot hour house how hundred i idea if in ' +
    'inside into is it its job jump just keep kept kind king knew know lady land large last late laugh lay lead learn leave left leg less ' +
    'let letter life light like line list listen little live long look lost lot love low made make man many may me mean men might mile milk ' +
    'mind miss money month moon more morning most mother mountain mouth move much mum must my name near need never new next nice night nine ' +
    'no north not note nothing now number of off often oh old on once one only open or other our out outside over own page paper part pass ' +
    'past pay people person pick picture piece place plan plant play point poor pull push put queen question quick quiet quite rain ran ' +
    'reach read ready real red rest rich ride right river road rock room round rule run sad said salt same sat saw say school sea second ' +
    'see seem seen self sell send sent set seven shall she ship shop short should show shut side sing sister sit six size skin sky sleep ' +
    'slow small smell smile snow so some son song soon sound south speak stand star start stay step still stone stood stop store story ' +
    'street strong such sun sure sweet table take talk tall teach tell ten than thank that the their them then there these they thing ' +
    'think third this those though thought three through time to today together told too took top toward town tree true try turn two ' +
    'under until up upon us use usual very wait walk wall want war warm was wash watch water way we week well went were west what wheel ' +
    'when where which while white who whole why wide wife will win wind window winter wish with without woman women wood word work world ' +
    'would write wrong year yes yet you young your'
  ).split(' '));

  /* The 60 most frequent function words: in running English prose they are 35-55% of all words.
   * A low share means the block is not English prose (another language, a list of names, a menu, code). */
  const FUNCTION = new Set((
    'the of and a to in is it that was for on are as with his they at be this have from or one had by but not what all were we when your ' +
    'can said there an each which she do how their if will up other about out many then them these so some her would he you i its has than'
  ).split(' '));

  // ---------------------------------------------------------------- tokens
  const WORD_RE = /[\p{L}][\p{L}\p{M}’'-]*/gu;
  const LATIN_RE = /\p{Script=Latin}/u;
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const ramp = (x, lo, hi) => clamp01((x - lo) / (hi - lo));
  const round = (x, n = 3) => { const k = Math.pow(10, n); return Math.round(x * k) / k; };

  /** Cheap syllable estimate: vowel groups, minus silent endings. Agrees with the bundled
   *  Glider.Syllables.count on about 90% of words (see the test script); either can be used:
   *  to use the bundled one, replace the call in features() with Glider.Syllables.count(w). */
  function syllables(word) {
    let w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 1;
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|[^tdaeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    const groups = w.match(/[aeiouy]{1,2}/g);
    return groups ? groups.length : 1;
  }

  /** Is this (lower-case) word, or its base form, on the common list? */
  function isCommon(w) {
    if (COMMON.has(w) || w.length <= 2) return true;
    w = w.replace(/[’']s$/, '').replace(/[’']$/, '');
    if (COMMON.has(w)) return true;
    const tries = [];
    if (w.endsWith('ies')) tries.push(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) tries.push(w.slice(0, -2));
    if (w.endsWith('s')) tries.push(w.slice(0, -1));
    if (w.endsWith('ed')) tries.push(w.slice(0, -2), w.slice(0, -1), w.slice(0, -3));
    if (w.endsWith('ing')) tries.push(w.slice(0, -3), w.slice(0, -3) + 'e', w.slice(0, -4));
    if (w.endsWith('ly')) tries.push(w.slice(0, -2));
    if (w.endsWith('er')) tries.push(w.slice(0, -2), w.slice(0, -1), w.slice(0, -3));
    if (w.endsWith('est')) tries.push(w.slice(0, -3), w.slice(0, -2), w.slice(0, -4));
    for (const t of tries) if (t.length >= 2 && COMMON.has(t)) return true;
    return false;
  }

  function splitSentences(text) {
    // A sentence ends at . ! ? (plus closing quotes) followed by a space and a capital, quote, bracket or digit.
    return text.split(/(?<=[.!?…]["”’)\]]?)\s+(?=[\p{Lu}"“‘(\[\d])/u).map((s) => s.trim()).filter(Boolean);
  }

  // ------------------------------------------------------------ difficulty
  /* Constants. Each feature is mapped linearly onto 0..1 between an "easy" and a "hard" anchor,
   * then combined. Word-level features carry 70% of the score, sentence-level 30%. */
  const K = {
    syl: [1.10, 1.95, 0.25],        // mean syllables per word      (Flesch-Kincaid's word term)
    long: [0.0, 0.40, 0.20],       // share of words with 7+ letters (LIX / word-length effect)
    veryLong: [0.0, 0.14, 0.10],    // share with 10+ letters
    rare: [0.08, 0.70, 0.45],       // share not on the common list (Dale-Chall's word term)
    sent: [6, 32, 0.75],            // mean words per sentence      (FK / Dale-Chall sentence term)
    maxSent: [12, 46, 0.25],        // longest sentence
    wordWeight: 0.70, sentenceWeight: 0.30,
  };

  function features(text) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const chars = t.length;
    const nonSpace = t.replace(/\s/g, '').length || 1;
    const words = t.match(WORD_RE) || [];
    const n = words.length;
    const sents = splitSentences(t);
    let letters = 0, long = 0, veryLong = 0, syl = 0, rare = 0, fn = 0, nonLatinWords = 0;
    for (const w of words) {
      const bare = w.replace(/[’'-]/g, '');
      const lower = w.toLowerCase();
      letters += bare.length;
      if (bare.length >= 7) long++;
      if (bare.length >= 10) veryLong++;
      syl += syllables(w);
      if (!isCommon(lower)) rare++;
      if (FUNCTION.has(lower)) fn++;
      if (!LATIN_RE.test(w.charAt(0))) nonLatinWords++;
    }
    // Capitalised words that do not start a sentence (names, titles, acronyms).
    let caps = 0, maxSent = 0, sentWordTotal = 0, endedSentences = 0;
    for (const s of sents) {
      const sw = s.match(WORD_RE) || [];
      sentWordTotal += sw.length;
      if (sw.length > maxSent) maxSent = sw.length;
      if (/[.!?…]["”’)\]]?$/.test(s)) endedSentences++;
      for (let i = 1; i < sw.length; i++) { const c = sw[i].charAt(0); if (c !== c.toLowerCase()) caps++; }
    }
    const digits = (t.match(/\d/g) || []).length;
    const tokens = t.split(' ').filter(Boolean);
    const numTokens = tokens.filter((x) => /\d/.test(x)).length;
    const symbols = (t.match(/[{}\[\]<>=;_|\\/`$#@^*~+]|\(\)|=>|::/g) || []).length;
    const codeTokens = tokens.filter((x) => /[a-z][A-Z]|[A-Za-z]_[A-Za-z]|\w\.\w+\(|\w\(\)|^https?:|^www\.|\w\/\w+\/|^[\w.-]+@[\w-]+\./.test(x)).length;
    return {
      chars, words: n, sentences: sents.length,
      meanWordLen: n ? round(letters / n, 2) : 0,
      longWordShare: n ? round(long / n) : 0,
      veryLongWordShare: n ? round(veryLong / n) : 0,
      meanSyllables: n ? round(syl / n, 2) : 0,
      meanSentenceWords: sents.length ? round(sentWordTotal / sents.length, 1) : 0,
      maxSentenceWords: maxSent,
      rareShare: n ? round(rare / n) : 0,
      digitsShare: round(digits / nonSpace),
      capsShare: n ? round(caps / n) : 0,
      // extras used by suitability()
      functionShare: n ? round(fn / n) : 0,
      nonLatinShare: n ? round(nonLatinWords / n) : 0,
      numberTokenShare: tokens.length ? round(numTokens / tokens.length) : 0,
      symbolShare: round(symbols / nonSpace),
      codeTokenShare: tokens.length ? round(codeTokens / tokens.length) : 0,
      endedSentenceShare: sents.length ? round(endedSentences / sents.length) : 0,
    };
  }

  const BANDS = [[0.25, 'easy'], [0.45, 'plain'], [0.65, 'moderate'], [0.8, 'hard'], [Infinity, 'very hard']];

  function difficulty(text) {
    const f = features(text);
    if (!f.words) return { score: 0, level: 0, band: 'easy', fkGrade: 0, features: f };
    const r = (key, x) => ramp(x, K[key][0], K[key][1]) * K[key][2];
    const word = r('syl', f.meanSyllables) + r('long', f.longWordShare) + r('veryLong', f.veryLongWordShare) + r('rare', f.rareShare);
    const sentence = r('sent', f.meanSentenceWords) + r('maxSent', f.maxSentenceWords);
    const score = round(clamp01(K.wordWeight * word + K.sentenceWeight * sentence));
    // Flesch-Kincaid grade from the same counts, for a familiar scale (0.39 words/sentence + 11.8 syllables/word - 15.59).
    const fk = 0.39 * f.meanSentenceWords + 11.8 * f.meanSyllables - 15.59;
    const fkGrade = round(Math.max(0, Math.min(18, fk)), 1);
    // Grade-like level derived from the score itself: 0 -> grade 2, 1 -> grade 17.
    const level = round(2 + 15 * score, 1);
    const band = BANDS.find(([max]) => score < max)[1];
    return { score, level, band, fkGrade, features: f };
  }

  // ------------------------------------------------------------------ gain
  /** Share of the original's words that do not survive, in order, into the simplified text (LCS). */
  function changedShare(a, b) {
    const x = (a.toLowerCase().match(WORD_RE) || []), y = (b.toLowerCase().match(WORD_RE) || []);
    if (!x.length) return 0;
    let prev = new Uint16Array(y.length + 1), cur = new Uint16Array(y.length + 1);
    for (let i = 1; i <= x.length; i++) {
      for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      const t = prev; prev = cur; cur = t;
    }
    return (x.length - prev[y.length]) / x.length;
  }

  const G = {
    dropFull: 0.10,     // an absolute difficulty drop of 0.10 counts as a full-size improvement
    changedFull: 0.12,  // 12% of the words changed counts as a full-size rewrite
    dropWeight: 0.7, changedWeight: 0.3,
    longer: 1.12,       // a result more than 12% longer starts losing credit; 1.35x loses all of it
    longerZero: 1.35,
    MIN: 0.40,          // below this the offline result is "barely changed": do not show it on its own
  };

  function gain(original, simplified) {
    const a = String(original || '').replace(/\s+/g, ' ').trim(), b = String(simplified || '').replace(/\s+/g, ' ').trim();
    const before = difficulty(a), after = difficulty(b);
    const share = a === b ? 0 : changedShare(a, b);
    const lengthRatio = a.length ? b.length / a.length : 1;
    const drop = before.score - after.score;
    let g = G.dropWeight * clamp01(drop / G.dropFull) + G.changedWeight * clamp01(share / G.changedFull);
    if (drop <= 0) g = Math.min(g, 0.15);                       // words moved, text no easier: not a gain
    g *= 1 - ramp(lengthRatio, G.longer, G.longerZero);         // longer text is more to read
    return {
      gain: round(clamp01(g)), difficultyBefore: before.score, difficultyAfter: after.score,
      changedShare: round(share), lengthRatio: round(lengthRatio),
    };
  }

  // ----------------------------------------------------------- suitability
  const V = {
    minChars: 60, minWords: 12, maxChars: 3000,
    minSentenceWords: 6,       // mean words per sentence below this, over 3+ sentences: a list of fragments
    nonLatin: 0.30,            // share of words not in Latin script
    functionShare: 0.18,       // English prose has 35-55% function words; below this it is not English prose
    digits: 0.15,              // share of characters that are digits
    numberTokens: 0.25,        // share of tokens containing a digit
    caps: 0.30,                // share of words that are mid-sentence capitals (names)
    symbols: 0.04, codeTokens: 0.08,
    EASY: 0.25,                // already easy: never swap automatically
    OFFER: 0.45,               // no-gaze mode: offer a simpler version at or above this
    LLM: 0.40,                 // offline did nothing but the text is at least this hard: an LLM rewrite can still help
    llmSentence: 35,           // ... or it has a sentence this long that the offline splitter found no joint in
    linkShare: 0.25,           // share of the block's characters inside links above which a plain-text swap is refused
  };

  /**
   * @param text  the block's text
   * @param opts  { simplified?: string (the offline result; pass Simplify.simplify(text).text),
   *                meta?: { links, linkChars, inline, media } from domMeta(el) }
   * verdict: 'never'    hard veto, whatever the gaze says
   *          'offline'  the offline simplifier helps: swap on gaze evidence
   *          'llm-only' the offline simplifier changes too little; swap only when the LLM rewrite has arrived
   */
  function suitability(text, opts = {}) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const d = difficulty(t), f = d.features;
    const vetoes = [], flags = [];
    if (t.length < V.minChars || f.words < V.minWords) vetoes.push('too-short');
    if (t.length > V.maxChars) vetoes.push('too-long');
    if (f.nonLatinShare > V.nonLatin) vetoes.push('non-latin-script');
    else if (f.words >= V.minWords && f.functionShare < V.functionShare) {
      vetoes.push(f.endedSentenceShare < 0.5 ? 'fragments' : f.capsShare > V.caps ? 'mostly-names' : 'not-english-prose');
    } else if (f.capsShare > V.caps) vetoes.push('mostly-names');
    if (f.digitsShare > V.digits || f.numberTokenShare > V.numberTokens) vetoes.push('mostly-numbers');
    if (f.symbolShare > V.symbols || f.codeTokenShare > V.codeTokens) vetoes.push('code-like');
    if (f.sentences >= 3 && f.meanSentenceWords < V.minSentenceWords && !vetoes.includes('fragments')) vetoes.push('fragments');
    if (!vetoes.length && d.score < V.EASY) vetoes.push('already-easy');

    const meta = opts.meta || null;
    if (meta) {
      if (meta.media > 0) vetoes.push('contains-media-or-code');           // img, svg, math, code, kbd, sup/sub, br-formatted text
      if (meta.links > 0 && meta.linkChars / Math.max(1, t.length) > V.linkShare) vetoes.push('mostly-links');
      else if (meta.links > 0) flags.push('loses-links');                   // links become dead text until "Show original"
      if (meta.inline > 0) flags.push('loses-emphasis');                    // strong / em / mark / abbr are flattened
    }

    let g = null, verdict = 'never', llmCouldHelp = false;
    if (!vetoes.length) {
      if (typeof opts.simplified === 'string') {
        g = gain(t, opts.simplified);
        if (g.gain >= G.MIN) verdict = 'offline';
        else { flags.push(opts.simplified.replace(/\s+/g, ' ').trim() === t ? 'offline-no-change' : 'offline-low-gain'); llmCouldHelp = d.score >= V.LLM || f.maxSentenceWords >= V.llmSentence; verdict = llmCouldHelp ? 'llm-only' : 'never'; }
        if (g.lengthRatio > G.longer) flags.push('offline-longer');
      } else verdict = 'offline';
    }
    const ok = verdict !== 'never';
    return {
      verdict, vetoes, flags, llmCouldHelp,
      auto: ok,                                   // may be swapped automatically, given enough gaze evidence
      offer: ok && d.score >= V.OFFER,            // no-gaze mode: show a quiet "Simpler version" offer
      multiplier: ok ? evidenceMultiplier(d.score) : Infinity,
      difficulty: d, gain: g,
    };
  }

  // ------------------------------------------------------- text x gaze rule
  /* Multiplier on the gaze threshold (tau, the ratio of time spent to time expected) for one block.
   *   d <  0.25  -> Infinity (hard veto: already easy)
   *   d =  0.25  -> 1.50     easy-ish text needs half as much evidence again
   *   d =  0.50  -> 1.00     ordinary news-level prose: the calibrated threshold as it is
   *   d >= 0.80  -> 0.80     hard text: 20% less evidence, never less than that
   * Linear between the anchors. */
  const M = { easy: 0.25, mid: 0.50, hard: 0.80, mEasy: 1.5, mMid: 1.0, mHard: 0.8 };
  function evidenceMultiplier(score) {
    if (!(score >= M.easy)) return Infinity;
    if (score <= M.mid) return round(M.mEasy + (M.mMid - M.mEasy) * (score - M.easy) / (M.mid - M.easy), 2);
    if (score >= M.hard) return M.mHard;
    return round(M.mMid + (M.mHard - M.mMid) * (score - M.mid) / (M.hard - M.mid), 2);
  }
  /** Extra jumps back required before a 'rereading' struggle counts (on top of gaze-core's needBack). */
  const extraBacktracks = (score) => (score < 0.40 ? 1 : 0);

  // ------------------------------------------------------------ DOM helper
  /** What a plain-text swap of this element would destroy. Browser only. */
  function domMeta(el) {
    let linkChars = 0;
    const links = el.querySelectorAll('a[href]');
    for (const a of links) linkChars += (a.textContent || '').replace(/\s+/g, ' ').trim().length;
    return {
      links: links.length, linkChars,
      inline: el.querySelectorAll('strong, b, em, i, mark, abbr, u, q, cite').length,
      media: el.querySelectorAll('img, picture, svg, canvas, math, code, kbd, samp, pre, sup, sub, br, ul, ol, audio').length,
    };
  }

  const api = { difficulty, gain, suitability, evidenceMultiplier, extraBacktracks, domMeta, syllables, isCommon, features,
    constants: { K, G, V, M }, COMMON_SIZE: COMMON.size };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderTextScore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
