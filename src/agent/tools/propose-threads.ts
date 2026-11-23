import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { FOLDER_TOOL_KEYS, PROPOSE_THREADS_TOOL, UPDATE_FOLDER_SETTINGS_TOOL, START_THREAD_TOOL, parseThreadProposal } from "../../core/orchestration.ts";

/** LOCAL PATCH (folder-orchestrator): the orchestrator's split proposal.
 * The call's arguments ARE the proposal: the transcript card renders one
 * start button per chunk. Nothing starts here. */
const schema = Type.Object({
	resource: Type.String({ description: "The resource being split: its name and path or link." }),
	summary: Type.Optional(Type.String({ description: "One or two sentences on how you split it and why." })),
	chunks: Type.Array(Type.Object({
		title: Type.String({ description: "Short session title, e.g. \"Ch. 3 — Eigenvalues\"." }),
		brief: Type.String({ description: "Self-contained instructions for that session's tutor: resource path, exact chapter/section/page range, what earlier chunks covered, the learner's wishes for this chunk." }),
	}), { minItems: 1, maxItems: 200 }),
});

export const proposeThreadsTool: AgentTool<typeof schema> = {
	name: PROPOSE_THREADS_TOOL,
	label: PROPOSE_THREADS_TOOL,
	description: "Propose how to split a resource into separate study sessions in this folder. Shows the learner one start button per chunk; it starts nothing by itself. Call again with a revised list to change the split.",
	parameters: schema,
	execute: serverExecute(PROPOSE_THREADS_TOOL, schema, async (input) => {
		const proposal = parseThreadProposal(input);
		if (!proposal) return { ok: false, error: "Each chunk needs a non-empty title and a brief." };
		return `Shown to the learner as ${proposal.chunks.length} start button${proposal.chunks.length === 1 ? "" : "s"}. No session has started; the learner starts each one when they choose.`;
	}),
};

/** LOCAL PATCH (folder-orchestrator): the orchestrator saves the folder's
 * "project settings" when the learner asks for them in chat. Omitted fields
 * keep their current value; `instructions` replaces the whole text. */
const settingsSchema = Type.Object({
	instructions: Type.Optional(Type.String({ description: "The COMPLETE folder instructions every session in the folder will follow (replaces the current text; include anything from the current instructions that should stay). Write them as direct instructions to a tutor." })),
	paths: Type.Optional(Type.Array(Type.String(), { description: "The COMPLETE list of resource folders/files (absolute or ~/ paths) every session should use." })),
	tools: Type.Optional(Type.Object(Object.fromEntries(FOLDER_TOOL_KEYS.map((k) => [k, Type.Optional(Type.Union([Type.Boolean(), Type.Null()]))])), { description: "Tool switches for the folder's sessions: research (web), demo (interactive simulations), visual, pdf, explain (true = free-recall questions, false = multiple choice). null = follow the app default." })),
});

export function updateFolderSettingsTool(save: (input: { instructions?: string; paths?: string[]; tools?: Record<string, boolean | null> }) => string): AgentTool<typeof settingsSchema> {
	return {
		name: UPDATE_FOLDER_SETTINGS_TOOL,
		label: UPDATE_FOLDER_SETTINGS_TOOL,
		description: "Save this folder's project settings (instructions, resource folders, tool switches) for every session in it, including sessions started or moved in later. Only call when the learner asked for these settings or agreed to your wording.",
		parameters: settingsSchema,
		execute: serverExecute(UPDATE_FOLDER_SETTINGS_TOOL, settingsSchema, async (input) => {
			try { return save(input as never); }
			catch (error) { return { ok: false, error: (error as Error).message }; }
		}),
	};
}

/** LOCAL PATCH (folder-orchestrator): start one proposed session when the
 * learner asks in words (the card's Start button does the same). */
const startSchema = Type.Object({
	chunk: Type.Optional(Type.Integer({ minimum: 1, description: "The chunk's number in your latest propose_threads list, 1 = first." })),
	title: Type.Optional(Type.String({ description: "Session title. Required when not starting a proposed chunk; otherwise overrides the chunk's title." })),
	brief: Type.Optional(Type.String({ description: "The session's complete brief. Omit to use the chunk's brief; when the learner added wishes, give the chunk's brief plus those wishes." })),
});

export function startThreadTool(start: (input: { chunk?: number; title?: string; brief?: string }) => string): AgentTool<typeof startSchema> {
	return {
		name: START_THREAD_TOOL,
		label: START_THREAD_TOOL,
		description: "Start ONE new study session in this folder, from a chunk of your latest proposal (or a custom title + brief). Only when the learner asks for it. The session appears in the sidebar inside the folder; the learner opens it to begin.",
		parameters: startSchema,
		execute: serverExecute(START_THREAD_TOOL, startSchema, async (input) => {
			try { return start(input); }
			catch (error) { return { ok: false, error: (error as Error).message }; }
		}),
	};
}
