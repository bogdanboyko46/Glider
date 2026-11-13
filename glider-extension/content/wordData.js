/*
 * wordData.js — looking words up in the bundled lists: definitions (data/dictionary.txt,
 * from WordNet) and prefixes/roots/suffixes (data/wordparts.txt). The lists are kept as one
 * string each and searched by line, so nothing is parsed up front.
 *
 *   prepare(text)          -> '\n' + text   (do this once per file)
 *   define(dict, word)     -> { word, senses: [{ pos, posName, def, example }] } or null
 *   partsOf(table, word)   -> [{ type, id, start, end, form, base?, kind, label, meaning, example }] or null
 *
 * Needs GliderLevels (base forms of "studies", "hoped") and GliderParts (meanings of parts).
 * Classic script (globalThis.GliderWordData), require()-able in Node.
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const L = isNode ? require('./wordLevels.js') : root.GliderLevels;
  const P = isNode ? require('./wordParts.js') : root.GliderParts;

  const POS = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };
  const prepare = (text) => '\n' + String(text || '').replace(/\r/g, '');

  /** The rest of the line for `word`, or null. `text` comes from prepare(). */
  function line(text, word) {
    const key = '\n' + word + '\t';
    const at = text.indexOf(key);
    if (at < 0) return null;
    const end = text.indexOf('\n', at + key.length);
    return text.slice(at + key.length, end < 0 ? undefined : end);
  }

  const clean = (w) => String(w || '').toLowerCase().replace(/[’‘]/g, "'").replace(/^'+|'+$/g, '').trim();
  const forms = (w) => [w].concat(L && w.length <= 40 ? L.candidates(w) : []);

  function define(dict, raw) {
    const w = clean(raw);
    if (!dict || !w || w.length > 40) return null;
    for (const f of forms(w)) {
      let rest = line(dict, f), word = f;
      if (rest && rest.startsWith('@')) { word = rest.slice(1); rest = line(dict, word); }   // went -> go
      if (!rest) continue;
      const senses = rest.split('\t').map((s) => {
        const [pos, def, example] = s.split('|');
        return { pos, posName: POS[pos] || '', def: def || '', example: example || '' };
      }).filter((s) => s.def);
      if (senses.length) return { word, senses };
    }
    return null;
  }

  function partsOf(table, raw) {
    const w = clean(raw);
    if (!table || !P || !w || w.length > 40) return null;
    // The word itself, or a base form it starts with ("teachers" -> "teacher"): the spans still fit.
    for (const f of forms(w)) {
      if (f !== w && !w.startsWith(f)) continue;
      const enc = line(table, f);
      if (!enc) continue;
      const parts = P.decode(enc, f).map((p) => Object.assign(p, P.describe(p)));
      if (parts.length && parts.every((p) => p.kind)) return parts;
    }
    return null;
  }

  const api = { POS, prepare, line, define, partsOf };
  if (isNode) module.exports = api;
  else root.GliderWordData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
