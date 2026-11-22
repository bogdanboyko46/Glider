/*
 * splitter.js — where a long sentence divides into parts. Pure: no DOM, no Chrome APIs.
 * Classic script in the browser (globalThis.GliderSplitter), require()-able in Node.
 *
 * "Adapt ahead" (adapt/adapt.js) shows a long multi-clause sentence one part per line.
 * This file only finds the places: it returns character offsets and never produces
 * text of its own, so no word can be changed, dropped, added or moved. Joining the
 * parts always gives back the sentence, character for character.
 *
 * A sentence divides
 *   - after ';' and ':'                                   (when white space follows)
 *   - after a comma followed by a joining word            (and, but, which, who, excluding, provided ...)
 *   - after the comma that closes a clause opened by      (if, when, where, although ...)
 *     "where the Tenant disputes the apportionment, | the burden ..."
 * Parts shorter than MIN_PART_WORDS are joined to the part after them (the last one to
 * the part before), so "provided, however, that where ..." stays in one piece.
 *
 * The trait: a sentence is "long multi-clause" when it has LONG_WORDS words or more, or
 * MANY_BREAKS dividing places or more and at least MANY_BREAKS_MIN_WORDS words.
 */
(function (root) {
  'use strict';

  const LONG_WORDS = 30;             // this many words: the trait, whatever the punctuation
  const MANY_BREAKS = 3;             // or this many dividing places ...
  const MANY_BREAKS_MIN_WORDS = 16;  // ... in a sentence that is not just a short list
  const MIN_PART_WORDS = 3;          // no part shorter than this
  const OPENER_REACH = 3;            // a clause opener counts within the first words of a part
  const OPENER_MIN_WORDS = 4;        // "If so, ..." is too short to be a clause worth a line

  /* After a comma, these start a new part. */
  const JOINERS = new Set([
    'and', 'but', 'or', 'nor', 'yet', 'so',
    'which', 'who', 'whom', 'whose', 'that', 'where', 'when', 'while', 'whilst', 'whereas',
    'whereby', 'wherein', 'whereupon',
    'although', 'though', 'because', 'since', 'unless', 'until', 'if',
    'provided', 'providing', 'excluding', 'including', 'except', 'however', 'notwithstanding',
  ]);
  /* A part that begins with one of these is a clause that ends at its next comma. */
  const OPENERS = new Set([
    'if', 'when', 'where', 'while', 'whilst', 'whereas', 'although', 'though', 'because',
    'since', 'unless', 'until', 'once', 'after', 'before', 'provided',
  ]);
  /* A full stop after these does not end a sentence. */
  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'no', 'nos', 'fig', 'figs', 'vol',
    'inc', 'ltd', 'co', 'corp', 'e.g', 'i.e', 'cf', 'approx', 'art', 'sec', 'para', 'p', 'pp', 'ca',
  ]);

  const WORD_RE = /\S+/g;
  const words = (text) => String(text == null ? '' : text).match(WORD_RE) || [];
  const wordCount = (text) => words(text).length;
  const bare = (word) => String(word).toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');

  /** Does the text begin, within its first few words, with a clause opener? */
  function opensClause(text) {
    const w = words(text);
    if (w.length < OPENER_MIN_WORDS) return false;
    for (let i = 0; i < Math.min(OPENER_REACH, w.length); i++) if (OPENERS.has(bare(w[i]))) return true;
    return false;
  }

  /** Every place the punctuation allows a division, before short parts are joined up. */
  function rawPoints(sentence) {
    const s = String(sentence == null ? '' : sentence);
    const out = [];
    const re = /([,;:])(["'”’)\]]*)(\s+)(?=\S)/g;
    let from = 0;   // start of the part being built
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const at = m.index + m[0].length;   // the next part starts here, on its first character
      let cut = m[1] !== ',';
      if (!cut) {
        const next = /^\S+/.exec(s.slice(at));
        cut = !!next && JOINERS.has(bare(next[0]));
        if (!cut) cut = opensClause(s.slice(from, m.index));
      }
      if (cut) { out.push(at); from = at; }
    }
    return out;
  }

  /** Remove the divisions that would leave a part of only a word or two. */
  function joinShortParts(s, points) {
    const kept = [];
    let start = 0;
    for (const at of points) {
      if (wordCount(s.slice(start, at)) < MIN_PART_WORDS) continue;   // too short: it joins the part after it
      kept.push(at);
      start = at;
    }
    while (kept.length && wordCount(s.slice(kept[kept.length - 1])) < MIN_PART_WORDS) kept.pop();
    return kept;
  }

  /**
   * The character offsets at which each later part of the sentence begins.
   * [] when the sentence does not divide.
   */
  function splitPoints(sentence) {
    const s = String(sentence == null ? '' : sentence);
    return joinShortParts(s, rawPoints(s));
  }

  /** The sentence cut at its split points. parts(s).join('') === s, always. */
  function parts(sentence) {
    const s = String(sentence == null ? '' : sentence);
    const out = [];
    let start = 0;
    for (const at of splitPoints(s)) { out.push(s.slice(start, at)); start = at; }
    out.push(s.slice(start));
    return out;
  }

  /** { words, points, trait } for one sentence. `trait` is the long multi-clause test. */
  function analyse(sentence) {
    const s = String(sentence == null ? '' : sentence);
    const n = wordCount(s);
    const points = splitPoints(s);
    const trait = n >= LONG_WORDS || (points.length >= MANY_BREAKS && n >= MANY_BREAKS_MIN_WORDS);
    return { words: n, points, trait };
  }
  const hasTrait = (sentence) => analyse(sentence).trait;

  /** Is the full stop that ends at `end` part of an abbreviation or an initial? */
  function isAbbreviation(text, end) {
    const m = /(\S+)\.$/.exec(text.slice(Math.max(0, end - 24), end));
    if (!m) return false;
    const w = m[1].toLowerCase().replace(/^[("'“‘\[]+/, '');
    return ABBREVIATIONS.has(w) || /^\p{L}$/u.test(w) || /^(\p{L}\.)+\p{L}$/u.test(w);
  }

  /**
   * The sentences of a paragraph's text as [{ start, end, text }], where text is
   * paragraph.slice(start, end). White space between sentences belongs to none of them.
   */
  function sentences(paragraph) {
    const text = String(paragraph == null ? '' : paragraph);
    const out = [];
    const push = (a, b) => {
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b > a) out.push({ start: a, end: b, text: text.slice(a, b) });
    };
    const re = /([.!?]+)(["'”’)\]]*)(?=\s+["'“‘(\[]*[\p{Lu}\p{N}])/gu;
    let start = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const stop = m.index + m[1].length;
      if (m[1] === '.' && isAbbreviation(text, stop)) continue;
      const end = m.index + m[0].length;
      push(start, end);
      start = end;
    }
    push(start, text.length);
    return out;
  }

  const api = {
    sentences, splitPoints, parts, analyse, hasTrait, wordCount,
    THRESHOLDS: { LONG_WORDS, MANY_BREAKS, MANY_BREAKS_MIN_WORDS, MIN_PART_WORDS },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderSplitter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
