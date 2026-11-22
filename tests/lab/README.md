# Gaze Lab

A local page plus a tiny server for running short eye-tracking tasks with a real
webcam. Every run is saved as one JSON recording for offline analysis.

## Start

```
node tests/lab/server.mjs
```

It prints `Gaze Lab: http://127.0.0.1:8377/`. Open that address in the Chrome
profile that has the Glider extension loaded. The page shows a red banner when
the extension's lab bridge does not answer: reload the extension in
`chrome://extensions`, then reload the page.

`http://127.0.0.1:8377/?fake=1` runs the page against a built-in fake bridge
(synthetic data, no extension, no camera). It is for smoke tests only and is
labelled on screen.

Node 24, no dependencies, no build step. Files: `server.mjs`, `site/index.html`,
`site/lab.js`, `site/lab.css`. Recordings land in `tests/lab/recordings/`.

`node tests/lab/server.mjs --recordings <folder> --port <n>` saves somewhere else and listens on
another port. `tests/lab/session-smoke.mjs` uses that to try the benchmark session in fake mode
without writing into `tests/lab/recordings/`.

## Benchmark session (about 6 minutes)

The button "Run the benchmark session" on the home screen runs a fixed sequence and saves seven
recordings, one per step:

1. `camera`, 15 s
2. `calibrate` (the extension's own calibration, with its five-dot check)
3. `validate`
4. `lines-paced` at a 64 px line spacing
5. `lines-paced` at a 32 px line spacing
6. `headshift`
7. `validate` again

Each step shows its instruction and waits for Space, as when run alone. A step that fails or is
aborted with Esc ends the session; what was saved stays. Every recording of the session carries
`sequence: { name: 'benchmark', step, of, run }`. From the console:
`await __lab.session()`.

Afterwards, from the checkout root:

```
node tests/bench/gaze-bench.mjs --real-only     the REAL rows alone, in about a second
node tests/bench/gaze-bench.mjs                 the whole benchmark, with the REAL rows under the synthetic ones
node tests/lab/analyze.mjs latest               the lab's own analysis of the newest recording
```

`--recordings <folder>` makes the benchmark read another folder.

## Server

| Route | What it does |
|---|---|
| `GET /` and static files | Served from `tests/lab/site/`, `cache-control: no-store`. |
| `POST /api/recording` | JSON body up to 80 MB, streamed to `recordings/<YYYYMMDD-HHMMSS>-<task>[-<label>].json` (local time; task and label reduced to `[a-z0-9-]`). Task and label come from `?task=&label=` when given (the page does this), else from the body. Replies `{ ok, file, bytes }` and prints `RECORDING <path> <bytes> bytes`. |
| `GET /api/instruction` | Contents of `tests/lab/instruction.json`, or `{ "seq": 0 }` when missing or not valid JSON. |
| `GET /api/recordings` | `[{ name, bytes, mtime }]`, newest first. |
| `POST /api/note` `{ text }` | Appends a line to `recordings/notes.log` and prints `NOTE <text>`. |

Listens on 127.0.0.1 only.

## Instruction file (the coach)

Overwrite `tests/lab/instruction.json` by hand to direct the tester. The page
polls it every 2 s and reacts when `seq` changes (never while a task runs):

```json
{ "seq": 3, "text": "Sit normally. Run Validate.", "task": "validate", "params": { "points": 9 }, "autostart": false }
```

`text` is shown large, the named task's button is highlighted, `params` are
filled into its form, and with `autostart: true` the task starts after a 3 s
countdown. Params with no form field still reach the task.

## Tasks

Every task hides the home screen, hides the extension widget, turns the stream
on, shows an instruction (Space begins, Esc aborts and discards), records, takes
a `dump`, saves, and shows "Saved" with a summary under "Last result". If no
camera frames are arriving when a task begins, the page sends `start` first.

| Task | Defaults | What happens | Truth |
|---|---|---|---|
| `camera` | `durationMs: 15000` | Stare at a centre cross. Summary: frames, fps, face-lost %, blink %, camera settings. | one `target` |
| `calibrate` | `baseline: false` | Sends `calibrate` (the extension draws its own UI; Esc is left to it), then `dump`. Summary: accuracy and the result of the five-dot check. | one `phase`; one `caldot` per calibration dot; the five check dots also as `target` with `phase: 'check'` |
| `validate` | `points: 13, dwellMs: 1800, settleMs: 700, extras: []` | A dot jumps to a shuffled 3x3 grid (10/50/90 %) plus 4 inner points (30/70 %). `points` below 13 keeps a random subset; `extras` is a list of `[fx, fy]` viewport fractions. Summary: per-target error and scatter, mean absolute error H/V in px and degrees, worst point, a map. | `target` per point |
| `headshift` | `dwellMs: 1800, settleMs: 700` | Four prompts (`baseline`, `lean-left`, `lean-back`, `slouch`), each followed by 5 targets (centre + 25/75 %). Summary: error per phase. | `phase` entries, `target` entries with `phase` |
| `lines-paced` | `pitch: 64, fontPx: 22, lines: 8, wpm: 150, widthPx: 760, passage: 0` | One text block `#lab-p1`; a highlight moves word by word (time per word proportional to length + 1). | `word` and `line` |
| `lines-self` | same minus `wpm`, `passage: 1` | Tester reads alone and presses Space at the end of every line. | `line` and `key` |
| `stall` | plus `stallLine: 4, rereadLines: [6, 7]`, `passage: 2` | As `lines-self`. S marks the start and end of a deliberate stall. R means "jumped back": the line counter returns to the first re-read line. | `line`, `key`, `phase` (`stall`, `reread`) |

"Dump now" saves a recording with task `dump`: no events, just `dump`, `env`
and `physical`.

Degrees need the setup form: px per cm = `hypot(screen.w, screen.h)` CSS px /
(diagonal in inches x 2.54); degrees = `atan(cm / distance)`.

From the console or a test: `await __lab.run(task, params, { auto: true })`
(`auto` answers every key prompt by itself) resolves with `{ ok, file, summary }`.

## Recording format

```
{ v: 1, task, label, startedAt (ISO), durationMs, t0,
  env: { ua, viewport:{w,h}, screen:{w,h,availW,availH}, dpr, screenX, screenY, outerW, outerH },
  physical: { screenDiagIn, distanceCm, glasses, lighting },
  params: { ... },
  truth: [ ... ],
  layout: { blocks: [ { id, pitch, fontPx, left, top, widthPx,
            lines: [ { top, bottom, left, right, textTop, textBottom, words: [ { text, left, right } ] } ] } ] },
  events: [ ... every bridge event received during the task ... ],
  dump: { ... reply of the dump command at task end, or { error } ... },
  notes, summary, extra }
```

- `session: { id, calibratedAt }` names the calibration the recording was made on (`id` is `cal-<time the calibration
  finished>`, taken from the extension's dump, so it survives a page reload; `null` before any calibration). Recordings
  with the same id belong to one sitting. A benchmark-session recording also has `sequence`.
- `http://127.0.0.1:8377/?landmarks=1` (lab only, off by default) makes every `raw` event carry `lmk`: 24 face
  landmarks as `[x, y, z]` in MediaPipe's units, in this order of mesh indices: 33, 133, 159, 145, 362, 263, 386, 374
  (eye corners and lids), 468 to 477 (both irises, five points each), 168, 1 (nose bridge and tip), 234, 454 (cheeks),
  10, 152 (forehead, chin). It adds about 0.6 KB a frame (about 6 MB to a benchmark session) and restarts the tracker
  once so that the camera frame learns of it.
- All times are the page's `performance.now()`. `t0` is when recording began.
- `truth` entries:
  `{ kind:'target', id, x, y, tShow, tSettle, tEnd, phase? }` (samples between `tSettle` and `tEnd` count);
  `{ kind:'line', block, line, t0, t1 }`;
  `{ kind:'word', block, line, word, text, x, t0, t1 }` (`word` is the index within its line, `x` the word's centre);
  `{ kind:'phase', name, t0, t1, ... }`;
  `{ kind:'caldot', id, seg, role, x, y, tShow, tSettle, tEnd, frames, settled }` (calibrate recordings: one per dot the
  extension showed; `seg` is `dots`, `reshow`, `head` or `check`, `role` is `cal`, `val`, `move` or `check`; frames
  between `tSettle` and `tEnd` are the ones the calibration used);
  `{ kind:'key', key, t }` (`Space`, `s`, `r`).
- `line` and `word` indices are 0-based. The `stallLine` and `rereadLines` params are 1-based, as shown to the tester.
- `layout` is in viewport px, measured with `Range.getClientRects` after the extension has been pointed at the block. A line's `top`/`bottom` are its full line box (text centre plus or minus half the pitch, so lines tile); `textTop`/`textBottom` are the measured glyph box. `layout` is `null` for non-reading tasks.
- `summary` is the page's own quick result; `extra` holds oddities (for example a failed `setRoot`, or the reply of `calibrate`).

## Bridge protocol

Both directions are `CustomEvent`s on `document` whose `detail` is a JSON string.
The extension bridge activates only on 127.0.0.1/localhost pages carrying
`<meta name="glider-lab" content="1">`. All lab UI is inside an open shadow root
on `<div id="lab-root">`, which the extension does not restyle.

- page to extension: `glider-lab:cmd`, `{ id, cmd, args }`. Commands: `hello`,
  `start`, `stop`, `calibrate { baseline }`, `state`, `dump`,
  `setWidget { visible }`, `debug { on }`, `setRoot { hostSelector | null }`,
  `stream { on }`.
- extension to page: `glider-lab:reply`, `{ id, ok, result, error }`.
- extension to page: `glider-lab:data`, `{ batch: [event, ...] }` about every
  100 ms while streaming. Each event has `k` and `t` (page clock): `raw`, `gaze`,
  `fix`, `line`, `status`, `struggle`, `camera`, `caldot`, `accuracy`. A `camera` event also has `delegate`, `fps`,
  `modelFps` and `warnings`. Since 2026-11-20 a `raw` event also carries
  `lids` (the two blink scores and the lid opening), and `dump` returns the last calibration
  as it happened (`calibration.dots`: every dot with all its camera frames).

`hello` is retried every 1.5 s until it answers; the banner shows after the
first miss and clears on success.
