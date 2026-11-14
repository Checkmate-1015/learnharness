import type { AssistantMessage, StreamFunction } from "@earendil-works/pi-ai";

/**
 * Refusal details (issue 474): a policy decline arrives as `stop_reason:
 * "refusal"` with `stop_details: { category, explanation }`. The category says
 * which classifier fired, which is the only way to diagnose a false positive,
 * so it must survive into the saved error message on every provider path.
 */

export const REFUSAL_MESSAGE = "The model refused to complete the request";

export type RefusalDetails = { category?: string | null; explanation?: string | null };

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** `<explanation or fixed message> (refusal category: <category>)`; no suffix without a category. */
export function refusalMessage(details?: RefusalDetails | null): string {
	const category = text(details?.category);
	const message = text(details?.explanation) ?? REFUSAL_MESSAGE;
	return category ? `${message} (refusal category: ${category})` : message;
}

/** Reads `stop_details` off a raw Anthropic `message_delta` event; undefined for anything else. */
export function refusalDetailsOf(raw: unknown): RefusalDetails | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const event = raw as { type?: unknown; delta?: { stop_reason?: unknown; stop_details?: unknown } | null };
	if (event.type !== "message_delta" || event.delta?.stop_reason !== "refusal") return undefined;
	const details = event.delta.stop_details;
	if (typeof details !== "object" || details === null) return {};
	const { category, explanation } = details as { category?: unknown; explanation?: unknown };
	return { category: text(category) ?? null, explanation: text(explanation) ?? null };
}

/**
 * pi-ai's Anthropic adapter keeps a refusal's explanation and drops its
 * category. This wrapper watches the raw provider events (still forwarding
 * them to the caller's observer) and adds the category to the refused
 * message's error text. Non-refusal results pass through untouched.
 */
export function withRefusalCategory(streamFn: StreamFunction): StreamFunction {
	return (model, context, options) => {
		let details: RefusalDetails | undefined;
		const amend = (message: AssistantMessage | undefined) => {
			if (!message || !details || text(details.category) === undefined) return;
			if ((message as { rawStopReason?: string }).rawStopReason !== "refusal") return;
			if (message.errorMessage?.includes("(refusal category: ")) return;
			message.errorMessage = refusalMessage({ category: details.category, explanation: message.errorMessage ?? details.explanation });
		};
		const stream = streamFn(model, context, {
			...options,
			onProviderStreamEvent: async (raw, eventModel) => {
				details = refusalDetailsOf(raw) ?? details;
				await options?.onProviderStreamEvent?.(raw, eventModel);
			},
		});
		// The provider pushes its terminal event onto this same stream object.
		const push = stream.push.bind(stream);
		stream.push = (event) => {
			if (event.type === "error") amend(event.error);
			else if (event.type === "done") amend(event.message);
			push(event);
		};
		return stream;
	};
}
