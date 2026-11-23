/** Local patch (cli-replay-guard): replayed tool calls come with a "records only" rule. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLAY_TOOL_CALL_RULE, toClaudeInput } from "../src/agent/claude-code/transcript.ts";

test("a replay with tool calls tells the model never to type tool calls", () => {
	const messages = [
		{ role: "system", content: "You are a tutor." },
		{ role: "user", content: "hi", timestamp: 0 },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "quiz", arguments: { question: "q" } }], timestamp: 0 },
		{ role: "toolResult", toolCallId: "t1", toolName: "quiz", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 0 },
		{ role: "user", content: "next", timestamp: 0 },
	] as never;
	assert.ok(toClaudeInput(messages).systemPrompt.endsWith(REPLAY_TOOL_CALL_RULE));
	assert.ok(!toClaudeInput([{ role: "system", content: "p" }, { role: "user", content: "hi", timestamp: 0 }] as never).systemPrompt.includes("Transcript replay"));
});

import { salvageTypedToolCall } from "../src/agent/claude-code/salvage.ts";

test("a typed quiz call is cut out of the prose and returned as a real call", () => {
	const text = 'Now test it.\n\n[tool call quiz] {"type":"check","question":"What is \\\\max_{|x|=1} {braces} \\"q\\"?","options":[{"label":"1","value":"a"}],"correctAnswer":"a"}\n';
	const got = salvageTypedToolCall(text, new Set(["quiz"]));
	assert.ok(got);
	assert.equal(got.name, "quiz");
	assert.equal(got.text, "Now test it.");
	assert.equal((got.arguments as { correctAnswer: string }).correctAnswer, "a");
	assert.equal(salvageTypedToolCall(text, new Set(["probe"])), null);
	assert.equal(salvageTypedToolCall("[tool call quiz] {broken", new Set(["quiz"])), null);
});

import { questionLacksDeliveredProse } from "../src/agent/narration-guard.ts";

test("CLI thinking that talks to the learner, with no delivered prose, blocks the next question", () => {
	const leaked = { role: "assistant", content: [{ type: "thinking", thinking: "Your σ₁ = √(3+2√2) is correct, and it equals 1+√2, not the 5.83 you picked." }, { type: "toolCall", id: "t", name: "quiz", arguments: {} }] } as never;
	assert.equal(questionLacksDeliveredProse(leaked, "quiz"), true);
	assert.equal(questionLacksDeliveredProse(leaked, "quiz", true), false);
	const reasoning = { role: "assistant", content: [{ type: "thinking", thinking: "I should check the eigenvalues of A^T A before posing the next check." }, { type: "toolCall", id: "t", name: "quiz", arguments: {} }] } as never;
	assert.equal(questionLacksDeliveredProse(reasoning, "quiz"), false);
});
