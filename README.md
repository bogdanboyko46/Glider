# Glider

A Chrome extension (Manifest V3) that makes dense web reading easier for students with dyslexia and visual-processing fatigue. It adds a small draggable dock to any page. Everything runs on the device: no accounts, no network calls, no build step. The one exception is opt-in: if you save your own Anthropic API key, the paragraph you are stuck on is sent to Claude to be rewritten more simply.

There is one reading lens and one switch. No modes.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `glider-extension` folder. If an older copy is already loaded, press its reload arrow instead.
4. Pin Glider from the puzzle-piece menu. It has no logo, so Chrome shows a plain letter tile in the toolbar.
5. Open any article. The lens is already on and the Glider pill sits bottom right. Tabs that were already open work straight away; if one does not, reload it.

To try it on a local file such as `demo/sample-assignment.html`, also switch on **Allow access to file URLs** on the extension's details page.

## What the lens does

Switching it on (the pill, the panel or the toolbar popup) applies all of this together:

| Part | What happens |
|---|---|
| Spacing guard | Left-aligns text and widens letter spacing, word spacing and line height |
| Text size | Body text can be enlarged from 100% to 160%; it reflows inside the same column |
| Bionic cadence | Bolds the start of each word (1 letter for short words, 2 for 4 to 5 letters, about 40% beyond) and adds a small pause after commas, semicolons and periods |
| Hover lens | Hover a word of 6+ letters to see it broken into chunks, each with the sound it makes written underneath (the stressed chunk in bold). Tap a chunk to hear just that sound, **Hear word** for the whole word, or **Sound it out** to hear each chunk in turn, lit up as it is said, then the whole word. Double-click keeps it open |
| Look-alike words | Commonly confused words get a dotted underline; hovering shows a short meaning for each word in the group (177 groups, 380 words) |

Switching it off puts the page back exactly as it was, with no reload.

The panel also has fine-tuning for the lens: four sliders (size 100 to 160%, letters 0 to 4 px, words 0 to 10 px, lines 1.4 to 2.4), colours for b d p q, and the Atkinson Hyperlegible font. The last two are off by default.

Shortcuts: `Alt L` open or minimise the dock, `Esc` minimise. It can be changed at `chrome://extensions/shortcuts`.

Settings and the dock position are saved in `chrome.storage.local` and follow you across tabs and reloads.

## Eye tracking (optional, off by default)

Switch on **Eye tracking** in the panel or the popup. The webcam is read inside an extension-origin iframe; only numbers (eye-shape features) leave that frame, and nothing leaves the device. The first time, allow the camera on the page that opens.

Calibration has two parts and takes about a minute:

1. **Eyes.** Follow 18 dots. This fits the gaze model and reports its accuracy.
2. **Reading pace.** Read one short, easy passage at your normal speed and press Space. This gives the reader's **baseline**: words a minute, how much their time per word varies from line to line, and how often they jump back a line.

From the baseline comes **tau (τ)**, the personal threshold: a reader is treated as struggling when a line takes more than τ times as long as their baseline predicts.

| Value | How it is set |
|---|---|
| Baseline pace | Gaze dwell per line over the passage; falls back to the wall clock when gaze coverage is poor. Stored for 30 days (`grBaseline`) |
| τ | `1.6 + 1.4 × (cv / 0.6)`, clamped to 1.6 to 3.0, where `cv` is the reader's own line-to-line variability. Steady readers get help sooner; erratic readers are not flagged for their normal variation. Without a baseline τ is 2.0 |
| Help slider | Multiplies τ by 1.4, 1.2, 1, 0.85 or 0.7 (Rarely to Often) |
| Working pace | Starts at the baseline, keeps learning from paragraphs read without trouble, but stays within 0.6 to 1.5 times the baseline |

Struggle signals, all relative to the baseline: **stuck-line** (time on a line above `max(2 s, τ × expected)`), **rereading** (two jumps back within 15 s, three for habitual re-readers), **slow-paragraph** (unfinished paragraph above `1.1 × τ × expected`). The state ends when the reader moves to another line at normal pace, changes paragraph, or 15 s pass.

What Glider does: highlights the line and offers to read it aloud; on a stuck line it opens the syllable lens on the hardest word of that line; on rereading or a slow paragraph it widens that paragraph's spacing. Switching the lens or eye tracking off undoes all of it.

Shortcuts: `Alt Shift E` on or off, `Alt Shift C` recalibrate, `Alt Shift G` debug overlay (gaze dot, decoded line, pace, τ and the struggling state).

The pure maths is in `gaze/gaze-core.js` (`summarizeBaseline`, `tauFromCv`, `struggleDecision`); the tuning constants are there and in `checkStruggle` in `gaze/gaze-reader.js`.

## Simplify hard text (on a struggle)

With eye tracking on, the paragraph a reader gets stuck on is swapped, right where it is, for a larger and simpler version. **Show original** on the paragraph puts it back; so does turning eye tracking or the lens off.

- **On the device, always.** `simplify/simplifier.js` swaps hard words for common ones, shortens wordy phrases and splits long sentences at safe joints. It appears at once and needs nothing.
- **Claude, optional.** Open the extension's **Options** page (`simplify/options.html`) and save an Anthropic API key. The offline version still appears at once, and Claude's rewrite replaces it a moment later. This is the only network call Glider makes: the paragraph being rewritten is sent to Anthropic, only when a key is saved. The key stays in this browser's extension storage.
- The page's own paragraph is never edited: it is hidden and a stand-in with the same tag and classes sits after it, so the page goes back exactly as it was.

`simplify/bridge.js` listens to the tracker's `struggle` event; `simplify/claude.js` runs in the service worker and holds the model name and prompt.

## Reading Check (analytics dashboard)

