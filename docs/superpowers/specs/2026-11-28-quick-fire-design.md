# Quick Fire: something to do while the tutor thinks

Status: approved by Isaac on 2026-11-28 and built in `plugins/quick-fire`.

## Why

Waits between tutor turns run from seconds to minutes. With ADHD, an empty wait is
where attention leaves the lesson. Quick Fire fills the wait with small questions
and gets out of the way the moment the tutor is ready.

## What Isaac decided

- A LearnHarness plugin. It pops up when the tutor starts thinking and closes
  itself when the reply has landed. Unfinished questions are thrown away.
- Two modes with a toggle on the card: **Related** (about the lesson) and **Maths**.
- Related questions are written ahead of time by a model, in batches.
- On the Mac it is a small card in the bottom-right corner, so the reply streaming
  in behind it stays visible.
- Answers are four tap choices. There is a **Skip** button.
- Maths covers: times tables and 2-digit x 1-digit; add/subtract 2-3 digit numbers;
  percentages and fractions; 2-digit x 2-digit; chained returns; number sequences;
  series sums; rules of thumb (rule of 72, small powers, decimal/fraction odds).
- Mac only for now. iPad is a later step.

## Goals

- A question is on screen within about half a second of the tutor starting.
- The card is gone as soon as the turn settles, mid-question or not.
- Maths works with no model, no network and no cost.

## Not doing

- iPad page, pairing or QR code.
- Grading, saved scores, history, or anything written into the lesson, the
  transcript or the knowledge graph.
- Changing the iPad Scratchpad plugin.

## Must never happen

- A Related question gives away the answer to the check the tutor is currently
  waiting on. The writing prompt says to use only material already taught and
  answered, and the batch is written from the transcript up to the last answered
  check.
- The card steals keyboard focus from the answer box or blocks clicks outside
  its own rectangle.
- A model call starts without a model Isaac has configured.

## Approaches considered

1. **Community plugin, like Motion (chosen).** The app already tells plugins when
   a turn starts and settles, lets a backend read the session and call a model.
   No change to the app itself, and it survives upstream updates.
2. **Build it into the app's chat screen.** Tighter fit, but it edits core files
   that upstream changes often, so every merge risks conflicts.
3. **Extend iPad Scratchpad.** That build is minified third-party code with no
   source here. Ruled out.

## How it works

**Showing and hiding (browser side).** The plugin listens for `turn-started` and
`turn-settled`. If the started chat is the one on screen, it shows the card. On
`turn-settled` for that chat, on leaving the session, or on plugin disable, it
removes the card. The card is the plugin's own fixed-position element, because the
host has no floating-card widget; styles are scoped under one class and use the
theme variables.

**The card.**

```
+-----------------------------+
| Up 10%, then down 10%. Net? |
| [ -1% ]        [ 0% ]       |
| [ +1% ]        [ -2% ]      |
| Related | Maths     Skip  3 |
+-----------------------------+
```

Tap a choice: it turns green or red, the right answer is marked, and about 0.8 s
later the next question appears. Skip goes straight to the next one. The number is
a streak for this wait only. Mouse and touch only in this version; no keyboard
shortcuts, so typing in the answer box is never intercepted.

**Maths.** Generated in the browser at the moment of asking, picked at random
across the eight kinds. Wrong choices are plausible slips (off by ten, wrong last
digit, the "0%" trap for up-then-down). Rule-of-thumb questions say "roughly" and
keep the choices far enough apart to have one right answer.

**Related.** When a turn settles in a teaching or practice session and fewer than
3 unseen questions remain for that chat, the backend asks the model for 5 more:
one-line question, four choices, index of the right one. It uses the **Cheap**
model slot from Settings and marks the call as background work, so the app's
existing consent and quota rules apply. Batches live in memory, per chat, and are
dropped on restart. If there is no Cheap model, consent is refused, the call fails
or no batch is ready yet (the first wait of a session), the card shows Maths and a
one-line note saying why.

**Settings and toggles.** Plugin settings page: on/off, and the mode to start in.
The Related/Maths toggle on the card changes the mode and remembers it. Both are
saved in the plugin's own data folder.

## Files

- `plugins/quick-fire/dist/manifest.json`, `main.js`, `backend.cjs`, `styles.css`
- `plugins/quick-fire/dist/assets/maths.js` (the maths generators, no dependencies)
- `plugins/quick-fire/tests/` (maths generators, batch parsing and top-up rule)
- `plugins/quick-fire/README.md`

Hand-written with no build step, the same way `plugins/motion` is laid out.
Installing means copying `dist` into the app's plugins folder, enabling it under
Settings, Community plugins, and restarting the app.

## My calls, for Isaac to check

- Name "Quick Fire", id `quick-fire`.
- Card appears immediately, with no delay for short waits.
- Top up at fewer than 3 unseen, 5 per batch.
- Cheap model slot, no separate model picker.
- Streak counter per wait, never saved.
- No keyboard shortcuts in this version.
- 0.8 s pause to show right/wrong.
