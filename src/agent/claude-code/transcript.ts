import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

export type ClaudeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type ClaudeInput = {
	systemPrompt: string;
	tools: Tool[];
	userContent: ClaudeContentBlock[];
};

type ReplayPart = string | ImageContent;

function toImageBlock(image: ImageContent): ClaudeContentBlock {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	return [text ? `${label}\n${text}` : label, ...images];
}

function getReplayParts(message: Message): ReplayPart[] {
	switch (message.role) {
		case "system":
			return [];

		case "user":
			return getLabelledParts("[user]", message.content);

		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`[assistant]\n${block.text}`];
				if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
				return [];
			});

		case "toolResult": {
			const label = message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`;
			return getLabelledParts(label, message.content);
		}
	}
}

function toContentBlocks(parts: ReplayPart[]): ClaudeContentBlock[] {
	const blocks: ClaudeContentBlock[] = [];
	let pendingText: string[] = [];

	const flushText = () => {
		if (pendingText.length > 0) blocks.push({ type: "text", text: pendingText.join("\n\n") });
		pendingText = [];
	};

	for (const part of parts) {
		if (typeof part === "string") {
			pendingText.push(part);
		} else {
			flushText();
			blocks.push(toImageBlock(part));
		}
	}

	flushText();

	return blocks;
}

function toUnlabelledBlocks(content: string | (TextContent | ImageContent)[]): ClaudeContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];

	return content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : toImageBlock(block)));
}

function toUserContent(conversation: Message[]): ClaudeContentBlock[] {
	const [first] = conversation;
	const leadsWithUser = first?.role === "user";
	const blocks: ClaudeContentBlock[] = leadsWithUser ? toUnlabelledBlocks(first.content) : [];
	let pending: ReplayPart[] = [];

	const flush = () => {
		blocks.push(...toContentBlocks(pending));
		pending = [];
	};

	for (const message of leadsWithUser ? conversation.slice(1) : conversation) {
		pending.push(...getReplayParts(message));
		if (message.role === "user") flush();
	}

	flush();

	return blocks;
}

export const REPLAY_TOOL_CALL_RULE =
	"## Transcript replay\n\n" +
	"The conversation so far arrives as a text transcript. Lines like `[tool call quiz] {...}` and `[tool result quiz]` are RECORDS of tool calls that were already made through the real tools. " +
	"Never write such a line, or a tool's JSON arguments, in your own reply: the learner would see raw JSON and nothing would happen. " +
	"To ask a question, deliver prose, or use any tool now, call the actual tool.";

export function toClaudeInput(messages: Message[], resumeAfter = 0): ClaudeInput {
	const conversation = messages.filter((message) => message.role !== "system");

	// Local patch (cli-replay-guard): the replay below renders past tool calls
	// as "[tool call NAME] {json}" text. Models (seen with Sonnet) then copy
	// that line into their own reply instead of calling the tool, so the
	// learner sees raw JSON and no question. Say plainly that those lines are
	// records only.
	const replayed = conversation.slice(resumeAfter);
	const replaysToolCalls = replayed.length > 1 && replayed.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall"));
	const basePrompt = getCurrentSystemPrompt(messages);
	return {
		systemPrompt: replaysToolCalls ? `${basePrompt}\n\n${REPLAY_TOOL_CALL_RULE}` : basePrompt,
		tools: getCurrentTools(messages),
		userContent: toUserContent(replayed),
	};
}

export function toStreamJsonLine(content: ClaudeContentBlock[]): string {
	return JSON.stringify({ type: "user", message: { role: "user", content } });
}
