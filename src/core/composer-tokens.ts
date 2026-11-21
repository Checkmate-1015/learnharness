import { collectCitations, collectPlanNodeComments, type PlanNodeComment, type TutorCitation } from "./citations.ts";
import { parseFilePaths } from "./file-paths.ts";

/** A lossless projection of learner text into the composer's atomic tokens:
 *  quoted file paths, tutor citations and plan-node comments. A link wins
 *  over anything that looks like a path inside it. */
export type ComposerToken =
	| { kind: "text"; text: string; start: number; end: number }
	| { kind: "path"; text: string; path: string; start: number; end: number }
	| { kind: "citation"; text: string; citation: TutorCitation; start: number; end: number }
	| { kind: "planNode"; text: string; planNode: PlanNodeComment; start: number; end: number };

export function parseComposerTokens(text: string): ComposerToken[] {
	const tokens: ComposerToken[] = [];
	let cursor = 0;
	const gap = (end: number) => {
		if (end <= cursor) return;
		for (const part of parseFilePaths(text.slice(cursor, end))) {
			tokens.push({ ...part, start: part.start + cursor, end: part.end + cursor });
		}
	};
	const links: ComposerToken[] = [
		...collectCitations(text).map((o) => ({ kind: "citation" as const, text: o.source, citation: o.citation, start: o.start, end: o.end })),
		...collectPlanNodeComments(text).map((o) => ({ kind: "planNode" as const, text: o.source, planNode: o.planNode, start: o.start, end: o.end })),
	].sort((a, b) => a.start - b.start);
	for (const link of links) {
		gap(link.start);
		tokens.push(link);
		cursor = link.end;
	}
	gap(text.length);
	return tokens;
}
