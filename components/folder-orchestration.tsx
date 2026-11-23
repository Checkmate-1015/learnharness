"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, PlayIcon, WorkflowIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	emptyOrchestration, FOLDER_TOOL_KEYS, FOLDER_TOOL_LABELS, parseThreadProposal, threadForChunk,
	type FolderConfig, type FolderToolKey, type OrchestrationState,
} from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * LOCAL PATCH (folder-orchestrator): the client side of folder
 * orchestration — the shared state hook, the folder settings and thread
 * brief dialogs, and the proposal card in an orchestrator's transcript.
 * Colours are a first pass; the owner may restyle them.
 */

/** The orchestrator accent: icon + text colour. */
export const ORCHESTRATOR_ACCENT = "text-violet-400";
export const OrchestratorIcon = WorkflowIcon;

type ChangeResult = { state: OrchestrationState; chatId?: string; prompt?: string };

let shared: OrchestrationState | undefined;
const listeners = new Set<(s: OrchestrationState) => void>();
function publish(state: OrchestrationState) { shared = state; for (const l of listeners) l(state); }

async function readState() {
	try {
		const res = await fetch("/api/orchestration", { cache: "no-store" });
		if (res.ok) publish(await res.json() as OrchestrationState);
	} catch { /* keep the last good state */ }
}

