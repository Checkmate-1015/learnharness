import { placementOf, type SourceOrganization } from "./source-organization.ts";
import type { EnabledTools } from "./pending.ts";

/**
 * LOCAL PATCH (folder-orchestrator): folder-level instructions and tool
 * permissions, orchestrator chats and the threads they start. Presentation
 * of folders stays in source-organization.json; this lives in its own file
 * (data/orchestration.json) so no existing record changes shape. Pure and
 * browser-safe.
 *
 * Layering for one chat: every ancestor folder's config, outermost first,
 * then the chat's own thread brief. Inner folders win on tool permissions.
 */

/** The tool switches a folder may set (Settings > Agent's toggles plus the
 * quizzing mechanic). Absent = inherit from the parent folder / Settings. */
export const FOLDER_TOOL_KEYS = ["research", "demo", "visual", "pdf", "explain"] as const;
export type FolderToolKey = (typeof FOLDER_TOOL_KEYS)[number];
export const FOLDER_TOOL_LABELS: Record<FolderToolKey, string> = {
	research: "Web research",
	demo: "Interactive demos",
	visual: "Visuals",
	pdf: "PDF reading",
	explain: "Free-recall questions (off = multiple choice)",
};

export interface FolderConfig {
	/** The folder's orchestrator chat, when one was spawned. */
	orchestratorChatId?: string;
	/** Instructions every chat in the folder (and its subfolders) receives. */
	instructions?: string;
	tools?: Partial<Record<FolderToolKey, boolean>>;
	/** Resource folders/files on disk every chat in the folder should use
	 * (course materials, past papers). Absolute or ~/ paths. */
	paths?: string[];
	updatedAt?: string;
}

export interface ThreadConfig {
	/** The folder the orchestrator started it in (informational). */
	folderId: string;
	/** Thread-specific instructions layered on top of the folder's. */
	brief?: string;
	/** The proposal chunk it came from. */
	from?: { chatId: string; toolCallId: string; chunk: number };
	createdAt: string;
}

export interface OrchestrationState {
	version: 1;
	folders: Record<string, FolderConfig>;
	threads: Record<string, ThreadConfig>;
}

export const emptyOrchestration = (): OrchestrationState => ({ version: 1, folders: {}, threads: {} });

const MAX_TEXT = 20_000;

export function parseOrchestration(raw: unknown): OrchestrationState {
	const fail = (): never => { throw new Error("Could not read folder orchestration. Its data is invalid or newer than this app."); };
	if (!raw || typeof raw !== "object") return fail();
	const r = raw as Partial<OrchestrationState>;
	if (r.version !== 1 || !r.folders || typeof r.folders !== "object" || Array.isArray(r.folders)
		|| !r.threads || typeof r.threads !== "object" || Array.isArray(r.threads)) return fail();
	for (const f of Object.values(r.folders)) {
		if (!f || typeof f !== "object") return fail();
		if (f.orchestratorChatId !== undefined && typeof f.orchestratorChatId !== "string") return fail();
		if (f.instructions !== undefined && typeof f.instructions !== "string") return fail();
		if (f.paths !== undefined && (!Array.isArray(f.paths) || f.paths.some((x) => typeof x !== "string"))) return fail();
		if (f.tools !== undefined) {
			if (!f.tools || typeof f.tools !== "object" || Array.isArray(f.tools)) return fail();
			for (const [k, v] of Object.entries(f.tools)) if (!(FOLDER_TOOL_KEYS as readonly string[]).includes(k) || typeof v !== "boolean") return fail();
		}
	}
	for (const t of Object.values(r.threads)) {
		if (!t || typeof t !== "object" || typeof t.folderId !== "string" || typeof t.createdAt !== "string") return fail();
		if (t.brief !== undefined && typeof t.brief !== "string") return fail();
		if (t.from !== undefined && (!t.from || typeof t.from.chatId !== "string" || typeof t.from.toolCallId !== "string" || typeof t.from.chunk !== "number")) return fail();
	}
	return r as OrchestrationState;
}

