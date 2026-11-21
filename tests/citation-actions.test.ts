import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { commentOnPlanNode, createCiteAction } from "../components/citation-actions.ts";
import { INSERT_CITATION_EVENT } from "../components/path-input.tsx";
import { parseCitationHref, parsePlanNodeHref } from "../src/core/citations.ts";
import type { CapturedSelection } from "../components/selection-text.ts";

const capture = (text: string): CapturedSelection => ({ messageId: "m9", range: {} as Range, selector: { text, start: 0, end: text.length, prefix: "", suffix: "" } });

describe("createCiteAction", () => {
	it("inserts the citation link into the composer and opens the comment editor", () => {
		const { document } = parseHTML("<html><body><div id='c'></div></body></html>");
		const composer = document.getElementById("c")! as unknown as HTMLElement;
		const seen: unknown[] = [];
		composer.addEventListener(INSERT_CITATION_EVENT, (event) => {
			const detail = (event as CustomEvent).detail;
			seen.push(parseCitationHref(detail.link.slice(detail.link.indexOf("(") + 1, -1)));
			detail.onInserted({ start: 3, end: 3 + detail.link.length, spaceBefore: true, spaceAfter: true });
		});
		const opened: unknown[] = [];
		const action = createCiteAction({ chatId: "c1", composer: () => composer, openEditor: (target) => opened.push(target) });
		assert.equal(action.label, "Cite");
		assert.equal(action.ariaLabel, "Cite selection in your input");
		assert.equal(action.onSelect(capture("the chain")), true);
		assert.deepEqual(seen, [{ version: 1, chatId: "c1", messageId: "m9", text: "the chain", start: 0, end: 9, prefix: "", suffix: "" }]);
		assert.equal((opened[0] as { fresh: { start: number } }).fresh.start, 3);
	});

	it("is hidden without a mounted composer and disabled over the length limit", () => {
		const action = createCiteAction({ chatId: "c1", composer: () => null, openEditor: () => {} });
		assert.equal(action.visible(capture("x")), false);
		assert.equal(action.onSelect(capture("x")), false);
		assert.equal(action.disabledLabel!(capture("x".repeat(8_001))), "Shorten selection");
		assert.equal(action.disabledLabel!(capture("x")), null);
	});
});

describe("commentOnPlanNode", () => {
	it("inserts a plan-node link into the composer and opens the comment editor on it", () => {
		const { document } = parseHTML("<html><body><div id='c'></div></body></html>");
		const composer = document.getElementById("c")! as unknown as HTMLElement;
		const seen: unknown[] = [];
		composer.addEventListener(INSERT_CITATION_EVENT, (event) => {
			const detail = (event as CustomEvent).detail;
			seen.push(parsePlanNodeHref(detail.link.slice(detail.link.indexOf("(") + 1, -1)));
			detail.onInserted({ start: 0, end: detail.link.length, spaceBefore: false, spaceAfter: true });
		});
		const opened: Array<{ citation: unknown; fresh?: unknown }> = [];
		const done = commentOnPlanNode({ chatId: "c1", messageId: "m4", node: { id: "roots", title: "The roots" }, composer: () => composer, openEditor: (target) => opened.push(target) });
		const expected = { version: 1, kind: "plan-node", chatId: "c1", messageId: "m4", nodeId: "roots", title: "The roots" };
		assert.equal(done, true);
		assert.deepEqual(seen, [expected]);
		assert.deepEqual(opened[0]!.citation, expected);
		assert.ok(opened[0]!.fresh);
	});

	it("does nothing without an input to put the chip in", () => {
		assert.equal(commentOnPlanNode({ chatId: "c1", messageId: "m4", node: { id: "a", title: "A" }, composer: () => null, openEditor: () => assert.fail("no editor") }), false);
	});
});
