/*
 * profile.js — what "Adapt ahead" has learned about one reader, and the decision it
 * leads to. Pure: no DOM, no Chrome APIs. Classic script in the browser
 * (globalThis.GliderAdaptProfile), require()-able in Node.
 *
 * The profile is a mode and counters, never any text. There is one set of counters per
 * rule ('split': long multi-clause sentences shown one part per line; 'reorder': a
 * sentence that opens with a subordinate clause shown main clause first):
 *
 *   { v: 2, mode: 'learn',
 *     split:   { plain, trait, adapted, undone },
 *     reorder: { plain, trait, adapted, undone } }
 *
 *   plain    sentences WITHOUT the rule's trait                         { read, struggled }
 *   trait    sentences with the trait, shown as the page wrote them     { read, struggled }
 *   adapted  sentences with the trait, shown adapted                    { read, struggled }
 *   undone   how often the reader asked for the original back
 *
 * decide(rule, mode) -> { active, why }
 *   mode 'off'    never adapt
 *   mode 'on'     always adapt (no evidence needed: for recording a demo)
 *   mode 'learn'  adapt when the reader struggles clearly more often on trait sentences than
 *                 on the others, and stop again when adapting turns out not to help
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    minTraitRead: 12,     // trait sentences read before anything is decided
    minPlainRead: 12,     // and as many others, to compare against
    minTraitStruggles: 3, // never act on one or two events
    margin: 0.15,         // the trait struggle rate must exceed the plain rate by this much ...
    ratio: 1.5,           // ... and be this many times the plain rate
    minAdaptedRead: 12,   // adapted sentences read before the result is judged
    cap: 400,             // a bucket that reaches this many reads is halved, so old reading fades
  };
  const MODES = ['learn', 'on', 'off'];
  const RULES = ['split', 'reorder'];
  const BUCKETS = ['plain', 'trait', 'adapted'];

  const count = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const obj = (v) => (v && typeof v === 'object' ? v : {});
  const emptyRule = () => ({ plain: { read: 0, struggled: 0 }, trait: { read: 0, struggled: 0 }, adapted: { read: 0, struggled: 0 }, undone: 0 });
  const empty = () => ({ v: 2, mode: 'learn', split: emptyRule(), reorder: emptyRule() });
  const mode = (m) => (MODES.includes(m) ? m : 'learn');
  const rate = (bucket) => (bucket && bucket.read > 0 ? bucket.struggled / bucket.read : 0);

  function sanitizeRule(raw) {
    const src = obj(raw), r = emptyRule();
    for (const name of BUCKETS) {
      const b = obj(src[name]);
      r[name].read = count(b.read);
      r[name].struggled = Math.min(r[name].read, count(b.struggled));
    }
    r.undone = count(src.undone);
    return r;
  }

  /** A stored value of any shape -> a well-formed profile. */
  function sanitize(raw) {
    const src = obj(raw), p = empty();
    p.mode = mode(src.mode);
    for (const name of RULES) p[name] = sanitizeRule(src[name]);
    return p;
  }

  /** Add the counts in `delta` to a profile; returns a new, capped profile. The mode is the profile's. */
  function add(profile, delta, opts) {
    const cfg = { ...DEFAULTS, ...(opts || {}) };
    const p = sanitize(profile), d = obj(delta);
    for (const name of RULES) {
      const r = p[name], dr = obj(d[name]);
      for (const bucket of BUCKETS) {
        const b = obj(dr[bucket]);
        r[bucket].read += count(b.read);
        r[bucket].struggled = Math.min(r[bucket].read, r[bucket].struggled + count(b.struggled));   // a struggle can arrive after its sentence was counted
        if (r[bucket].read >= cfg.cap) { r[bucket].read = Math.round(r[bucket].read / 2); r[bucket].struggled = Math.round(r[bucket].struggled / 2); }
      }
      r.undone += count(dr.undone);
    }
    return p;
  }

  /** Count one sentence in place on a rule's counters: bucket 'plain' | 'trait' | 'adapted'. */
  function record(rule, bucket, struggled) {
    if (!rule || !rule[bucket]) return rule;
    rule[bucket].read += 1;
    if (struggled) rule[bucket].struggled += 1;
    return rule;
  }

  /** Should this rule be applied for this reader? `rule` is one rule's counters. */
  function decide(rule, wantedMode, opts) {
    const cfg = { ...DEFAULTS, ...(opts || {}) };
    const m = mode(wantedMode);
    if (m === 'off') return { active: false, why: 'off' };
    if (m === 'on') return { active: true, why: 'on' };
    const r = sanitizeRule(rule);
    const traitRate = rate(r.trait), plainRate = rate(r.plain), adaptedRate = rate(r.adapted);
    const out = { active: false, why: '', traitRate, plainRate, adaptedRate };
    if (r.trait.read < cfg.minTraitRead || r.plain.read < cfg.minPlainRead) return { ...out, why: 'not-enough-read' };
    if (r.trait.struggled < cfg.minTraitStruggles) return { ...out, why: 'few-struggles' };
    if (traitRate < plainRate + cfg.margin || traitRate < plainRate * cfg.ratio) return { ...out, why: 'no-clear-difference' };
    if (r.adapted.read >= cfg.minAdaptedRead && adaptedRate >= traitRate) return { ...out, why: 'no-benefit' };
    return { ...out, active: true, why: 'trait-is-harder' };
  }

  const api = { DEFAULTS, MODES, RULES, empty, emptyRule, sanitize, sanitizeRule, add, record, rate, mode, decide };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GliderAdaptProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
