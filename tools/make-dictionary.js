// node tools/make-dictionary.js <path to WordNet 3.1 dict/ folder>
//
// Builds glider-extension/data/dictionary.txt from Princeton WordNet 3.1
// (https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz). Only single words the lens can show are
// kept (everyday English rather than taxonomy), with at most three senses:
// the most-used part of speech first, two senses of it, then one sense of each other part of speech.
//
// Line formats (LF ends, sorted):
//   word<TAB>pos|definition|example<TAB>pos|definition|example ...     pos: n v a r (noun verb adjective adverb)
//   form<TAB>@base                                                      an irregular form (went -> go), from WordNet's *.exc lists
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'index.noun'))) {
  console.error('usage: node tools/make-dictionary.js <WordNet dict/ folder>');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..', 'glider-extension', 'data');
const POS = { noun: 'n', verb: 'v', adj: 'a', adv: 'r' };
const MAX_SENSES = 3;

// Words the hover lens can open on: the pronunciation list (long words), the CEFR word list
// (everyday words of any length) and the look-alike groups (their, affect, ...).
const known = new Set();
for (const file of ['pronounce.txt', 'levels.txt']) {
  for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) known.add(line.slice(0, tab));
  }
}
for (const group of require(path.join(ROOT, '..', 'content', 'homophones.js')).HOMOPHONES) {
  for (const entry of group.words) known.add(String(entry.w).toLowerCase());
}

const clean = (s) => s.replace(/\s+/g, ' ').replace(/[|\t]/g, '/').trim();

/** "def; "example one"; "example two"" -> { def, example } */
function splitGloss(gloss) {
  const parts = gloss.split(/;\s*(?=")/);
  const def = clean(parts[0].replace(/;\s*$/, ''));
  const ex = parts.slice(1).map((p) => p.trim().replace(/^"|"$/g, '').replace(/"\s*$/, '')).find(Boolean) || '';
  return { def, example: clean(ex) };
}

const entries = new Map();   // word -> [{ pos, rank, senses: [{def, example}] }]
for (const [file, pos] of Object.entries(POS)) {
  const data = fs.readFileSync(path.join(dir, `data.${file}`));   // byte offsets: keep it a Buffer
  for (const line of fs.readFileSync(path.join(dir, `index.${file}`), 'latin1').split('\n')) {
    if (!line || line.startsWith(' ')) continue;                   // licence header
    const f = line.trim().split(' ');
    const word = f[0];
    if (!/^[a-z][a-z'-]*$/.test(word) || !known.has(word)) continue;
    const ptrCount = Number(f[3]);
    const senseCount = Number(f[4 + ptrCount]);
    const tagged = Number(f[5 + ptrCount]);                        // how often this part of speech was seen in tagged text
    const offsets = f.slice(6 + ptrCount, 6 + ptrCount + senseCount);
    const senses = [];
    for (const off of offsets.slice(0, MAX_SENSES)) {
      const at = Number(off);
      const end = data.indexOf(10, at);
      const rec = data.toString('latin1', at, end);
      const bar = rec.indexOf(' | ');
      if (bar < 0) continue;
      const g = splitGloss(rec.slice(bar + 3));
      if (g.def) senses.push(g);
    }
    if (!senses.length) continue;
    if (!entries.has(word)) entries.set(word, []);
    entries.get(word).push({ pos, rank: tagged, senses });
  }
}

const lines = [];
for (const [word, groups] of entries) {
  groups.sort((a, b) => b.rank - a.rank || 'nvar'.indexOf(a.pos) - 'nvar'.indexOf(b.pos));
  const out = [];
  groups.forEach((g, i) => { for (const s of g.senses.slice(0, i === 0 ? 2 : 1)) out.push(`${g.pos}|${s.def}|${s.example}`); });
  lines.push(`${word}\t${out.slice(0, MAX_SENSES).join('\t')}`);
}

// Irregular forms: mice -> mouse, went -> go, better -> good.
let redirects = 0;
for (const file of ['noun', 'verb', 'adj', 'adv']) {
  for (const line of fs.readFileSync(path.join(dir, `${file}.exc`), 'latin1').split('\n')) {
    const [form, base] = line.trim().split(' ');
    if (!form || !base || form === base || entries.has(form) || !entries.has(base) || !/^[a-z][a-z'-]*$/.test(form)) continue;
    lines.push(`${form}\t@${base}`);
    entries.set(form, []);   // first base wins
    redirects++;
  }
}

lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const out = path.join(ROOT, 'dictionary.txt');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`${lines.length - redirects} words + ${redirects} irregular forms -> ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
