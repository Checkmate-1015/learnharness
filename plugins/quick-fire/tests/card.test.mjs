import assert from "node:assert/strict";
import { test } from "node:test";
import { createCard } from "../dist/assets/card.js";

const q = n => ({ prompt: `Q${n}`, choices: ["a", "b", "c", "d"], answer: 1 });
function rig(nextQuestion) {
	let n = 0; const timers = []; const frames = [];
	const card = createCard({
		nextQuestion: nextQuestion ?? (async () => q(++n)), render: s => frames.push(s),
		setTimer: fn => (timers.push(fn), timers.length - 1), clearTimer: id => { timers[id] = null; },
	});
	const tick = async () => { for (const fn of timers.splice(0)) fn?.(); await null; await null; await null; };
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
	const { card, tick } = rig();
	await card.open(); card.choose(1);
	await card.skip();
	assert.equal(card.state().question.prompt, "Q2"); assert.equal(card.state().streak, 1);
	await tick(); // the cancelled feedback timer must not skip Q2
	assert.equal(card.state().question.prompt, "Q2");
});
test("closing during feedback renders null and the timer does nothing", async () => {
	const { card, frames, tick } = rig();
	await card.open(); card.choose(1); card.close();
	assert.equal(frames.at(-1), null);
	await tick();
	assert.equal(card.state(), null); assert.equal(frames.at(-1), null);
});
test("a question that arrives after close is dropped", async () => {
	let release;
	const { card, frames } = rig(() => new Promise(r => { release = r; }));
	const opening = card.open(); card.close(); release(q(1)); await opening;
	assert.equal(card.state(), null);
	assert.ok(frames.every(frame => frame === null));
});
test("opening twice does not fetch twice", async () => {
	const { card } = rig();
	await Promise.all([card.open(), card.open()]);
	assert.equal(card.state().question.prompt, "Q1");
});
test("reopening starts a fresh streak, and the note travels with the question", async () => {
	const { card } = rig(async () => ({ ...q(1), note: "why" }));
	await card.open(); card.choose(1); card.close();
	await card.open();
	assert.equal(card.state().streak, 0); assert.equal(card.state().note, "why");
});
test("a question source that throws closes the card instead of leaving it stuck", async () => {
	const { card, frames } = rig(async () => { throw new Error("boom"); });
	await card.open();
	assert.equal(card.state(), null); assert.equal(frames.at(-1) ?? null, null);
});
test("choose and skip do nothing while closed", async () => {
	const { card } = rig();
	card.choose(1); await card.skip();
	assert.equal(card.state(), null);
});
test("taps and skips are ignored while the next question is loading", async () => {
	const waiting = []; let n = 0; const frames = []; const timers = [];
	const card = createCard({
		nextQuestion: () => new Promise(resolve => waiting.push(() => resolve(q(++n)))), render: s => frames.push(s),
		setTimer: fn => (timers.push(fn), timers.length - 1), clearTimer: id => { timers[id] = null; },
	});
	const opening = card.open(); waiting.shift()(); await opening;
	const skipping = card.skip();
	void card.skip(); card.choose(1);
	assert.equal(waiting.length, 1, "a second skip must not take another question");
	assert.equal(card.state().picked, null); assert.equal(timers.filter(Boolean).length, 0);
	waiting.shift()(); await skipping;
	assert.equal(card.state().question.prompt, "Q2");
});
