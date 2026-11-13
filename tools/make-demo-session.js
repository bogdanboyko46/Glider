// node tools/make-demo-session.js — writes lexilens-extension/assessment/demo-session.json
// A simulated adult reader: sequential fixations per line, ~15-20% regressions,
// one stuck line late in the passage, two line re-reads, a blink every ~4 s, mild noise.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'lexilens-extension', 'assessment');
const D = require(path.join(dir, 'demo-generator.js'));
const A = require(path.join(dir, 'analytics.js'));

const DEMO_OPTIONS = { seed: 29, regressionProb: 0.2, stuckLine: 6, stuckFactor: 2.3, rereadAfterLines: [3, 7], fatigue: 0.2, answers: [1, 2] };
const { session, truth } = D.makeSession(DEMO_OPTIONS);
const file = path.join(dir, 'demo-session.json');
fs.writeFileSync(file, JSON.stringify(session));

const a = A.analyze(session);
console.log('wrote', path.relative(process.cwd(), file), (fs.statSync(file).size / 1024).toFixed(0) + ' kB');
console.log('truth  ', JSON.stringify(truth));
console.log('metrics', JSON.stringify({ ...a.metrics, head: undefined }));
console.log('lines  ', a.lines.map((l) => l.ratio + (l.flagged ? '!' : '') + (l.rereads ? ' r' + l.rereads : '')).join(' | '));
console.log('profile', JSON.stringify(a.profile), 'quality', a.quality.level);
console.log('halves ', JSON.stringify(a.halves));
console.log('finds  ', a.findings.map((f) => f.id).join(', '));

module.exports = { DEMO_OPTIONS };
