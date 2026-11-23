import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hiddenUnitsBefore, hiddenUnitsFor, unitsOf, unitStarts, unitWeights } from "../components/history-window.tsx";

// Local Intel-build patch: the transcript history window (components/history-window.tsx).
const text = (n: number) => ({ type: "text", text: "x".repeat(n) });
const messages = [
	{ role: "user", parts: [text(100)] },
	{ role: "assistant", parts: [{ type: "step-start" }, text(1000), text(2000)] },
	{ role: "user", parts: [] },
	{ role: "assistant", parts: [] },
	{ role: "assistant", parts: [text(500), { type: "tool-quiz", input: { q: "y".repeat(300) }, output: { a: 1 } }] },
];

describe("history window", () => {
	it("windows assistant groups by part and every other row as one unit", () => {
		assert.deepEqual(messages.map(unitsOf), [1, 3, 1, 1, 2]);
		assert.deepEqual(unitStarts(messages), [0, 1, 4, 5, 6]);
		const weights = unitWeights(messages);
		assert.equal(weights.length, 8, "one weight per unit, aligned with unitStarts");
		assert.equal(weights[2], 64 + 1000);
		assert.ok(weights[7]! > 300, "tool input/output count toward the cost");
	});

	it("hides only what lies beyond the budget, counted back from the end", () => {
		const weights = unitWeights(messages);
		assert.equal(hiddenUnitsFor(weights, weights.length, Number.POSITIVE_INFINITY), 0);
		assert.equal(hiddenUnitsFor(weights, weights.length, 1), 7, "the newest unit always renders");
		const hidden = hiddenUnitsFor(weights, weights.length, 1500);
		assert.ok(hidden > 0 && hidden < weights.length);
		const shown = weights.slice(hidden).reduce((a, b) => a + b, 0);
		assert.ok(shown >= 1500, "renders at least the budget");
		assert.ok(shown - weights[hidden]! < 1500, "and stops at the first unit that meets it");
	});

	it("the lazy walk-back picks exactly the boundary the full weighing does", () => {
		const weights = unitWeights(messages);
		for (const end of [0, 1, 3, 4, 5, 6, 7, 8, Number.POSITIVE_INFINITY]) {
			for (const budget of [0, 1, 64, 600, 1100, 1500, 2500, 4000, 1e9]) {
				assert.equal(hiddenUnitsBefore(messages, end, budget), hiddenUnitsFor(weights, Math.min(end, weights.length), budget), `end ${end}, budget ${budget}`);
			}
		}
		assert.equal(hiddenUnitsBefore([], Number.POSITIVE_INFINITY, 100), 0);
	});

	it("loading earlier only ever moves the boundary back toward the start", () => {
		const weights = unitWeights(messages);
		let hidden = hiddenUnitsFor(weights, weights.length, 600);
		const seen = [hidden];
		while (hidden > 0) {
			const next = hiddenUnitsFor(weights, hidden, 600);
			assert.ok(next < hidden);
			hidden = next;
			seen.push(hidden);
		}
		assert.equal(seen.at(-1), 0);
	});
});
