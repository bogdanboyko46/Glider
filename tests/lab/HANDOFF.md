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

## Added 2026-11-22 (first real-camera rounds on the laptop; not committed)

Laptop: 13.4 in, 1280x800 CSS px, "QC Front Camera" 1280x720 at 30 fps, face model on the GPU. Owner sat at 33 cm (rounds 1-3) and 51 cm (round 4), screen tilt about 5 degrees, daylight. Recordings in `tests/lab/recordings/` (git-ignored); the 7 in `old-extension-1fps/` came from an old unpacked copy and are not valid.

Measured:
- Validation right after calibrating, model A: 32 to 57 px vertical, 38 to 62 px horizontal per fixation (1.2 to 2.2 degrees). The card claimed about 18 px.
- While reading, the height slides down the page: 50 to 300 px low by the last of 8 lines, in every round and with every model. The eyelids close steadily while reading (opening 0.26 -> 0.04 at 33 cm, 0.26 -> 0.13 at 51 cm) beyond anything the dots showed; the head barely moves (under 3 degrees, under 1 cm). On dots straight after reading the lids are back to normal. Dropping lid features from the regression, head-frame models (B, C, E failed to fit; the head segment ran) and sitting further back did not fix it.
- The head-turn segment and model 'auto' can be switched on from the lab only: Calibrate params `headSegment`, `model` (sent through the bridge's `init`).

Changed (line tracker, so that absolute height matters less): in `gaze-core.js` LineHMM a visit starts at the first visible line unless the drift-corrected height is more than `LineHMM.ENTRY_FAR` (3) lines below; a line only glanced at is no reference (a move to the left edge from it starts afresh); the furthest line read is no longer raised by a passing guess; each line's first `LineHMM.SETTLE_SKIP` (2) fixations are left out of the line-to-line pairing. In `gaze-reader.js` pickBlock (and `tests/lab/lib/replay.mjs`) the current paragraph is kept when the fixation fits once the learned offset (`S.drift.y`, capped at 250 px) is taken off. `ENTRY_FAR = 0, SETTLE_SKIP = 0` restores the old line choice.

Result, replayed offline on the 5 real read-along recordings (share of fixation time on the true line): 0 / 3 / 1 / 37 / 0 % before, 100 / 97 / 99.5 / 98 / 89 % after (analyze.mjs "shipped LineHMM"). The rules were found on these same recordings, so they need a fresh live check (instruction seq 7: lines-paced 64 and 48, lines-self, stall). Synthetic fixtures: 52 / 100 / 36 % -> 95 / 100 / 76 %. Price: a reader who starts a paragraph at its 2nd or 3rd line with no reading history is placed on line 1 until the next sweeps. Suites after the change: gaze-core.test, lab selftest, gaze.mjs 46/46, gaze-full 20/20, e2e 66/66; bench.test has 2 failures that are the same on the untouched branch.

## Working agreements with the owner

- Do not commit or push unless the owner says so. Never commit recordings.
- No real network calls with the owner's data; everything stays on the device.
- UI copy is plain, short, no emoji, no exclamation marks. The project is called Glider; do not reintroduce the old names.
- Report honestly: say what was measured and what was only simulated.

### Round 5 (held-out, 2026-11-22 evening) and the re-read change

- Round 5, new recordings, untouched by the tuning: paced reading 97.8 % (pitch 64) and 92.6 % (pitch 48) of fixation time on the right line; nearest line 58 / 46 %. Vertical error 60-63 px per fixation (1.5-1.7 deg) against a claimed 34 px.
- Stall run: first pass 97 %, the 6 s stall line 100 %, both re-reads 0 % (one line off). Cause: the owner had started line 8 before pressing R, so each jump back was two lines; it measured about -1.5 lines and the step prior (-1: 0.08, -2: 0.02) took it as one.
- Change: `LINE_STEP_PRIOR` now `+1 0.7, 0 0.1, -1 0.1, +2 0.05, -2 0.05`. Real paced recordings unchanged except 20261122-121236 (97.0 -> 95.9 %); stall 75.1 -> 80.7 %; synthetic stall 76 -> 89 %. A sigma of 0.6 was tried and rejected (pitch-32 recording fell to 41 %). Evidence on real re-reads is two events: confirm with round 6.
- The stall task's R now also ends the last re-read line (the owner pressed it there by instinct); Space then R still works.
- Tests: gaze-core.test, lab selftest, tests/gaze.mjs 46/46.
- Round 6 (20261122-181428-stall): no gaze output, because the extension reload cleared the calibration and the instruction said not to recalibrate. Rebuilt offline from raw frames with the round 5 model (the same rebuild of round 5's stall reproduces the live 80.7 % exactly). The owner sat 7.7 cm closer than at calibration, so lines 7-8 landed 250-350 px below the paragraph and are lost; the one-line jumps back to line 6 were right (old prior 100/100 %, new 80/100 %). Inconclusive; round 7 recalibrates first.
- Round 7 (2026-11-25, 20261125-155904-calibrate + 20261125-160015-stall, live gaze): the owner again read into line 8 before pressing R on the second re-read (three of four re-reads so far began with a two-line jump back). With the 0.05 prior it decoded 83 %; `LINE_STEP_PRIOR` is now `+1 0.65, 0 0.1, -1 0.1, +2 0.05, -2 0.1`: round 7 stall 97.0 %, round 5 stall 93.0 %, synthetic stall 97.6 %; paced recordings unchanged except 121236 95.9 % and 124237 96.9 % (from 97.0 / 97.8). Tuned on these same stall runs: needs another held-out re-read run. Tests: gaze-core.test, lab selftest, tests/gaze.mjs 46/46.
- Open: the struggle prompt did not fire live in round 7 (stall or re-read), and the 6 s stall has never fired in any run. Vertical error 54 px per fixation (1.4 deg) right after calibration.
- Calibration dot (2026-11-25, owner: "the dot pulses erratically"): it used to sit for a variable 0.9-2.2 s (waiting for still eyes), pop to 1.15x, shrink, pop again on each restart, and snap back to full size while gliding. Now it shrinks once, smoothly (1 -> 0.55, ease in-out) over its frames, holds its size through a restart until the new count catches up, and grows back during the glide to the next spot. Which frames count is unchanged. The first card now says to look at the white centre until the dot has shrunk. Tests: tests/gaze.mjs 46/46, tests/gaze-full.mjs 20/20.
- Heat trace height (2026-11-25): measured offline per fixation on the 9 real reading recordings, the heat (raw estimate less `drift.y`) sat on the line being read 59 % of fixation time (raw estimate alone 25 %; also correcting the slide along a line with a learned slope gave 63 %, dropped). `traceLineY` in gaze-reader.js now draws the heat on the line the decoder has locked (middle of the line plus 0.25 of the estimate's offset, capped at 0.4 of the line height), falling back to the estimate with no locked line or when it is more than 2 line spacings away: 95 % on the same recordings (89-100 %). This changes only the drawing, not the estimate. Tests: tests/gaze.mjs 46/46, tests/gaze-full.mjs 20/20.
- Simplify made seamless (2026-11-25, owner: only the wording should change, plus an optional small "see original"): simplify/bridge.js has no offer chip, label bar, tint, enlargement, margins or animation; the stand-in keeps the paragraph's tag and classes. Gate 'offer' decisions now swap in place. The "See original" mark (adapt's faint three-bar control) appears only with the panel's switch on; using it stops the look-ahead on that page. New look-ahead: after the first swap, up to 3 paragraphs below the window at least as hard (difficulty score - 0.05) are swapped before they are reached; the Claude rewrite is used only where it cannot be seen arriving. content.js: the "Spaced out for you" spacing card and its Undo note are removed. Options page: "How much larger" removed; privacy note says up to three hard paragraphs below may also be sent when Claude rewrites are on. Tests: tests/simplify.mjs rewritten (all pass), gaze-full 20/20, e2e 66/66, gaze 46/46, simplify-gate unit pass.
- Only the wording changes (2026-11-25, owner: "remove both"): the panel no longer acts on struggles (content.js onStruggle, the gaze-opened syllable lens and its timers removed); the tracker's own line highlight and "Read line aloud" button are off in Glider (`autoAdapt: false` in content.js init; standalone GazeReader keeps its default); adapt.js's split rule (layout: one part per line) is off via `splitAllowed()` (tests/adapt.mjs sets `__gliderAllowSplit` to keep testing it); the reorder rule (word order only) stays. Tests: gaze-full 20/20 (new checks: no struggle handler, split off), adapt.mjs pass, e2e 66/66, simplify pass, gaze 46/46.
- Legitimacy review (2026-11-25, owner: "make sure everything is legit"):
  - "See original" is now the Glider logo (data-URI SVG in content.css, colour when Glider's text shows, grey when the original is back).
  - bridge.js swaps only on the gate's automatic rule (pace on the paragraph against the reader's own measured baseline, at least 1.8x the pace threshold scaled by bias and text, held 4 s, offline simplifier must have real gain, baseline required). The gate's 'offer' level (built to ask the reader) no longer changes text; struggle events alone never do. Silent swaps record 'swapped' so a quick "See original" raises the bar (bias).
  - Offline simplifier: 81 of 316 word swaps removed (noun/verb clashes, second senses, meaning shifts, mid-sentence connectives); -ed doubling (controlled); no split before ", and that"; "However," / "Therefore," swapped only where they open a clause. Found on the reading page: "a few minutes" -> "a few tinies", "regulated" -> "controled", a fragment "That the glass rattled ...". Regression cases in tests/simplify.test.js.
  - Real-camera evidence for struggle detection is thin: 9 reading runs (~7.5 min): one stuck-line event in normal paced reading (false), the 6 s stall never fired (by design it needs about 2x the line's expected time: ~9.6 s at 150 wpm and tau 2), re-reading fired once in two runs. The gate's constants were tuned by simulation (gate.js), not on real readers. The look-ahead rule (difficulty >= struggled - 0.05) is a heuristic with no reader data.
  - Tests: simplify.test, adapt.test, gaze-core.test, simplify-gate, simplify.mjs (incl. no-baseline and events-only checks), adapt.mjs, e2e 66/66, gaze-full 20/20, gaze 46/46.
- Adapt demo / live test (2026-11-25): tests/lab/site/read.html is now "How honeybees find their way": 5 easy paragraphs (verdict never), 4 hard ones the offline simplifier improves cleanly (p3, p5, p7, p8; difficulty 0.81-0.88). The reader reads p3 slowly (M marks start / end). The page logs, invisibly, every paragraph Glider changes (on-screen or below = struggle or look-ahead), its source, scroll, and the M marks, and posts the log to /api/recording?task=adapt-demo on tab hide / page leave. `#clean` hides the instruction note for filming. Headless check: struggle on p3 swaps it; the look-ahead then swaps p8 only (p5 was on screen, p7 is below the struggled paragraph's difficulty less 0.05). Simplifier: 8 more swaps removed (sufficient, adequate, insufficient, facilitate, immediately, instantly, possibly, despite); rapidly/swiftly -> quickly.
- Camera box hidden in Glider (2026-11-25, owner chose "no box at all"): GazeReader option `camera: 'hidden'` (content.js sets it). #cam gets class `ghost`: opacity .02 and shrunk to 40 px with no bar (never removed: an undrawn camera picture stops sending frames); class `need` brings it back in full while the face has been lost for 1.2 s; the calibration face card still shows it (its :has rule outranks). Toasts are unaffected. The dock mark shows the status as a 7 px dot (`.ll-pill[data-gaze]`: green on, amber paused / needs calibrating / move back / camera blocked). Standalone GazeReader keeps the box by default. Not yet checked on the real camera that frames keep coming with the 40 px box (the fake frame posts regardless). Tests: gaze-full 21/21 (new dot check, tests/out/gaze-minimal.png), gaze 46/46, e2e 66/66.
