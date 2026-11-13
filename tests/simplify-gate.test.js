// node tests/simplify-gate.test.js — when may simplified text appear? (pure decision logic)
const path = require('path');
const G = require(path.join(__dirname, '..', 'glider-extension', 'simplify', 'gate.js'));
const T = require(path.join(__dirname, '..', 'glider-extension', 'simplify', 'textscore.js'));

let failed = 0;
const ok = (c, m, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${d ? '  -> ' + d : ''}`); if (!c) failed += 1; };

const HARD = 'The light-independent reactions, often called the Calvin cycle, use that stored energy to fix carbon dioxide into sugars. The enzyme responsible for the first step, ribulose-1,5-bisphosphate carboxylase-oxygenase, is probably the most abundant protein on Earth, and it is famously slow and inefficient at its job.';
const HARD_SIMPLE = 'The second set of reactions is called the Calvin cycle. It uses the stored energy to turn carbon dioxide into sugar. One enzyme starts it. It is very common, but it is slow.';
const EASY = 'Every morning the baker opens her shop before the sun comes up. She mixes flour, water and a little salt, then leaves the dough to rest. While it rises, she sweeps the floor and lights the big oven.';

const el = () => ({});   // any object works as a paragraph identity
const ev = (element, over = {}) => ({
  element, reason: over.reason || 'slow-paragraph', coarse: true,
  metrics: { paragraphDwellMs: (over.ratio || 2) * 10000, expectedParagraphMs: 10000, tau: 2, baselineWpm: 'baselineWpm' in over ? over.baselineWpm : 140, backtracks: over.backtracks || 0 },
});
const ctx = (now, over = {}) => ({ text: over.text || HARD, simplified: 'simplified' in over ? over.simplified : HARD_SIMPLE, meta: over.meta || null, serviceReady: !!over.serviceReady, now });

// ---- the measure itself
ok(G.slowness(2, 2, 1) === 1, 'slowness is 1.0 exactly at the reader threshold');
ok(G.slowness(1, 2, 1) === 0 && G.slowness(0.8, 2, 1) === 0, 'reading at or under the expected time is no evidence');
ok(G.slowness(2, 2, 0.8) > 1 && G.slowness(2, 2, 1.5) < 1, 'hard text needs less slowness, easy text more');
ok(G.slowness(3, 2, 1) > G.slowness(2, 2, 1), 'slower is more evidence');

// ---- text vetoes come first
{
  const g = G.create(); const p = el();
  const d1 = g.evaluate(ev(p, { ratio: 4 }), ctx(0, { text: EASY, simplified: EASY }));
  const d2 = g.evaluate(ev(p, { ratio: 5 }), ctx(20000, { text: EASY, simplified: EASY }));
  ok(d1.action === 'none' && d2.action === 'none' && /^text:/.test(d2.why), 'easy text is never offered or swapped, however slow the reader', d2.why);
  ok(T.suitability(EASY, { simplified: EASY }).verdict === 'never', 'the text score vetoes the easy passage');
}
{
  const g = G.create(); const p = el();
  g.evaluate(ev(p, { ratio: 2.2 }), ctx(0, { simplified: HARD }));
  const d = g.evaluate(ev(p, { ratio: 3 }), ctx(20000, { simplified: HARD }));
  ok(d.action === 'none' && d.why === 'text:offline-cannot-help', 'when the offline simplifier changes nothing and there is no rewrite service, nothing is shown', d.why);
  const g2 = G.create(); const q = el();
  g2.evaluate(ev(q, { ratio: 2.2 }), ctx(0, { simplified: HARD, serviceReady: true }));
  const d2 = g2.evaluate(ev(q, { ratio: 3 }), ctx(20000, { simplified: HARD, serviceReady: true }));
  ok(d2.action === 'offer' && d2.why === 'offer-llm', 'with a rewrite service the same paragraph gets an offer', d2.why);
}

// ---- first sign is for the gentle help; the second brings the offer
{
  const g = G.create(); const p = el();
  const d1 = g.evaluate(ev(p, { ratio: 2.1 }), ctx(0));
  ok(d1.action === 'gentle', 'first sign on a paragraph: gentle help only', JSON.stringify(d1));
  const d2 = g.evaluate(ev(p, { ratio: 2.9 }), ctx(9000));
  ok(d2.action === 'offer', 'the reader stays slow: a second sign brings the offer', JSON.stringify(d2));
  const d3 = g.evaluate(ev(p, { ratio: 3.6 }), ctx(30000));
  ok(d3.action === 'none' && d3.why === 'already-offered', 'the same paragraph is not offered twice in a row', d3.why);
}
{
  const g = G.create(); const p = el();
  const d1 = g.evaluate(ev(p, { ratio: 6 }), ctx(0));
  ok(d1.action === 'gentle', 'even a very slow first sign is left to the gentle help');
}
{
  const g = G.create(); const p = el();
  g.evaluate(ev(p, { ratio: 1.3, reason: 'stuck-line' }), ctx(0));
  const d = g.evaluate(ev(p, { ratio: 1.4, reason: 'stuck-line' }), ctx(10000));
  ok(d.action === 'none', 'a stuck line with a normal paragraph total never brings the simplifier (a word problem, not a paragraph problem)', JSON.stringify(d));
}
{
  const g = G.create(); const p = el();
  g.evaluate(ev(p, { ratio: 1.7 }), ctx(0));
  const slowOnly = G.create(); const q = el();
  slowOnly.evaluate(ev(q, { ratio: 1.5 }), ctx(0));
  const a = g.evaluate(ev(p, { ratio: 1.75, reason: 'rereading', backtracks: 2 }), ctx(10000));
  const b = slowOnly.evaluate(ev(q, { ratio: 1.5 }), ctx(10000));
  ok(a.score > b.score && a.reread, 're-reading on top of slowness is stronger evidence than slowness alone', `${a.score} vs ${b.score}`);
}
{
  const g = G.create(); const p = el();
  g.evaluate(ev(p, { ratio: 2.1 }), ctx(0));
  const d = g.evaluate(ev(p, { ratio: 2.2 }), ctx(200000));
  ok(d.action === 'gentle', 'signs from long ago no longer count: it starts again with gentle help', d.action);
}

// ---- pace never measured
{
  const g = G.create(); const p = el();
  g.evaluate(ev(p, { ratio: 2.1, baselineWpm: null }), ctx(0));
  const d = g.evaluate(ev(p, { ratio: 2.2, baselineWpm: null }), ctx(10000));
  const g2 = G.create(); const q = el();
  g2.evaluate(ev(q, { ratio: 2.1 }), ctx(0));
  const d2 = g2.evaluate(ev(q, { ratio: 2.2 }), ctx(10000));
  ok(d.score < d2.score, 'without a measured reading pace the same slowness counts for less', `${d.score} vs ${d2.score}`);
  const ga = G.create({ mode: 'auto' }); const r = el();
  ga.evaluate(ev(r, { ratio: 4, baselineWpm: null }), ctx(0));
  const d3 = ga.evaluate(ev(r, { ratio: 8, baselineWpm: null }), ctx(10000));
  ok(d3.action !== 'swap', 'and it never swaps automatically without a measured pace', d3.action);
}

// ---- struggle events alone never swap, even in automatic mode
{
  const g = G.create({ mode: 'auto' }); const p = el();
  const d1 = g.evaluate(ev(p, { ratio: 2.1 }), ctx(0));
  const d2 = g.evaluate(ev(p, { ratio: 4 }), ctx(9000));
  ok(d1.action === 'gentle' && d2.action === 'offer', 'automatic mode: struggle events bring gentle help, then an offer, never a swap', `${d1.action}, ${d2.action}`);
}

// ---- the pace rule: time spent against time expected for the part read so far
// pr(): a tracker progress sample. pace = dwell / (expected x progress).
const pr = (element, pace, over = {}) => {
  const progress = over.progress || 0.5, expected = 40000;
  return { element, paragraphDwellMs: 'dwell' in over ? over.dwell : pace * expected * progress, expectedParagraphMs: expected, progress,
    coarse: 'coarse' in over ? over.coarse : false, baselineWpm: 'baselineWpm' in over ? over.baselineWpm : 240 };
};
const K = (() => { const g = G.create(); return g.evaluateProgress(pr(el(), 1), ctx(0)).k; })();   // threshold for HARD, typical reader, fine tracking
ok(K > 1.8, 'the swap threshold for a long-worded paragraph is above the base multiple', String(K));
{
  const g = G.create(); const p = el();
  ok(g.evaluateProgress(pr(p, 1.0), ctx(0)).why === 'pace-normal', 'reading at the expected pace: nothing');
  ok(g.evaluateProgress(pr(p, 0.75 * K), ctx(1000)).action === 'none', 'a little slow: still nothing');
  const d = g.evaluateProgress(pr(p, 0.85 * K), ctx(2000));
  ok(d.action === 'offer' && d.why === 'offer-pace', 'clearly slow for the part read so far: the offer appears, mid-paragraph', JSON.stringify(d));
  ok(g.evaluateProgress(pr(p, 0.9 * K), ctx(3000)).action === 'none' && g.evaluateProgress(pr(p, 0.9 * K), ctx(30000)).why === 'already-offered', 'and is not repeated');
}
{
  const g = G.create(); const p = el();
  ok(g.evaluateProgress(pr(p, 5, { dwell: 5000 }), ctx(0)).why === 'too-early', 'a few seconds in, pace means nothing: no decision');
  ok(g.evaluateProgress(pr(p, 5, { progress: 0.2 }), ctx(0)).why === 'too-early', 'nor in the first third of the paragraph');
}
{
  const g = G.create({ mode: 'auto' }); const p = el();
  const a = g.evaluateProgress(pr(p, 1.1 * K), ctx(0));
  const b = g.evaluateProgress(pr(p, 1.1 * K), ctx(2000));
  ok(a.action === 'offer' && b.action !== 'swap', 'automatic mode: slow pace offers first and does not swap at once', `${a.action}, ${b.action}`);
  const g2 = G.create({ mode: 'auto', minGapMs: 0 }); const q = el();
  g2.evaluateProgress(pr(q, 1.1 * K), ctx(0));
  g2.evaluateProgress(pr(q, 1.1 * K), ctx(2000));
  const c = g2.evaluateProgress(pr(q, 1.15 * K), ctx(4500));
  ok(c.action === 'swap' && c.why === 'pace-held', 'automatic mode: the pace stayed above the threshold for four seconds, so the paragraph is swapped', JSON.stringify(c));
  const g3 = G.create({ mode: 'auto', minGapMs: 0 }); const r = el();
  g3.evaluateProgress(pr(r, 1.1 * K), ctx(0));
  g3.evaluateProgress(pr(r, 0.8 * K), ctx(2000));    // dipped: the clock restarts
  const e = g3.evaluateProgress(pr(r, 1.1 * K), ctx(4500));
  ok(e.action !== 'swap', 'a dip below the threshold restarts the four seconds', e.action);
  const g4 = G.create({ mode: 'offer', minGapMs: 0 }); const s = el();
  g4.evaluateProgress(pr(s, 1.2 * K), ctx(0));
  ok(g4.evaluateProgress(pr(s, 1.3 * K), ctx(6000)).action !== 'swap', 'offer mode never swaps by itself');
}
{
  const g = G.create(); const base = g.evaluateProgress(pr(el(), 1), ctx(0)).k;
  const coarse = G.create().evaluateProgress(pr(el(), 1, { coarse: true }), ctx(0)).k;
  const slowReader = G.create().evaluateProgress(pr(el(), 1, { baselineWpm: 110 }), ctx(0)).k;
  const unknown = G.create().evaluateProgress(pr(el(), 1, { baselineWpm: null }), ctx(0)).k;
  ok(coarse > base && slowReader > base && unknown > base, 'the bar is higher when tracking is coarse, when the reader is slow by nature, and when pace was never measured', `${base} / ${coarse} / ${slowReader} / ${unknown}`);
  const ga = G.create({ mode: 'auto', minGapMs: 0 }); const p = el();
  ga.evaluateProgress(pr(p, 9, { baselineWpm: null }), ctx(0));
  ok(ga.evaluateProgress(pr(p, 9, { baselineWpm: null }), ctx(6000)).action !== 'swap', 'no automatic swap without a measured pace, whatever the pace');
  ok(G.create().evaluateProgress(pr(el(), 9), ctx(0, { text: EASY, simplified: EASY })).action === 'none', 'easy text is vetoed on this path too');
}

// ---- rate limits
{
  const g = G.create(); const a = el(), b = el();
  g.evaluate(ev(a, { ratio: 2.1 }), ctx(0)); g.evaluate(ev(b, { ratio: 2.1 }), ctx(100));
  const d1 = g.evaluate(ev(a, { ratio: 3 }), ctx(9000));
  const d2 = g.evaluate(ev(b, { ratio: 3 }), ctx(10000));
  ok(d1.action === 'offer' && d2.action === 'none' && d2.why === 'too-soon', 'two paragraphs at once: one offer, the other waits', d2.why);
  const d3 = g.evaluate(ev(b, { ratio: 3.2 }), ctx(25000));
  ok(d3.action === 'offer', 'and gets its turn later');
}
{
  const g = G.create({ mode: 'auto', maxSwapsPerPage: 2, minGapMs: 0, maxOffersPerPage: 99 });
  let swaps = 0;
  for (let i = 0; i < 5; i++) {
    const p = el(), t = i * 20000;
    g.evaluateProgress(pr(p, 1.2 * K), ctx(t));
    if (g.evaluateProgress(pr(p, 1.2 * K), ctx(t + 5000)).action === 'swap') swaps += 1;
  }
  ok(swaps === 2, 'automatic swaps are capped per page', String(swaps));
}

// ---- learning from what the reader does
{
  // A pace that is just enough to swap with a fresh gate...
  const swapsAt = (g, p, t) => { g.evaluateProgress(pr(p, 1.1 * K), ctx(t)); return g.evaluateProgress(pr(p, 1.1 * K), ctx(t + 5000)).action; };
  const g = G.create({ mode: 'auto', minGapMs: 0 }); const p = el();
  ok(swapsAt(g, p, 0) === 'swap', 'baseline for the learning test: this pace swaps');
  const b0 = g.bias;
  g.feedback('undone', p, 15000);
  ok(g.bias > b0, 'a quick "Show original" raises the bar', `${b0} -> ${g.bias}`);
  ok(g.evaluateProgress(pr(p, 5), ctx(60000)).why === 'reader-declined' && g.evaluate(ev(p, { ratio: 5 }), ctx(60000)).why === 'reader-declined', 'and that paragraph is left alone from then on');
  // ... no longer swaps another paragraph after the undo.
  const after = swapsAt(g, el(), 200000);
  ok(after !== 'swap', 'after the undo, the pace that used to swap another paragraph no longer does', after);
  const g2 = G.create(); const q = el();
  const k0 = g2.evaluateProgress(pr(q, 1), ctx(0)).k;
  for (let i = 0; i < 3; i++) g2.feedback('accepted', el(), i);
  ok(g2.evaluateProgress(pr(el(), 1), ctx(10)).k < k0, 'accepted offers lower the bar a little', `${k0} -> ${g2.evaluateProgress(pr(el(), 1), ctx(20)).k}`);
}
{
  const g = G.create(); const p = el();
  for (let i = 0; i < 40; i++) g.feedback('dismissed', el(), i);
  ok(g.bias <= G.DEFAULTS.biasMax + 1e-9, 'the bar cannot rise without limit', String(g.bias));
  for (let i = 0; i < 80; i++) g.feedback('accepted', el(), i);
  ok(g.bias >= G.DEFAULTS.biasMin - 1e-9, 'nor fall without limit', String(g.bias));
  const late = G.create({ mode: 'auto', minGapMs: 0 });
  late.evaluateProgress(pr(p, 1.1 * K), ctx(0)); late.evaluateProgress(pr(p, 1.1 * K), ctx(5000));
  const b = late.bias; late.feedback('undone', p, 9000 + 5 * 60000);
  ok(late.bias === b, 'putting the original back minutes later is not held against the gate');
}

// ---- the reader asked for help here already
{
  const g = G.create(); const p = el();
  g.noteManual(p, 0);
  const d = g.evaluate(ev(p, { ratio: 1.9 }), ctx(2000));
  ok(d.action === 'offer' && d.manual, 'after the reader used the word lens or read-aloud on a paragraph, the first slow sign already brings the offer', JSON.stringify(d));
}

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall gate tests passed');
