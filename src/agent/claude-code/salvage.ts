/**
 * Local patch (cli-replay-guard): salvage a tool call the model TYPED instead
 * of calling. The CLI replay renders past calls as "[tool call NAME] {json}"
 * text, and Sonnet sometimes copies that form into its reply: the learner
 * sees raw JSON and no question. When a finished reply made no real call but
 * its text holds one such line for a known harness tool with valid JSON
 * arguments, cut it out of the text and return it as a real call.
 */

export interface SalvagedCall { name: string; arguments: Record<string, unknown>; text: string }

/** The index just past the JSON object starting at `start` (a "{"), or -1. */
function objectEnd(s: string, start: number): number {
	let depth = 0, inString = false, escaped = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}") { depth--; if (depth === 0) return i + 1; }
	}
	return -1;
}

const MARKER = /\[tool call ([A-Za-z0-9_\-]+)\]\s*(?=\{)/g;

/** Find the first typed call to a known tool in `text`. */
export function salvageTypedToolCall(text: string, toolNames: ReadonlySet<string>): SalvagedCall | null {
	for (const m of text.matchAll(MARKER)) {
		const name = m[1]!;
		if (!toolNames.has(name)) continue;
		const jsonStart = m.index! + m[0].length;
		const end = objectEnd(text, jsonStart);
		if (end < 0) continue;
		let args: unknown;
		try { args = JSON.parse(text.slice(jsonStart, end)); } catch { continue; }
		if (!args || typeof args !== "object" || Array.isArray(args)) continue;
		const rest = (text.slice(0, m.index!) + text.slice(end)).replace(/\n{3,}/g, "\n\n").trim();
		return { name, arguments: args as Record<string, unknown>, text: rest };
	}
	return null;
}
