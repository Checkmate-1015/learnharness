import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type StreamFunction } from "@earendil-works/pi-ai";
import { refusalMessage, withRefusalCategory } from "../src/agent/refusal-details.ts";

type Script = { raw: unknown[]; final: Partial<AssistantMessage> & { rawStopReason?: string } };

/** A provider that reports raw events to the observer, then ends with an error message. */
function fakeProvider(script: Script): StreamFunction {
	return ((model: unknown, _context: unknown, options?: { onProviderStreamEvent?: (raw: unknown, model: unknown) => unknown }) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			for (const raw of script.raw) await options?.onProviderStreamEvent?.(raw, model);
			const error = { role: "assistant", content: [], stopReason: "error", ...script.final } as unknown as AssistantMessage;
			stream.push({ type: "error", reason: "error", error } as never);
			stream.end();
		})();
		return stream;
	}) as unknown as StreamFunction;
}

async function run(script: Script, observer?: (raw: unknown) => void): Promise<AssistantMessage> {
	const stream = await withRefusalCategory(fakeProvider(script))({} as never, { messages: [] } as never, {
		onProviderStreamEvent: observer ? (raw: unknown) => observer(raw) : undefined,
	} as never);
	return stream.result();
}

const refusalDelta = (details: unknown) => ({ type: "message_delta", delta: { stop_reason: "refusal", stop_details: details } });

test("refusalMessage formats explanation and category", () => {
	assert.equal(refusalMessage({ category: "bio", explanation: "Blocked." }), "Blocked. (refusal category: bio)");
	assert.equal(refusalMessage({ category: null, explanation: "Blocked." }), "Blocked.");
	assert.equal(refusalMessage(null), "The model refused to complete the request");
	assert.equal(refusalMessage({ category: "  ", explanation: "" }), "The model refused to complete the request");
});

test("an API refusal keeps its category on the error message", async () => {
	const message = await run({
		raw: [refusalDelta({ type: "refusal", category: "reasoning_extraction", explanation: "Blocked." })],
		final: { rawStopReason: "refusal", errorMessage: "Blocked." },
	});
	assert.equal(message.errorMessage, "Blocked. (refusal category: reasoning_extraction)");
});

test("a refusal without a category is left untouched", async () => {
	for (const details of [null, { type: "refusal", category: null, explanation: "Blocked." }]) {
		const message = await run({ raw: [refusalDelta(details)], final: { rawStopReason: "refusal", errorMessage: "Blocked." } });
		assert.equal(message.errorMessage, "Blocked.");
	}
});

test("a non-refusal error is left untouched", async () => {
	const message = await run({
		raw: [{ type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "error" }, null, "noise"],
		final: { errorMessage: "503 status code (no body)" },
	});
	assert.equal(message.errorMessage, "503 status code (no body)");
});

test("the caller's observer still receives every raw event", async () => {
	const seen: unknown[] = [];
	const raw = [{ type: "message_start" }, refusalDelta({ category: "cyber" })];
	await run({ raw, final: { rawStopReason: "refusal", errorMessage: "Blocked." } }, (event) => seen.push(event));
	assert.deepEqual(seen, raw);
});
