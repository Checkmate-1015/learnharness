/** Local patch (ask-first): a set-aside question tells the teacher to re-ask it. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { compactAnswerForModel, dismissedAnswer } from "../src/core/question-core.ts";

it("set-aside dismissals reach the model with a re-ask note and the reading thoughts", () => {
	const out = compactAnswerForModel({ ...dismissedAnswer("quiz", "Is S p.d.?"), setAside: true, readingThinking: "why det?" });
	assert.equal(out.setAside, true);
	assert.equal(out.dismissed, true);
	assert.match(String(out.note), /pose this same question again/);
	assert.equal(out.thinkingWhileReading, "why det?");
	assert.deepEqual(compactAnswerForModel(dismissedAnswer("quiz", "q")), { kind: "quiz", dismissed: true });
});
