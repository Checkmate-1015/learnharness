# Quick Fire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A LearnHarness community plugin that shows a corner card of quick questions while the tutor is thinking and removes it when the turn settles.

**Architecture:** Hand-written plugin with no build step, laid out like `plugins/motion`. The browser module shows and hides the card from `turn-started` / `turn-settled` app events and generates maths questions locally. The Node backend writes batches of lesson questions with the Cheap model slot and keeps them in memory per chat.

**Tech Stack:** Plain ES module (browser), CommonJS (backend), CSS, `node:test`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-11-28-quick-fire-design.md`

## Global Constraints

- Plugin id `quick-fire`, name `Quick Fire`, `apiVersion: 1`, `version: 0.1.0`, `minAppVersion: 0.6.1`.
- Use only the public plugin API in `docs/plugin-authoring.md`. No imports from the app's private modules. No changes outside `plugins/quick-fire/` and `docs/`.
- Every question, maths or related, has the shape `{ prompt: string, choices: string[4], answer: 0|1|2|3 }`. The four choices are distinct.
- Mouse and touch only. No key listeners. The card never calls `focus()`.
- Nothing is written to the session, transcript or knowledge graph. The only file written is `<ctx.dataDirectory>/config.json`.
- Top up when fewer than 3 unseen related questions remain; 5 per batch; 0.8 s (800 ms) feedback pause.
- Mac only. No iPad page.
- UI copy is plain: "Related", "Maths", "Skip".

## Review Focus

1. Model returns prose, fenced JSON, fewer than four choices, duplicate choices or an out-of-range answer: the batch keeps only valid questions and never throws into the app. (Task 2)
2. `turn-settled` arrives while a question is showing feedback: the card is removed and the pending 800 ms timer does nothing. (Task 3)
3. Turn starts in a chat that is not the one on screen, or the learner navigates away mid-turn: no card, or the card is removed. (Task 3)
4. No Cheap model, consent refused, or the model call fails: Related falls back to Maths with a one-line note; no retry loop. (Tasks 2 and 3)
5. Two `turn-settled` events for one chat in quick succession: only one batch request is in flight per chat. (Task 2)

---

### Task 1: Maths generators

**Files:**
- Create: `plugins/quick-fire/dist/assets/maths.js`
- Test: `plugins/quick-fire/tests/maths.test.mjs`

**Interfaces:**
- Produces: `export const KINDS` = `["times", "addsub", "percent", "twodigit", "returns", "sequence", "series", "thumb"]`
- Produces: `export function mathsQuestion(random = Math.random, kind?) -> { kind, prompt, choices, answer }`. With no `kind`, one is picked uniformly.

- [ ] **Step 1: Write the failing tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { KINDS, mathsQuestion } from "../dist/assets/maths.js";

const seeded = seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

test("every kind gives four distinct choices and a valid answer index", () => {
	for (const kind of KINDS) for (let seed = 1; seed <= 300; seed++) {
		const q = mathsQuestion(seeded(seed), kind);
		assert.equal(q.kind, kind);
		assert.equal(q.choices.length, 4);
		assert.equal(new Set(q.choices).size, 4, `${kind}: ${q.prompt} ${q.choices}`);
		assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3);
		assert.ok(q.prompt.length > 0 && q.prompt.length <= 80);
	}
});
test("times, addsub and twodigit answers are arithmetically right", () => {
	for (const kind of ["times", "addsub", "twodigit"]) for (let seed = 1; seed <= 200; seed++) {
		const q = mathsQuestion(seeded(seed), kind);
		const [, a, op, b] = q.prompt.match(/^(\d+) ([x+-]) (\d+) = \?$/);
		const want = op === "x" ? a * b : op === "+" ? +a + +b : a - b;
		assert.equal(q.choices[q.answer], String(want));
	}
});
test("chained returns compound: the answer never equals the plain sum of the legs", () => {
	for (let seed = 1; seed <= 200; seed++) {
		const q = mathsQuestion(seeded(seed), "returns");
		const legs = [...q.prompt.matchAll(/(Up|down|up) (\d+)%/g)];
		if (!legs.length) continue; // the "100 at 5% a year" form
		const sum = legs.reduce((total, [, way, size]) => total + (way.toLowerCase() === "up" ? +size : -size), 0);
		assert.match(q.choices[q.answer], /%$/);
		assert.notEqual(parseFloat(q.choices[q.answer]), sum, q.prompt);
	}
});
test("with no kind, all eight kinds turn up", () => {
	const seen = new Set();
	const random = seeded(7);
	for (let i = 0; i < 400; i++) seen.add(mathsQuestion(random).kind);
	assert.equal(seen.size, 8);
});
test("the right answer is not always in the same position", () => {
	const random = seeded(3);
	const spots = new Set();
	for (let i = 0; i < 100; i++) spots.add(mathsQuestion(random, "times").answer);
	assert.equal(spots.size, 4);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test plugins/quick-fire/tests/maths.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `maths.js`**

Prompt formats and ranges:

| Kind | Prompt | Ranges |
| --- | --- | --- |
| `times` | `17 x 6 = ?` | a 2-19, b 2-12 |
| `addsub` | `348 + 277 = ?` / `503 - 168 = ?` | both 12-999, subtraction never negative |
| `percent` | `15% of 240 = ?` or `3/8 as a decimal = ?` | percent from 5,10,15,20,25,30,40,60,75 of a multiple of 20 up to 800; fractions with denominator 4, 5, 8, 16, 20 |
| `twodigit` | `23 x 47 = ?` | both 11-99 |
| `returns` | `Up 10%, then down 10%. Net change?` or `100 at 5% a year for 3 years = ?` | 2-3 legs from ±5, 10, 20, 25, 50%; answer to 1 dp with sign and `%`; compounding answer to nearest whole number |
| `sequence` | `3, 6, 12, 24, ?` | arithmetic, geometric (ratio 2 or 3), `x2 + 1`, squares, Fibonacci-style; 4 terms shown |
| `series` | `1 + 2 + ... + 40 = ?` or `1 + 1/2 + 1/4 + ... = ?` | n 10-100; infinite geometric with first term 1-4 and ratio 1/2, 1/3, 1/4 |
| `thumb` | `Roughly how many years to double at 8%?` / `1.02 to the power 5, roughly?` / `0.125 as a fraction?` | rule of 72 with rates dividing 72; powers of 1.01-1.10 up to 10, 2 dp; decimals for 1/8, 3/8, 5/8, 7/8, 1/6, 1/3, 2/3, 1/16 |

Wrong choices are slips a person makes: ±10, ±1 in the last digit, sum instead of product of the legs (the `0%` trap), the neighbouring term rule. For `thumb` "roughly" questions, wrong choices differ from the right one by at least 10% of its value. Build choices as strings, dedupe, top up with further slips until there are four, then shuffle with the supplied `random`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test plugins/quick-fire/tests/maths.test.mjs`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit** (only if Isaac has asked for commits)

