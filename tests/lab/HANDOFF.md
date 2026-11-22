# Handoff: eye-tracking accuracy work, continued on the owner's laptop

**Update, night of 2026-11-20.** The tracker was reworked overnight without a camera (four steps: benchmark, head-aware model, calibration procedure, what the owner sees). Read `tests/bench/RESULTS.md`, section "Read this first", before anything below: it has the synthetic before-and-after numbers, the list of what could not be measured, and the morning steps. The fastest first real measurement is now the lab's "Run the benchmark session" button (about 6 minutes, seven recordings), then `node tests/bench/gaze-bench.mjs --real-only`. The round plan below is older; its tasks are the same ones the session runs.

Written 2026-11-13 by the Claude Code session that built the eye tracking on the owner's desktop PC. You are a new session on the owner's laptop. The owner sits at this laptop, so this machine has the webcam and the screen that matter. Other sessions (dock UI, motion, Reading Check) stay on the PC and are no longer reachable from here; sync with them only through git.

## What the owner wants

Make the webcam eye tracking as accurate and as honest as it can be, by measuring it on the owner's real eyes: "I am your test dummy, you give me directions, we test in real time." Hard deadline: about 5 hours from 13:00 on 2026-11-13. Work in short rounds: one instruction, one 15 to 60 second task, analyse, change, repeat.

## Start here

```bash
node tests/lab/server.mjs            # leave running in the background; serves http://127.0.0.1:8377/
```

1. Owner: `chrome://extensions`, Developer mode, Load unpacked on `glider-extension/` (or reload it), then open `http://127.0.0.1:8377/`. Chrome needs the extension's one-time camera permission (a button opens `gaze/permission.html`).
2. You direct the owner by overwriting `tests/lab/instruction.json`; the lab page polls it every 2 s and shows `text` in its coach panel. Bump `seq` every time. Shape: `{ "seq": 2, "text": "...", "task": "validate", "params": {}, "autostart": false }`.
3. Each task saves `tests/lab/recordings/<stamp>-<task>.json` (git-ignored: eye-feature data, never commit or upload it). To be woken when one lands, run a background command that exits when a new file appears in that folder.
4. Analyse: `node tests/lab/analyze.mjs latest` (also `--compare A B`, `--cal <file with dump>`). `tests/lab/README.md` documents the page, tasks, recording format and bridge.

The lab has passed a smoke test with a fake bridge only. It has never met the real extension bridge or a real camera, and the analyzer has only seen synthetic recordings. Expect small first-contact bugs; check the analyzer's numbers by hand on the first real recording.

## Round plan

1. `camera`: resolution, frame rate, face-lost and blink share, real feature noise and its autocorrelation.
2. `calibrate` (dots only), then `validate` (13 targets): true error in px and degrees against what the tracker claims; the model shoot-out table.
3. `headshift`: cost of leaning 3 cm, leaning back, slouching.
4. `lines-paced` at pitch 96, 64, 48, 32: line-decoding accuracy against spacing; then `lines-self` and `stall`.
5. Change the tracker according to the data (list below), reload the extension, repeat `calibrate` + `validate` + one reading task, and compare with `--compare`.

## How the tracker works

`glider-extension/gaze/`: `frame.js` runs MediaPipe Face Landmarker in an extension-origin iframe and posts a 63-number feature vector per frame (since step 2 of the 2026-11-20 accuracy work; 44-62 are listed at `F` in `gaze-core.js`: iris from five points, iris against rigid points, a pose flag, head yaw/pitch/roll and position in fixed units, head-frame iris offsets) (indices 0-16 eye features, 17-24 eye-look blendshapes, 25-40 the raw 4x4 face matrix, 41-43 head centre and scale). `gaze-core.js` (pure, require()-able): `extractFeatures`, `Ridge`, `FixationDetector`, `LineHMM`, `summarizeBaseline`, `tauFromCv`, `struggleDecision`. `gaze-reader.js`: 13 + 5 dot calibration, a reading-pace passage that sets baseline pace and a personal threshold tau, fixation -> paragraph -> line decoding, struggle detection, UI in a closed shadow root. `gaze-lab.js`: the lab bridge, active only on 127.0.0.1/localhost pages with `<meta name="glider-lab">`; it turns click refinement off. `content/content.js` owns enablement (settings key `gaze` in `glider:settings:v2`) and reacts to struggles.

## What six independent audits found (all simulated or from the literature; nothing measured on a real camera yet)

