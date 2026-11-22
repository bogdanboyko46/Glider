# Gaze benchmark results

Every number in this file comes from a synthetic camera. The noise levels are assumptions.
Nothing here is evidence of how accurate the tracker is on a real webcam or on real eyes.

## Read this first

Written at the end of the night of 2026-11-20, after step 4 of 4. Nobody sat in front of a camera.
The tracker's maths was measured on synthetic people only. The camera path (camera, face model,
calibration screens, permission page) was run for real in a headless browser, with a still photo of
a face in place of the camera. Nothing was committed; all changes are in the working tree.

### Sign-off (after review): what changed last, and the final numbers

A review of the night's work found one blocker and one major problem. Both were real, both are fixed,
and the numbers in this section replace the "final" column wherever the two differ. Saved as
`tests/bench/after-signoff.json`; command `node tests/bench/gaze-bench.mjs --compare`.

| Score (synthetic) | Baseline (start of the night) | Final (sign-off) | Change |
|---|---|---|---|
| S_still | 41.98 px [40.28, 45.00] | 29.65 px [28.07, 32.66] | -29.4 %, better for 18 of 20 people |
| S_move | 173.51 px [169.63, 178.60] | 39.82 px [34.14, 44.05] | -77.0 %, better for 20 of 20 people |

Against step 3 and 4 (29.70 / 39.11): -0.2 % and +1.8 %, inside the noise of 20 people.

| Condition (synthetic 3D person), fixation RMS px, baseline -> sign-off | 0.2 px iris noise | 0.5 px | 0.8 px |
|---|---|---|---|
| STILL | 32.7 -> 20.0 | 42.0 -> 29.7 | 51.9 -> 39.6 |
| HEAD-SHIFT | 99.0 -> 27.6 | 104.6 -> 33.9 | 109.3 -> 44.5 |
| HEAD-ROTATE | 231.5 -> 32.9 | 240.7 -> 43.2 | 244.0 -> 52.9 |
| LATER | 70.0 -> 22.3 | 76.2 -> 31.9 | 83.9 -> 42.3 |
| LOW-FPS | 28.5 -> 21.4 | 39.5 -> 28.4 | 50.0 -> 38.0 |
| HEAD-ROTATE frames the head gate throws away | 41 % | 21 % | 7 % |

Line of text, sitting still, 0.5 px: a 32 px line is hit exactly on 56 % of fixations, the
three-line band on 98 %. Still a band of about three lines, not single lines.

**1. Blocker: the head-turn instruction was shown while its first dot was already being sampled.**
Anyone who read it had frames of the top of the screen labelled as the centre dot. Measured with a
synthetic reader who reads it (`--proc headPause=false --fit moveTrim=false --who readMs=N`, 0.5 px):

| The reader reads the note for | As it was (S_still / S_move) | Model chosen | With the fix |
|---|---|---|---|
| not at all | 29.7 / 39.1 | E 20 | 29.7 / 39.8 |
| 1.2 s | 38.9 / 49.7 | | 30.4 / 40.8 (trim alone) |
| 2 s | 50.2 / 64.3 | E 16, A 4 | 30.3 / 41.2 (trim alone) |
| 3 s | 52.9 / 68.5 | | 30.4 / 41.8 (trim alone) |

