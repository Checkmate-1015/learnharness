# Quick Fire

Something to do while the tutor is thinking. A small card appears in the bottom-right corner when a turn starts and removes itself when the reply has landed. Unfinished questions are thrown away. Nothing is graded or saved.

- **Related**: quick recall questions on the lesson so far. A batch of 5 is written in the background after a turn settles, whenever fewer than 3 unseen ones are left, using the **Cheap** model slot (Settings → Agent → Models). This uses model quota. Questions only draw on the lesson up to your last answer, so they cannot give away the check the tutor is waiting on. The first wait of a session has no batch yet and shows Maths.
- **Maths**: made on the spot, free. Times tables, add/subtract, percentages and fractions, 2-digit x 2-digit, chained returns, number sequences, series sums and rules of thumb.

Tap a choice to answer, **Skip** to move on, and the Related/Maths buttons to switch. The number is right answers in a row for this wait. Mouse and touch only; the card never takes keyboard focus.

Settings → Quick Fire has an on/off switch and the mode to start in.

## Install into the app

Copy `plugins/quick-fire/dist` to `<data>/plugins/quick-fire/dist`, enable Quick Fire under Settings → Community plugins, then restart the app.

## Limits

- Mac only. There is no iPad page.
- The card appears when a turn starts while its lesson is on screen. Opening a lesson mid-turn does not show it.
- Related questions are plain text; maths notation is written in words.

## Tests

```bash
node --test plugins/quick-fire/tests/*.test.*
```