1. Limits. Browser webcam trackers reach about 1.5 to 4 degrees in good conditions; 1 degree is about 65 px on a 14 inch 1080p laptop at 60 cm; a text line is 28 to 36 px. Single-line tracking of normal web text is not achievable. Realistic: a band of 3 to 5 lines, or single lines only with greatly enlarged spacing.
2. Our test numbers (about 18 x 13 px error, 100% line accuracy) come from a fake camera that is linear, noise-independent, head-fixed and uses 60 px line pitch. Made realistic, the same code gives roughly 50 to 75% line accuracy and 1.5 to 4 false alarms a minute.
3. Head-pose features hurt. The raw matrix entries and head centre/scale barely vary during a keep-still calibration and are z-scored by that tiny variance, so a 2 to 3 cm shift multiplies error by 2 to 5; the "you moved" gate allows about 5 cm and ignores rotation. Two candidate fixes that are alternatives, not a pair: (a) drop indices 25-43 from the regression, or (b) keep a compact pose (yaw, pitch, roll, normalised translation) and have the user move their head during calibration. The analyzer's model table decides on real data.
4. Calibration: no outlier rejection (per-dot MAD trimming helped in simulation); a dot with zero frames is accepted silently; the five-point accuracy figure on the "Calibration done" card is unreliable (leave-one-dot-out over all 18 dots tracks truth better); restoring a 3-hour-old calibration on window geometry alone is unsafe; click refinement can degrade the model when the eyes are elsewhere; a moving-target calibration roughly halved error in one simulation.
5. Line decoding: the shipped HMM stays above 85% only while vertical error / line pitch is 0.5 or less (56% at 1.0). A decoder over (line, progress along the line) with reader pace, page-wide decoding and a strong first-line prior moves that to about 0.75 (about 1.2 with a known start line). It is ported in `tests/lab/lib/replay.mjs`. Known defect: the early returns in `onFixation` skip the `prevFixEnd` update, so a glance away is billed to the next line.
6. Struggle rules fail even with perfect gaze: expected time counts words and is anchored on an easy 3.9-letters-per-word passage (a dyslexic reader on academic text: about 17 false alarms per 40 lines); pace learning excludes paragraphs that triggered; one 79-word baseline read is too short; tau does not give a constant false-alarm rate. Proposed: milliseconds per character, learn from every line, a cumulative (CUSUM) rule on log dwell ratios, default at most one alarm per 40 lines.

## Already changed on the audits' advice, just before handoff (simulated-camera suite 19/19 and full-stack 15/15 afterwards; no real-eye data yet)

All in `gaze-reader.js`:
- Model A, the regression that has always shipped, trains on features 0-24 only (`opts.featureCount`): eyes and eye-look blendshapes, no raw head matrix or head position. Since step 2 the calibration also fits head-frame models (B, C, E: a geometric head-pose correction plus a ridge on head-frame inputs) and uses one only when it beats A's leave-one-dot-out error by 5 % (`opts.model`, `debugDump().modelKind` and `.shootout`; numbers in `tests/bench/RESULTS.md`, all synthetic). This is fix 3a; the lab's model table can still show 3b is better, in which case revisit.
- Per-dot outlier trimming of calibration frames (`trimTrain`, 2.5 scaled MAD per axis, one refit); calibration fails with a clear message when more than two dots have under 8 frames.
- Reported error assumes about 2.5 independent frames per fixation, not 6.
- Expected reading time is by characters: a block's size is its characters divided by the baseline passage's characters per word (`CHARS_PER_WORD`).
- Pace learns from every finished paragraph (winsorised, EWMA 0.2), and may move to 0.45-1.6 times baseline.
- A glance away or a scroll is no longer billed to the next line (`prevFixEnd` reset).
- Coarse mode: when the tracker's vertical error exceeds 0.6 of the line pitch of the block being read, line-level triggers are off; only a paragraph-total rule fires (once per visit), and the event carries `coarse: true` with a three-line band as `lineRect`. In fine mode a stuck line needs line confidence of at least 0.5.
- A toast warns when the camera delivers less than 1280 by 720.

Still open from that list: the 18-dot accuracy estimate on the calibration card (its wording still promises "line by line"), the head gate, the saved-calibration check, the new decoder, and the cumulative struggle rule. (Step 3 of the 2026-11-20 work closed the first three: see "Added 2026-11-20 (overnight accuracy work, step 3 of 4)" below.)

## Planned changes, in order (do each only when the lab data supports it)

1. Product honesty: highlight a band of lines sized to measured error; act only when the decoder is confident; replace the calibration card's accuracy with the 18-dot estimate; warn if the camera delivers under 1280x720 or under 20 fps (`frame.js` now reports the real settings in a `camera` message).
2. Tracker: settle 3a vs 3b; per-dot trimming and re-showing bad dots; tighter head gate including rotation; two-dot check before reusing a saved calibration.
3. Decoder: progress-state HMM, page-wide, anchored.
4. Struggle rules: per-character expectation, learning from all lines, cumulative rule.

## State of the code