export async function changeOrchestration(action: Record<string, unknown>): Promise<ChangeResult> {
	const res = await fetch("/api/orchestration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
	const body = await res.json().catch(() => ({})) as Partial<ChangeResult> & { error?: string };
	if (!res.ok || !body.state) throw new Error(body.error ?? `Could not save (${res.status}).`);
	publish(body.state);
	return body as ChangeResult;
}

/** One shared copy across the sidebar and transcript cards. */
export function useOrchestration(): OrchestrationState {
	const [state, setState] = useState<OrchestrationState>(shared ?? emptyOrchestration());
	useEffect(() => {
		listeners.add(setState);
		if (!shared) void readState(); else setState(shared);
		return () => { listeners.delete(setState); };
	}, []);
	useServerEvent("sources-changed", () => void readState());
	useServerEvent("chats-changed", () => void readState());
	useServerResync(() => void readState());
	return state;
}

function DialogFrame({ label, testid, onClose, busy, children }: { label: string; testid: string; onClose: () => void; busy: boolean; children: ReactNode }) {
	const frame = (
		<div role="dialog" aria-modal="true" aria-label={label} data-testid={testid} onClick={(e) => e.stopPropagation()}
			className="w-[36rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">{children}</div>
	);
	return <HostDialog open frame={frame} onClose={() => { if (busy) return "blocked"; onClose(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}>{frame.props.children}</HostDialog>;
}

function DialogButtons({ busy, onClose, onSave, saveLabel = "Save" }: { busy: boolean; onClose: () => void; onSave: () => void; saveLabel?: string }) {
	return (
		<div className="mt-5 flex justify-end gap-2">
			<button type="button" onClick={onClose} disabled={busy}
				className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40">Cancel</button>
			<button type="button" data-testid="orchestration-save" onClick={onSave} disabled={busy}
				className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40">{busy ? "Saving…" : saveLabel}</button>
		</div>
	);
}

type TriState = "inherit" | "on" | "off";

/** Folder instructions + per-tool permissions (inherit / on / off). */
export function FolderSettingsDialog({ folder, config, onClose }: {
	folder: { id: string; name: string };
	config: FolderConfig | undefined;
	onClose: () => void;
}) {
	const [instructions, setInstructions] = useState(config?.instructions ?? "");
	const [tools, setTools] = useState<Record<FolderToolKey, TriState>>(() => Object.fromEntries(FOLDER_TOOL_KEYS.map((k) => {
		const v = config?.tools?.[k];
		return [k, v === undefined ? "inherit" : v ? "on" : "off"];
	})) as Record<FolderToolKey, TriState>);
	const [paths, setPaths] = useState((config?.paths ?? []).join("\n"));
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState("");
	const save = async () => {
		setBusy(true); setFailure("");
		try {
			const out: Partial<Record<FolderToolKey, boolean>> = {};
			for (const k of FOLDER_TOOL_KEYS) if (tools[k] !== "inherit") out[k] = tools[k] === "on";
			await changeOrchestration({ action: "set-folder", folderId: folder.id, instructions, tools: out, paths: paths.split("\n") });
			onClose();
		} catch (error) { setFailure((error as Error).message); setBusy(false); }
	};
	return (
		<DialogFrame label="Folder instructions and permissions" testid="folder-settings-dialog" onClose={onClose} busy={busy}>
			<h2 className="text-sm font-semibold text-foreground">Folder instructions &amp; permissions</h2>
			<div className="mt-1.5"><code className="font-mono text-sm text-foreground">{folder.name}</code></div>
			<p className="mt-2 text-xs text-muted-foreground">Every session in this folder and its subfolders gets these, including sessions you move in later. Subfolders add their own on top.</p>
			<textarea data-testid="folder-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={busy}
				placeholder="e.g. This is MATH 2131 (linear algebra, Strang). Exam on 12 Dec. Prefer geometric pictures, then the algebra. Use the course's notation."
				className="mt-3 h-40 w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-border" />
			<div className="mt-4 text-xs uppercase tracking-wider text-muted-foreground/80">Resource folders</div>
			<textarea data-testid="folder-paths" value={paths} onChange={(e) => setPaths(e.target.value)} disabled={busy}
				placeholder={"One path per line, e.g.\n~/Documents/HKUST/MATH2131/Homework\n~/Documents/HKUST/MATH2131/Past papers"}
				className="mt-2 h-20 w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-border" />
			<p className="mt-1 text-xs text-muted-foreground">Every session here is told to use these with its file tools.</p>
			<div className="mt-4 text-xs uppercase tracking-wider text-muted-foreground/80">Permissions</div>
			<div className="mt-2 flex flex-col gap-1.5">
				{FOLDER_TOOL_KEYS.map((k) => (
					<div key={k} className="flex items-center justify-between gap-3 text-sm">
						<span className="text-foreground">{FOLDER_TOOL_LABELS[k]}</span>
						<div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 p-0.5" data-testid={`folder-tool-${k}`}>
							{(["inherit", "on", "off"] as const).map((v) => (
								<button key={v} type="button" disabled={busy} onClick={() => setTools((t) => ({ ...t, [k]: v }))}
									className={cn("rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors",
										tools[k] === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
									{v === "inherit" ? "Default" : v}
								</button>
							))}
						</div>
					</div>
				))}
			</div>
			<p className="mt-2 text-xs text-muted-foreground">Default follows the parent folder, or Settings → Agent at the top level.</p>
			{failure && <div role="alert" className="mt-3 text-xs text-destructive">{failure}</div>}
			<DialogButtons busy={busy} onClose={onClose} onSave={() => void save()} />
		</DialogFrame>
	);
}

/** A session's own brief, layered over its folders' instructions. */
export function ThreadBriefDialog({ chat, brief, onClose }: { chat: { id: string; title: string }; brief: string; onClose: () => void }) {
	const [text, setText] = useState(brief);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState("");
	const save = async () => {
		setBusy(true); setFailure("");
		try { await changeOrchestration({ action: "set-thread-brief", chatId: chat.id, brief: text }); onClose(); }
		catch (error) { setFailure((error as Error).message); setBusy(false); }
	};
	return (
		<DialogFrame label="Session brief" testid="thread-brief-dialog" onClose={onClose} busy={busy}>
			<h2 className="text-sm font-semibold text-foreground">Session brief</h2>
			<div className="mt-1.5"><code className="font-mono text-sm text-foreground">{chat.title}</code></div>
			<p className="mt-2 text-xs text-muted-foreground">Instructions for this session only, layered on top of its folder&apos;s. Takes effect from the next reply.</p>
			<textarea data-testid="thread-brief" value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
				className="mt-3 h-48 w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-border" />
			{failure && <div role="alert" className="mt-3 text-xs text-destructive">{failure}</div>}
			<DialogButtons busy={busy} onClose={onClose} onSave={() => void save()} />
		</DialogFrame>
	);
}

/** The orchestrator's propose_threads call: one row per chunk; a chunk
 * starts a session in the folder only when the learner presses Start. */
export function ThreadProposalCard({ chatId, part }: { chatId: string; part: { toolCallId?: string; input?: unknown; state?: string } }) {
	const state = useOrchestration();
	const router = useRouter();
	const proposal = parseThreadProposal(part.input);
	const [open, setOpen] = useState<number | null>(null);
	const [drafts, setDrafts] = useState<Record<number, { title: string; brief: string }>>({});
	const [busy, setBusy] = useState<number | null>(null);
	const [failure, setFailure] = useState("");
	const mounted = useRef(true);
	useEffect(() => () => { mounted.current = false; }, []);
	const start = useCallback(async (index: number) => {
		if (!proposal || !part.toolCallId) return;
		const draft = drafts[index] ?? proposal.chunks[index]!;
		setBusy(index); setFailure("");
		try {
			const result = await changeOrchestration({ action: "spawn-thread", orchestratorChatId: chatId, toolCallId: part.toolCallId, chunk: index, title: draft.title, brief: draft.brief });
			if (result.chatId) router.push(result.prompt ? `/chat/${result.chatId}?prompt=${encodeURIComponent(result.prompt)}` : `/chat/${result.chatId}`);
		} catch (error) { if (mounted.current) setFailure((error as Error).message); }
		finally { if (mounted.current) setBusy(null); }
	}, [proposal, part.toolCallId, drafts, chatId, router]);
	if (!proposal) {
		return part.state === "input-streaming" || part.state === "input-available"
			? <div className="my-2 text-xs text-muted-foreground">Preparing a split…</div> : null;
	}
	return (
		<div data-testid="thread-proposal" className="my-3 rounded-xl border border-violet-400/30 bg-card/60 p-3">
			<div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
				<OrchestratorIcon aria-hidden="true" className={cn("size-3.5", ORCHESTRATOR_ACCENT)} />
				<span>Proposed sessions</span>
				<span className="normal-case tracking-normal text-muted-foreground/70">· {proposal.resource}</span>
			</div>
			{proposal.summary && <p className="mt-1.5 text-sm text-muted-foreground">{proposal.summary}</p>}
			<div className="mt-2 flex flex-col gap-1">
				{proposal.chunks.map((chunk, i) => {
					const existing = part.toolCallId ? threadForChunk(state, chatId, part.toolCallId, i) : null;
					const draft = drafts[i] ?? chunk;
					const expanded = open === i;
					return (
						<div key={i} className="rounded-lg border border-border/50">
							<div className="flex items-center gap-2 px-2 py-1.5">
								<button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i)}
									className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm text-foreground">
									<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground/70 transition-transform", expanded && "rotate-90")} />
									<span className="truncate">{draft.title}</span>
								</button>
								{existing ? (
									<button type="button" data-testid={`thread-open-${i}`} onClick={() => router.push(`/chat/${existing}`)}
										className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">Open</button>
								) : (
									<button type="button" data-testid={`thread-start-${i}`} disabled={busy !== null || !part.toolCallId} onClick={() => void start(i)}
										className="flex shrink-0 items-center gap-1 rounded-md bg-violet-500/15 px-2 py-0.5 text-xs text-violet-300 transition-colors hover:bg-violet-500/25 disabled:opacity-40">
										<PlayIcon aria-hidden="true" className="size-3" />{busy === i ? "Starting…" : "Start"}
									</button>
								)}
							</div>
							{expanded && (
								<div className="border-t border-border/50 px-2 py-2">
									<input value={draft.title} disabled={!!existing || busy !== null} aria-label="Session title"
										onChange={(e) => setDrafts((d) => ({ ...d, [i]: { ...draft, title: e.target.value } }))}
										className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-sm text-foreground outline-none" />
									<textarea value={draft.brief} disabled={!!existing || busy !== null} aria-label="Session brief"
										onChange={(e) => setDrafts((d) => ({ ...d, [i]: { ...draft, brief: e.target.value } }))}
										className="mt-1.5 h-32 w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground outline-none" />
									{existing && <p className="mt-1 text-xs text-muted-foreground">Already started. Edit its brief from the session&apos;s right-click menu.</p>}
								</div>
							)}
						</div>
					);
				})}
			</div>
			{failure && <div role="alert" className="mt-2 text-xs text-destructive">{failure}</div>}
		</div>
	);
}
