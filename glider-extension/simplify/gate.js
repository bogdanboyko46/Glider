/*
 * gate.js — decides WHEN simplified text may appear. Pure: no DOM, no Chrome APIs.
 * Classic script in the browser (globalThis.GliderSimplifyGate), require()-able in Node.
 *
 * The eye tracker raises a 'struggle' event far more readily than a whole paragraph
 * should be replaced. Replacing text under a reader who was fine is the costly mistake,
 * so the gate asks for more than one sign before it lets the simplifier act:
 *
 *   1. the text itself is worth simplifying        (GliderTextScore: difficulty, gain, vetoes)
 *   2. the reader is slow ON THIS PARAGRAPH against their own measured pace
 *      (dwell / expected, where expected comes from the baseline read at calibration)
 *   3. the slowness persists or comes with re-reading: a first sign only ever gets the
 *      gentle help (spacing, syllable lens); the simplifier comes second
 *
 * Two inputs feed it. The tracker's 'progress' samples (about one a second) drive the main
 * rule: pace = time spent / (time expected x share of the paragraph read so far), which shows
 * a slow reader long before the paragraph is finished; it must hold for several seconds.
 * The tracker's 'struggle' events are a second, weaker witness: they can bring gentle help
 * or an offer, never an automatic swap. (simplify/bridge.js asks nothing of the reader any more:
 * it carries out an offer as a swap, in place.)
 *
 * Outcomes: 'none'   nothing from the simplifier
 *           'gentle' leave this event to the gentle help
 *           'offer'  enough evidence to change the paragraph (simplify/bridge.js swaps it in place)
 *           'swap'   replace the paragraph (only when the reader chose automatic mode)
 *
 * Every threshold is a multiple of the reader's own baseline, so the constants below are
 * fixed defaults; the one thing learned per reader is `bias`, nudged by what they do with
 * the offers (accepting lowers it a little, undoing or ignoring raises it more).
 */
