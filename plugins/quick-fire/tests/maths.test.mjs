import assert from "node:assert/strict";
import { test } from "node:test";
import { KINDS, mathsQuestion } from "../dist/assets/maths.js";

// mulberry32: well mixed from the first draw, so nearby seeds reach every branch.
const seeded = seed => () => {
	seed = (seed + 0x6D2B79F5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test("every kind gives four distinct choices and a valid answer index", () => {
	for (const kind of KINDS) for (let seed = 1; seed <= 3000; seed++) {
		const q = mathsQuestion(seeded(seed), kind);
		assert.equal(q.kind, kind);
		assert.equal(q.choices.length, 4);
		assert.equal(new Set(q.choices).size, 4, `${kind}: ${q.prompt} ${q.choices}`);
		assert.ok(q.choices.every(choice => typeof choice === "string" && choice.length > 0 && !/NaN|Infinity/.test(choice)), `${kind}: ${q.choices}`);
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
		assert.ok(want >= 0);
	}
});
test("chained returns compound: the answer never equals the plain sum of the legs", () => {
	let chained = 0;
	for (let seed = 1; seed <= 200; seed++) {
		const q = mathsQuestion(seeded(seed), "returns");
		const legs = [...q.prompt.matchAll(/(up|down) (\d+)%/gi)];
		if (!legs.length) continue; // the "100 at 5% a year" form
		chained++;
		const sum = legs.reduce((total, [, way, size]) => total + (way.toLowerCase() === "up" ? +size : -size), 0);
		const product = legs.reduce((total, [, way, size]) => total * (1 + (way.toLowerCase() === "up" ? +size : -size) / 100), 1);
		assert.match(q.choices[q.answer], /%$/);
		assert.notEqual(parseFloat(q.choices[q.answer]), sum, q.prompt);
		assert.ok(Math.abs(parseFloat(q.choices[q.answer]) - (product - 1) * 100) <= 0.0501, q.prompt);
	}
	assert.ok(chained > 50);
});
test("rough questions keep wrong choices at least 10% away from the right one", () => {
	for (let seed = 1; seed <= 300; seed++) {
		const q = mathsQuestion(seeded(seed), "thumb");
		if (!/roughly/i.test(q.prompt)) continue;
		const right = parseFloat(q.choices[q.answer]);
		q.choices.forEach((choice, index) => {
			if (index !== q.answer) assert.ok(Math.abs(parseFloat(choice) - right) >= 0.1 * right - 0.005, `${q.prompt} ${q.choices}`);
		});
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
test("compound growth answers are exact and differ from simple interest", () => {
	let seen = 0;
	for (let seed = 1; seed <= 300; seed++) {
		const q = mathsQuestion(seeded(seed), "returns");
		const m = q.prompt.match(/^(\d+) at (\d+)% a year for (\d+) years = \?$/);
		if (!m) continue;
		seen++;
		const [start, rate, years] = m.slice(1).map(Number);
		assert.ok(Math.abs(Number(q.choices[q.answer]) - start * (1 + rate / 100) ** years) < 1e-6, q.prompt);
		assert.ok(q.choices.some(choice => Math.abs(Number(choice) - start * (1 + rate * years / 100)) < 1e-6), `${q.prompt} ${q.choices}`);
		assert.ok(q.choices.every(choice => /^\d+(\.\d{1,2})?$/.test(choice)), `${q.prompt} ${q.choices}`);
	}
	assert.ok(seen > 30);
});
