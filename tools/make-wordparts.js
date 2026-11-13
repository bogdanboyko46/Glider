// node tools/make-wordparts.js <path to WordNet 3.1 dict/ folder>
//
// Builds glider-extension/data/wordparts.txt: for each word the hover lens can show, its
// prefixes, roots, suffixes and base word, as found by content/wordParts.js. WordNet supplies
// two things the splitter needs: the word classes of real words (noun, verb ...) and which words
// are formed from which (teacher <- teach, happiness <- happy: its "derivationally related"
// and "derived from" links).
//   word<TAB>p:un:0:2 w:happy:2:7 s:ness:7:11
const fs = require('node:fs');
const path = require('node:path');
const P = require('../glider-extension/content/wordParts.js');

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'index.noun'))) {
  console.error('usage: node tools/make-wordparts.js <WordNet dict/ folder>');
  process.exit(1);
}
const DATA = path.join(__dirname, '..', 'glider-extension', 'data');
const FILES = { noun: 'n', verb: 'v', adj: 'a', adv: 'r' };

// Word classes of every WordNet word.
const classes = new Map();
for (const [file, pos] of Object.entries(FILES)) {
  for (const line of fs.readFileSync(path.join(dir, `index.${file}`), 'latin1').split('\n')) {
    if (!line || line.startsWith(' ')) continue;
    const word = line.slice(0, line.indexOf(' '));
    if (!/^[a-z]+$/.test(word)) continue;
    classes.set(word, (classes.get(word) || '') + pos);
  }
}
// Irregular forms count as words of their base's class (better -> good).
for (const file of Object.keys(FILES)) {
  for (const line of fs.readFileSync(path.join(dir, `${file}.exc`), 'latin1').split('\n')) {
    const [form, base] = line.trim().split(' ');
    if (form && base && /^[a-z]+$/.test(form) && classes.has(base) && !classes.has(form)) classes.set(form, classes.get(base));
  }
}

// "Formed from" links between words: + (derivationally related) and \ (derived from / pertains to).
const synsetWords = new Map();   // "pos:offset" -> [words]
const records = [];
for (const [file, pos] of Object.entries(FILES)) {
  for (const line of fs.readFileSync(path.join(dir, `data.${file}`), 'latin1').split('\n')) {
    if (!line || line.startsWith(' ')) continue;
    const f = line.split(' ');
    const n = parseInt(f[3], 16);
    const words = [];
    for (let i = 0; i < n; i++) words.push(f[4 + 2 * i].toLowerCase().replace(/\(.*\)$/, ''));
    synsetWords.set(`${pos}:${f[0]}`, words);
    records.push({ words, f, n });
  }
}
const SS = { n: 'n', v: 'v', a: 'a', s: 'a', r: 'r' };
const links = new Set();
for (const { words, f, n } of records) {
  let i = 4 + 2 * n;
  const count = Number(f[i++]);
  for (let k = 0; k < count; k++, i += 4) {
    const [symbol, offset, ptrPos, st] = [f[i], f[i + 1], f[i + 2], f[i + 3]];
    if (symbol !== '+' && symbol !== '\\') continue;
    const src = parseInt(st.slice(0, 2), 16), dst = parseInt(st.slice(2), 16);
    const target = synsetWords.get(`${SS[ptrPos]}:${offset}`);
    if (!src || !dst || !target) continue;
    const a = words[src - 1], b = target[dst - 1];
    if (a && b) { links.add(a + '|' + b); links.add(b + '|' + a); }
  }
}
const posOf = (w) => classes.get(w) || '';
const related = (a, b) => links.has(a + '|' + b);

// Everyday words (the CEFR list): only these count as base words, so "accumulate" is not ac + "cumulate".
const everyday = new Set();
for (const line of fs.readFileSync(path.join(DATA, 'levels.txt'), 'utf8').split('\n')) {
  const tab = line.indexOf('\t');
  if (tab > 0) everyday.add(line.slice(0, tab));
}
const common = (w) => everyday.has(w);

// The words the lens can open on.
const words = new Set();
for (const file of ['pronounce.txt', 'levels.txt', 'dictionary.txt']) {
  for (const line of fs.readFileSync(path.join(DATA, file), 'utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) words.add(line.slice(0, tab));
  }
}

const out = [];
const kinds = { p: 0, r: 0, s: 0, w: 0 };
for (const word of [...words].sort()) {
  const parts = P.split(word, posOf, related, common);
  if (!parts) continue;
  for (const p of parts) kinds[p.type]++;
  out.push(`${word}\t${P.encode(parts)}`);
}
const file = path.join(DATA, 'wordparts.txt');
fs.writeFileSync(file, out.join('\n') + '\n');
console.log(`${out.length} of ${words.size} words split -> ${path.relative(process.cwd(), file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`, kinds, `${links.size / 2} dictionary links`);
