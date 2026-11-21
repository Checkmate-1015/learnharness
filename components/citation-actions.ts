import { Quote } from "lucide-react";
import { CITATION_MAX_TEXT_LENGTH, serializeCitation, serializePlanNodeComment, type ComposerCitation, type PlanNodeComment, type TutorCitation } from "@/src/core";
import { INSERT_CITATION_EVENT, type CitationInsertedRange, type InsertCitationDetail } from "./path-input";
import type { SelectionAction } from "./selection-toolbar";

/** A citation chip in the composer whose comment is being edited. `fresh`
 *  marks one inserted just now: Cancel removes it with the spaces it added. */
export interface CitationEditTarget {
	citation: ComposerCitation;
	link: string;
	start: number;
	host?: HTMLElement;
	/** Exact editable host: also supports reading/question/practice thinking. */
	input?: HTMLElement;
	fresh?: CitationInsertedRange;
}

/** The toolbar's Cite button: quote the selection into the composer and
 *  open the comment editor on the new chip. */
export function createCiteAction({ chatId, composer, openEditor }: {
	chatId: string;
	/** The intended editable root: composer or the active thinking field. */
	composer: () => HTMLElement | null;
	openEditor: (target: CitationEditTarget) => void;
}): SelectionAction {
	return {
		id: "cite",
		label: "Cite",
		ariaLabel: "Cite selection in your input",
		icon: Quote,
		disabledLabel: (capture) => (capture.selector.text.length > CITATION_MAX_TEXT_LENGTH ? "Shorten selection" : null),
		visible: () => composer() !== null,
		onSelect: (capture) => {
			const root = composer();
			if (!root) return false;
			const citation: TutorCitation = { version: 1, chatId, messageId: capture.messageId, ...capture.selector };
			const link = serializeCitation(citation);
			const detail: InsertCitationDetail = {
				link,
				onInserted: (fresh) => openEditor({ citation, link, start: fresh.start, fresh, input: root }),
			};
			const View = root.ownerDocument.defaultView;
			root.dispatchEvent(new (View?.CustomEvent ?? CustomEvent)(INSERT_CITATION_EVENT, { detail }));
			return true;
		},
	};
}

/** A click on a node of the presented plan map: put a plan-node chip in the
 *  composer and open the comment editor on it. False when no input is there. */
export function commentOnPlanNode({ chatId, messageId, node, composer, openEditor }: {
	chatId: string;
	messageId: string;
	node: { id: string; title: string };
	composer: () => HTMLElement | null;
	openEditor: (target: CitationEditTarget) => void;
}): boolean {
	const root = composer();
	if (!root) return false;
	const citation: PlanNodeComment = { version: 1, kind: "plan-node", chatId, messageId, nodeId: node.id, title: node.title };
	const link = serializePlanNodeComment(citation);
	const detail: InsertCitationDetail = {
		link,
		onInserted: (fresh) => openEditor({ citation, link, start: fresh.start, fresh, input: root }),
	};
	const View = root.ownerDocument.defaultView;
	root.dispatchEvent(new (View?.CustomEvent ?? CustomEvent)(INSERT_CITATION_EVENT, { detail }));
	return true;
}