```bash
git add plugins/quick-fire/dist/assets/maths.js plugins/quick-fire/tests/maths.test.mjs
git commit -m "feat(quick-fire): maths question generators"
```

---

### Task 2: Backend, related-question batches and settings

**Files:**
- Create: `plugins/quick-fire/dist/backend.cjs`
- Test: `plugins/quick-fire/tests/backend.test.cjs`

**Interfaces:**
- Produces (frontend calls through `ctx.call`):
  - `"settings"` `() -> { enabled: boolean, mode: "related" | "maths" }`. Defaults when no file: `{ enabled: true, mode: "related" }`.
  - `"save-settings"` `(partial) -> settings`. Rejects unknown keys and wrong types. Atomic write (temp file then rename) to `config.json`.
  - `"take"` `({ chatId }) -> { question: Question | null, note: string }`. Removes and returns the next unseen question for that chat. `note` is `""`, or the reason none is available: `"No Cheap model is set in Settings."`, `"Related questions are not ready yet."`, or `"Could not write related questions."`.
- Produces: `exports._internal = { lessonText, batchPrompt, parseBatch, createPool }`
  - `lessonText(session) -> string`: the session's text blocks, labelled `Teacher:` / `Learner:`, **stopping at the last learner message** (role `user` or `toolResult`); anything the tutor said after it is left out. Last 8 messages, each cut to 1,500 characters. Returns `""` when there is no learner message.
  - `batchPrompt(lesson) -> string`
  - `parseBatch(text) -> Question[]`
  - `createPool({ write, low = 3 }) -> { take(chatId), settled(chatId), size(chatId) }` where `write(chatId) -> Promise<Question[]>`.
- Consumes from the host: `ctx.handle`, `ctx.events.on`, `ctx.learning.getSession(id)`, `ctx.inference.catalog()`, `ctx.inference.complete({ model, context, purpose: "background", options: { maxTokens: 1200 }, signal: ctx.signal })`, `ctx.dataDirectory`, `ctx.signal`, `ctx.cleanup`.

- [ ] **Step 1: Write the failing tests**

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { lessonText, batchPrompt, parseBatch, createPool } = require("../dist/backend.cjs")._internal;

