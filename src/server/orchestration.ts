import { stores } from "./stores.ts";
import { sourceDirectory } from "./source-organization.ts";
import { readSettings } from "../store/settings.ts";
import { orchestrationStore } from "../store/orchestration.ts";
import { titleFromPrompt } from "../core/index.ts";
import {
	emptyOrchestration, layeredContext, parseFolderConfigInput, parseThreadProposal, threadForChunk,
	PROPOSE_THREADS_TOOL, type LayeredContext, type OrchestrationState,
} from "../core/orchestration.ts";
import { orderKey } from "../core/source-organization.ts";

/** LOCAL PATCH (folder-orchestrator): server side of folder orchestration. */
export class OrchestrationInputError extends Error {}

const now = () => new Date().toISOString();

/** The layered folder context for one chat's turn. Never throws: a broken
 * orchestration file must not stop a study session (it just loses the layer). */
export function orchestrationContextFor(chatId: string): LayeredContext {
	try {
		return layeredContext(orchestrationStore.read(), stores.sourceOrganizationStore.read(), chatId);
	} catch (error) {
		console.error("[orchestration] context unavailable:", error);
		return { instructions: [], tools: {}, orchestrates: null };
	}
}

export function readOrchestration(): OrchestrationState {
	try { return orchestrationStore.read(); } catch { return emptyOrchestration(); }
}

function newChat(title: string): string {
	const chat = stores.chatStore.createChat(titleFromPrompt(title));
	// Same birth stamp as POST /api/chats: the strong slot's model.
	const strong = readSettings()?.models?.strong;
	if (strong?.model) stores.chatStore.saveSettings(chat.id, { model: { provider: strong.model.provider, id: strong.model.id }, thinkingLevel: strong.thinkingLevel });
	return chat.id;
}

/** Place a chat in a folder, first in the folder's manual order when asked. */
function place(chatId: string, folderId: string, first: boolean) {
	const organization = stores.sourceOrganizationStore.read();
	const existing = organization.order?.[orderKey(folderId)] ?? [];
	if (first) sourceDirectory.change({ action: "arrange", kind: "source", id: chatId, parentId: folderId, order: [chatId, ...existing.filter((x) => x !== chatId)] });
	else sourceDirectory.change({ action: "move", kind: "source", id: chatId, parentId: folderId });
}

function requireFolder(folderId: unknown) {
	if (typeof folderId !== "string" || !folderId) throw new OrchestrationInputError("A folder is required.");
	const folder = stores.sourceOrganizationStore.read().folders.find((f) => f.id === folderId);
	if (!folder) throw new OrchestrationInputError("That folder no longer exists.");
	return folder;
}

export function changeOrchestration(raw: unknown): { state: OrchestrationState; chatId?: string; prompt?: string } {
	if (!raw || typeof raw !== "object") throw new OrchestrationInputError("Invalid request.");
	const r = raw as Record<string, unknown>;
	const state = orchestrationStore.read();
	if (r.action === "spawn-orchestrator") {
		const folder = requireFolder(r.folderId);
		const current = state.folders[folder.id]?.orchestratorChatId;
		if (current && stores.chatStore.getChat(current)) return { state, chatId: current };
		const chatId = newChat(`${folder.name} · Orchestrator`);
		place(chatId, folder.id, true);
		state.folders[folder.id] = { ...state.folders[folder.id], orchestratorChatId: chatId, updatedAt: now() };
		orchestrationStore.write(state);
		return { state, chatId };
	}
	if (r.action === "remove-orchestrator") {
		const folder = requireFolder(r.folderId);
		const config = state.folders[folder.id];
		if (config) { delete config.orchestratorChatId; config.updatedAt = now(); orchestrationStore.write(state); }
		return { state };
	}
	if (r.action === "set-folder") {
		const folder = requireFolder(r.folderId);
		let input;
		try { input = parseFolderConfigInput(r); } catch (error) { throw new OrchestrationInputError((error as Error).message); }
		const config = { ...state.folders[folder.id], updatedAt: now() };
		if (input.instructions) config.instructions = input.instructions; else delete config.instructions;
		if (Object.keys(input.tools).length) config.tools = input.tools; else delete config.tools;
		if (input.paths.length) config.paths = input.paths; else delete config.paths;
		state.folders[folder.id] = config;
		orchestrationStore.write(state);
		return { state };
	}
	if (r.action === "set-thread-brief") {
		if (typeof r.chatId !== "string" || !stores.chatStore.getChat(r.chatId)) throw new OrchestrationInputError("That session no longer exists.");
		if (typeof r.brief !== "string") throw new OrchestrationInputError("The brief must be text.");
		const brief = r.brief.trim();
		const existing = state.threads[r.chatId];
		const folderId = stores.sourceOrganizationStore.read().placements[r.chatId]?.folderId ?? existing?.folderId ?? "";
		state.threads[r.chatId] = { ...existing, folderId, createdAt: existing?.createdAt ?? now(), ...(brief ? { brief } : {}) };
		if (!brief) delete state.threads[r.chatId]!.brief;
		orchestrationStore.write(state);
		return { state };
	}
	if (r.action === "spawn-thread") {
		const { orchestratorChatId, toolCallId, chunk } = r;
		if (typeof orchestratorChatId !== "string") throw new OrchestrationInputError("Invalid thread request.");
		const folderId = Object.entries(state.folders).find(([, c]) => c.orchestratorChatId === orchestratorChatId)?.[0];
		if (!folderId) throw new OrchestrationInputError("This chat is no longer a folder orchestrator.");
		const folder = requireFolder(folderId);
		if (toolCallId === undefined && chunk === undefined) {
			// A custom session (no proposal chunk): title + brief only.
			if (typeof r.title !== "string" || !r.title.trim()) throw new OrchestrationInputError("A custom session needs a title.");
			const brief = typeof r.brief === "string" ? r.brief.trim() : "";
			const chatId = newChat(r.title.trim());
			place(chatId, folder.id, false);
			state.threads[chatId] = { folderId: folder.id, ...(brief ? { brief } : {}), createdAt: now() };
			orchestrationStore.write(state);
			return { state, chatId, prompt: `Let's start this part: ${r.title.trim()}.` };
		}
		if (typeof toolCallId !== "string" || typeof chunk !== "number" || !Number.isInteger(chunk)) {
			throw new OrchestrationInputError("Invalid thread request.");
		}
		const already = threadForChunk(state, orchestratorChatId, toolCallId, chunk);
		if (already && stores.chatStore.getChat(already)) return { state, chatId: already };
		const record = stores.chatStore.getChat(orchestratorChatId);
		let proposal;
		for (const message of record?.messages ?? []) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall" && block.id === toolCallId && block.name === PROPOSE_THREADS_TOOL) proposal = parseThreadProposal(block.arguments);
			}
		}
		const picked = proposal?.chunks[chunk];
		if (!picked) throw new OrchestrationInputError("That proposal is no longer in the orchestrator chat.");
		const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : picked.title;
		const brief = typeof r.brief === "string" ? r.brief.trim() : picked.brief;
		const chatId = newChat(title);
		place(chatId, folder.id, false);
		state.threads[chatId] = { folderId: folder.id, ...(brief ? { brief } : {}), from: { chatId: orchestratorChatId, toolCallId, chunk }, createdAt: now() };
		orchestrationStore.write(state);
		return { state, chatId, prompt: `Let's start this part: ${title}.` };
	}
	throw new OrchestrationInputError("Unknown orchestration action.");
}