(function (root) {
  'use strict';
  const Text = root.GliderTextScore || (typeof require === 'function' ? require('./textscore.js') : null);

  const DEFAULTS = {
    mode: 'offer',        // 'offer' | 'auto'
    offerAt: 1.0,         // evidence needed for an offer
    minSlowForOffer: 0.8, // an event-based offer still needs real slowness, not just re-reading
    // Pace rule (tuned by simulation; multiples of the reader's own measured pace):
    paceK: 1.8,           // pace needed for an automatic swap, before the conditions below
    paceCoarse: 1.3,      // x this when the tracker cannot tell lines apart
    paceSlowReader: 1.5,  // x this when the reader's measured pace is under slowWpm
    slowWpm: 160,
    paceWordLen: 0.12,    // longer words need MORE evidence: expected time under-predicts dense text
    offerShare: 0.8,      // offer at this share of the swap threshold
    holdMs: 4000,         // the pace must stay above the threshold this long before a swap
    releaseShare: 0.87,   // ... and dropping below this share of it restarts the clock
    minDwellMs: 8000, minProgress: 0.35,   // too early in a paragraph, pace means nothing
    rereadBonus: 0.35,    // re-reading on top of slowness
    persistBonus: 0.3,    // per earlier sign on the same paragraph (this visit)
    persistMax: 0.6,
    manualBonus: 0.5,     // the reader already asked for help here (word lens, read aloud)
    noBaselinePenalty: 0.4,   // pace was never measured: the "expected time" is a guess
    eventWindowMs: 90000, // signs older than this on a paragraph no longer count
    minGapMs: 12000,      // between two offers or swaps anywhere on the page
    maxSwapsPerPage: 6,
    maxOffersPerPage: 10,
    biasMin: -0.25, biasMax: 1.0,
    stepAccept: -0.08, stepUndo: 0.25, stepDismiss: 0.2, stepIgnore: 0.1,
    undoWindowMs: 30000,  // "See original" this soon after a swap means the swap was wrong
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * How far past "normal for this reader" the paragraph is, on a scale where 1.0 means
   * "exactly at the tracker's own threshold for this kind of text".
   * @param ratio  time spent on the paragraph / time expected from the reader's pace
   * @param tau    the reader's calibrated threshold (how many times slower counts)
   * @param mult   text multiplier from GliderTextScore (hard text needs less, easy text more)
   */
  function slowness(ratio, tau, mult) {
    if (!(ratio > 1) || !(tau > 1) || !Number.isFinite(mult)) return 0;
    const need = Math.max(1.15, tau * mult);
    return Math.log(ratio) / Math.log(need);
  }

  function create(options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    let bias = clamp(Number(cfg.bias) || 0, cfg.biasMin, cfg.biasMax);
    const blocks = new WeakMap();      // element -> { events: [{t, reason, ratio}], manualAt, offeredAt, swappedAt }
    const page = { offers: 0, swaps: 0, lastActAt: -1e12, lastEl: null };

    const stateOf = (el) => { let s = blocks.get(el); if (!s) { s = { events: [], manualAt: -1e12, offeredAt: -1e12, swappedAt: -1e12, declined: false, holdSince: null }; blocks.set(el, s); } return s; };

    /** Longer words than plain prose (about 4.8 letters) raise the bar; shorter ones lower it a little. */
    const wordLenFactor = (suit) => {
      const len = suit && suit.difficulty && suit.difficulty.features ? suit.difficulty.features.meanWordLen : 0;
      if (!(len > 0)) return 1;
      return Math.exp(cfg.paceWordLen * clamp((len - 4.8) / 0.7, -1.5, 2.5));
    };
    const suitOf = (ctx) => (Text ? Text.suitability(ctx.text, { simplified: ctx.simplified, meta: ctx.meta })
      : { verdict: 'offline', vetoes: [], multiplier: 1, difficulty: { score: 0.5, features: {} } });

    /**
     * The main rule. Call with every 'progress' sample from the tracker.
     * @param p    { element, paragraphDwellMs, expectedParagraphMs, progress, coarse, baselineWpm }
     * @param ctx  { text, simplified, meta, serviceReady, now }
     */
    function evaluateProgress(p, ctx) {
      const now = ctx && Number.isFinite(ctx.now) ? ctx.now : Date.now();
      const out = (action, why, extra) => ({ action, why, bias: +bias.toFixed(2), ...(extra || {}) });
      if (!p || !p.element) return out('none', 'no-element');
      const st = stateOf(p.element);
      if (st.declined) return out('none', 'reader-declined');
      if (!(p.paragraphDwellMs >= cfg.minDwellMs) || !(p.progress >= cfg.minProgress) || !(p.expectedParagraphMs > 0)) { st.holdSince = null; return out('none', 'too-early'); }

      const suit = suitOf(ctx);
      if (suit.verdict === 'never') return out('none', 'text:' + (suit.vetoes[0] || 'low-gain'));
      if (suit.verdict === 'llm-only' && !ctx.serviceReady) return out('none', 'text:offline-cannot-help');

      const hasBaseline = p.baselineWpm != null;
      const pace = p.paragraphDwellMs / (p.expectedParagraphMs * Math.min(1, p.progress));
      const k = cfg.paceK * (p.coarse ? cfg.paceCoarse : 1) * (!hasBaseline || p.baselineWpm < cfg.slowWpm ? cfg.paceSlowReader : 1)
        * wordLenFactor(suit) * Math.max(1, Number.isFinite(suit.multiplier) ? suit.multiplier : 1) * (1 + bias);
      const info = { pace: +pace.toFixed(2), k: +k.toFixed(2), progress: p.progress, verdict: suit.verdict, difficulty: +suit.difficulty.score.toFixed(2), hasBaseline };

      if (pace < cfg.releaseShare * k) st.holdSince = null;
      if (pace >= k && st.holdSince == null) st.holdSince = now;
      const held = st.holdSince != null ? now - st.holdSince : 0;
      info.heldMs = Math.round(held);

      if (pace < cfg.offerShare * k) return out('none', 'pace-normal', info);
      // The pause between actions is about not peppering the page; a paragraph's own offer does not delay its swap.
      if (now - page.lastActAt < cfg.minGapMs && page.lastEl !== p.element) return out('none', 'too-soon', info);

      if (cfg.mode === 'auto' && hasBaseline && suit.verdict === 'offline' && pace >= k && held >= cfg.holdMs) {
        if (page.swaps >= cfg.maxSwapsPerPage) return out('none', 'page-cap', info);
        page.swaps += 1; page.lastActAt = now; page.lastEl = p.element; st.swappedAt = now; st.holdSince = null;
        return out('swap', 'pace-held', info);
      }
      if (now - st.offeredAt < cfg.eventWindowMs) return out('none', 'already-offered', info);
      if (page.offers >= cfg.maxOffersPerPage) return out('none', 'page-cap', info);
      page.offers += 1; page.lastActAt = now; page.lastEl = p.element; st.offeredAt = now;
      return out('offer', suit.verdict === 'llm-only' ? 'offer-llm' : 'offer-pace', info);
    }

    /**
     * @param detail  the tracker's struggle event ({element, reason, coarse, metrics})
     * @param ctx     { text, simplified, meta, serviceReady, now }
     */
    function evaluate(detail, ctx) {
      const now = ctx && Number.isFinite(ctx.now) ? ctx.now : Date.now();
      const out = (action, why, extra) => ({ action, why, bias: +bias.toFixed(2), ...(extra || {}) });
      if (!detail || !detail.element) return out('none', 'no-element');
      const el = detail.element;
      const st = stateOf(el);
      if (st.declined) return out('none', 'reader-declined');

      const m = detail.metrics || {};
      const ratio = m.expectedParagraphMs > 0 ? m.paragraphDwellMs / m.expectedParagraphMs : Number(m.ratio) || 0;
      const tau = Number(m.tau) || 2;
      const hasBaseline = m.baselineWpm != null;

      // 1. the text
      const suit = suitOf(ctx);
      const info = { verdict: suit.verdict, difficulty: suit.difficulty ? +suit.difficulty.score.toFixed(2) : null, vetoes: suit.vetoes, ratio: +ratio.toFixed(2), tau };
      // Record the sign even when the text is not suitable now (it may become so: an LLM service appears).
      st.events = st.events.filter((e) => now - e.t < cfg.eventWindowMs);
      const earlier = st.events.length;
      st.events.push({ t: now, reason: detail.reason, ratio });

      if (suit.verdict === 'never') return out('none', 'text:' + (suit.vetoes[0] || 'low-gain'), info);
      if (suit.verdict === 'llm-only' && !ctx.serviceReady) return out('none', 'text:offline-cannot-help', info);

      // 2. the evidence
      // Text can raise the bar (easy-ish or long-worded paragraphs) but never lowers it.
      const slow = slowness(ratio, tau, Math.max(1, Number.isFinite(suit.multiplier) ? suit.multiplier : 1) * wordLenFactor(suit));
      const reread = detail.reason === 'rereading' || (m.backtracks || 0) >= 2;
      const persist = Math.min(cfg.persistMax, cfg.persistBonus * earlier);
      const manual = now - st.manualAt < cfg.eventWindowMs ? cfg.manualBonus : 0;
      let score = slow + (reread && slow > 0.5 ? cfg.rereadBonus : 0) + persist + manual;
      if (!hasBaseline) score -= cfg.noBaselinePenalty;
      // A stuck line with a normal paragraph total is a word-level problem: the syllable lens, not a rewrite.
      if (detail.reason === 'stuck-line' && slow < 0.8 && !manual) score = Math.min(score, cfg.offerAt + bias - 0.01);
      Object.assign(info, { score: +score.toFixed(2), slow: +slow.toFixed(2), reread, persist: +persist.toFixed(2), manual: !!manual, hasBaseline });

      // 3. the decision
      const offerAt = cfg.offerAt + bias, autoAt = cfg.autoAt + bias;
      if (score < offerAt || (slow < cfg.minSlowForOffer && !manual)) return out(earlier === 0 ? 'gentle' : 'none', 'not-enough-evidence', info);
      // The first sign on a paragraph belongs to the gentle help, unless the reader has asked for help here already.
      if (earlier === 0 && !manual) return out('gentle', 'first-sign', info);
      if (now - page.lastActAt < cfg.minGapMs) return out('none', 'too-soon', info);

      // Events alone never swap: in the realistic tracking regime they fire once, right at the
      // threshold, and carry too little to justify replacing text. Only the held pace rule swaps.
      void autoAt;
      if (now - st.offeredAt < cfg.eventWindowMs) return out('none', 'already-offered', info);
      if (page.offers >= cfg.maxOffersPerPage) return out('none', 'page-cap', info);
      page.offers += 1; page.lastActAt = now; page.lastEl = el; st.offeredAt = now;
      return out('offer', suit.verdict === 'llm-only' ? 'offer-llm' : 'offer', info);
    }

    /** What the reader did. kind: 'accepted' | 'swapped' | 'undone' | 'dismissed' | 'ignored'. Returns the new bias. */
    function feedback(kind, el, now) {
      const t = Number.isFinite(now) ? now : Date.now();
      const st = el ? stateOf(el) : null;
      let step = 0;
      if (kind === 'accepted') { step = cfg.stepAccept; if (st) st.swappedAt = t; }
      else if (kind === 'swapped') { if (st) st.swappedAt = t; }   // swapped without asking: only an undo soon after teaches anything
      else if (kind === 'undone') { step = st && t - st.swappedAt < cfg.undoWindowMs ? cfg.stepUndo : 0; if (st) st.declined = true; }
      else if (kind === 'dismissed') { step = cfg.stepDismiss; if (st) st.declined = true; }
      else if (kind === 'ignored') step = cfg.stepIgnore;
      bias = clamp(bias + step, cfg.biasMin, cfg.biasMax);
      return bias;
    }

    /** The reader used the word lens or read-aloud on this paragraph: explicit intent beats inference. */
    function noteManual(el, now) { if (el) stateOf(el).manualAt = Number.isFinite(now) ? now : Date.now(); }

    return {
      evaluate, evaluateProgress, feedback, noteManual,
      setMode(mode) { cfg.mode = mode === 'auto' ? 'auto' : 'offer'; },
      setBias(b) { bias = clamp(Number(b) || 0, cfg.biasMin, cfg.biasMax); },
      get bias() { return bias; },
      get mode() { return cfg.mode; },
      page: () => ({ offers: page.offers, swaps: page.swaps, lastActAt: page.lastActAt }),
      config: () => ({ ...cfg, bias }),
    };
  }

  const api = { create, slowness, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderSimplifyGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
