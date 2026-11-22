/*
 * reorder.js — puts the main clause of a sentence first. Pure: no DOM, no Chrome APIs.
 * Classic script in the browser (globalThis.GliderReorder), require()-able in Node.
 *
 *   "If you disagree, you must prove the damage was already there."
 *     -> "You must prove the damage was already there if you disagree."
 *
 * The trait: a sentence that opens with a subordinate clause (If, When, Where, While,
 * Although, Though, Because, Since, Unless, Until, Once, Provided that, In the event
 * that ...), then a comma, then its main clause.
 *
 * HARD RULE: words are only ever moved. The set of words, with their counts, is the same
 * before and after (sameWords). The only other things that change are the capital letter
 * of the two words that swap first place, and the comma at the boundary, which goes. If a
 * result would break the rule, the sentence is returned untouched.
 *
 * It is deliberately timid. A sentence is left alone when it has quotes, brackets, dashes,
 * a colon or semicolon, a question or exclamation mark, a full stop inside it, more or
 * fewer than one comma, a main clause that begins with a pronoun pointing back at the
 * opening clause ("When Ann arrived, she ..."), with "then", or with a joining word, or an
 * opening clause much longer than the main clause.
 */
(function (root) {
  'use strict';

  const MAX_LEAD_RATIO = 2;    // opening clause at most this many times the main clause, in words
  const MAX_LEAD_WORDS = 20;
  const MIN_LEAD_WORDS = 2;
  const MIN_MAIN_WORDS = 3;

  /* Sentence-initial spellings only: these are the words that lose their capital when moved. */
  const OPENER_RE = /^(If|When|Where|While|Although|Though|Because|Since|Unless|Until|Once|Provided that|In the event that)\s/;
  /* A main clause that starts like this would read wrongly, or is not a main clause. */
  const BAD_MAIN_START = new Set([
    'then', 'and', 'but', 'or', 'nor', 'so', 'yet', 'which', 'who', 'whom', 'whose', 'that', 'where', 'when', 'while',
    'he', 'she', 'it', 'they', 'him', 'her', 'them', 'his', 'hers', 'its', 'their', 'theirs',
    'this', 'these', 'those', 'such', 'one', 'both', 'each', 'either', 'neither',
  ]);
  const UNSAFE_RE = /["“”„«»‘()\[\]{}<>;:!?—–…\/]|\s-\s|--/;

  /** The words of a text: lower-cased, punctuation at either end removed. */
  function wordsOf(text) {
    const out = [];
    for (const raw of String(text == null ? '' : text).split(/\s+/)) {
      const w = raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (w) out.push(w);
    }
    return out;
  }

  /** Do two texts hold exactly the same words, the same number of times each? */
  function sameWords(a, b) {
    const x = wordsOf(a).sort(), y = wordsOf(b).sort();
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  /** Split into { lead, main } when the sentence has the trait and is safe to reorder; else null. */
  function clauses(sentence) {
    const s = String(sentence == null ? '' : sentence);
    if (!s || s !== s.trim() || !s.endsWith('.')) return null;
    const body = s.slice(0, -1);
    if (body.includes('.') || UNSAFE_RE.test(body)) return null;
    if (/(^|[^\p{L}\p{N}])['’]|['’]($|[^\p{L}\p{N}])/u.test(body)) return null;   // a quote mark, not an apostrophe inside a word
    if (!OPENER_RE.test(body)) return null;
    const commas = body.match(/,/g);
    if (!commas || commas.length !== 1) return null;
    const m = /^([^,]+),\s+(\S[^,]*)$/.exec(body);
    if (!m) return null;
    const lead = m[1], main = m[2];
    if (/\s$/.test(lead)) return null;
    const leadWords = wordsOf(lead), mainWords = wordsOf(main);
    if (leadWords.length < MIN_LEAD_WORDS || leadWords.length > MAX_LEAD_WORDS || mainWords.length < MIN_MAIN_WORDS) return null;
    if (leadWords.length > MAX_LEAD_RATIO * mainWords.length) return null;
    if (BAD_MAIN_START.has(mainWords[0])) return null;
    if (!/^[\p{L}\p{N}]/u.test(main)) return null;
    return { lead, main };
  }

  /**
   * reorder(sentence) -> { text, changed }. `text` is the sentence with its main clause first,
   * or the sentence exactly as given when it does not have the trait or cannot be moved safely.
   */
  function reorder(sentence) {
    const s = String(sentence == null ? '' : sentence);
    const same = { text: s, changed: false };
    const c = clauses(s);
    if (!c) return same;
    // The old first word is one of the openers above, so it is safe to lower-case; names are never touched.
    const lead = c.lead[0].toLowerCase() + c.lead.slice(1);
    const main = c.main[0].toUpperCase() + c.main.slice(1);
    const text = main + ' ' + lead + '.';
    if (!sameWords(s, text)) return same;
    return { text, changed: true };
  }

  const hasTrait = (sentence) => clauses(sentence) !== null;

  const api = { reorder, hasTrait, sameWords, wordsOf, THRESHOLDS: { MAX_LEAD_RATIO, MAX_LEAD_WORDS, MIN_LEAD_WORDS, MIN_MAIN_WORDS } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderReorder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