- Branch `gaze-lab` is a snapshot of the PC's working tree at handoff, including uncommitted edits by the UI and motion sessions (calibration dot glide .6 s, card styling). `origin/main` is where the other sessions commit.
- Suites that passed just before handoff: `node tests/gaze-core.test.js`, `tests/e2e.mjs` 65/65, `tests/gaze-full.mjs` 15/15, `tests/gaze.mjs` 19/19 (the last one before the newest gaze-reader edits). `tests/live.mjs` uses Edge with the unpacked extension. The CDP tests assume Windows paths for Chrome and Edge; override with `CHROME_PATH` and `BROWSER_WITH_EXTENSION` on another OS.
- Recent tracker edits that have only been syntax-checked: `raw` and `camera` events, `debugDump()`, `clickRefine` option, `widget` option, `settleMs` 1000 (the dot now glides for 600 ms; keep settle at least glide + 400 ms), no self-start on extension pages.
- `gaze/vendor/face_landmarker.task` (3.6 MB) and the wasm (14.7 MB) must be present in `glider-extension/gaze/vendor/`; if the model file is missing, download it from `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`.
- `gaze-lab.js` is a developer tool. Remove it from the manifest and the service worker list before any release.

## Added 2026-11-20 (overnight accuracy work, step 1 of 4)

- `node tests/bench/gaze-bench.mjs` scores the tracker as shipped on a synthetic camera in about 11 seconds, with no browser. `--compare` checks it against `tests/bench/baseline.json`. Read `tests/bench/RESULTS.md` first: every number there is synthetic, and it lists what could not be measured. Recordings saved in `tests/lab/recordings` show up in that report as REAL rows.
- The calibration maths now lives in `gaze-core.js` as `fitCalibration` (same behaviour); the reader, the lab's synthetic recordings and the benchmark all call it. `tests/lab/fixtures` were regenerated because the lab's own copy of the maths had drifted from the tracker.
- The model table in `analyze.mjs` used to come out empty on a real recording (25-number training rows against 44-number camera frames). Fixed. (Since step 2 the tracker stores the camera's whole 63-number vector per training frame, so the pose variant and the head-frame models B, C, E are refitted from any new dump.) Before that it stored only the 25 numbers it trains on, so the pose variants could not be refitted from a dump yet.
- `GazeReader.init({ trace })` is the heat trace; the console log is `traceLog`. `debugDump()` also reports `delegate` (GPU or CPU) and `timeSource` (`capture` when the camera gives real capture times).

## Added 2026-11-20 (overnight accuracy work, step 3 of 4)

All numbers behind these are synthetic; `tests/bench/RESULTS.md`, "Step 3", has them and says what was not measured.

- The calibration is a procedure now, not 18 fixed windows: `CalibrationRun` in `gaze-core.js` decides which dot to show and when its frames count; `gaze-reader.js` only moves the dot. A dot is sampled once the eyes have stopped; up to three doubtful dots (too few frames, or far from where the other dots put them) are shown again; a dot with no frames ends the calibration with a message. It takes about 47 seconds.
- It ends with a head segment: first a card ("One more step: a small head turn") that waits for Space, then three dots, six seconds, with no text on screen (changed at sign-off: the text used to sit above the first dot while it was already being sampled, and reading it spoiled the fit; frames with the eyes off the dot are also dropped now, see `shootout.moveTrim` in the dump). Those frames are what lets the head-aware model (E) be fitted and checked; model A never sees them. `GazeReader.init({ headSegment: false })` leaves the segment out.
- The five validation dots are no longer folded into the training set. The accuracy on the done card is the shipped model's error on them. The card says "line by line" only under 16 px of vertical error; otherwise "a band of about N lines".
- The head gate reads the head pose (yaw, pitch, roll, position in cm) and has limits by model: 8 / 4.6 / 8 degrees and 8 / 4.6 / 12 cm for a head-frame model, 3 / 2.5 / 5 degrees and 2.5 / 2 / 6 cm for model A (`HEAD_GATE`; widened at sign-off from about 1 degree and 1.3 cm, which paused a reader sitting still). A saved calibration is reused only if the head is inside the gate during the first second after the camera starts. A resized or moved window gives the new status `paused`.
- Blinks are decided in the reader by `BlinkDetector` from the lid numbers the camera frame now sends (`lids`), so that a look down the page is not taken for a blink.
- Clicks refine the model only when a fixation is in progress and the model already has the eyes within 2 sigma of the click, never on Glider's own controls, and for 60 seconds.
- New in `debugDump()`: `calibration` (every dot with all its frames, for replay), `trainExtra`, `headGate`, `restoreCheck`, `clickStats`. New event: `caldot`.
- First thing to look at on a real camera: `debugDump().modelKind` and `.shootout.note` after a calibration. If the answer is A and the note says a head-frame model did not beat it, either the head did not move in the head segment or the face matrix is not in the convention `poseFromMatrix` assumes, and model A's gate (1 degree) will pause tracking on small movements.

## Working agreements with the owner

- Do not commit or push unless the owner says so. Never commit recordings.
- No real network calls with the owner's data; everything stays on the device.
- UI copy is plain, short, no emoji, no exclamation marks. The project is called Glider; do not reintroduce the old names.
- Report honestly: say what was measured and what was only simulated.
