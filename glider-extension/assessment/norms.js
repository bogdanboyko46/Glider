/*
 * norms.js — reference ranges for the Reading Check, per age band.
 *
 * IMPORTANT: these are APPROXIMATE values taken from lab eye-tracking studies
 * of silent reading (infrared trackers, chin rests, 500-1000 Hz). They are
 * NOT validated for webcam tracking, which merges short fixations and misses
 * small saccades. They exist to give the reader a rough "typical range"
 * marker, never to classify anyone. Edit freely.
 *
 * Every range is [low, high] of the typical band.
 *   wpm             silent reading speed, words per minute
 *   fixMs           mean fixation duration, ms
 *   regressionRate  share of saccades that go backwards (0..1)
 *   fixPerWord      fixations per word
 *   blinkRate       blinks per minute while reading (lower than at rest)
 *   stabilityPx     median within-fixation gaze scatter, px (webcam-specific, rough)
 *   headSd          head position scatter, fraction of camera frame width
 */
(function (root) {
  'use strict';

  const SHARED = {
    blinkRate: [4, 18],
    stabilityPx: [8, 40],
    headSd: [0.002, 0.02],
  };

  const BANDS = {
    '8-10': { label: 'Ages 8–10', wpm: [80, 160], fixMs: [240, 330], regressionRate: [0.18, 0.32], fixPerWord: [1.2, 1.9] },
    '11-13': { label: 'Ages 11–13', wpm: [120, 200], fixMs: [220, 290], regressionRate: [0.15, 0.28], fixPerWord: [1.0, 1.5] },
    '14-17': { label: 'Ages 14–17', wpm: [160, 260], fixMs: [205, 265], regressionRate: [0.12, 0.24], fixPerWord: [0.9, 1.3] },
    adult: { label: 'Adult', wpm: [200, 320], fixMs: [200, 250], regressionRate: [0.10, 0.18], fixPerWord: [0.8, 1.2] },
  };
  for (const k of Object.keys(BANDS)) Object.assign(BANDS[k], SHARED);

  /* Data-quality gates. */
  const QUALITY = {
    minFixations: 15,        // fewer than this: "Not enough data — retake"
    calibGoodPx: 45,         // accuracy.effY at or below this is good
    calibPoorPx: 70,         // above this the calibration is flagged
    fpsGood: 24,
    fpsPoor: 15,
    faceLostFairPct: 5,
    faceLostPoorPct: 15,
  };

  const AGE_BANDS = ['8-10', '11-13', '14-17', 'adult'];
  const forBand = (band) => BANDS[band] || BANDS.adult;

  const api = { BANDS, QUALITY, AGE_BANDS, forBand };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RCNorms = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
