// node tools/make-levels.js <cefrj-vocabulary-profile-1.5.csv> <octanove-vocabulary-profile-c1c2-1.0.csv>
//
// Builds glider-extension/data/levels.txt: one "word<TAB>LEVEL" line per single word, CEFR A1..C2.
// Sources (https://github.com/openlanguageprofiles/olp-en-cefrj):
//   CEFR-J Wordlist 1.5 (A1..B2), Tono Laboratory, Tokyo University of Foreign Studies
//   Octanove Vocabulary Profile C1/C2 1.0, Octanove Labs, CC BY-SA 4.0
// A word listed under several parts of speech keeps its lowest (easiest) level.
// Spelling variants ("colour/color") each get their own line. Phrases ("bus stop") are left out.
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const [cefrjPath, octanovePath] = process.argv.slice(2);
if (!cefrjPath || !octanovePath) {
  console.error('usage: node tools/make-levels.js <cefrj.csv> <octanove.csv>');
  process.exit(1);
}

/** Minimal CSV row splitter: commas, with "quoted, fields". */
function cells(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const levels = new Map();
function addFile(file) {
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const head = cells(rows[0]).map((h) => h.trim().toLowerCase());
  const wordCol = head.indexOf('headword'), levelCol = head.indexOf('cefr');
  if (wordCol < 0 || levelCol < 0) throw new Error(`${file}: expected headword and CEFR columns`);
  let used = 0;
  for (const row of rows.slice(1)) {
    if (!row.trim()) continue;
    const c = cells(row);
    const level = String(c[levelCol] || '').trim().toUpperCase();
    if (!LEVELS.includes(level)) continue;
    for (const variant of String(c[wordCol] || '').split('/')) {
      const word = variant.trim().toLowerCase().replace(/’/g, "'");
      if (!/^[a-z][a-z'-]*$/.test(word.normalize('NFD').replace(/[̀-ͯ]/g, ''))) continue; // single words only
      for (const w of new Set([word, word.normalize('NFD').replace(/[̀-ͯ]/g, '')])) { // café -> cafe too
        const had = levels.get(w);
        if (!had || LEVELS.indexOf(level) < LEVELS.indexOf(had)) levels.set(w, level);
      }
      used++;
    }
  }
  return used;
}

const a = addFile(cefrjPath);
const b = addFile(octanovePath);
const words = [...levels.keys()].sort();
const out = path.join(__dirname, '..', 'glider-extension', 'data', 'levels.txt');
fs.writeFileSync(out, words.map((w) => `${w}\t${levels.get(w)}`).join('\n') + '\n');
const count = {};
for (const w of words) count[levels.get(w)] = (count[levels.get(w)] || 0) + 1;
console.log(`${a} CEFR-J + ${b} Octanove entries -> ${words.length} words in ${path.relative(process.cwd(), out)}`, count);