/** The orchestrator's update_folder_settings: merge onto the current config. */
export function saveFolderSettingsFromChat(folderId: string, input: { instructions?: string; paths?: string[]; tools?: Record<string, boolean | null> }): string {
	const current = orchestrationStore.read().folders[folderId] ?? {};
	const tools: Record<string, boolean | null> = { ...current.tools };
	for (const [k, v] of Object.entries(input.tools ?? {})) { if (v === null) delete tools[k]; else tools[k] = v; }
	const { state } = changeOrchestration({
		action: "set-folder", folderId,
		instructions: input.instructions ?? current.instructions ?? "",
		paths: input.paths ?? current.paths ?? [],
		tools,
	});
	const saved = state.folders[folderId] ?? {};
	const on = Object.entries(saved.tools ?? {}).map(([k, v]) => `${k} ${v ? "on" : "off"}`);
	return `Saved. Every session in this folder now follows these from its next reply. Instructions: ${saved.instructions ? `${saved.instructions.length} characters` : "none"}; resource paths: ${saved.paths?.length ?? 0}; tool switches: ${on.length ? on.join(", ") : "app defaults"}.`;
}

/** The orchestrator's start_thread: a chunk (1-based) of its LATEST proposal,
 * or a custom title + brief. Already-started chunks are reported, not duplicated. */
export function startThreadFromChat(orchestratorChatId: string, input: { chunk?: number; title?: string; brief?: string }): string {
	let action: Record<string, unknown> = { action: "spawn-thread", orchestratorChatId, title: input.title, brief: input.brief };
	if (input.chunk !== undefined) {
		const record = stores.chatStore.getChat(orchestratorChatId);
		let latest: { id: string; count: number } | undefined;
		for (const message of record?.messages ?? []) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type !== "toolCall" || block.name !== PROPOSE_THREADS_TOOL) continue;
				const proposal = parseThreadProposal(block.arguments);
				if (proposal) latest = { id: block.id, count: proposal.chunks.length };
			}
		}
		if (!latest) throw new Error("There is no proposal yet. Propose a split first, or give a title and brief.");
		if (input.chunk < 1 || input.chunk > latest.count) throw new Error(`Chunk ${input.chunk} is not in the latest proposal (1 to ${latest.count}).`);
		const existing = threadForChunk(orchestrationStore.read(), orchestratorChatId, latest.id, input.chunk - 1);
		if (existing && stores.chatStore.getChat(existing)) return `That session already exists ("${stores.chatStore.getChat(existing)!.title}"); nothing new was started.`;
		action = { ...action, toolCallId: latest.id, chunk: input.chunk - 1 };
	}
	const result = changeOrchestration(action);
	const title = result.chatId ? stores.chatStore.getChat(result.chatId)?.title : undefined;
	return `Started the session "${title ?? "new session"}" in this folder. It is in the sidebar; the learner opens it to begin.`;
}