The baseline was 42.0, so a slow reader ended up worse than before the night began. Two fixes:
- The instruction is now a card ("One more step: a small head turn") that waits for Space, with no
  dot on screen and nothing being measured. While a head dot is sampled there is no text to read.
  The first head dot gets a full second before its frames count. (`CalibrationRun` option
  `headPause`, `run.resume()`; the bench's person takes 4 s over the card.)
- `fitCalibration` drops head-segment frames in which a head-aware model fitted on the still dots
  alone puts the eyes further from the dot than 12 % of the viewport's diagonal (204 px here), unless
  that is more than 60 % of them (`shootout.moveTrim` in the dump says how many). A reader who keeps
  the eyes on the dot loses 1 frame in 2191. With both fixes and a reader who is still looking at
  where the card was for 1.5 s or 3 s after pressing Space: 29.3 / 42.1 and 29.3 / 41.9.

**2. Major: model A's head gate paused a reader who had not moved.** Its limits were where A's error
doubles (0.9 degrees of yaw, 1.3 cm). With the head following the eyes a fifth of the way
(`--model A --set headFollow=0.2`) 54 % of the frames of somebody sitting as calibrated were paused;
with one degree of head wander 37 %. The limits are now 3 degrees of yaw, 2.5 of pitch, 5 of roll,
2.5 cm sideways, 2 cm up or down, 6 cm of depth (0.035 of the picture without a head pose): the
tightest set tried that pauses 0 % of a still sitter under both assumptions and still pauses a
5 degree head turn (84 to 98 % of its frames) and the 3 cm lean. The price, model A forced, standard
person: HEAD-SHIFT 59 px with 66 % paused -> 77 px with 37 % paused; LATER (2 cm drift) 79 px with
48 % paused -> 83 px with none paused. The second synthetic person (no head pose, always A): HEAD-SHIFT
47 px with 65 % paused -> 101 px with 38 % paused; LATER 58 px with 98 % paused -> 82 px, not paused.
A saved model-A calibration is now restored for a head within these limits; it was almost never.

**3. Minor, all fixed.**
- The five-dot check now filters blinks with the detector live tracking uses (it stored the frame's
  fixed flag before the detector replaced it). Not covered by a test: the test camera sends no lids.
- A camera that answers after the 20 s timeout is stopped at once (no camera light under "the camera
  did not answer"). Not run: it needs a camera that takes 20 s.
- Off, window resized, on: the model left in memory no longer counts as a calibration (status
  'ready', calibrated false). Tested in `tests/gaze.mjs`.
- `gaze-core.js` is LF again, as in the backup.
- The synthetic face matrix carries the true distance; real MediaPipe reported tz = -34.0 cm for a
  face 20 % of the picture wide (the smoke test prints it), about 0.6 to 0.7 of what the synthetic
  camera gives. `--set matrixDepthK=0.68` reruns the bench with that depth: S_still 29.0, S_move
  39.7, model E for 20 of 20, but "sideways 3 cm" goes from 35.2 to 43.3 px. The headline holds; the
  HEAD-SHIFT row is optimistic for a real webcam. The smoke test now also checks that every real
  frame yields a head pose in the convention `poseFromMatrix` assumes (51 of 51).

**Found on the way.** A camera track that ends by itself (unplugged, taken by the system) left the
tracker on 'ready' or 'tracking' with no pictures and no message. The camera frame now reports
`camera-lost` and the reader shows "The camera stopped ... Retry". Seen for real: headless Edge's
built-in fake camera hands over a track that has already ended (`node tests/extension-load.mjs`).

Calibration time: 47 s of dots and head segment (longest 50 s) plus the time spent on the new card,
plus about 10 s of check.

### Baseline against final (all synthetic)

(The "final" column of this subsection is the state after step 4; the sign-off numbers are above.)

Fixation-level error in CSS px, median over 20 synthetic people, [95 % interval]. S_still: sitting as
calibrated. S_move: mean of the head-shift and head-turn conditions. Both at 0.5 px iris noise.

| Score (synthetic) | Baseline (start of the night) | Final | Change |
|---|---|---|---|
| S_still | 41.98 px [40.28, 45.00] | 29.70 px [28.12, 33.24] | -29.3 %, better for 19 of 20 people |
| S_move | 173.51 px [169.63, 178.60] | 39.11 px [35.62, 43.83] | -77.5 %, better for 20 of 20 people |

In degrees, if the screen is a 14 inch laptop at 60 cm (assumed, 51.9 px per degree): S_still 0.81
to 0.57, S_move 3.34 to 0.75. Step 4 did not touch the maths: its run gives the same numbers as
step 3 for every person (`tests/bench/after-step4.json` against `after-step3.json`).

The full table, synthetic 3D person, fixation RMS px, baseline -> final:

| Condition (synthetic) | 0.2 px iris noise | 0.5 px | 0.8 px |
|---|---|---|---|
| STILL: same posture as calibrated | 32.7 -> 21.0 | 42.0 -> 29.7 | 51.9 -> 40.9 |
| HEAD-SHIFT: 3 cm sideways, 5 cm back, 2 cm slouch | 99.0 -> 26.3 | 104.6 -> 33.6 | 109.3 -> 46.0 |
| HEAD-ROTATE: 5 degrees yaw, 5 degrees pitch | 231.5 -> 32.1 | 240.7 -> 43.6 | 244.0 -> 55.3 |
| LATER: five minutes on, 2 cm slow drift | 70.0 -> 22.6 | 76.2 -> 33.5 | 83.9 -> 44.1 |
| LOW-FPS: camera at 15 fps | 28.5 -> 21.7 | 39.5 -> 29.1 | 50.0 -> 39.2 |
| HEAD-ROTATE frames the head gate throws away, final | 39 % | 27 % | 14 % |

The second synthetic person (features only, no head pose, so always the old model A), fixation RMS px,
baseline -> final: STILL 33.7 -> 28.2. HEAD-SHIFT 105.9 -> 47.2, with 65 % of its frames paused by
the head gate. HEAD-ROTATE 189.3 -> 193.2 (without a head pose the gate cannot see a turn). LATER
80.4 -> 58.0, with 98 % paused. LOW-FPS 36.6 -> 32.7.

What it means for lines of text (synthetic, sitting still, 0.5 px noise): vertical error per fixation
24.6 -> 20.3 px. A 32 px line is hit exactly on 49 % -> 59 % of fixations; the three-line band on
95 % -> 99 %. The tracker follows a band of about three lines, not a single line of normal text.

### Kept and reverted

| Step | Change | Decision |
|---|---|---|
| 1 | Benchmark, baseline, six bug fixes (frame times, canvas size, heat trace rate, and others) | kept |
| 2a | Regression hygiene (six options) | reverted: -2.2 % / -1.1 %, under the 3 % rule; the options stay in the code, off |
| 2b | Iris from five points, iris against rigid points | reverted as model inputs: no gain on the synthetic camera, which cannot judge it |
| 2c | Head pose and head-frame iris offsets | kept |
| 2d | Model shoot-out by leave-one-dot-out error (A, B, C, E) | kept |
| 2 | RBF kernel model (D) | not built |
| 3a | Dot quality: wait for the eyes, show doubtful dots again | kept |
| 3b | Head-turn segment at the end of the calibration | kept: this is where most of S_move comes from |
| 3b | Smooth-pursuit pass | not built: upper bound -3.7 % for 8 more seconds |
| 3c | Accuracy from dots the model has not seen (no folding in) | kept |
| 3d | Head gate with rotation, check before a saved calibration is reused, pause on a moved window | kept |
| 3e | Blink rule that does not take a look down for a blink | kept |
| 3f | Click refinement only when the eyes rest on the click | kept |
| 3f | Vertical drift applied to paragraph picking, horizontal drift model | not built: the benchmark has no reading condition to measure them |
| 3 | Fixation dispersion limit 2.5 x (scatter across + scatter down) | kept: S_still 35.1 -> 29.7 |
| 4 | Five-dot check after the fit and a result card in plain words | built; card against truth measured below |
| 4 | "Show tracking" from a faster filter, first-run flow, camera smoke test, lab session | built |
| 4 | MediaPipe's usage logger, found sending to a Google address | blocked in the camera frame (see "Found in step 4") |

### Could NOT be measured

Nobody can say tonight how the tracker does on a person. In particular:

- Accuracy on real eyes, in px or in degrees. Every accuracy number in this file is synthetic.
- Glasses: reflections, frames across the eye, lens distortion.
- Lighting: a dim room, backlight, the screen as the only light.
- The real camera's noise and frame rate: how big MediaPipe's iris and lid errors are on this
  laptop's webcam, and how they change from frame to frame. The benchmark assumes 0.2 to 0.8 px.
- Whether a person gains anything from the head-turn segment. The synthetic person keeps the eyes
  on the dot and turns the head about 5 degrees when asked. A person may not. The pursuit pass was
  not built, so its benefit on a person is unknown too.
- Whether single-line tracking is reachable. The synthetic answer is no (59 % of fixations on the
  right 32 px line); the real answer may be better or worse.
- The face matrix. The head-aware model trusts MediaPipe's head pose (its axes, its units, its
  noise). The smoke test showed that the matrix arrives; whether it means what the code assumes can
  only be seen with a head that moves.
- The check card on a person. On synthetic people its grade agrees with the measured error for 44
  of 60 (below). On a person it has never run.
- The quality warnings (slow camera, small face, face near the edge) on a real picture. Their
  limits are reasoned, not measured.
- The permission prompt of a real browser. The test browser grants the camera without asking, so
  "not allowed yet" was played by making the camera call fail; everything after that was real.
- "Show tracking" was not looked at on a screen. Its lag was computed (below), not seen.

### Morning steps

1. Open `chrome://extensions` (or `edge://extensions`), switch on Developer mode, press "Load
   unpacked" and choose the folder `glider-extension` in this checkout. If Glider is already
   loaded, press the reload arrow on its card.
2. Open an article on any normal web page (not a `chrome://` page) and reload it once.
3. Open the Glider dock (Alt+L), switch the lens on, then switch on **Adaptive**.
4. First time only: a message says "Eye tracking needs one-time camera access". Press "Allow
   camera". A tab opens; press "Allow camera" there and allow it in the browser's prompt. Go back to
   the article. Eye tracking starts by itself; no reload is needed.
5. Press "Calibrate" in the message (or in the dock). It takes about a minute: follow the dot with
   your eyes. After the dots a card asks for a small head turn: read it, press Space, then keep
   your eyes on the dot for six seconds while you slowly turn your head a little (left, right, up,
   down). Five more dots then check the result.
6. Read the card. It says "Tracking is good", "fair" or "poor", with the typical error in px and
   approximate degrees in the small line. On "poor" it says what to change (more light, sit closer,
   keep the head still) and offers "Recalibrate" first and "Use anyway" second.
7. Optional: switch on "Show tracking" in the dock to see where the tracker thinks you look.
8. Optional, about 6 minutes, gives the first REAL rows:
   - `node tests/lab/server.mjs` in a terminal at the checkout root (leave it running);
   - open `http://127.0.0.1:8377/` in the same browser and press "Run the benchmark session";
   - then `node tests/bench/gaze-bench.mjs --real-only` (the REAL rows alone), or
     `node tests/bench/gaze-bench.mjs` (everything); stop the server with Ctrl+C.
9. If something looks wrong, the lab page's "Dump now" saves the tracker's state. The fields to look
   at: `modelKind` and `shootout.note` (which model and why), `validation` and `health` (the check
   and what the camera saw), `perf` and `delegate` (GPU or CPU and how fast), `timeSource`,
   `headGate`, `blockedRequests`.

### Known risks

- The head-aware model (E) rests on an unverified reading of MediaPipe's face matrix. If it is
  wrong, the shoot-out should keep the old model A for most people, but not for all (16 of 20 in
  the synthetic test of this case). Model A pauses beyond about 3 degrees or 2.5 cm (widened at
  sign-off from 1 degree and 1.3 cm, which paused a still reader); inside that it tracks with
  whatever error the movement brings, about twice the still error after a 2 cm drift.
- The synthetic person gives "Tracking is fair, a band of about 3 lines" for most people. If a real
  camera is noisier than assumed, expect "fair" with a wider band or "poor".
- The calibration now takes about a minute (47 s of dots and head turn, then 10 s of check).
- On a "poor" card, Space or Enter means "Recalibrate". "Use anyway" needs a click. Esc also keeps
  the calibration, and skips the reading-pace passage as it always did.
- The small-face warning is set at 17 % of the picture width, not the 20 % asked for: at 60 cm a
  65 degree webcam shows a face at about 19 %, and a warning in the normal seat would be a false
  alarm. It may still be wrong for this laptop's camera in either direction.
- GPU or CPU is chosen from the time the face model takes per picture over 30 pictures, not from
  the camera's frame rate, so that a dark room (slow camera) does not look like a slow GPU.
- The fix for MediaPipe's logger is in `frame.js` and `frame.html`, not in the vendored bundle. A
  new copy of the bundle is covered by the same block; a new way of sending would be stopped by the
  frame's `connect-src` policy and would then show as a console error.
- At sign-off `tests/adapt.mjs`, `tests/adapt.test.js`, `tests/words.mjs` and `tests/e2e.mjs` were
  run and pass. Not run: `tests/simplify.mjs`, `tests/live.mjs` and the showcase scripts; some of
  them may reach a paid service.
- OPEN: `tests/assessment-live.mjs` (the Reading Check on a fake camera) failed 1 of 3 runs at
  sign-off: "regressions 1 (planted 2)". The same test on the start-of-night code passed 4 of 4
  (regressions 3, 3, 2, 2). The Reading Check counts a jump back as a regression when it is longer
  than 1.5 x the calibration's effX; that figure is now measured on dots the model has not seen and
  came out at 30 to 32 px where it was 23 to 24, and the wider fixation limit of step 3 gives fewer
  fixations (44 to 47 against 49 to 58). `glider-extension/assessment/analytics.js` was not changed.

### Found in step 4

- **MediaPipe's bundle phones home.** `gaze/vendor/vision_bundle.js` contains a usage logger that
  POSTs to `https://odml.pa.googleapis.com/v1/log` once a minute and when the face model is closed.
  The smoke test caught two such requests on its first run. It sends usage counts, not pictures,
  but Glider says it runs entirely on the device. `frame.js` now refuses every network call from
  the camera frame that is not to the extension's own files, and `frame.html` carries a
  `connect-src 'self' blob: data:` policy as a second lock. The manifest's policy is unchanged. The
  smoke test now shows one refused call and zero requests leaving the extension.
- **A false "slow camera" at start.** The frame rate was counted from page load, so the face
  model's loading time read as 5 to 12 pictures a second for the first second. Fixed in `frame.js`;
  the warning also has to hold for two looks (4 s) before it is shown.

The rest of this file is the detail, in the order the work was done. The baseline section is the
tracker before tonight's changes to the maths and is kept as the reference. Step 4 is the last
section before "How to read the rows".

## Baseline: the tracker as shipped (2026-11-20, step 1 of 4)

The tracker measured here is the one in the working tree after step 1: 25 features, ridge
regression, per-dot trimming, the 13 + 5 dot calibration, the head-moved pause and the fixation
detector, all unchanged. Step 1 moved the calibration maths into `gaze-core.js` without changing
it and fixed bugs that do not touch the regression (see "What step 1 changed").

Command, from the checkout root (about 11 seconds, no browser):

```
node tests/bench/gaze-bench.mjs --save-baseline
```

It wrote `tests/bench/baseline.json` (kept) and `tests/out/gaze-bench.json` (git-ignored).
Later steps run `node tests/bench/gaze-bench.mjs --compare`, which exits 1 when a primary score is
more than 3 % worse than this baseline (`--baseline FILE` compares against another saved result). Do not run `--save-baseline` again unless the benchmark
itself has to change; if it does, say so here and keep the old numbers.

- Seeds: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20. One seed is one
  synthetic person (face size, eye geometry, seat) and one session; the same seed is the same
  person at every noise level.
- Iris landmark noise: 0.2, 0.5 and 0.8 px SD per axis at 1280x720, AR(1), lag-1 correlation 0.5
  at 30 fps.
- Calibration failed for 0 of 20 seeds in every row.

### Primary scores (fixed for tonight)

| Score | Value, px | 95 % interval | Definition |
|---|---|---|---|
| S_still | 41.98 | 40.28 to 45.00 | Median over seeds of the fixation-level euclidean RMS error, SYNTH-3D, STILL, 0.5 px iris noise |
| S_move | 173.51 | 169.63 to 178.60 | The same for the mean of HEAD-SHIFT and HEAD-ROTATE |

In degrees, under the assumed 14 inch 1536x864 screen at 60 cm (51.9 px per degree, assumed, not
measured): S_still is 0.81 degrees, S_move is 3.34 degrees.

### What the baseline says

All of this is about the synthetic person, not about a real one.

1. Sitting still, the synthetic tracker is at 33 to 52 px per fixation (0.6 to 1.0 degrees assumed)
   depending on the noise level. A 32 px line is hit exactly on 41 to 54 % of fixations; the
   three-line band is hit on 89 to 98 %. This agrees with the handoff: single lines of normal web
   text are out of reach, a band of three lines is reachable when the reader sits still.
2. Any head movement the gate lets through goes straight into the gaze estimate. A 3 cm sideways
   lean costs about 137 px horizontally, a 2 cm slouch about 90 px vertically, and a 5 degree head
   turn about 240 px, because the 25 features describe the eye in the head and the model has no
   idea the head moved. The "you moved" pause never fires in any of these runs (gated 0 %): it
   allows about 5 cm and ignores rotation.
3. Five minutes later, after a slow 2 cm drift, the error has doubled (76 px at 0.5 px noise) and
   the exact-line hit rate at 32 px pitch is 5 %.
4. The accuracy on the "Calibration done" card is about right while the reader sits still
   (measured error is 1.1 to 1.3 times the claim) and 1.5 to 10 times too optimistic after movement or
   drift.
5. 15 fps is not worse than 30 fps here. That is a property of the noise model (the noise is given
   the same size and less memory at 15 fps); a real camera drops to 15 fps in poor light, where the
   noise is larger. Do not read this row as "15 fps is fine".

### Full output

```
GAZE BENCH   tracker variant: features 25, trim on (as shipped)   20 seeds (1..20)   iris noise 0.2 / 0.5 / 0.8 px
Each seed: the reader's 13 + 5 dot calibration (fitCalibration), then 13 held-out targets per run; blink skip, head gate, FixationDetector as in gaze-reader.js.
Cells are the median over seeds; [..] is a bootstrap 95 % interval of that median. Errors in CSS px against the target.
deg* = px / 51.9: ASSUMED 14 inch 1536x864 screen at 60 cm, not measured.
bias x/y = RMS over targets of each target's mean error; "claimed" = effX/effY from the calibration card; "off by" = measured fixation RMS / claimed (above 1: worse than claimed).
scatter x/y = mean over targets of the frame-to-frame SD; gated = frames the head-moved pause threw away; blink = frames skipped as blinks; in fix = share of the time inside an emitted fixation; n = seeds with a calibration.

== SYNTH-3D: accuracy   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
   geometric head, eyeballs and pinhole camera (tests/bench/synth3d.mjs) through the real extractFeatures
noise   condition     fix RMS px [95% CI]  deg*  fix med  fix p90  frame RMS  fix x RMS  fix y RMS  bias x  bias y  scatter x/y  claimed x/y  x off by  y off by  gated  blink  in fix   n
0.2 px  STILL           32.7 [30.8, 36.6]  0.63     29.0     47.0       35.6       22.1       20.7    22.0    19.8        12/10        18/17     x1.26     x1.26     0%     4%     91%  20
0.2 px  HEAD-SHIFT     99.0 [93.8, 102.5]  1.91     88.5    143.1      100.6       81.2       55.1    80.7    55.2        13/10        18/17     x4.54     x3.16     0%     4%     92%  20
0.2 px  HEAD-ROTATE  231.5 [223.6, 243.3]  4.46    229.1    257.4      231.6      167.5      159.4   162.4   161.7         13/9        18/17     x9.53     x9.65     0%     3%     92%  20
0.2 px  LATER           70.0 [65.7, 77.1]  1.35     70.0     91.7       72.7       47.8       50.5    47.7    49.9        13/10        18/17     x2.67     x3.22     0%     4%     91%  20
0.2 px  LOW-FPS         28.5 [23.5, 36.1]  0.55     26.8     40.6       32.3       20.6       19.5    19.8    19.0        13/10        20/23     x1.10     x0.75     0%     4%     89%  20
0.5 px  STILL           42.0 [40.3, 45.0]  0.81     34.9     62.4       49.5       31.8       24.6    26.2    22.3        29/20        26/21     x1.14     x1.21     0%     4%     64%  20
0.5 px  HEAD-SHIFT   104.6 [100.6, 107.3]  2.02     95.5    151.2      107.0       86.0       61.3    82.9    58.6        29/20        26/21     x3.30     x2.74     0%     4%     64%  20
0.5 px  HEAD-ROTATE  240.7 [237.2, 248.8]  4.64    239.1    272.0      242.3      169.5      170.7   169.3   168.5        28/19        26/21     x6.44     x8.25     0%     3%     67%  20
0.5 px  LATER           76.2 [72.2, 90.7]  1.47     74.5    103.9       81.7       51.5       53.4    48.5    52.7        30/19        26/21     x1.99     x2.38     0%     4%     64%  20
0.5 px  LOW-FPS         39.5 [32.3, 43.7]  0.76     35.2     57.8       49.2       28.7       25.2    21.7    21.8        29/20        29/26     x1.03     x0.90     0%     4%     75%  20
0.8 px  STILL           51.9 [50.5, 55.2]  1.00     43.1     79.2       66.1       41.4       30.0    31.2    24.3        44/30        35/27     x1.09     x1.19     0%     4%     64%  20
0.8 px  HEAD-SHIFT   109.3 [106.5, 111.9]  2.11     98.2    161.3      118.2       90.3       65.8    84.8    61.3        45/30        35/27     x2.38     x2.41     0%     4%     63%  20
0.8 px  HEAD-ROTATE  244.0 [241.6, 249.4]  4.70    241.7    282.8      245.8      175.4      173.9   171.8   169.8        44/30        35/27     x4.71     x6.52     0%     4%     66%  20
0.8 px  LATER           83.9 [75.6, 97.2]  1.62     80.1    110.7       93.4       56.3       58.0    49.3    53.6        46/30        35/27     x1.53     x2.08     0%     4%     63%  20
0.8 px  LOW-FPS         50.0 [42.0, 52.5]  0.96     41.7     72.8       66.2       36.5       28.9    25.8    23.8        45/30        39/30     x0.98     x0.99     0%     4%     77%  20

== SYNTH-3D: would the vertical error land on the right line? exact line / 3-line band, by line pitch   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
noise   condition    24px fix  28px fix  32px fix  36px fix  48px fix  64px fix  24px frame  28px frame  32px frame  36px frame  48px frame  64px frame
0.2 px  STILL         39%/93%   46%/96%   54%/98%  61%/100%  72%/100%  88%/100%     37%/89%     43%/93%     50%/97%     56%/98%    71%/100%    85%/100%
0.2 px  HEAD-SHIFT    22%/50%   24%/55%   28%/59%   30%/63%   36%/74%   46%/94%     20%/49%     23%/54%     25%/59%     28%/64%     36%/75%     45%/93%
0.2 px  HEAD-ROTATE   19%/46%   23%/48%   27%/51%   31%/51%   38%/51%   43%/51%     19%/45%     23%/47%     26%/49%     29%/49%     35%/50%     42%/50%
0.2 px  LATER          0%/27%    0%/35%    1%/48%    1%/62%    8%/96%  21%/100%      2%/25%      3%/36%      3%/48%      4%/62%     10%/93%    20%/100%
0.2 px  LOW-FPS       43%/94%  49%/100%  54%/100%  57%/100%  78%/100%  90%/100%     36%/90%     41%/94%     47%/97%     52%/99%    69%/100%    85%/100%
0.5 px  STILL         36%/84%   42%/91%   49%/95%   53%/97%  66%/100%  80%/100%     31%/79%     36%/85%     42%/90%     46%/93%     59%/98%    72%/100%
0.5 px  HEAD-SHIFT    19%/49%   22%/54%   25%/59%   27%/62%   35%/72%   44%/87%     17%/46%     20%/51%     22%/56%     25%/60%     33%/70%     42%/85%
0.5 px  HEAD-ROTATE   18%/43%   21%/45%   24%/46%   26%/48%   33%/49%   40%/49%     16%/40%     19%/43%     21%/45%     23%/47%     29%/49%     37%/50%
0.5 px  LATER          2%/26%    4%/36%    5%/46%    6%/56%   11%/84%   21%/99%      6%/28%      8%/37%      9%/48%     11%/58%     15%/81%     23%/95%
0.5 px  LOW-FPS       33%/84%   37%/93%   42%/96%   47%/99%  62%/100%  76%/100%     30%/75%     34%/83%     38%/88%     42%/93%     53%/98%    68%/100%
0.8 px  STILL         30%/80%   35%/85%   41%/89%   44%/93%   57%/98%  74%/100%     24%/66%     28%/73%     32%/80%     36%/85%     47%/94%     60%/98%
0.8 px  HEAD-SHIFT    16%/44%   18%/49%   21%/55%   24%/59%   32%/69%   39%/84%     15%/42%     17%/47%     20%/53%     22%/57%     29%/68%     38%/82%
0.8 px  HEAD-ROTATE   16%/38%   19%/41%   22%/44%   24%/46%   29%/49%   34%/49%     13%/33%     15%/37%     17%/40%     19%/42%     24%/47%     30%/50%
0.8 px  LATER          6%/29%    7%/36%    8%/47%   10%/55%   18%/77%   23%/95%     10%/34%     12%/41%     13%/48%     16%/54%     22%/73%     30%/90%
0.8 px  LOW-FPS       31%/79%   35%/86%   39%/91%   44%/94%   58%/98%  74%/100%     23%/64%     27%/72%     30%/78%     34%/85%     45%/94%     59%/99%

== SYNTH-FEATURE: accuracy   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
   the lab feature-level person (tests/lab/lib/synth.mjs World), its own noise model at scale 1
noise   condition     fix RMS px [95% CI]  deg*  fix med  fix p90  frame RMS  fix x RMS  fix y RMS  bias x  bias y  scatter x/y  claimed x/y  x off by  y off by  gated  blink  in fix   n
lab x1  STILL           33.7 [31.7, 35.2]  0.65     27.0     50.0       46.3       18.1       28.4    13.9    18.7        21/36        22/27     x0.82     x0.99     0%     3%     71%  20
lab x1  HEAD-SHIFT   105.9 [104.1, 107.9]  2.04     95.7    154.1      109.3       85.7       61.8    83.4    57.2        21/36        22/27     x3.82     x2.24     0%     3%     69%  20
lab x1  HEAD-ROTATE  189.3 [186.1, 193.0]  3.65    177.6    244.2      191.9      114.2      150.9   112.5   148.0        21/35        22/27     x5.05     x5.65     0%     3%     72%  20
lab x1  LATER           80.4 [77.5, 85.1]  1.55     76.1    108.6       87.4       55.9       58.6    54.5    54.7        20/36        22/27     x2.61     x2.12     0%     2%     71%  20
lab x1  LOW-FPS         36.6 [35.4, 39.0]  0.71     29.1     55.9       48.0       19.3       30.6    15.1    20.5        20/36        20/31     x1.01     x0.99     0%     3%     80%  20

== SYNTH-FEATURE: would the vertical error land on the right line? exact line / 3-line band, by line pitch   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
noise   condition    24px fix  28px fix  32px fix  36px fix  48px fix  64px fix  24px frame  28px frame  32px frame  36px frame  48px frame  64px frame
lab x1  STILL         31%/79%   36%/86%   41%/92%   48%/94%   59%/99%  73%/100%     23%/65%     27%/71%     31%/77%     34%/82%     45%/93%     58%/99%
lab x1  HEAD-SHIFT    19%/51%   22%/56%   26%/61%   30%/65%   38%/73%   46%/85%     15%/43%     18%/49%     20%/54%     23%/59%     30%/71%     39%/83%
lab x1  HEAD-ROTATE   15%/38%   16%/43%   20%/44%   21%/46%   27%/49%   35%/50%     12%/31%     14%/35%     15%/38%     17%/41%     22%/46%     28%/50%
lab x1  LATER          9%/32%   10%/36%   10%/47%   14%/55%   18%/78%   24%/93%     11%/34%     13%/41%     14%/47%     17%/53%     23%/70%     30%/87%
lab x1  LOW-FPS       32%/74%   36%/81%   41%/86%   45%/93%   57%/98%  69%/100%     22%/62%     27%/68%     30%/75%     34%/80%     44%/92%     57%/98%

== SYNTH-3D: the pooled movement rows, run by run (fixation RMS px)   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
noise   condition              run   fix RMS px [95% CI]  fix x RMS  fix y RMS  gated
0.2 px  HEAD-SHIFT   sideways 3 cm  134.0 [124.4, 144.8]      132.7       22.4     0%
0.2 px  HEAD-SHIFT       back 5 cm     59.9 [56.0, 63.9]       46.4       38.7     0%
0.2 px  HEAD-SHIFT     slouch 2 cm     86.0 [75.7, 93.9]       20.8       81.9     0%
0.2 px  HEAD-ROTATE      yaw 5 deg  229.9 [224.2, 254.0]      228.9       20.3     0%
0.2 px  HEAD-ROTATE    pitch 5 deg  229.9 [210.5, 235.8]       26.4      228.4     0%
0.5 px  HEAD-SHIFT   sideways 3 cm  139.7 [130.8, 147.4]      136.6       29.2     0%
0.5 px  HEAD-SHIFT       back 5 cm     64.0 [58.9, 68.8]       49.5       39.3     0%
0.5 px  HEAD-SHIFT     slouch 2 cm    95.0 [89.0, 101.3]       28.7       90.1     0%
0.5 px  HEAD-ROTATE      yaw 5 deg  240.5 [236.8, 254.1]      239.4       24.6     0%
0.5 px  HEAD-ROTATE    pitch 5 deg  241.2 [230.7, 249.6]       32.6      238.4     0%
0.8 px  HEAD-SHIFT   sideways 3 cm  143.5 [135.9, 151.7]      139.5       33.6     0%
0.8 px  HEAD-SHIFT       back 5 cm     68.8 [68.0, 76.8]       58.3       44.1     0%
0.8 px  HEAD-SHIFT     slouch 2 cm   102.2 [95.1, 107.6]       38.1       95.1     0%
0.8 px  HEAD-ROTATE      yaw 5 deg  246.9 [236.9, 256.2]      244.9       29.7     0%
0.8 px  HEAD-ROTATE    pitch 5 deg  244.2 [240.4, 249.3]       40.7      239.7     0%

== SYNTH-FEATURE fixtures: tests/lab/fixtures, one recorded synthetic session, no interval   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
file                      phase      fix RMS px  deg*  fix med  frame RMS  fix x RMS  fix y RMS  claimed x/y  gated  blink  fixations
synthetic-camera.json     all              30.3  0.58     23.0       43.7       13.0       27.4        22/25     0%     8%         26
synthetic-headshift.json  baseline         33.6  0.65     24.0       43.4       17.8       28.5        22/25     0%     2%         16
synthetic-headshift.json  lean-left       150.4  2.90    148.4      152.7      148.1       26.2        22/25     0%     2%         12
synthetic-headshift.json  lean-back        43.9  0.85     40.0       57.5       32.5       29.4        22/25     0%     6%         11
synthetic-headshift.json  slouch          286.4  5.52    280.5      291.4       16.0      285.9        22/25     0%     2%         14
synthetic-validate.json   all              27.2  0.52     22.5       43.0       14.0       23.2        22/25     0%     3%         53

REAL: no recordings

PRIMARY SCORES   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
  S_still = 41.98 [40.28, 45.00] px   fixation-level euclidean RMS, SYNTH-3D STILL at 0.5 px iris noise (median over 20 seeds)
  S_move  = 173.51 [169.63, 178.60] px   the same, mean of HEAD-SHIFT and HEAD-ROTATE
```

## Step 2: regression robustness and head pose (2026-11-20, step 2 of 4)

Still every number is from the synthetic camera. Nothing in this section was tried on a real one.

### Result

| Score | Baseline | After step 2 | Change |
|---|---|---|---|
| S_still | 41.98 px | 40.28 px [36.77, 43.91] | -4.1 %, better on 6 of 20 seeds, worse on 0 |
| S_move | 173.51 px | 168.35 px [108.93, 175.36] | -3.0 %, better on 6 of 20 seeds, worse on 0 |

The medians hide what happened. The calibration now tries a head-pose-aware model (E, below) and
uses it only when it beats the old model's leave-one-dot-out error by 5 %. After a keep-still
calibration that happened for 6 of the 20 synthetic people. For those six S_move fell from
165-199 px to 39-59 px; for the other fourteen nothing changed. The mean over seeds of S_move went
from 174.0 to 136.7 px.

The same 20 people, when model E is in use for all of them:

| Calibration | Model in use | S_still | S_move |
|---|---|---|---|
| keep still (as shipped), shoot-out | A for 14, E for 6 | 40.3 | 168.3 |
| keep still, model A (the baseline) | A for 20 | 42.0 | 173.5 |
| keep still, model E forced (`opts.model: 'E'`) | E for 20 | 32.2 | 49.5 |
| head sways 1.5 cm and 3 degrees during the dots, shoot-out | E for 20 | 35.9 | 44.2 |
| head sways during the dots, model A | A for 20 | 73.5 | 137.8 |

So the large gain is there, and the shipped default reaches it for only some people until the
calibration makes the head move (step 3). See "Why the shoot-out keeps A so often" below.

Commands, from the checkout root:

```
node tests/bench/gaze-bench.mjs --compare                                         (29 s; exit 0)
node tests/bench/gaze-bench.mjs --compare --json tests/bench/after-step2.json     (the saved result of this step)
node tests/bench/gaze-bench.mjs --compare --baseline tests/bench/after-step2.json (for later steps)
```

`tests/bench/baseline.json` is untouched. `--model A` reproduces it exactly, row for row.

### Decisions, one line per sub-change

Rule: keep a sub-change only if S_still or S_move improves by at least 3 %, neither gets more
than 3 % worse, and the tests pass. Before is the baseline in every line: 41.98 / 173.51 px.

| Sub-change | S_still before -> after | S_move before -> after | Decision |
|---|---|---|---|
| 2a regression hygiene, all six options on model A | 41.98 -> 41.05 (-2.2 %) | 173.51 -> 171.66 (-1.1 %) | REVERTED: under 3 % on both, alone or together |
| 2b iris from the mean of five points, and against rigid points | 41.98 -> 41.99 (+0.0 %) | 173.51 -> 173.55 (+0.0 %) | REVERTED as a model input: no model reads it |
| 2c head pose and head-frame iris offsets | 41.98 -> 41.62 (-0.9 %) | 173.51 -> 163.41 (-5.8 %) | KEPT |
| 2d model shoot-out in fitCalibration | 41.98 -> 40.28 (-4.1 %) | 173.51 -> 168.35 (-3.0 %) | KEPT |

After each sub-change `node tests/gaze-core.test.js` and `node tests/lab/lib/selftest.mjs` passed.

### 2a. Regression hygiene: reverted

Each option alone and all together, on model A (`--model A --hygiene ...`, 0.5 px noise, 20 seeds):

| `--hygiene` | S_still | S_move |
|---|---|---|
| (none: the baseline) | 41.98 | 173.51 |
| `zClamp=4` (inputs held within 4 SD of the calibration) | 41.98 (+0.0 %) | 173.48 (-0.0 %) |
| `sdFloor` (no input scaled by less than 2 % of its typical range) | 41.98 (+0.0 %) | 173.51 (+0.0 %) |
| `bounds=0.15` (answers held within the viewport plus 15 %) | 41.98 (+0.0 %) | 171.17 (-1.3 %) |
| `norm` (Gram matrix divided by the frame count, grid 1e-5 to 3) | 41.76 (-0.5 %) | 174.12 (+0.3 %) |
| `norm,perAxis` (also a penalty each for x and y) | 41.94 (-0.1 %) | 173.33 (-0.1 %) |
| `dropMeans` (the four collinear mean features left out) | 42.00 (+0.1 %) | 174.16 (+0.4 %) |
| all six | 41.05 (-2.2 %) | 171.66 (-1.1 %) |
| all but `dropMeans` | 41.94 (-0.1 %) | 171.14 (-1.4 %) |

Nothing reaches 3 %, so model A fits and predicts exactly as before: `--model A` gives the baseline
to the last digit on every row. What is left in the code:

- The options exist in `Ridge.fit` and are off by default (`Ridge.DEFAULTS`, `HYGIENE` in
  `gaze-core.js`). The new models of 2d use them (normalised penalty per axis, z-clamp 4, SD floor,
  answers within the viewport plus 15 %) and were judged with them on.
- The collinear means stay in the fit of model A: the benchmark shows no difference.
- Model JSON has a version. `Ridge.fromJSON` loads a model saved before tonight (no version, no
  kind) and predicts exactly as it did: no clamp, no bounds, its one unnormalised penalty.

Why so little: the clamps and floors are safety nets for inputs the benchmark never produces (an
input 50 SD out, a feature that stood still in calibration). The benchmark cannot show their worth.

### 2b. Iris from five points, iris against rigid points: reverted as model inputs

`extractFeatures` appends eight numbers at 44-51: the iris offsets of both eyes from the mean of
the five iris points, against the eye corners (44-47) and against the inner eye corners and the
nose bridge (48-51). Tried as model A's iris inputs in place of features 0, 1, 4, 5:

| Model A reads | S_still | S_move |
|---|---|---|
| 0, 1, 4, 5 (the baseline) | 41.98 | 173.51 |
| 44-47, mean of five points | 41.99 (+0.0 %) | 173.55 (+0.0 %) |
| 44-47, when half of each rim point's noise is its own (`--set irisRingIndep=0.5`) | 41.02 (-2.3 %) | 171.22 (-1.3 %) |
| 48-51, against rigid points | 43.13 (+2.7 %) | 178.31 (+2.8 %) |
| 0, 1, 4, 5 and 48-51 | 42.25 (+0.6 %) | 174.56 (+0.6 %) |

(`--columns 44,45,46,47,2,3,6,7,8,...,24` and so on.)

No model reads 44-51, and the head-frame offsets of 2c are taken from the iris centre point, as
features 0-7 are. The eight numbers are still in the vector, unread. That is a deliberate
half-measure: the synthetic camera cannot answer this question, because how much the five iris
points disagree with each other is an assumption (the standard synthetic person moves them as one,
which makes the mean of five equal to the centre by construction). A recording from a real camera
can answer it, and the lab only records the feature vector. To take them out altogether, delete
the three lines after "44 onwards" in `extractFeatures` and renumber `F`.

### 2c. Head pose and head-frame iris offsets: kept

Appended at 52-62, all computed from what `frame.js` already sends:

- 52: 1 when the face matrix is a usable rigid transform, else 0.
- 53-55: head yaw, pitch, roll in units of 0.1 rad. 56-58: head position in units of 3 cm.
  Fixed physical units, never divided by how much they varied in calibration. The depth becomes a
  ratio to the calibration depth inside the model, which is where the calibration depth is known.
- 59-62: the iris offsets of both eyes in the head's own frame. The eye corners rest at known
  places in the head (MediaPipe's canonical face model, Apache-2.0, noted in the source), so their
  picture can be turned back before the offset is measured. A face off to one side is seen from
  that side, so the rotation taken out is the one against the line of sight, not against the
  camera axis; without that, a 3 cm sideways move was only half corrected.
- A missing, non-finite or non-rigid matrix (the browser test camera sends noise there) gives flag
  0, pose 0, and 59-62 equal to the plain offsets.

Measured on their own, with model A reading 59-62 in place of 0, 1, 4, 5: S_still 41.62 (-0.9 %),
S_move 163.41 (-5.8 %). A head turn no longer slides the iris against the corners. Model A itself
was left as it is (2d needs it unchanged as the fallback); model E is where these numbers are used.

One more run, not adopted: model A with the six pose numbers added as ordinary z-scored inputs gave
S_still 38.86 and S_move 139.38. It helps here, but it is the construction the handoff warns about
(pose weights learned from a head that hardly moved), and model E does far better.

### 2d. Model shoot-out: kept

`fitCalibration` always fits model A as before. When the camera rows carry a usable head pose it
also fits three head-frame models on the same trimmed rows and compares leave-one-dot-out errors
(bias and scatter per unseen dot, combined as on the calibration card). The best of them replaces
A only if it beats A by at least 5 %.

A head-frame model has two parts:

1. Geometry, not learned. Head pose and eye direction give a gaze ray. Where that ray meets the
   screen plane moves when the head moves. That movement in cm, times the screen's px per cm
   (estimated from the dots), is added to the prediction. The one assumption about the eye is the
   distance from its centre of rotation to the iris centre, 1.05 cm.
2. A ridge regression on head-frame inputs for everything else, plus the six pose numbers with a
   penalty of their own (0.1 per frame in pose units squared), so that a calibration in which the
   head really moved can correct the geometry.

| Model | Regression inputs | S_still forced | S_move forced |
|---|---|---|---|
| A | features 0-24, as shipped | 41.98 | 173.51 |
| B | head-frame iris offsets and lid terms of both eyes, pose 6 | 55.61 | 72.21 |
| C | B plus squares and products | 56.75 | 73.73 |
| E | C plus the eight eye-look blendshapes (model A's inputs, in the head frame), pose 6 | 32.18 | 49.46 |

- B and C lose to A when still because A has the blendshapes, and the synthetic blendshapes are
  probably too clean (see "Assumptions"). On a real camera B or C may be the better choice. The
  shoot-out decides per calibration; the lab's model table now refits B, C and E from a real dump.
- D (RBF kernel ridge) was not built. It is not cheap: a kernel fit on 500 frames per fold, and
  nothing here suggested the mapping is short of non-linearity (C does not beat B).
- The chosen kind is in the model JSON (`kind`), in `accuracy.model`, and in `debugDump()` as
  `modelKind` with `shootout` (the errors compared and one sentence on why).
- `GazeReader.init({ model })`: `'auto'` (default), `'A'` forces the old path, `'B'`, `'C'`, `'E'`
  force that model whenever it can be fitted.
- Click refinement refits the same kind of model (`refitModel`).
- The geometry checks itself on the calibration: the gaze rays must line up with the dots (r2 over
  0.8 on both axes), at a believable screen scale, landing below the camera. Otherwise A is kept
  and the note says why.

### Why the shoot-out keeps A so often after a keep-still calibration

Leave-one-dot-out error is measured during the calibration. If the head keeps still, A and E give
almost the same answers there, and E wins by 5 % only when the head happened to move: E is chosen
for 14 of 20 people at 0.2 px noise, 6 at 0.5 px, 3 at 0.8 px. What E is good for (the head moving
later) is not in the data the rule looks at.

| Synthetic person changed (`--set`) | A still / move | Shoot-out still / move | Shoot-out picks E for | E forced still / move |
|---|---|---|---|---|
| standard | 42.0 / 173.5 | 40.3 / 168.3 | 6 of 20 | 32.2 / 49.5 |
| `headWanderDeg=0` (no slow head rotation) | 32.5 / 172.3 | 32.5 / 172.0 | 1 | 32.4 / 49.6 |
| `headWanderDeg=1` | 85.8 / 183.9 | 36.1 / 50.1 | 19 | 36.1 / 50.1 |
| `headFollow=0.2` (head turns 20 % of the way to the dot) | 46.4 / 193.2 | 33.9 / 50.0 | 15 | 32.7 / 47.4 |
| `headFollow=0.4` | 56.0 / 227.5 | 31.8 / 41.2 | 20 | 31.8 / 41.2 |
| `eyeRadiusCm=1.05` (the eye as the geometry assumes it) | 42.5 / 175.1 | 40.4 / 169.4 | 6 | 32.7 / 38.8 |
| `eyeRadiusCm=0.9` | 42.9 / 175.8 | 42.0 / 171.6 | 5 | 34.9 / 49.9 |

The standard synthetic eye has a radius of 1.2 cm against the 1.05 cm the geometry assumes, so the
standard numbers already include a 14 % mismatch.

I did not make E the default after a keep-still calibration, for two reasons. The brief fixes the
5 % rule. And a keep-still calibration cannot check the part of the geometry that matters: with
the face matrix reported in the wrong convention (rotation transposed, `matrixTranspose` in
`synth3d.mjs`), a forced E after a keep-still calibration doubled the error of a 5 degree head turn
(about 430 px against A's 250 px, 10 seeds). The shoot-out kept A for all 10 of those, and with head
movement during the dots the geometry check refused E for all 10. Whether MediaPipe's real matrix
follows the convention assumed here (column-major, cm, camera looking along -z) has not been
checked on a camera.

### For step 3 (calibration)

- A calibration during which the head moves makes the shoot-out pick E for 20 of 20 people:
  S_still 35.9, S_move 44.2, LATER 36.0 (baseline 42.0, 173.5, 76.2). `--cal move` runs it: a slow
  sway of up to 1.5 cm and 3 degrees while the 18 dots are shown.
- The same calibration with model A is much worse than today: S_still 73.5. Frames taken while the
  head moves must not reach model A. If the movement segment is a separate set of dots, A has to
  be fitted without them, and `fitCalibration` does not do that yet: it gives A every dot.
- The pose penalty (0.1) is a compromise between two risks, measured with E forced:

| Pose penalty | still calibration: S_still / S_move | calibration with movement: S_still / S_move |
|---|---|---|
| 0.01 | 33.1 / 61.5 | 34.4 / 42.3 |
| 0.03 | 32.3 / 52.6 | 34.3 / 42.0 |
| 0.1 (in use) | 32.2 / 49.5 | 35.9 / 44.2 |
| 0.3 | 32.0 / 49.1 | 36.6 / 46.7 |
| 1 | 32.0 / 49.1 | 37.8 / 48.9 |

  A small penalty lets a keep-still calibration mistake "the head follows the eyes" for a pose
  effect; a large one stops a calibration with movement from correcting the geometry. The constant
  is `POSE_PENALTY` in `gaze-core.js`; the other values were measured by editing it.

### What else changed in step 2

- The training rows a calibration stores (`train.X`, in `debugDump()` and in the saved calibration)
  are now the camera's whole vector, 63 numbers, not the 25 model A reads. A dump from a real
  session can then refit any model. About 300 KB per saved calibration instead of 120 KB.
  `tests/gaze-core.test.js` asserted 25-wide rows; that assertion was changed on purpose.
- `tests/lab/lib/analysis.mjs`: the model table refits what model A reads (b), adds the pose
  variant (e) from any new dump, and adds B, C, E when the rows have 63 numbers. The lab self-test
  expected seven variants from a default synthetic session; it now expects eight, and seven from
  25-wide rows (`cal: { trainWidth: 25 }`). Changed on purpose.
- `tests/bench/synth3d.mjs`: noise on the rigid landmarks, optional independent noise on the iris
  rim points, optional wrong matrix convention. These use a second random stream, so features 0-43
  and the baseline are unchanged (checked in `tests/bench/bench.test.mjs`).
- `tests/bench/gaze-bench.mjs`: `--model`, `--cal`, `--hygiene`, `--columns`, `--baseline`,
  `--no-variants`; a model column in every table; the "other models and calibrations" table. The
  run takes 29 s instead of 11 s because of that table (five more passes at 0.5 px).
- `tests/gaze.mjs` has two more checks (28): a camera without a head pose ends with model A and the
  dump says so; a click refits the same kind of model.
- The lab fixtures in `tests/lab/fixtures` were not regenerated. They hold models saved before
  tonight's version field and 25-wide rows, and they still load and score exactly as in the
  baseline, which is the old-model test on real files.

### Not measured in step 2

- Anything on a real camera. In particular: whether the face matrix follows the assumed
  convention; how noisy it is (the synthetic one has 0.3 degrees and 0.08 to 0.5 cm of noise at
  0.5 px, assumed); whether 1.05 cm is a fair eye radius; whether the real blendshapes are as
  useful as the synthetic ones make model E look.
- Head-frame models in the browser. The browser tests use a camera that sends 44 numbers and no
  pose, so they only show that the reader falls back to model A and keeps working. Models B, C
  and E run in node only (`tests/gaze-core.test.js`, `tests/bench/bench.test.mjs`).
- SYNTH-FEATURE rows are unchanged by construction: the lab's synthetic person has no landmarks,
  only 44 numbers, so it always ends with model A.
- The mean of five iris points and the rigid reference points (2b), as said above.

### Full comparison output

```
COMPARE against tests/bench/baseline.json (baseline variant: features 25, trim on, model A; 20 seeds)   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
  S_still  41.98 -> 40.28 px   delta -1.70 px (-4.1%)   better on 6, worse on 0 of 20 seeds   ok
  S_move   173.51 -> 168.35 px   delta -5.16 px (-3.0%)   better on 6, worse on 0 of 20 seeds   ok

source         row                 baseline    now  delta px   delta       fix y RMS     gated   model now
SYNTH-3D       0.2 px STILL            32.7   22.5     -10.2  -31.2%    20.7 -> 14.2  0% -> 0%   A 6, E 14
SYNTH-3D       0.2 px HEAD-SHIFT       99.0   32.8     -66.3  -66.9%    55.1 -> 24.7  0% -> 0%   A 6, E 14
SYNTH-3D       0.2 px HEAD-ROTATE     231.5   62.9    -168.5  -72.8%   159.4 -> 51.0  0% -> 0%   A 6, E 14
SYNTH-3D       0.2 px LATER            70.0   24.5     -45.6  -65.1%    50.5 -> 18.9  0% -> 0%   A 6, E 14
SYNTH-3D       0.2 px LOW-FPS          28.5   20.2      -8.3  -29.2%    19.5 -> 14.0  0% -> 0%   A 1, E 19
SYNTH-3D       0.5 px STILL            42.0   40.3      -1.7   -4.1%    24.6 -> 23.8  0% -> 0%   A 14, E 6
SYNTH-3D       0.5 px HEAD-SHIFT      104.6   99.6      -5.0   -4.8%    61.3 -> 56.8  0% -> 0%   A 14, E 6
SYNTH-3D       0.5 px HEAD-ROTATE     240.7  237.2      -3.5   -1.5%  170.7 -> 162.5  0% -> 0%   A 14, E 6
SYNTH-3D       0.5 px LATER            76.2   72.7      -3.5   -4.6%    53.4 -> 51.5  0% -> 0%   A 14, E 6
SYNTH-3D       0.5 px LOW-FPS          39.5   33.4      -6.2  -15.6%    25.2 -> 21.1  0% -> 0%  A 10, E 10
SYNTH-3D       0.8 px STILL            51.9   51.6      -0.3   -0.6%    30.0 -> 29.2  0% -> 0%   A 17, E 3
SYNTH-3D       0.8 px HEAD-SHIFT      109.3  107.0      -2.3   -2.1%    65.8 -> 65.8  0% -> 0%   A 17, E 3
SYNTH-3D       0.8 px HEAD-ROTATE     244.0  243.5      -0.6   -0.2%  173.9 -> 172.6  0% -> 0%   A 17, E 3
SYNTH-3D       0.8 px LATER            83.9   79.6      -4.4   -5.2%    58.0 -> 56.9  0% -> 0%   A 17, E 3
SYNTH-3D       0.8 px LOW-FPS          50.0   46.3      -3.8   -7.6%    28.9 -> 27.1  0% -> 0%   A 16, E 4
SYNTH-FEATURE  lab x1 STILL            33.7   33.7      +0.0   +0.0%    28.4 -> 28.4  0% -> 0%        A 20
SYNTH-FEATURE  lab x1 HEAD-SHIFT      105.9  105.9      +0.0   +0.0%    61.8 -> 61.8  0% -> 0%        A 20
SYNTH-FEATURE  lab x1 HEAD-ROTATE     189.3  189.3      +0.0   +0.0%  150.9 -> 150.9  0% -> 0%        A 20
SYNTH-FEATURE  lab x1 LATER            80.4   80.4      +0.0   +0.0%    58.6 -> 58.6  0% -> 0%        A 20
SYNTH-FEATURE  lab x1 LOW-FPS          36.6   36.6      +0.0   +0.0%    30.6 -> 30.6  0% -> 0%        A 20

RESULT: no primary score is more than 3 % worse than the baseline.
```

The accuracy rows of this run at 0.5 px (the full tables are printed by the command):

```
noise   condition     fix RMS px [95% CI]  deg*  fix med  fix p90  frame RMS  fix x RMS  fix y RMS  bias x  bias y  scatter x/y  claimed x/y  x off by  y off by  gated  blink  in fix   n       model
0.5 px  STILL           40.3 [36.3, 43.8]  0.78     33.1     59.1       47.9       29.5       23.8    23.4    20.1        29/21        24/21     x1.11     x1.18     0%     4%     63%  20   A 14, E 6
0.5 px  HEAD-SHIFT     99.6 [67.6, 104.7]  1.92     87.0    138.5      102.7       79.7       56.8    75.9    55.4        30/21        24/21     x3.08     x2.61     0%     4%     62%  20   A 14, E 6
0.5 px  HEAD-ROTATE  237.2 [147.3, 241.8]  4.57    234.8    262.4      238.3      164.5      162.5   163.4   160.8        29/20        24/21     x6.06     x7.09     0%     3%     66%  20   A 14, E 6
0.5 px  LATER           72.7 [42.9, 81.4]  1.40     67.4     94.8       77.5       45.2       51.5    41.4    50.0        30/21        24/21     x1.63     x2.16     0%     4%     64%  20   A 14, E 6
0.5 px  LOW-FPS         33.4 [31.2, 38.8]  0.64     25.3     51.7       47.0       25.4       21.1    19.9    16.6        30/21        27/23     x1.00     x0.94     0%     4%     75%  20  A 10, E 10

noise   condition              run   fix RMS px [95% CI]  fix x RMS  fix y RMS  gated
0.5 px  HEAD-SHIFT   sideways 3 cm   125.0 [79.5, 139.1]      121.5       28.5     0%
0.5 px  HEAD-SHIFT       back 5 cm     60.6 [46.3, 66.8]       45.6       34.5     0%
0.5 px  HEAD-SHIFT     slouch 2 cm    89.3 [59.8, 100.4]       27.9       84.2     0%
0.5 px  HEAD-ROTATE      yaw 5 deg  229.0 [134.6, 245.7]      228.2       23.8     0%
0.5 px  HEAD-ROTATE    pitch 5 deg  230.7 [155.2, 242.7]       29.8      228.5     0%
```

```
== SYNTH-3D at 0.5 px: the same 20 people under other models and calibrations (fixation RMS px)   [synthetic; noise levels are assumptions; not evidence of real-camera accuracy]
   head movement during calibration: a slow sway of up to 1.5 cm and 3 degrees while the dots are shown. LODO error: median leave-one-dot-out error the shoot-out compared.
calibration and model                                  model in use   S_still [95% CI]       S_move [95% CI]  STILL  HEAD-SHIFT  HEAD-ROTATE  LATER  LOW-FPS              LODO error by model
still calibration, shoot-out (the standard run above)  A 14, E 6     40.3 [36.8, 43.9]  168.3 [108.9, 175.4]   40.3        99.6        237.2   72.7     33.4   A 32.3, B 55.1, C 57.4, E 31.9
still calibration, model A                             A 20          42.0 [40.3, 45.0]  173.5 [169.6, 179.5]   42.0       104.6        240.7   76.2     39.5                           A 32.3
still calibration, model E forced                      E 20          32.2 [31.1, 36.1]     49.5 [46.3, 54.8]   32.2        39.7         60.0   34.0     32.5                   A 32.3, E 31.9
calibration with head movement, model A                A 20          73.5 [70.7, 82.0]  137.8 [126.3, 140.5]   73.5       104.3        166.6   88.3     77.4                          A 115.3
calibration with head movement, shoot-out              E 20          35.9 [33.4, 38.7]     44.2 [39.8, 46.1]   35.9        39.0         47.3   36.0     34.7  A 115.3, B 60.9, C 63.7, E 43.0
```

## Step 3: calibration procedure, head gate, saved calibration, blinks (2026-11-20, step 3 of 4)

Still every number is from the synthetic camera. Nothing in this section was tried on a real one,
and step 3 adds assumptions about how a person behaves during calibration (listed under "Not
measured in step 3").

### Result

| Score | Baseline | After step 2 | After step 3 | Change against step 2 |
|---|---|---|---|---|
| S_still | 41.98 px | 40.28 px | 29.70 px [28.12, 33.24] | -26.3 %, better on 17 of 20 seeds, worse on 3 |
| S_move | 173.51 px | 168.35 px | 39.11 px [35.62, 43.83] | -76.8 %, better on 20 of 20 seeds |

Against the baseline: S_still -29.3 %, S_move -77.5 %.

Read S_move with two things in mind.
- The head-aware model (E) is now chosen for 20 of 20 synthetic people, because the calibration
  ends with a head-movement segment. After step 2 it was 6 of 20. That is where most of the gain is.
- The head gate now pauses tracking for part of the HEAD-ROTATE row: 27 % of its frames are thrown
  away (the 5 degree nod is beyond the 4.6 degree limit), so that row is scored on the rest. With
  the gate switched off S_move is 39.9 px (`--proc gate=false`).

The calibration takes 46.7 s from the first dot to the last (longest of 20: 49.9 s); for a careless
reader 53.1 s (longest 59.9 s). It was 36.7 s.

What the calibration card claims against what is measured, STILL at 0.5 px: claimed 25 px across
and 20 px up and down; measured fixation RMS 22.6 and 20.3 px. Per person the measured vertical
error is 1.14 times the claim (median of the ratios).

Commands, from the checkout root:

```
node tests/bench/gaze-bench.mjs --compare                                         (53 s; exit 0; compares with baseline.json and after-step2.json)
node tests/bench/gaze-bench.mjs --compare --json tests/bench/after-step3.json     (the saved result of this step)
node tests/bench/gaze-bench.mjs --compare --baseline tests/bench/after-step3.json (for the next step)
node tests/bench/gaze-bench.mjs --gate-sweep                                      (51 s; the sweep behind the head gate)
node tests/bench/gaze-bench.mjs --clicks                                          (click refinement, gated and not)
node tests/bench/pursuit-bound.mjs                                                (the most a pursuit pass could give)
node tests/bench/fold-compare.mjs                                                 (validation dots folded in or held out, 60 people)
```

`baseline.json` and `after-step2.json` are untouched.

### Decisions, one line per sub-change

Rule: 3a, 3c and 3d are correctness and safety items, kept if the tests pass and the benchmark is
not worse. The others are kept only if S_still or S_move improves by at least 3 % with neither
more than 3 % worse. "Off" is the final tree with that one thing switched off, 20 seeds at 0.5 px;
the two numbers are S_still / S_move in px. Final tree: 29.7 / 39.1.

| Sub-change | Off | On | Decision |
|---|---|---|---|
| 3a dot quality: sample once the eyes have stopped, show doubtful dots again, never an empty dot, `caldot` event, untrimmed frames in the dump | clean reader 31.1 / 39.9. Careless reader: 12 of 20 calibrations end in an error; with empty dots accepted as before, 51.6 / 69.7 | clean reader 29.7 / 39.1. Careless reader 28.9 / 40.4, none fail | KEPT |
| 3b head segment (6 s, three dots, "turn your head a little") | 31.6 / 46.4, model A for 10 of 20, 33 % and 73 % of the two movement rows gated | 29.7 / 39.1, model E for 20 of 20 | KEPT |
| 3b smooth-pursuit pass | not built | upper bound with perfect following, 40 seeds: S_still 29.5 -> 28.4 (-3.7 %), movement 36.4 -> 36.5; 8 s longer | SKIPPED |
| 3c honest accuracy: validation dots no longer folded into training, accuracy is the shipped model's error on them, card reworded | folded, leave-one-dot-out figure: 30.6 / 40.1. Folded, step 2 figure: 29.4 / 39.1 | 29.7 / 39.1 | KEPT |
| 3d head gate with rotation and tighter translation, by model; saved calibration reused only inside the gate; resized or moved window pauses | 29.7 / 39.9, nothing gated. Model A forced: 38.4 / 175.9 | 29.7 / 39.1, 27 % of HEAD-ROTATE gated. Model A forced: paused for 66 % of HEAD-SHIFT and 98 % of HEAD-ROTATE | KEPT |
| 3e blink rule (both eyes, against the recent lid level, two frames after a blink) | 29.8 / 39.0. Person whose lids follow the eyes down: 17 of 20 calibrations fail, 82 % of bottom-row frames lost | 29.7 / 39.1. That person: none fail, 6 % of bottom-row frames lost | KEPT |
| 3f click refinement gate (fixation in progress, within 2 sigma, not on Glider's controls, 60 s life) | frame RMS after 12 clicks: 71.6 px | 44.0 px (no clicks at all: 44.1 px) | KEPT |
| 3f vertical drift applied to paragraph picking and to the emitted gaze | not built | not measurable: the benchmark has no reading condition | SKIPPED |
| 3f horizontal drift model | not built | not measured | SKIPPED |
| Not on the list: the fixation detector's dispersion limit, 2.5 x (scatter across + scatter down) instead of 2.2 x the larger one | 35.1 / 43.2, 60 % of the time inside a fixation | 29.7 / 39.1, 89 % | KEPT |

After every sub-change `node tests/gaze-core.test.js`, `node tests/lab/lib/selftest.mjs` and
`node tests/bench/bench.test.mjs` passed; `node tests/gaze.mjs` (36 of 36, three runs in a row
at the end) and `node tests/gaze-full.mjs` (20 of 20) passed on the final tree.

How much to trust a 3 % difference: the same configuration run with one frame of timing changed
moves S_still by about 1 px and can move S_move by much more when some people get model A and
others E. The interval on S_still is about +/- 2.5 px. Differences under 2 px between two rows of
the table above are noise. The decisions that rest on small differences are marked below.

### Where the logic lives

`gaze-core.js` has all of it, so the benchmark runs the same code as the extension:
`CalibrationRun` (the procedure as a state machine driven by a clock: which dot to show, when its
frames count, which dots to show again, the head segment), `reviewDots`, `betterShowing`,
`streamStill`, `streamMoved`, `StreamNoise`, `fitCalibration` (roles `cal`, `val`, `move`,
`pursuit`), `accuracyGrade`, `HEAD_GATE`, `headMoved`, `headOffset`, `headWithinGate`,
`BlinkDetector`, `markBlinks`, `clickUsable`, `liveClicks`, `FixationDetector.current`.
`gaze-reader.js` only moves the dot, shows the text and wires events.
`tests/bench/gaze-bench.mjs` has `runProcedure`: a synthetic person following `CalibrationRun`,
with options for late, missed and lost dots and for how far the head turns in the head segment.

### 3a. Dot quality: kept

What it does:
- A dot's frames are recorded from the moment it appears. Sampling starts once 700 ms have passed,
  the eyes have left where they were, and the stream has been still for 300 ms. If the eyes were
  already there it starts 500 ms later; if the stream never settles, after 1.5 s more. The first
  300 ms of sampling are thrown away, the next second is the dot. A jump during sampling starts
  it over. A dot takes 2 s when the eyes arrive in time, as before.
- After the 18 dots a first fit gives each dot's leave-one-dot-out residual. Dots with under 8
  frames, then dots with a residual over 2.5 x the median, are shown once more (at most three).
  The showing that the other dots agree with better is used.
- A dot with no frames is never accepted: the calibration ends with a message.
- One `caldot` event per dot; `debugDump().calibration.dots` has every frame of every dot from
  the moment it appeared, with the sampled stretch marked.

| Reader | Calibration | S_still / S_move | Calibrations failed | Seconds (median, longest) |
|---|---|---|---|---|
| does as told | as shipped | 29.7 / 39.1 | 0 | 46.7, 49.9 |
| does as told | fixed windows, nothing shown twice | 31.1 / 39.9 | 0 | 42.7, 42.8 |
| careless | as shipped | 28.9 / 40.4 | 0 | 53.1, 59.9 |
| careless | fixed windows, nothing shown twice | 47.8 / 56.0 | 12 | 42.7, 42.8 |
| careless | the same, empty dots accepted (as before step 3) | 51.6 / 69.7 | 0 | 42.7, 42.9 |
| careless | fixed windows, doubtful dots shown again | 29.3 / 39.5 | 0 | 48.8, 49.1 |
| careless | sampled when still, nothing shown twice, empty accepted | 38.2 / 51.6 | 0 | 48.6, 53.8 |
| 30 % of dots reached late | as shipped | 29.8 / 39.8 | 0 | 51.7, 55.9 |
| 30 % of dots reached late | fixed windows, doubtful dots shown again | 27.8 / 36.3 | 0 | 48.8, 49.0 |

The careless reader (assumed): 15 % of dots reached 0.8 to 1.6 s late, 6 % not looked at on their
first showing, 4 % with the face lost during the showing.

What the table says: showing doubtful dots again does the work. Waiting for the eyes to stop has
no gain of its own in this benchmark (the late reader is no better with it), because late frames
were already removed by the per-dot trimming and late dots are caught by the second showing. It
costs about 4 s per calibration for a reader who does everything right. It is kept because the
brief lists it as a correctness item and the benchmark is not worse, not because it measured
better. If the 4 s matter, `still: false, dropMs: 0` in `CalibrationRun` switches it off.

### 3b. Head segment: kept. Pursuit pass: skipped

After the dots, three more dots (centre, upper left, lower right; 2 s each) with the text "Keep
watching the dot and slowly turn your head a little: left, right, up, down." on screen.

These frames go to the head-frame models only. Model A is fitted without them (step 2 measured
what they do to it: S_still 73.5). The shoot-out then compares every model on dots it has not
seen, and for model A that includes the head-segment dots. A model that knows about the head wins
there by a wide margin when the head really moved: median unseen-dot error A 67.4, E 35.0.

| Head movement in the segment (assumed) | Model chosen | S_still | S_move | Gated: HEAD-SHIFT, HEAD-ROTATE |
|---|---|---|---|---|
| no head segment | A 10, E 10 | 31.6 | 46.4 (10 people) | 33 %, 73 % |
| segment shown, reader keeps the head still | A 7, E 13 | 29.8 | 49.0 (13 people) | 0 %, 35 % |
| about 2.5 degrees and 0.5 cm | E 20 | 29.1 | 43.1 | 0 %, 27 % |
| about 5 degrees and 1 cm (the standard) | E 20 | 29.7 | 39.1 | 0 %, 27 % |
| about 10 degrees and 2 cm | E 20 | 30.6 | 37.1 | 0 %, 27 % |

Where the count is under 20, the other people were paused by the gate for the whole row and have
no score. With the gate off and model A forced, S_move is 175.9; with E in use, 39.9.

A face matrix in the wrong convention (`matrixTranspose`), 20 people, gate off: the shoot-out
kept model A for 16 and chose B for 4, never E; scores 39.9 / 169.2, the same as model A. Forcing
E there gives 51.4 / 139.8. So the head segment still protects against a pose that does not mean
what the geometry takes it to mean, but not perfectly: 4 of 20 got a head-frame model (B).

The pursuit pass was not built. `node tests/bench/pursuit-bound.mjs` gives the fit 8 more seconds
of perfectly labelled frames along a gliding path, which no real pursuit pass can beat:

| Extra data (40 seeds) | S_still, shipped model | 3 cm and 5 degree yaw, gate off |
|---|---|---|
| none | 29.5 | 36.4 |
| 240 frames of a gliding target, the eye exactly on it | 28.4 (-3.7 %) | 36.5 |
| 8 more fixation dots of 1 s | 28.6 (-3.1 %) | 35.0 |

A real pass loses part of that to the lag estimate and to catch-up saccades, so it would land
at or under the 3 % line, and it would take the calibration from 47 to 55 s (a careless reader
from a longest 60 to 68 s, over the limit). `fitCalibration` already takes `pursuit` groups with
a target per frame, so a later attempt only needs the dot path and the lag estimate.

### 3c. Honest accuracy: kept

- The 5 validation dots are no longer folded into the training set. The model that ships is the
  13-dot fit (plus the head-segment dots for a head-frame model), and the accuracy is its error
  on the 5 dots it has not seen. Fewer than 3 usable validation dots: no accuracy, the
  calibration ends with a message.
- `fitCalibration` keeps the other two ways as options: `fold: true` (accuracy by
  leave-one-dot-out over all 18 dots) and `fold: true, score: 'val'` (step 2).
- The done card says "line by line" only when the vertical error is under 16 px (half of a 32 px
  line). Otherwise "follows the paragraph you are reading, to within a band of about N lines",
  or "only which paragraph" when the band is over 5 lines. At the benchmark's 20 px the card
  says "Good ... a band of about 3 lines".

Is folding better? The same 60 people, the same camera frames, three ways of fitting
(`node tests/bench/fold-compare.mjs`):

| Way | S_still mean | S_move mean | Against the first row, per person | Claimed y / measured (medians) | Mean abs log of measured / claimed, y | People off by over 30 % |
|---|---|---|---|---|---|---|
| folded, leave-one-dot-out over 18 dots | 29.5 | 39.5 | - | 21.0 / 18.1 | 0.213 | 20 of 60 |
| folded, a 13-dot fit scored on the 5 (step 2) | 28.9 | 38.9 | better on 44, worse on 11 (same model; only the fixation limit differs) | 20.0 / 17.9 | 0.234 | 23 of 60 |
| not folded, the shipped model on the 5 (in use) | 29.3 | 38.9 | better on 30, worse on 30 | 20.0 / 18.4 | 0.247 | 25 of 60 |

Folding is not better (30 against 30), so it was stopped, as the brief says. What this costs:
the leave-one-dot-out figure over 18 dots is a little closer to the truth per person than the
figure from 5 dots (0.213 against 0.247). And none of the three is tight per person: for a third
of the people the measured vertical error is more than 30 % away from the claim, in either
direction. The claim is right on average, not for each person.

### 3d. Head gate, saved calibration, resized window: kept

The sweep (`--gate-sweep`): each of the 20 people is calibrated as shipped, then looks at 13
targets with the head moved by a fixed amount, gate off. The table is the median over people of
the fixation RMS error divided by that person's own error in the calibration posture, for the
worse of the two directions. "Doubles at" is where that ratio reaches 2 (interpolated).

Head-frame model in use (E for 20 of 20); 29.4 px in the calibration posture:

| Movement | Ratio at each size | Doubles at |
|---|---|---|
| sideways, cm | 1: 1.05, 2: 1.08, 3: 1.21, 4: 1.28, 6: 1.56, 8: 1.86, 12: 2.35 | 9.2 cm |
| up or down, cm | 1: 1.11, 2: 1.29, 3: 1.56, 4: 1.87, 6: 2.34, 8: 2.92 | 4.6 cm |
| back or forward, cm | 2: 1.07, 4: 1.08, 6: 1.25, 8: 1.41, 12: 1.73, 16: 2.33 | 13.8 cm |
| yaw, degrees | 2: 1.11, 4: 1.31, 6: 1.54, 8: 1.80, 10: 2.38, 15: 5.83, 20: 15.26 | 8.7 |
| pitch, degrees | 2: 1.28, 4: 1.76, 6: 2.55, 8: 3.76, 10: 5.86, 15: 14.13, 20: 17.44 | 4.6 |
| roll, degrees | 2: 1.04, 4: 1.08, 6: 1.17, 8: 1.30, 10: 1.59, 15: 1.75, 20: 2.11 | 18.5 |

Model A forced; 37.9 px in the calibration posture:

| Movement | Ratio at each size | Doubles at |
|---|---|---|
| sideways, cm | 1: 1.76, 2: 2.68, 3: 3.99, 4: 5.08, 6: 7.35, 8: 9.87, 12: 14.24 | 1.3 cm |
| up or down, cm | 1: 1.96, 2: 2.67, 3: 3.67, 4: 4.66, 6: 6.94, 8: 9.23 | 1.1 cm |
| back or forward, cm | 2: 1.25, 4: 1.49, 6: 2.12, 8: 2.78, 12: 4.22, 16: 6.27 | 5.6 cm |
| yaw, degrees | 2: 3.15, 4: 5.47, 6: 8.45, 8: 10.71, 10: 13.72, 15: 20.69, 20: 26.58 | 0.9 |
| pitch, degrees | 2: 3.03, 4: 5.35, 6: 7.42, 8: 9.69, 10: 12.28, 15: 16.94, 20: 20.55 | 1.0 |
| roll, degrees | 2: 1.41, 4: 2.07, 6: 2.71, 8: 3.38, 10: 4.16, 15: 5.84, 20: 7.76 | 3.8 |

The limits in use (`HEAD_GATE` in `gaze-core.js`): the doubling point, capped at 8 degrees, 8 cm
sideways and 12 cm of depth.

| Model in use | Yaw | Pitch | Roll | Sideways | Up or down | Depth | Without a head pose: picture, eye distance |
|---|---|---|---|---|---|---|---|
| head-frame (B, C, E) | 8 | 4.6 | 8 | 8 cm | 4.6 cm | 12 cm | 0.08, 15 % |
| A | 0.9 | 1.0 | 3.8 | 1.3 cm | 1.1 cm | 5.6 cm | 0.02, 10 % |

Inside the gate a head-frame model compensates (its error grows as in the first table). Outside,
after 600 ms, tracking pauses with the existing "Move back to where you sat" message. The gate
measures against the mean head pose over the still dots, stored as `calibHead` with the
calibration. A camera that gives no head pose falls back to the picture limits in the last
column, which cannot see rotation.

Model A's limits are very tight because model A is that sensitive. With them, model A sitting
still is never paused in the benchmark (0 % of STILL gated), but it is paused for a 3 cm lean, a
2 cm slouch, any 5 degree turn and for a quarter of the frames after a slow 2 cm drift. Whether
a real head pose is steady enough for a 1 degree limit is not known; see "Not measured".

Also in 3d, tested in `tests/gaze.mjs` with the simulated camera:
- A saved calibration is put back in use only when the head, over the first second of camera
  frames, is inside the gate of the stored `calibHead` (`headWithinGate`). Otherwise the
  tracker asks for a calibration. `debugDump().restoreCheck` says what it saw. This adds one
  second to every start with a saved calibration.
- A window that was resized, or moved on the screen (checked once a second, since moving fires no
  event), puts the tracker in a new status, `paused`: no gaze, no fixations, no struggle events on
  the old mapping. Back at the calibrated size and place it resumes on its own. `content.js` got
  one line for the new status ("Paused. The window changed, so recalibrate to go on").

### 3e. Blink rule: kept

Before: a frame was a blink when either eye's blink score was over 0.45 or the lids were nearly
shut. Now `BlinkDetector` decides, in the reader (the camera frame sends the two blink scores and
the lid opening as `lids`): both eyes' scores at least 0.25 above their median over the last 45
frames and over 0.45, or the lid opening under half its recent median, or the lids closing faster
than 2.5 eye widths a second; eyes held shut are always a blink; two frames after a blink are left
out too. In calibration, where the frames are looked at afterwards, two frames before a blink go
as well. Live tracking cannot take frames back, so there it is two frames after only.

The opening threshold adapts to the last 1.5 s of the person's own lids, not to a range stored at
calibration: the same code then works during the calibration itself, which is where the fixed
rule did its damage.

| Synthetic person | Blink rule | S_still / S_move | Calibrations failed | Bottom-row frames lost | Other rows |
|---|---|---|---|---|---|
| standard | fixed | 29.8 / 39.0 | 0 | 4 % | 4 % |
| standard | detector | 29.7 / 39.1 | 0 | 6 % | 6 % |
| lids follow the eyes down (`blinkDownK=0.55`) | fixed | 30.4 / 38.7 (3 people) | 17 of 20 | 82 % | 6 % |
| lids follow the eyes down | detector | 29.0 / 38.3 | 0 | 6 % | 6 % |

No accuracy change for the standard person, at the cost of 2 % more frames left out. For a person
whose blink score rises when looking down, the fixed rule lost the bottom of the screen and most
calibrations. How common such people are on a real camera is not known; the synthetic coupling is
an assumption.

### 3f. Click gate: kept. Drift: skipped

`--clicks`: after the calibration the synthetic person clicks 12 times at random places; for 60 %
of the clicks the eyes are on the click, otherwise somewhere else (assumed). Frame-level RMS error
on 13 targets afterwards, median of 20 people:

| Clicks used | Error px |
|---|---|
| none | 44.1 |
| every click (before) | 71.6 |
| only clicks the gate lets through (now) | 44.0 |

The gate let through 76 % of the clicks with the eyes on them and none of the others. Note what
the first and last rows say together: in this benchmark good clicks do not improve the model at
all. The gate removes the damage; click refinement itself shows no gain here.

A click sample now also leaves the model after 60 s, and clicks on Glider's own controls (the
dock, the camera widget) are never used.

Not built: applying the line decoder's learned vertical drift to paragraph picking and to the
emitted gaze, and a horizontal drift model. The benchmark stops at fixations and has no reading
condition, so neither could be measured, and an unmeasured feedback loop was not worth the risk.

### Not on the list: the fixation detector's limit

`tests/gaze.mjs` failed its reading-pace check on the first run of step 3 (460 words a minute
measured against 360 simulated). That is the weakness step 1 wrote up: the detector compares the
x range plus the y range of a window with a limit that was 2.2 x the larger of the two scatters,
so at ordinary noise it kept breaking fixations up. The limit is now 2.5 x the sum of the two
scatters (still within 60 to 220 px).

| Limit | STILL at 0.5 px | In a fixation | S_still / S_move |
|---|---|---|---|
| 2.2 x the larger scatter (before) | 35.1 | 60 % | 35.1 / 43.2 |
| 2.5 x (across + down) (now) | 29.7 | 89 % | 29.7 / 39.1 |

In `tests/gaze.mjs` the measured reading pace is now within 2 % of the simulated one (three runs:
1 %, 0 %, 2 %), and line decoding went from 96 % to 99 %. The risk that the benchmark cannot see:
a wider limit merges neighbouring reading fixations. The benchmark's person holds one target for
2.5 s and never reads.

### What else changed in step 3

- `fitCalibration` returns `extra` (rows collected but not used by the model in use: the head
  segment when model A is in use), `calibHead` with the head pose, `procedure` when it came from a
  `CalibrationRun`, and `accuracy.source` (`val` or `lodo`) and `accuracy.dots`.
- `Ridge.fit` keeps the per-dot leave-one-dot-out errors as `cvDots` (not saved with the model).
- `debugDump()` adds `calibration` (every dot with its untrimmed frames), `trainExtra`,
  `headGate`, `restoreCheck`, `clickStats`.
- The camera frame sends `lids` with every frame, and the lab bridge records it.
- `tests/lab/lib/analysis.mjs` uses the tracker's own head gate in its replay (it had the old
  limits written out).
- The benchmark's standard run is now the calibration procedure. `--cal still` and `--cal move`
  are the fixed loop of steps 1 and 2. New: `--proc`, `--who`, `--fit`, `--gate-sweep`, `--clicks`;
  the frame-loop switches `blinks=flag`, `gate=false`, `dispersion=step2` under `--proc`; the
  "other models and calibrations" table is about the procedure; a column for the bottom-row
  blink share is in the JSON (`share.blinkBottom`).
- The fixed loop with `--fit fold=true,score=val` still fits exactly the models and accuracies
  saved in `after-step2.json` (checked in `bench.test.mjs`). Its tracking scores differ from
  step 2 because the fixation limit and the head gate changed.

Test expectations changed on purpose:
- `tests/gaze-core.test.js`: the default calibration trains on 13 dots and reports the accuracy
  from the 5 validation dots (the old checks now run with `fold: true`); five thin validation
  dots give the "several dots" message; `trackingParams` dispersion; `headMoved` limits.
- `tests/bench/bench.test.mjs`: the "not gated" lean is 1 cm (3 cm is outside model A's gate);
  the 5 degree yaw comparison runs with the gate off; six variants with new names; the trim check
  looks at trained dots only.
- `tests/gaze.mjs`: the calibration is 18 dots, up to 3 shown again and 3 head-segment dots (it
  checked for exactly 18); a click only counts when the simulated eyes rest on it. Ten new checks
  (36 in all).
- `tests/gaze-site/fake-frame.html`: `window.__fakeHeadDx` on the page moves the simulated head.

### Not measured in step 3

- Anything on a real camera, as before.
- What people do in the head segment. The benchmark assumes they keep their eyes on the dot and
  turn the head about 5 degrees. If they do not move, the choice falls back to step 2's coin toss
  (model E for 13 of 20). If they look at the text instead of the dot, those frames are wrong for
  every model; not simulated.
- Whether the face matrix means what model E takes it to mean (step 2's open question). If it
  does not, most people get model A, and model A now pauses at 1 degree or 1.3 cm. In the morning,
  `GazeReader.debugDump()` on the lab page says which model was chosen and why (`modelKind`,
  `shootout.note`) and what the gate is (`headGate`).
- How steady a real head pose is. The gate reads yaw, pitch, roll and position from the face
  matrix on every frame. The synthetic matrix has 0.3 degrees and 0.08 to 0.5 cm of noise
  (assumed). With more noise than that, model A's 1 degree limit would pause tracking while the
  reader sits still. The head-frame limits (4.6 to 8 degrees) have room.
- The "eyes have stopped" test on real camera noise. It scales with the noise it measures and has
  a 1.5 s cap, so it cannot hang a calibration, but how often it waits on a real camera is unknown.
- `BlinkDetector` on real blink scores: how high they go on a look down, and whether a real blink
  always raises both.
- The head-frame models, the pose gate and the blink detector in a browser. The browser tests use
  a camera that sends 44 numbers, no head pose and no lids, so they exercise the procedure, the
  fallback to model A, the picture-based gate, the saved-calibration check, `paused` and the click
  gate. The rest runs in node only.
- `screenX` and `screenY` when a real Chrome window is moved: the run-time check was only driven
  by resizing in the headless browser.
- Line decoding and struggle detection with the wider fixation limit, beyond `tests/gaze.mjs`.
- Other tests that load the gaze modules (`tests/adapt.mjs`, `tests/simplify.mjs`,
  `tests/e2e.mjs`, `tests/live.mjs`, `tests/assessment-live.mjs`, showcase scripts) were not run,
  as in steps 1 and 2; some may reach a paid service. `glider-extension/assessment/flow.js` reads
  the tracker status right after a start, where `paused` cannot occur.

## Step 4: what the owner sees (2026-11-20, step 4 of 4)

No change to the regression, the features or the calibration maths. The benchmark gives the same
numbers as after step 3 for every synthetic person:

```
node tests/bench/gaze-bench.mjs --compare --json tests/bench/after-step4.json
```

`--compare` now also compares against `after-step3.json` (S_still 29.70 -> 29.70, S_move 39.11 ->
39.11, better on 0 and worse on 0 of 20 seeds).

### 4a. The check after the fit, and the card

After the fit the reader shows five more dots (`CHECK_POINTS` in `gaze-core.js`: places no
calibration, validation or head-segment dot uses), 0.9 s for the eyes to arrive and 1.2 s that
count. The model in use runs on every frame of those 1.2 s. `validationResult` turns that into:

- `errPx`: the median distance between the model's output and the dot, over all frames ("typical
  error"), and `errDeg` = `errPx` / 52 (a 14 inch screen at 60 cm, assumed; the card says
  "approximately" and "approximate");
- `effX`, `effY`: the per-fixation error, computed as the calibration computes its own;
- the grade, by the rule the old card used (`accuracyGrade`): **good** when `effY` is under half a
  32 px line (16 px), **fair** up to a band of five lines, **poor** beyond;
- for a poor grade, advice chosen from what the camera saw during the calibration
  (`calibrationHealth`, `trackingAdvice`): under 20 pictures a second, a small face, a face near
  the edge, the face lost in over 10 % of the pictures, over 25 % thrown away as blinks, a head
  that moved during the eye dots.

The accuracy object keeps every field it had and gains `validation`; the `accuracy` event carries
it. The tracker's own noise figures (`sx`, `sy`, the fixation limit) still come from the
calibration's validation dots, as in step 3: the check decides what the card says, not how the
tracker runs.

The check has fixed windows; it does not wait for the eyes as the calibration does. Frames before
the eyes arrive are left out (`arrivalTrim`). Without that, a person who reaches 30 % of the check
dots late got a card 1.44 times too pessimistic; with it, 1.03.

**The card against the truth (synthetic).** `node tests/bench/check-card.mjs`: 60 synthetic people
calibrate, do the check as the reader runs it, then the benchmark's 13-target STILL block, whose
fixation error is taken as the truth.

| Iris noise (synthetic) | Vertical error: card / calibration's own / measured, px | Card / measured, per person (median, 10th to 90th percentile) | Card more than 30 % off | Grade on the card | Grade of the measured error | Grades agree |
|---|---|---|---|---|---|---|
| 0.2 px | 13.5 / 14.0 / 14.2 | x0.95, x0.68 to x1.33 | 25 of 60 | good 43, fair 17 | good 41, fair 19 | 42 of 60 |
| 0.5 px | 19.0 / 20.0 / 18.3 | x1.00, x0.77 to x1.46 | 16 of 60 | good 9, fair 51 | good 17, fair 43 | 44 of 60 |
| 0.8 px | 26.0 / 26.0 / 24.3 | x1.07, x0.88 to x1.43 | 15 of 60 | fair 60 | fair 60 | 60 of 60 |
| 0.5 px, 30 % of check dots reached late | 20.0 / 20.0 / 18.8 | x1.03, x0.81 to x1.46 | 19 of 60 | good 6, fair 54 | good 12, fair 48 | 44 of 60 |

Read it this way: on the median the card is right; for one person in four it is more than 30 %
off, because five dots of 1.2 s are a small sample. At 0.5 px noise it says "good" for 4 people
whose measured error is "fair", and "fair" for 12 whose measured error is "good". Every "fair" was a
band of 3 lines. No synthetic person got "poor". The calibration's own figure is off by more than
30 % slightly more often (20 of 60 at 0.5 px).

### 4b. Show tracking

- The `gazeTrace` setting drives only the heat trace. `content.js` calls `setTrace` at start and on
  every change (checked; no edit needed). `traceLog` is the console log and nothing else.
- The trace is drawn from the raw estimate through its own filter (OneEuro, 1.5 Hz at rest, against
  0.6 Hz for the smooth gaze), less the vertical offset the line decoder has learned. After a jump
  of 60 px (two words) with 17 px of frame noise the smooth gaze is 73 % of the way there at 100 ms
  and 84 % at 150 ms; the trace filter is at 93 % and 99 % (computed in `tests/gaze-core.test.js`).
  A jump of 300 px opens both filters at once. The trace shakes more at rest: 10 px against 7 px
  for 20 px of frame noise.
- The overlay is painted only while the trace or the debug overlay is on and no calibration is
  running. The canvas and its host have `pointer-events: none`; a point under the heat still hits
  the page text (tested).
- `setTrace(true)` before the tracker runs is kept, and the heat appears once it tracks (tested).

### 4c. First run

- **Permission.** `permission.js` writes the time into `grCameraGranted`; `gaze-reader.js` listens
  for that storage change and starts again when it is waiting for the camera. `start()` after
  "needs-permission" or "error" now really starts again (the old promise was returned forever).
- **Distinct messages.** Camera in use, no camera, camera blocked, camera not yet allowed, and a
  loading failure with its reason ("Eye tracking could not load (reason)") each have their own
  text; errors carry a Retry button. `getState().error` has `{code, short, text, detail}` and the
  dock's status line shows `short`.
- **No hanging on "starting".** `frame.js` gives the camera and the face model 20 s each and reports
  which one did not answer. The reader has its own 25 s clock for a frame that never answers at
  all; every stage report restarts it.
- **GPU or CPU.** The face model starts on the GPU. If one picture takes more than 100 ms on
  average over pictures 6 to 30, a CPU model is made once, timed the same way, and the faster one is
  kept. `getState().camera` and the `camera` event report `{width, height, delegate, fps, modelFps,
  warnings}`; the calibration's first card shows it in its small line.
- **Quality gate.** Warnings for under 20 pictures a second ("more light helps"), a face under 17 %
  of the picture width, and a face near the edge. They show on the camera widget's label and on
  the calibration's first card, never as a pop-up over text being read.
- **Defaults.** `gazeTrace` off, Adaptive off until switched on, `opts.model` 'auto'. The popup
  still says "Adaptive"; the options page has no eye-tracking text.

### 4d. The camera path, run for real

`node tests/gaze-camera-smoke.mjs` (about 80 s, one headless Edge with the unpacked extension and
the browser's fake camera playing one public-domain portrait, fetched at run time and deleted
afterwards). 14 checks, all pass on this machine:

- the extension loads; the dock's Adaptive switch starts the tracker;
- "camera not allowed yet" (played by making the camera call fail): status needs-permission with
  the message; then the real permission page, a click on its button, and the tracker starts by
  itself on the page that was waiting;
- the camera reports 1280 x 720; the face model and the wasm come from the extension's own files;
- frames arrive with a face and 63 finite numbers; frame times come from the camera's capture time
  (`timeSource: 'capture'`); GPU delegate, 151 to 161 model runs a second on this PC;
- the calibration runs to its end: "Tracking is poor" on the photo, which is the right answer for
  eyes that never move;
- MediaPipe's logger tries to send once and is refused; zero requests leave the extension;
- switching Adaptive off ends the camera track and removes the frame;
- a GPU slowed to 7 runs a second (played): the CPU is tried (94 a second here) and kept;
- no console errors (MediaPipe's own "INFO: Created TensorFlow Lite XNNPACK delegate for CPU."
  lines on stderr are not counted).

What this does not show: anything about accuracy, a real permission prompt, a real camera's frame
rate, or a moving head.

### 4e. Lab

- A calibrate recording keeps one `caldot` truth entry per calibration dot; the five check dots
  are also `target` entries (phase `check`), so the benchmark and the analyzer score them.
- Every recording has `session: { id, calibratedAt }`, taken from the calibration itself
  (`debugDump().calibratedAt`), so one sitting's recordings share an id across page reloads.
- `?landmarks=1` on the lab page (off by default) adds 24 face landmarks to every raw frame, about
  0.6 KB a frame.
- "Run the benchmark session": camera 15 s, calibrate, validate, read along at 64 px and 32 px line
  spacing, four head positions, validate again. Tried in the lab's fake mode by
  `node tests/lab/session-smoke.mjs` (7 checks), which saves into a temp folder.
- `node tests/bench/gaze-bench.mjs --recordings DIR` reads another folder for the REAL rows, and
  `--real-only` prints them alone. `tests/bench/bench.test.mjs` copies lab fixtures into a temp
  folder and checks that the rows fill (validate, the four headshift phases, the check dots of a
  calibrate recording) and that nothing is written into `tests/lab/recordings`.

### Tests changed on purpose in step 4

- `tests/gaze.mjs`: 45 checks, was 36. The calibration's dot count leaves out the five check dots
  and counts them on their own. The old card check ("line by line" under 16 px) became a check of
  the new card. The trace check now has the eyes on a line of text and `traceLog` off, so that it
  can show that the heat trace prints nothing; `traceLog: true` alone is checked after it. New:
  the five start failures and their messages, Retry, the start timeout, the permission flag, the
  camera status.
- `tests/gaze-site/fake-frame.html` can play the start failures and sends a `camera` message;
  `tests/gaze-site/harness.html` has storage change events.
- `tests/gaze-core.test.js`: one new block (check points, grade, result, arrival trim, trace filter,
  quality gate, health, advice).
- `tests/cdp.mjs`: `launch({ extraArgs })`; `send(method, params, sessionId)` for targets attached
  through the browser connection.

### Not measured in step 4

- Everything under "Could NOT be measured" at the top.
- The reader's check loop itself is not in the benchmark. `check-card.mjs` repeats its timing
  (0.9 s + 1.2 s per dot) around the same `validationResult`; the browser tests run the real loop
  on the fake camera (five dots, 18 frames each at the test's shortened timing).
- The 20 s timeouts of `frame.js` were not waited out. The reader's own timeout is tested at 0.7 s.
- "Camera in use" and "no camera" are tested as messages from a fake camera frame. The real
  browser errors they are mapped from (`NotReadableError`, `NotFoundError`) were not produced.
- The landmark stream (`?landmarks=1`) was not recorded from a real frame; the lab's fake mode does
  not produce it.

## How to read the rows

| Label | Where the camera frames come from | How far to trust it |
|---|---|---|
| SYNTH-3D | `tests/bench/synth3d.mjs`: a rigid head (MediaPipe's canonical face model), two 1.2 cm eyeballs turned to the target, lids coupled to vertical gaze, blinks, a pinhole camera (1280x720, 70 degrees) at the top centre of the screen. Landmarks are projected and go through the real `extractFeatures`. | Geometry is real, so head movement costs what geometry says. Noise is assumed. |
| SYNTH-FEATURE | `tests/lab/lib/synth.mjs` `World`: writes the 44 features directly from formulas (no landmarks, so none of the numbers added in step 2 and always model A). Also the recorded fixtures in `tests/lab/fixtures`. | An independent second opinion with a different noise model. It agrees with SYNTH-3D on the size of the head-shift problem. |
| REAL | Any recording in `tests/lab/recordings` that has targets, replayed through the model that was live when it was recorded. | The only rows that say anything about a real camera. There are none yet. |

Conditions, each on 13 held-out targets (3x3 at 10 / 50 / 90 % plus four inner points at 30 / 70 %),
700 ms settle and 1800 ms dwell per target, as the lab's `validate` task:

- STILL: the posture of the calibration, with ordinary small head wander.
- HEAD-SHIFT: three runs pooled: 3 cm sideways, 5 cm back, 2 cm down (slouch).
- HEAD-ROTATE: two runs pooled: 5 degrees yaw, 5 degrees pitch, eyes still on the target.
- LATER: five minutes after calibration, the head having drifted 2 cm in a straight line.
- LOW-FPS: a 15 fps camera for calibration and test.

The frame loop is the reader's: a lost face and blink frames are skipped, the head-moved pause is
applied (`headMoved`, 600 ms), predictions come from the fitted `Ridge`, fixations from
`FixationDetector` with the dispersion the calibration sets (`trackingParams`). A fixation counts
for a target when it lies wholly inside that target's window.

## Assumptions that set the numbers

The benchmark is only as good as these. They are options of `Person3D` (`DEFAULTS3D` in
`tests/bench/synth3d.mjs`); `--set name=number` changes one to see what it costs.

| Assumption | Value | Why it matters |
|---|---|---|
| Iris landmark noise | 0.2 / 0.5 / 0.8 px SD, lag-1 correlation 0.5, 30 % shared between the eyes | One degree of eye rotation moves the iris 0.32 px in this camera, so this is the main noise source. Not measured on a real camera. |
| Corner and lid landmark noise | 0.5x and 0.8x the iris noise | Assumed. |
| Eye-look blendshapes | A clean function of the true eye angle plus noise of 0.02 | Probably too kind: MediaPipe derives them from the same image and they share its errors. `--features 17` (no blendshapes) shows how much the model leans on them. |
| Head wander while "still" | 0.15 cm and 0.3 degrees SD, 20 s time constant | The largest single part of S_still (below). |
| Fixation error of the person | 0.2 degrees SD per target | People do not land exactly on a dot. Sets a floor of about 15 px. |
| Head follows the eyes | 5 % of the way | Small effect. |
| Blinks | every 5 s on average, 190 to 340 ms | About 4 % of frames. |
| Seat | eyes about 60 cm away and 5 cm below the camera axis, face tipped back about 10 degrees as the camera sees it | Puts the eyes 10 to 22 degrees down in the head over the screen. |
| Screen | 14 inch, 1536x864 CSS px, viewport 1536x730 | Fixes px per cm and px per degree. |

What S_still (fixation RMS, 0.5 px noise, STILL) is made of, by switching assumptions off:

| Run | Fixation RMS px |
|---|---|
| Standard | 42.0 |
| `--set headWanderDeg=0` | 32.5 |
| `--set headWanderDeg=0 --set headWanderCm=0` | 30.9 |
| the same and `--set lookErrDeg=0` | 25.2 |
| `--set headFollow=0` alone | 40.7 |
| `--set blinkEveryMs=0` alone | 40.6 |

(each: `node tests/bench/gaze-bench.mjs --noise 0.5 --set ...`, 20 seeds). So about a quarter of
S_still is the assumed 0.3 degree head wander passing straight through a model that cannot see the
head, and about 25 px is what is left when the person is perfectly still and perfectly on target.

## What step 1 changed

Refactor, no change in behaviour:

- `fitCalibration(points, opts)` in `gaze-core.js` now holds the two-pass ridge fit, `trimTrain`
  and `accuracyFrom`; `gaze-reader.js`, `tests/lab/lib/synth.mjs` and this benchmark all call it.
  `tests/gaze-core.test.js` checks it gives the same model, accuracy and training rows as the old
  steps written out by hand. Also moved to `gaze-core.js`: the calibration dot positions
  (`CAL_POINTS`, `VAL_POINTS`), `trackingParams` (was `applyAccuracy`'s arithmetic) and `headMoved`
  (the gate's test).
- `tests/lab/lib/synth.mjs` used to be a hand port that had drifted from the tracker: 44 features,
  no trimming, 6 independent frames per fixation. It now runs the shipped calibration, so the
  fixtures were regenerated and their numbers changed.
- `tests/lab/lib/analysis.mjs`: the model table no longer needs raw frames to be exactly as wide as
  the training rows (the tracker stores 25-number rows, the camera sends 44, so on a real recording
  the table would have been empty). Its trimming is the tracker's own.

Bug fixes (none touch the regression, the features, the dots or the head gate):

1. `trace` was declared twice in the reader's options. `trace` is the heat trace, `traceLog` is the
   console log.
2. The overlay canvas was reallocated on every frame when `devicePixelRatio` is fractional.
3. The render loop now stops when there is nothing to draw and restarts on demand.
4. `OneEuro` ignores samples under 5 ms apart (it used to turn them into a speed spike); the gaze
   filters reset when tracking resumes after the head-moved pause.
5. A restored calibration starts with no learned vertical offset.
6. The camera frame stamps each message with the capture time and reports GPU or CPU; the reader
   uses the capture time.
7. Not on the list, found by the new test: the heat trace added heat for the time since the last
   repaint, not since the last camera frame, so it got fainter the faster the screen refreshed.
   It now uses the time between camera frames, scaled so that a 60 Hz screen looks as before.

None of these can move a benchmark number, and none was tried on a real camera or a real screen:
the benchmark does not run the filters, the overlay or the camera frame. `tests/gaze-core.test.js`
covers 4 (the filter); `tests/gaze.mjs` covers 1, 2, 3, 5, 7 and the reader's half of 6 with a
simulated camera. The camera-frame half of 6 (`frame.js` reading the capture time from
`requestVideoFrameCallback`) has no test: it needs a real camera. It falls back to the old timing
when the browser gives no believable capture time.

## Seen on the way, not fixed in step 1

- The reading-pace measurement is fragile when the fixation dispersion limit is tight. The limit is
  2.2 x the larger scatter from calibration (floor 60 px), tested against the sum of the x and y
  ranges. In `tests/gaze.mjs`, a calibration that happened to report 28 px of scatter (limit 62 px)
  lost about a quarter of the reading time on the baseline passage (few fixations lasted the
  120 ms minimum, and gaps over 1.2 s are not credited), so the pace came out at 481 and 517 words
  a minute against a simulated 360. A calibration reporting 33 to 36 px (limit 73 to 79 px)
  measured within 7 % every time. This showed up only while new checks at the start of that test
  shifted which simulated camera frames the calibration saw; they were moved to the end and the
  test is stable again (26 of 26, three runs in a row). The weakness is in the tracker, not in the
  test: the benchmark's "in fix" column shows the same thing, only 64 % of the time ends up inside
  a fixation at 0.5 px noise.
  (Changed in step 3: the limit is now 2.5 x the scatter of both axes together, and 89 % of the
  time ends up inside a fixation. See "Not on the list" in the step 3 section.)
- The "you moved" pause does not fire for any movement in this benchmark (3 cm, 5 cm, 5 degrees).
  (Changed in step 3: the head gate has limits read from a sweep, by model. See 3d.)
- The tracker stores 25-number training rows, so the lab's model table cannot refit the head-pose
  variants from a real dump. A later step that wants pose features needs wider rows in the dump.
  (Done in step 2: the rows are the camera's whole vector.)

## Could not be measured

Nobody sat in front of a camera. These are unknown, and no synthetic run can settle them:

- Real eyes. Accuracy in px or degrees on a person; differences between people; whether the
  synthetic eyeball (a sphere, fixed kappa, lids that follow linearly) behaves like an eye.
- Real camera noise. The size, the colour and the frame-to-frame memory of MediaPipe's iris, corner
  and lid errors on a laptop webcam; how they grow in dim light; whether 0.2, 0.5 or 0.8 px is the
  right neighbourhood at all. The lab's `camera` task measures this in 15 seconds.
- Glasses. Reflections, frames across the eye, lens distortion of the iris position.
- Lighting. Backlight, a dim room, a screen as the only light, shadows from the brow.
- How MediaPipe's landmarks and blendshapes really respond to gaze, for example how much of the
  vertical signal survives when the lid covers the iris. The synthetic camera reports the true
  geometry plus noise.
- Real head movement: how much people move while reading, and what the face matrix reports when
  they do. Since step 2 this matters more: model E trusts the matrix (its convention, its units,
  its noise), and none of that has been seen on a camera.
- The real frame rate and its jitter, the GPU or CPU delegate in use, and whether the new capture
  timestamps are sane on this laptop (`debugDump()` now reports `delegate` and `timeSource`).
- Line decoding and struggle detection on real reading. This benchmark stops at fixations.

First real measurement, about three minutes: `node tests/lab/server.mjs`, open the lab page, run
`camera`, `calibrate`, `validate`, `headshift`. In the dump, `modelKind` and `shootout` say which
model the calibration chose and why; the model table of `analyze.mjs` shows A, B, C and E on the
same recording, `headshift` phases included. Then `node tests/bench/gaze-bench.mjs` prints REAL
rows next to the synthetic ones, and `node tests/lab/analyze.mjs latest` gives the detail.