const q = n => ({ prompt: `Q${n}?`, choices: ["a", "b", "c", "d"], answer: 0 });
const text = t => [{ type: "text", text: t }];

test("lesson text stops at the last learner message", () => {
	const session = { title: "Bonds", messages: [
		{ role: "assistant", content: text("Duration measures rate sensitivity.") },
		{ role: "user", content: "It rises with maturity." },
		{ role: "assistant", content: text("PENDING CHECK: what is convexity?") },
	] };
	const out = lessonText(session);
	assert.match(out, /Duration measures/);
	assert.match(out, /Learner: It rises/);
	assert.doesNotMatch(out, /PENDING CHECK/);
});
test("lesson text is empty with no learner message or no session", () => {
	assert.equal(lessonText(null), "");
	assert.equal(lessonText({ messages: [{ role: "assistant", content: text("Hi") }] }), "");
});
test("the prompt asks for 5 questions and forbids new material", () => {
	const prompt = batchPrompt("Teacher: x");
	assert.match(prompt, /5/);
	assert.match(prompt, /only .*already/i);
	assert.match(prompt, /JSON/);
});
test("parseBatch reads plain and fenced JSON", () => {
	const body = JSON.stringify([q(1), q(2)]);
	assert.equal(parseBatch(body).length, 2);
	assert.equal(parseBatch("Here you go:\n```json\n" + body + "\n```").length, 2);
});
test("parseBatch drops malformed questions and never throws", () => {
	const bad = [
		{ prompt: "", choices: ["a", "b", "c", "d"], answer: 0 },
		{ prompt: "x", choices: ["a", "b", "c"], answer: 0 },
		{ prompt: "x", choices: ["a", "a", "c", "d"], answer: 0 },
		{ prompt: "x", choices: ["a", "b", "c", "d"], answer: 4 },
		{ prompt: "x", choices: ["a", "b", "c", 5], answer: 1 },
		q(9),
	];
	assert.deepEqual(parseBatch(JSON.stringify(bad)), [q(9)]);
	for (const junk of ["", "not json", "{}", "[1,2]", "null"]) assert.deepEqual(parseBatch(junk), []);
});
test("the pool tops up below 3, once at a time, and hands questions out once", async () => {
	let calls = 0;
	const pool = createPool({ write: async () => { calls++; return [q(1), q(2), q(3), q(4), q(5)]; } });
	assert.equal(pool.take("c1"), null);
	await Promise.all([pool.settled("c1"), pool.settled("c1")]);
	assert.equal(calls, 1);
	assert.equal(pool.size("c1"), 5);
	await pool.settled("c1");
	assert.equal(calls, 1);
	assert.equal(pool.take("c1").prompt, "Q1?");
	pool.take("c1"); pool.take("c1");
	await pool.settled("c1");
	assert.equal(calls, 2);
	assert.equal(pool.size("c2"), 0);
});
test("a failed write leaves the pool usable", async () => {
	let fail = true;
	const pool = createPool({ write: async () => { if (fail) throw new Error("no"); return [q(1)]; } });
	await pool.settled("c1");
	assert.equal(pool.size("c1"), 0);
	fail = false;
	await pool.settled("c1");
	assert.equal(pool.size("c1"), 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test plugins/quick-fire/tests/backend.test.cjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the four pure functions and `createPool`**

`parseBatch`: take the text from the first `[` to the last `]`, `JSON.parse` inside try/catch, keep items with a non-empty string `prompt` (cut to 160 characters), exactly four distinct non-empty string `choices` (each cut to 60), and integer `answer` 0-3.

`batchPrompt` wording (fixed):

```
You write quick recall questions for a learner who is waiting for their tutor.

Write 5 multiple-choice questions on the lesson excerpt below.
- Use only facts the excerpt has already taught. Never introduce new material and never ask about anything the excerpt has not explained.
- Each question is one line and answerable in under ten seconds.
- Exactly four short choices, one correct, three plausible.

Reply with JSON only: [{"prompt": "...", "choices": ["...", "...", "...", "..."], "answer": 0}] where answer is the index of the correct choice.

Lesson excerpt:
<lesson>
```

`createPool`: a `Map` of chatId to queue, and a `Set` of chatIds with a write in flight. `settled` returns the in-flight promise's completion and swallows write errors.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test plugins/quick-fire/tests/backend.test.cjs`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Implement `exports.activate(ctx)`**

- `write(chatId)`: `lessonText(ctx.learning.getSession(chatId))`; return `[]` if empty. Read `(await ctx.inference.catalog()).slots?.cheap`; if missing, record the note `"No Cheap model is set in Settings."` for that chat and return `[]`. Otherwise call `ctx.inference.complete` with the slot's model (and its `thinkingLevel` if set), `context: { messages: [{ role: "user", content: batchPrompt(lesson), timestamp: Date.now() }] }`, and the options in Interfaces. If `stopReason` is `"error"` or `"aborted"`, or the call throws, record `"Could not write related questions."` and return `[]`. Otherwise clear the note and return `parseBatch` of the joined text blocks.
- `ctx.events.on(event => { if (event.type === "turn-settled") pool.settled(event.chatId); })` (the listener takes every event; there is no topic argument), unsubscribed in `ctx.cleanup`. Skip when settings say `enabled: false` or `mode: "maths"`.
- `"take"`: when the queue is empty, `note` is the recorded note for that chat or `"Related questions are not ready yet."`.
- Handlers and settings as in Interfaces.

- [ ] **Step 6: Run the tests again**

Run: `node --test plugins/quick-fire/tests/backend.test.cjs`
Expected: 7 pass, 0 fail.

- [ ] **Step 7: Commit** (only if Isaac has asked for commits)

```bash
git add plugins/quick-fire/dist/backend.cjs plugins/quick-fire/tests/backend.test.cjs
git commit -m "feat(quick-fire): related-question batches and settings"
```

---

### Task 3: The card

**Files:**
- Create: `plugins/quick-fire/dist/manifest.json`, `plugins/quick-fire/dist/main.js`, `plugins/quick-fire/dist/styles.css`, `plugins/quick-fire/README.md`
- Create: `plugins/quick-fire/dist/assets/card.js`
- Test: `plugins/quick-fire/tests/card.test.mjs`

**Interfaces:**
- Consumes: `mathsQuestion` (Task 1); `ctx.call("settings" | "save-settings" | "take")` (Task 2); `ctx.onAppEvent`, `ctx.app.pathname()`, `ctx.registerSettings`, `ctx.cleanup`.
- Produces, in `card.js` (no DOM access, so it is testable in Node):
  `export function createCard({ nextQuestion, render, setTimer = setTimeout, clearTimer = clearTimeout, pause = 800 }) -> { open(), close(), choose(index), skip(), state() }`
  - `nextQuestion() -> Promise<Question & { note?: string }>`
  - `render(state | null)` is called with every new state and with `null` on close.
  - `state() -> null | { question, picked: number | null, streak: number, note: string }`

- [ ] **Step 1: Write the failing tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCard } from "../dist/assets/card.js";

const q = n => ({ prompt: `Q${n}`, choices: ["a", "b", "c", "d"], answer: 1 });
function rig() {
	let n = 0; const timers = []; const frames = [];
	const card = createCard({
		nextQuestion: async () => q(++n), render: s => frames.push(s),
		setTimer: fn => (timers.push(fn), timers.length - 1), clearTimer: id => { timers[id] = null; },
	});
	const tick = async () => { for (const fn of timers.splice(0)) fn?.(); await null; await null; };
	return { card, frames, tick };
}

test("a right answer raises the streak, a wrong one resets it", async () => {
	const { card, tick } = rig();
	await card.open();
	card.choose(1); assert.equal(card.state().streak, 1); assert.equal(card.state().picked, 1);
	await tick(); assert.equal(card.state().question.prompt, "Q2"); assert.equal(card.state().picked, null);
	card.choose(0); assert.equal(card.state().streak, 0);
});
test("a second tap during feedback is ignored", async () => {
	const { card } = rig();
	await card.open();
	card.choose(0); card.choose(1);
	assert.equal(card.state().picked, 0); assert.equal(card.state().streak, 0);
});
test("skip moves on at once and keeps the streak", async () => {
	const { card } = rig();
	await card.open(); card.choose(1);
	await card.skip();
	assert.equal(card.state().question.prompt, "Q2"); assert.equal(card.state().streak, 1);
});
test("closing during feedback renders null and the timer does nothing", async () => {
	const { card, frames, tick } = rig();
	await card.open(); card.choose(1); card.close();
	assert.equal(frames.at(-1), null);
	await tick();
	assert.equal(card.state(), null); assert.equal(frames.at(-1), null);
});
test("a question that arrives after close is dropped", async () => {
	let release; const frames = [];
	const card = createCard({ nextQuestion: () => new Promise(r => { release = r; }), render: s => frames.push(s) });
	const opening = card.open(); card.close(); release(q(1)); await opening;
	assert.equal(card.state(), null);
});
test("opening twice does not fetch twice", async () => {
	const { card } = rig();
	await Promise.all([card.open(), card.open()]);
	assert.equal(card.state().question.prompt, "Q1");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test plugins/quick-fire/tests/card.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `card.js`**

Keep a generation counter that `close()` bumps; any awaited question or timer whose generation is stale is dropped.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test plugins/quick-fire/tests/card.test.mjs`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Write `manifest.json`, `main.js`, `styles.css`**

`manifest.json`: the Global Constraints values, `"main": "main.js"`, `"backend": "backend.cjs"`, `"styles": "styles.css"`, description `"Quick questions in a corner card while the tutor is thinking. Related questions use your Cheap model and may incur cost; Maths is free."`

`main.js` `export function activate(ctx)`:
- Load settings once with `ctx.call("settings")`; keep them in a local variable.
- `ctx.onAppEvent(event => ...)`: on `turn-started`, if `settings.enabled` and `ctx.app.pathname()` ends with `/${event.chatId}`, remember `activeChat = event.chatId` and `card.open()`. On `turn-settled` for `activeChat`, `card.close()`.
- While a card is open, check every 500 ms that the pathname still ends with `/${activeChat}`; if not, `card.close()`. Clear the interval on close.
- `nextQuestion`: in `maths` mode return `mathsQuestion()`. In `related` mode `await ctx.call("take", { chatId: activeChat })`; if `question` is null or the call throws, return `{ ...mathsQuestion(), note }`.
- `render(state)`: create one `<div class="quick-fire-card" role="group" aria-label="Quick Fire">` appended to `document.body` on first non-null state and removed on `null`. Build with `textContent` only (model text is never inserted as HTML). Contents: prompt; four `<button type="button" tabindex="-1">` choices; a footer with two mode buttons (`Related`, `Maths`, the current one marked `aria-pressed="true"`), a `Skip` button and the streak number; the note line when `note` is non-empty. After a pick, the right choice gets class `is-right` and a wrong pick gets `is-wrong`. Buttons call `preventDefault()` on `mousedown` so the answer box keeps focus.
- Mode buttons: update the local setting, `ctx.call("save-settings", { mode })`, then `card.skip()`.
- `ctx.registerSettings({ rows })` with a `toggle` row `enabled` ("Show questions while the tutor is thinking") and a `dropdown` row `mode` ("Start in": `Related`, `Maths`); each `onChange` saves through `save-settings` and then updates the handle.
- `ctx.cleanup`: close the card, clear the interval, unsubscribe.

`styles.css`, everything under `.quick-fire-card`: `position: fixed; right: 24px; bottom: 96px; width: 300px; z-index: 40;` background `var(--background)`, text `var(--foreground)`, `1px solid var(--border)`, 12px radius, soft shadow; choices in a 2 x 2 grid with a 44px minimum height; `is-right` green and `is-wrong` red using `color-mix` with the theme foreground so both themes stay readable; `@media (prefers-reduced-motion: no-preference)` for a 120 ms fade-in only.

`README.md`: what it does, the two modes, that Related uses the Cheap model slot, install steps (copy `dist` to `<data>/plugins/quick-fire/dist`, enable under Settings → Community plugins, restart), and the test commands.

- [ ] **Step 6: Run all plugin tests**

Run: `node --test plugins/quick-fire/tests/`
Expected: 18 pass, 0 fail.

- [ ] **Step 7: Check it in the running app with a scratch profile**

Run the dev app against a disposable data folder (see `docs/development.md`, "Safe local work") on port 3001, copy `plugins/quick-fire/dist` into `<scratch data>/plugins/quick-fire/dist`, enable it, start a lesson and confirm in the Browser pane:
- the card appears when a turn starts and is gone when it settles;
- typing in the answer box still works while the card is up;
- Skip, the mode toggle and right/wrong colours work in light and dark themes;
- with no Cheap model the card shows Maths and the note.

If the scratch profile has no working model, say so and report which of these were checked.

- [ ] **Step 8: Commit** (only if Isaac has asked for commits)

```bash
git add plugins/quick-fire docs/superpowers
git commit -m "feat(quick-fire): corner card of quick questions while the tutor thinks"
```

---

### Task 4: Install into Isaac's app (needs his go-ahead)

- [ ] **Step 1:** Ask Isaac before touching the installed app's data folder.
- [ ] **Step 2:** Copy `plugins/quick-fire/dist` to `~/Library/Application Support/LearnHarness/data/plugins/quick-fire/dist`. Touch nothing else there.
- [ ] **Step 3:** Isaac enables Quick Fire under Settings → Community plugins and restarts the app. Check the Cheap model slot is set under Settings → Agent → Models if he wants Related questions.
