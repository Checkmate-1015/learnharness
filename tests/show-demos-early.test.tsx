/**
 * Local patch (show-demos-early): a finished demo/figure renders in its
 * dispatch card while a pending question holds back delivery.
 */
import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DispatchCard, earlyArtifact } from "../components/artifacts/dispatch-card.tsx";
import { ChatActionsContext } from "../components/chat.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import type { JobRecord } from "../src/core/contracts.ts";

const demoJob = (over: Partial<JobRecord> = {}): JobRecord => ({
	id: "job-1",
	kind: "demo",
	chatId: "chat-1",
	toolCallId: "call-1",
	status: "done",
	activity: "",
	createdAt: "2026-11-21T00:00:00.000Z",
	updatedAt: "2026-11-21T00:00:00.000Z",
	delivery: { kind: "result", status: "pending" },
	result: { title: "Pendulum", html: "<html><body>swing</body></html>", tested: true },
	...over,
});

function render(job: JobRecord, questionPending: boolean): string {
	const actions = { chatId: "chat-1", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {}, questionPending };
	return renderToStaticMarkup(
		<ChatActionsContext.Provider value={actions}>
			<JobsContext.Provider value={[job]}>
				<DispatchCard toolCallId={job.toolCallId} kind={job.kind} />
			</JobsContext.Provider>
		</ChatActionsContext.Provider>,
	);
}

describe("show demos early", () => {
	it("renders the finished demo while a question is pending", () => {
		const html = render(demoJob(), true);
		assert.match(html, /data-testid="dispatch-early-artifact"/);
		assert.match(html, /data-testid="demo-iframe"/);
	});
	it("keeps the quiet line when no question is pending", () => {
		const html = render(demoJob(), false);
		assert.doesNotMatch(html, /demo-iframe/);
		assert.match(html, /dispatch-settled/);
	});
	it("hands over to the steer card once delivered", () => {
		assert.equal(earlyArtifact(demoJob({ delivery: { kind: "result", status: "delivered" } }), true), false);
	});
	it("skips failed builds and still-running jobs", () => {
		assert.equal(earlyArtifact(demoJob({ result: { title: "x", html: "", tested: true } }), true), false);
		assert.equal(earlyArtifact(demoJob({ status: "running" }), true), false);
	});
	it("covers figures too", () => {
		assert.equal(earlyArtifact(demoJob({ kind: "visual", result: { svg: "<svg/>" } }), true), true);
	});
});