/** Validate a folder-settings write from the client. */
export function parseFolderConfigInput(raw: unknown): { instructions: string; tools: Partial<Record<FolderToolKey, boolean>>; paths: string[] } {
	if (!raw || typeof raw !== "object") throw new Error("Invalid folder settings.");
	const r = raw as { instructions?: unknown; tools?: unknown; paths?: unknown };
	const paths: string[] = [];
	if (r.paths !== undefined) {
		if (!Array.isArray(r.paths)) throw new Error("Resource folders must be a list.");
		for (const entry of r.paths) {
			if (typeof entry !== "string") throw new Error("Resource folders must be paths.");
			const p = entry.trim();
			if (!p) continue;
			if (p.includes("\0") || !(p === "~" || p.startsWith("~/") || p.startsWith("/"))) throw new Error(`Not an absolute path: ${p}`);
			if (!paths.includes(p)) paths.push(p);
		}
	}
	if (r.instructions !== undefined && typeof r.instructions !== "string") throw new Error("Instructions must be text.");
	const instructions = (r.instructions ?? "").trim();
	if (instructions.length > MAX_TEXT) throw new Error("Instructions are too long.");
	const tools: Partial<Record<FolderToolKey, boolean>> = {};
	if (r.tools !== undefined) {
		if (!r.tools || typeof r.tools !== "object" || Array.isArray(r.tools)) throw new Error("Invalid permissions.");
		for (const [k, v] of Object.entries(r.tools)) {
			if (!(FOLDER_TOOL_KEYS as readonly string[]).includes(k)) throw new Error(`Unknown permission: ${k}`);
			if (v === null || v === undefined) continue;
			if (typeof v !== "boolean") throw new Error("Permissions must be on or off.");
			tools[k as FolderToolKey] = v;
		}
	}
	return { instructions, tools, paths };
}

/** A folder and its ancestors, OUTERMOST first (cycle-safe). */
export function folderLineage(organization: SourceOrganization, folderId: string | null): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (let id = folderId; id !== null && !seen.has(id);) {
		const folder = organization.folders.find((f) => f.id === id);
		if (!folder) break;
		seen.add(id);
		out.unshift(id);
		id = folder.parentId;
	}
	return out;
}

export function orchestratorFolderOf(state: OrchestrationState, chatId: string): string | null {
	for (const [folderId, config] of Object.entries(state.folders)) if (config.orchestratorChatId === chatId) return folderId;
	return null;
}

export interface LayeredContext {
	/** System-prompt segments, outermost folder first, the brief last. */
	instructions: string[];
	/** Tool switches to lay over the user's Settings toggles. */
	tools: EnabledTools;
	/** The folder this chat orchestrates, if it is an orchestrator. */
	orchestrates: string | null;
}

export function layeredContext(state: OrchestrationState, organization: SourceOrganization, chatId: string): LayeredContext {
	const placed = placementOf(organization, chatId)?.folderId ?? null;
	const lineage = folderLineage(organization, placed);
	const instructions: string[] = [];
	const tools: EnabledTools = {};
	for (const folderId of lineage) {
		const config = state.folders[folderId];
		if (!config) continue;
		const name = organization.folders.find((f) => f.id === folderId)?.name ?? "folder";
		if (config.instructions?.trim()) {
			instructions.push(`# Folder instructions: "${name}"\n\nThe learner set these instructions for every session in the folder "${name}". Follow them in this session; where they conflict with your general method, these win, except they never override safety or accuracy.\n\n${config.instructions.trim()}`);
		}
		if (config.paths?.length) {
			instructions.push(`# Folder resources: "${name}"\n\nThe learner gave every session in "${name}" these locations on their computer. Use them with your file tools whenever they help (course notes, textbook, homework and past exam papers for question formats). Read them yourself; don't ask the learner to paste them.\n\n${config.paths.map((p) => `- ${p}`).join("\n")}`);
		}
		for (const [k, v] of Object.entries(config.tools ?? {})) tools[k] = v;
	}
	const brief = state.threads[chatId]?.brief?.trim();
	if (brief) {
		instructions.push(`# This session's brief\n\nThis session was started from the folder's orchestrator for one part of a larger resource. Its brief is more specific than the folder instructions above and takes precedence over them for scope:\n\n${brief}`);
	}
	return { instructions, tools, orchestrates: orchestratorFolderOf(state, chatId) };
}

