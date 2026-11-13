/*
 * wordLevels.js — how hard a word is, as a CEFR level (A1 easiest .. C2 hardest).
 *
 * The list is data/levels.txt ("word<TAB>LEVEL" lines), built by tools/make-levels.js from
 * the CEFR-J Wordlist 1.5 (A1..B2) and the Octanove Vocabulary Profile (C1/C2).
 * A word not in the list has no level: nothing is guessed.
 *
 * Classic script in the page and the service worker (globalThis.GliderLevels), require()-able in Node.
 *   parse(text)          -> Map word -> level
 *   lookup(map, word)    -> { level, base } or null; base is the listed word ("studies" -> "study")
 */
(function (root) {
  'use strict';

  const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const INFO = Object.freeze({
    A1: { name: 'Beginner', text: 'One of the first words people learn' },
    A2: { name: 'Elementary', text: 'An everyday word' },
    B1: { name: 'Intermediate', text: 'A common word in school and news' },
    B2: { name: 'Upper intermediate', text: 'A word for more detailed topics' },
    C1: { name: 'Advanced', text: 'A less common, more formal word' },
    C2: { name: 'Proficient', text: 'A rare or specialist word' },
  });

  function parse(text) {
    const map = new Map();
    for (const line of String(text || '').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 1) continue;
      const level = line.slice(tab + 1).trim();
      if (LEVELS.includes(level)) map.set(line.slice(0, tab), level);
    }
    return map;
  }

  const VOWEL = /[aeiouy]/;

  /** Base forms to try, most likely first: plurals, -ed and -ing. */
  function candidates(w) {
    const out = [];
    const add = (s) => { if (s.length >= 2 && VOWEL.test(s) && !out.includes(s)) out.push(s); };
    if (w.endsWith("'s")) add(w.slice(0, -2));
    if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) add(w.slice(0, -2));
    if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
    if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
    for (const end of ['ed', 'ing']) {
      if (!w.endsWith(end)) continue;
      const stem = w.slice(0, -end.length);
      // A single final consonant after a single vowel was not doubled, so the base
      // ends in e (hoped -> hope, but hopped -> hop): try that first.
      if (/[^aeiou][aeiou][b-df-hj-np-tv-z]$/.test(stem)) { add(stem + 'e'); add(stem); }
      else { add(stem); add(stem + 'e'); }                         // walked -> walk, making -> make
      if (/([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1)); // running -> run, stopped -> stop
    }
    if (w.endsWith('d')) add(w.slice(0, -1));                     // used -> use (when "use" + d)
    return out;
  }

  function lookup(map, raw) {
    if (!map || typeof raw !== 'string') return null;
    const w = raw.toLowerCase().replace(/[’‘]/g, "'").trim();
    if (!w || w.length > 40) return null;
    if (map.has(w)) return { level: map.get(w), base: w };
    for (const c of candidates(w)) if (map.has(c)) return { level: map.get(c), base: c };
    return null;
  }

  const api = { LEVELS, INFO, parse, lookup, candidates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderLevels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
