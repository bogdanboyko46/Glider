# Handoff: refine cards 2 and 3 of the Glider showcase deck

The deck is five cards, under 75 seconds, every card advancing by itself. You own cards 2 and 3. Cards 1, 4 and 5 are being refined on the other computer; do not change their files.

| Card | Content | Files you own |
|---|---|---|
| 2 | The lens, and tuning it from the edge | `s1-lens.html`, `s2-tune.html`, the `2()` block in `cards.html` |
| 3 | Hear any word, and look-alike words | `s3-wordlens.html`, `s4-lookalike.html`, the `3()` block in `cards.html` |

Shared, change only with a note to the owner: `base.css` (look, fonts, components), `cards.html` outside your two blocks, the tools below.

## How a card is made

1. Each feature is a scene: one HTML file, 1280 x 720, `<html data-duration="7000">`, linking `base.css`. All motion is CSS `@keyframes` with `animation-delay` and `animation-fill-mode: both`. No JS timers, because the recorder pauses every animation and seeks it frame by frame.
2. `python showcase/record.py s1-lens s2-tune s3-wordlens s4-lookalike` records scenes to `showcase/out/<scene>.gif` (960 x 540, 15 fps). One headless Chrome at a time; needs Node 22+ and a local Chrome.
3. `cards.html?n=2` and `?n=3` are the static card layouts: headline, line, and empty `.screen` boxes. `node showcase/render_cards.mjs` renders them to `out/card-0N.png` and writes the box positions to `out/cards.json`.
4. `python showcase/build_cards.py` cuts the browser window out of each scene GIF, lays it into the boxes and writes `showcase/Glider-showcase.pptx` (needs `python-pptx` and Pillow, and the GIFs for all scenes: record `s0-title s5-stuck s6-simplify s9-close` once as well).
5. `node showcase/shot.mjs showcase/s1-lens.html 3200 out.png` gives one still frame of a scene at a time in ms.

The window is cut from the scene's default composition (`body class="scene"`), so keep that class; compose the card in `cards.html`, not in the scene.

## What the owner has asked for, still open on these two cards

- **Show the app exactly as it is.** The scenes are drawn stand-ins. The real UI on this branch differs:
  - There is no power button and no switch on the edge. The logo's five strokes sit bare on the right edge; pressing the logo opens the panel, and the lens is switched on in the panel header. `s2-tune.html` still shows a power button beside the logo: remove it and press the logo instead.
  - The real panel has a header (name, status line, lens switch, minimise), then Size / Letters / Words / Lines sliders, then switch rows.
  - The real word lens (see `glider-extension/content/content.js`, `showTip`) opens with a "Hard / Medium / Easy to read" chip and reason, a level tag, word-part badges, the chunk-and-sound chips, and three buttons: Hear word, Sound it out, Meaning. No bookmark.
  - The real look-alike card is that same lens with the word pair listed under the buttons.
  - `showcase/app-page.html` loads the real content scripts on a plain article, and `capture.mjs` plus the `real-r*.mjs` scripts record the real UI with a scripted pointer, if you want frames of the real thing to match against or to use directly (`python showcase/real2gif.py <name>`).
- **Written for dyslexic readers**, second person, plain. No slide counters. No emoji, no exclamation marks. Headline at most 5 words.
- **No glow**: flat tints and crisp edges; the owner disliked soft halos.
- **Every card composed differently** from the others. Card 2 is headline across the top with two windows side by side; card 3 is words on the left with two windows overlapping on a diagonal. Keep them distinct from each other and from card 4 (one large window left, words right).
- Timing: cards 2 and 3 run 7.8 s each. Scenes are 7 s (s4 is 6 s). Do not lengthen them.

## Report back

Push to this branch (`ui/current-look`) or a branch off it, and say which files changed and how long each card runs.
