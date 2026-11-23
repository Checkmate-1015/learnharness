"use client";

/**
 * HISTORY WINDOW (local Intel-build patch). Long sessions used to render
 * every message part, and every KaTeX formula in them, on open: 404 native
 * messages became ~95k DOM nodes and froze an Intel Mac for 7-15 s. Now only
 * the most recent slice renders up front; older parts mount as the learner
 * scrolls up, and the whole history mounts when something needs it (Find,
 * a citation jump, a #message link).
 *
 * The unit is a transcript PART, not a view message: the view groups a whole
 * teaching stretch into one assistant message (one held 385 KB). Each
 * assistant part is one unit; any other message is a single unit. The hidden
 * boundary counts units FROM THE START, so appended turns never push content
 * the learner is reading out of the window; it only ever moves back to 0.
 */

import { startTransition, useEffect, useInsertionEffect, useLayoutEffect, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

/** Characters of content rendered on open, and per scroll-up load. */
export const HISTORY_INITIAL_BUDGET = 12_000;
export const HISTORY_STEP_BUDGET = 30_000;

interface WindowPart { type: string; text?: string; input?: unknown; output?: unknown; data?: unknown }
interface WindowMessage { role: string; parts: readonly WindowPart[] }

/** Assistant parts are individually windowable; other rows are atomic. */
export function unitsOf(message: WindowMessage): number {
	return message.role === "assistant" ? Math.max(1, message.parts.length) : 1;
}

function size(value: unknown): number {
	if (value == null) return 0;
	if (typeof value === "string") return value.length;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

/** Rough render cost per unit (characters of content, plus a floor). */
export function unitWeights(messages: readonly WindowMessage[]): number[] {
	const weights: number[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") {
			weights.push(64 + m.parts.reduce((n, p) => n + size(p.text), 0));
			continue;
		}
		if (m.parts.length === 0) weights.push(64);
		for (const p of m.parts) weights.push(64 + size(p.text) + size(p.input) + size(p.output) + size(p.data));
	}
	return weights;
}

/** First unit index of each message. */
export function unitStarts(messages: readonly WindowMessage[]): number[] {
	let n = 0;
	return messages.map((m) => {
		const start = n;
		n += unitsOf(m);
		return start;
	});
}

/** Units to hide so that only ~budget of content renders before `end`. */
export function hiddenUnitsFor(weights: readonly number[], end: number, budget: number): number {
	let shown = 0;
	let i = end;
	while (i > 0 && shown < budget) shown += weights[--i] ?? 0;
	return i;
}

function unitWeight(m: WindowMessage, k: number): number {
	if (m.role !== "assistant") return 64 + m.parts.reduce((n, p) => n + size(p.text), 0);
	const p = m.parts[k];
	return p ? 64 + size(p.text) + size(p.input) + size(p.output) + size(p.data) : 64;
}

/** hiddenUnitsFor(unitWeights(messages), end, budget), but weighing only the
 *  units it walks back over: opening a long session must not serialize the
 *  whole transcript just to find where its recent slice starts. */
export function hiddenUnitsBefore(messages: readonly WindowMessage[], end: number, budget: number): number {
	let next = 0;
	for (const m of messages) next += unitsOf(m);
	let i = Math.min(end, next);
	let shown = 0;
	for (let mi = messages.length - 1; mi >= 0 && i > 0 && shown < budget; mi--) {
		const m = messages[mi]!;
		const first = next - unitsOf(m);
		next = first;
		while (i > first && shown < budget) {
			i--;
			shown += unitWeight(m, i - first);
		}
	}
	return i;
}

const fullHistoryListeners = new Set<() => void>();

/** Mount the whole transcript (Find, citation jumps, #message links). */
export function requestFullHistory(): void {
	for (const listener of fullHistoryListeners) listener();
}

/** The chat's window state: units hidden from the start of the transcript. */
export function useHistoryWindow(messages: readonly WindowMessage[]) {
	const [hidden, setHidden] = useState(() => hiddenUnitsBefore(messages, Number.POSITIVE_INFINITY, HISTORY_INITIAL_BUDGET));
	const hiddenRef = useRef(hidden);
	hiddenRef.current = hidden;
	useEffect(() => {
		// Find may render the whole history; a transition keeps its input
		// responsive (React expires a starved transition after ~5 s).
		const all = () => startTransition(() => setHidden(0));
		fullHistoryListeners.add(all);
		// A #message link (graph/citation arrival) needs its anchor mounted;
		// SessionMessageNavigation keeps retrying the jump until it exists.
		if (window.location.hash) setHidden(0);
		const onHash = () => { if (window.location.hash) setHidden(0); };
		window.addEventListener("hashchange", onHash, true);
		window.addEventListener("popstate", onHash, true);
		return () => {
			fullHistoryListeners.delete(all);
			window.removeEventListener("hashchange", onHash, true);
			window.removeEventListener("popstate", onHash, true);
		};
	}, []);
	// A plain (not transition) update: the app's background polling would
	// otherwise keep interrupting it until the reader hit the very top.
	const loadEarlier = () => {
		const next = hiddenUnitsBefore(messages, hiddenRef.current, HISTORY_STEP_BUDGET);
		setHidden((h) => Math.min(h, next));
	};
	return { hidden, setHidden, loadEarlier };
}

/**
 * Keeps the reader's place when older parts mount ABOVE them: the distance
 * from the bottom is read just before React mutates the DOM and restored
 * right after. (Browsers skip scroll anchoring at scrollTop 0, which is
 * exactly where a fast scroll-up lands.) Render it BEFORE the sentinel and
 * the rows: siblings commit in order, so the read precedes their insertion.
 */
export function HistoryAnchor({ hidden }: { hidden: number }) {
	const { scrollRef } = useStickToBottomContext();
	const previous = useRef(hidden);
	const fromBottom = useRef<number | null>(null);
	useInsertionEffect(() => {
		const scroller = scrollRef.current;
		fromBottom.current = scroller && hidden < previous.current ? scroller.scrollHeight - scroller.scrollTop : null;
		previous.current = hidden;
	}, [hidden, scrollRef]);
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (scroller && fromBottom.current != null) scroller.scrollTop = scroller.scrollHeight - fromBottom.current;
		fromBottom.current = null;
	}, [hidden, scrollRef]);
	return null;
}