Press **Open** next to *Reading check* in the toolbar popup. In about two minutes it calibrates the eye tracker, shows one short passage for the chosen age band, asks two comprehension questions and then opens a dashboard of the read: speed, comprehension, fixations, regressions and line re-reads, a scanpath replay with heatmap, time per line, a fixation histogram, a five-score reading profile, and fatigue and focus signals (blinks, gaze stability, head movement, first half against second half). Findings are written in plain language and link to Glider settings, which **Apply recommended settings** writes for you.

It is **not a diagnosis**. A webcam resolves lines, not words, and the typical ranges in `assessment/norms.js` are approximate values from lab eye-tracking studies that have not been validated for webcams. Everything is computed on the device; no video or images are stored, only numbers, and **Delete my data** removes them.

- `assessment/assessment.html?demo=1` shows the full dashboard from a simulated reader, with no camera. `?demo=sparse`, `?demo=noframes` and `?demo=poor` show how it degrades.
- `assessment/assessment.html?last=1` reopens the most recent saved check.
- While eye tracking is on during normal reading, `assessment/session-logger.js` stores one row a minute (blinks, mean fixation, regression rate) for the dashboard's "Over time" chart.

## Design

The dock and popup use the Sage design. Nine other designs are still defined in `DOCK_CSS` in `content/content.js` but there is no picker; `skin` in `DEFAULTS` selects one. The visible name is `APP_NAME` in the same file; internal ids, the folder and storage keys use the `glider` prefix.

## Test checklist

Use a long Wikipedia article (for example *Epistemology*) or `demo/sample-assignment.html`.

- [ ] The page loads with the lens on: spaced, left-aligned text, bold word starts.
- [ ] Hover a long word: each chunk shows its sound underneath. Tap a chunk, press Hear word, then Sound it out, and listen. Hover a dotted-underlined word (their, affect, principal): the meanings appear.
- [ ] Flip the switch on the pill: everything returns exactly as it was. Flip it back.
- [ ] Drag the pill to another corner; click it and the panel opens inward from that corner.
- [ ] In the panel: move the four sliders (Size enlarges body text without sideways scrolling), turn on Colour b d p q.
- [ ] Type in a search box or comment field: form fields and code blocks are never altered.
- [ ] Open the toolbar popup: its switches match the dock and change it live.
- [ ] Reload the page and open a second tab: the same settings are applied in both.

## Automated checks

No dependencies; Node 22+ and a local Chrome (Edge for the real-extension run).

```bash
node tests/e2e.mjs      # 65 behaviour checks on the demo page (headless Chrome)
node tests/live.mjs     # loads the unpacked extension in Edge and runs it on Wikipedia
node tests/shots.mjs    # screenshots of the pill, panel and hover lens 
node tests/popup-shots.mjs     # screenshots of the popup
node tests/syllables.test.js   # syllable splitter accuracy on 345 words
node tests/gaze-core.test.js   # gaze maths, baseline and tau
node tests/gaze.mjs     # simulated camera: calibration, reading-pace baseline, planted struggles
node tests/simplify.test.js    # offline text simplifier
node tests/simplify.mjs        # struggle -> simplify bridge in headless Chrome (canned Claude reply)
node tests/analytics.test.js   # Reading Check metrics on simulated sessions with planted answers
node tests/assessment.mjs      # Reading Check dashboard in headless Chrome (demo and degraded data)
node tests/assessment-live.mjs # the whole Reading Check with a simulated reader and fake camera
node tools/make-demo-session.js  # regenerate assessment/demo-session.json
```

## Layout

```text
glider-extension/
  manifest.json
  popup/           toolbar popup: lens switch, dock visibility
  content/
    content.js       orchestrator, Shadow DOM dock, settings and storage sync
    domEngine.js     safe TreeWalker tokeniser, original-text cache, bionic, b/d/p/q, look-alike marking
    syllableParser.js  rule-based English syllable splitter
    homophones.js    confusion groups with icons and five-word meanings
    content.css      page-side styles for tokens and text size
  gaze/
    gaze-core.js     pure maths: features, ridge model, fixations, line locking, baseline, tau
    gaze-reader.js   calibration, reading-pace baseline, struggle detection, camera widget
    frame.html/js    camera iframe running MediaPipe Face Landmarker (vendor/)
    permission.html  one-time camera permission page
  background/
    service-worker.js  shortcut command; answers pronunciation lookups; injects into already-open tabs on install
  data/
    pronounce.txt    the sound of each chunk for about 94,700 words, built from the CMU Pronouncing Dictionary
    sounds.txt       for sounds that speech voices misread, a spelling they say correctly
  fonts/           Lexend, Atkinson Hyperlegible, Instrument Serif, JetBrains Mono (SIL OFL)
demo/              sample LMS-style assignment page
tests/             dependency-free Chrome DevTools Protocol tests
parked/            the read-aloud engine, its test and the reading ruler, not loaded by the extension
```

## Known limits

- Text inside cross-origin iframes (some LMS quiz tools and embedded readers) and inside other components' closed shadow roots is not reached.
- On heavily scripted pages that rewrite their own text constantly, a rewritten line can lag until it next re-renders.
- The hover lens is pointer-only for now.
- Sounds are shown for words in the bundled list (American English). Words not in it still get their chunks and Hear word.
- Speech uses the browser's built-in voice. The spelling fed to the voice for each sound was checked against two Windows voices (David and Zira): about 94% of sounds are said exactly, 2% closely, and 4% are best effort. Other voices (Mac, Chromebook, online voices) were not checked.
- Text size enlarges paragraphs, list items, quotes and captions. Headings, tables and site menus keep their own size.
- Browser pages (`chrome://`), the Chrome Web Store and the built-in PDF viewer do not allow extensions to run.