// ─── The orchestrator's proposal tool ───────────────────────────────────────

export const PROPOSE_THREADS_TOOL = "propose_threads";
export const UPDATE_FOLDER_SETTINGS_TOOL = "update_folder_settings";
export const START_THREAD_TOOL = "start_thread";

export interface ThreadProposal {
	resource: string;
	summary?: string;
	chunks: { title: string; brief: string }[];
}

export function parseThreadProposal(input: unknown): ThreadProposal | undefined {
	if (!input || typeof input !== "object") return undefined;
	const r = input as { resource?: unknown; summary?: unknown; chunks?: unknown };
	if (typeof r.resource !== "string" || !Array.isArray(r.chunks) || r.chunks.length === 0 || r.chunks.length > 200) return undefined;
	const chunks: ThreadProposal["chunks"] = [];
	for (const c of r.chunks) {
		if (!c || typeof c !== "object") return undefined;
		const { title, brief } = c as { title?: unknown; brief?: unknown };
		if (typeof title !== "string" || !title.trim() || typeof brief !== "string") return undefined;
		chunks.push({ title: title.trim().slice(0, 200), brief: brief.trim().slice(0, MAX_TEXT) });
	}
	return { resource: r.resource.trim(), ...(typeof r.summary === "string" && r.summary.trim() ? { summary: r.summary.trim() } : {}), chunks };
}

/** The thread a proposal chunk already started, if any. */
export function threadForChunk(state: OrchestrationState, chatId: string, toolCallId: string, chunk: number): string | null {
	for (const [threadId, t] of Object.entries(state.threads)) {
		if (t.from && t.from.chatId === chatId && t.from.toolCallId === toolCallId && t.from.chunk === chunk) return threadId;
	}
	return null;
}

export const ORCHESTRATOR_PROMPT = `# You are this folder's orchestrator

You are not tutoring in this session. You run a folder of study sessions for the learner. Every session in the folder receives the folder's instructions; you help the learner plan the folder and start focused sessions inside it.

## What you do

- Talk with the learner about what this folder is for: the material, their goal, their deadline, how they like to be taught. Suggest folder instructions when useful (the learner sets them from the folder's right-click menu, "Folder instructions & permissions").
- When the learner tells you how sessions in this folder should work ("always begin with an example", "give extensive exercises and tricky questions", "use simulations whenever possible", "my materials are in ~/..."), turn it into clear folder instructions and save them with ${UPDATE_FOLDER_SETTINGS_TOOL}. Include the resource folder paths they give you as paths, and switch on demos when they want simulations. The current folder instructions and resources (if any) appear further down in this prompt; keep what should stay, since instructions you save replace the whole text. Tell the learner in one or two lines what you saved.
- When the learner gives you a resource (a file path, a PDF, notes, a syllabus, a pasted outline), read it with your file tools. Read enough to see its real structure: the table of contents, chapter and section headings, page ranges. Don't guess the structure from the title.
- Then propose a split with the ${PROPOSE_THREADS_TOOL} tool: one chunk per session the learner would study on its own, usually one per chapter, or a sensible grouping the learner asked for. Each chunk has a short title (e.g. "Ch. 3 — Eigenvalues") and a brief.
- A brief is the thread-specific instruction the new session's tutor will read, layered on top of the folder's instructions. Make it self-contained: name the resource and its path, the exact chapter/section/page range to cover, what to assume the learner already covered in earlier chunks, and anything the learner asked for this chunk. The tutor will not see this conversation.
- Calling ${PROPOSE_THREADS_TOOL} starts nothing. It shows the learner one button per chunk; they start a session when they choose to.
- When the learner asks you to start a session ("start the first one", "open chapter 7"), call ${START_THREAD_TOOL} with that chunk's number from your latest proposal (1 = first). Add any extra wishes they gave for that session to its brief. Start only what they asked for, one at a time, and never claim a session started unless the tool said so. Then tell them it's in the sidebar inside this folder.
- If the learner wants a different split, call ${PROPOSE_THREADS_TOOL} again with the revised list. Keep chunk order the same as the resource's order.

## How you talk

Short, plain replies. Ask before assuming a goal. Don't teach the material here: if the learner starts asking content questions, answer briefly and suggest starting the relevant session.`;