/** Sits above the rendered slice and loads the next slice well before it
 *  scrolls into view. Always mounted (never keyed or removed) so the
 *  anchor's pre-commit read is not skewed by its removal. */
export function HistorySentinel({ hidden, onReach }: { hidden: number; onReach: () => void }) {
	const { scrollRef, isAtBottom } = useStickToBottomContext();
	const ref = useRef<HTMLDivElement>(null);
	const onReachRef = useRef(onReach);
	onReachRef.current = onReach;
	useEffect(() => {
		const el = ref.current;
		const scroller = scrollRef.current;
		if (hidden <= 0 || !el || typeof IntersectionObserver === "undefined") return;
		// Pinned to the latest message: only fill a slice too short to scroll.
		// (On open the scroller sits at the top for a moment before the
		// instant scroll to the bottom; arming then would load extra history.)
		if (isAtBottom) {
			if (scroller && scroller.scrollHeight <= scroller.clientHeight) onReachRef.current();
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => { if (entries.some((e) => e.isIntersecting)) { observer.disconnect(); onReachRef.current(); } },
			{ root: scroller ?? null, rootMargin: "2000px 0px 0px 0px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [scrollRef, isAtBottom, hidden]);
	return (
		<div ref={ref} data-testid={hidden > 0 ? "history-sentinel" : undefined} data-session-find-exclude="" aria-hidden={hidden > 0 ? undefined : true}
			className={hidden > 0 ? "py-2 text-center font-ui text-xs text-muted-foreground/60" : "hidden"}>
			{hidden > 0 ? "Loading earlier messages…" : null}
		</div>
	);
}
