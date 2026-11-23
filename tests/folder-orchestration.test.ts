import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Isolated data dir: the stores are imported lazily below, after this runs.
process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-orchestration-"));
import { it } from "node:test";
import {
	emptyOrchestration, folderLineage, layeredContext, parseFolderConfigInput, parseOrchestration, parseThreadProposal, threadForChunk,
} from "../src/core/orchestration.ts";
import type { SourceOrganization } from "../src/core/source-organization.ts";

// LOCAL PATCH (folder-orchestrator) tests.
const org: SourceOrganization = {
	version: 1,
	folders: [
		{ id: "math", name: "MATH 2131", parentId: null, createdAt: "x" },
		{ id: "ch", name: "Chapters", parentId: "math", createdAt: "x" },
	],
	placements: { t1: { folderId: "ch" }, o1: { folderId: "math" }, loose: { folderId: null } },
};

it("layers outer folder instructions first, then inner, then the thread brief; inner folders win on tools", () => {
	const state = emptyOrchestration();
	state.folders.math = { instructions: "Use Strang's notation.", tools: { research: false, demo: true }, orchestratorChatId: "o1" };
	state.folders.ch = { instructions: "One chapter per session.", tools: { research: true } };
	state.threads.t1 = { folderId: "ch", brief: "Cover chapter 3 only.", createdAt: "x" };
	const ctx = layeredContext(state, org, "t1");
	assert.equal(ctx.instructions.length, 3);
	assert.match(ctx.instructions[0]!, /MATH 2131[\s\S]*Strang/);
	assert.match(ctx.instructions[1]!, /Chapters[\s\S]*One chapter/);
	assert.match(ctx.instructions[2]!, /chapter 3 only/);
	assert.deepEqual(ctx.tools, { research: true, demo: true });
	assert.equal(ctx.orchestrates, null);
	assert.equal(layeredContext(state, org, "o1").orchestrates, "math");
	assert.deepEqual(layeredContext(state, org, "loose"), { instructions: [], tools: {}, orchestrates: null });
	assert.deepEqual(folderLineage(org, "ch"), ["math", "ch"]);
});

it("moving a chat into a folder is enough to inherit (placement is read per turn)", () => {
	const state = emptyOrchestration();
	state.folders.math = { instructions: "Exam on 12 Dec.", paths: ["~/MATH2131/Past papers"] };
	const moved: SourceOrganization = { ...org, placements: { ...org.placements, loose: { folderId: "math" } } };
	assert.match(layeredContext(state, moved, "loose").instructions[0]!, /12 Dec/);
	assert.match(layeredContext(state, moved, "loose").instructions[1]!, /- ~\/MATH2131\/Past papers/);
});

it("parsers refuse corrupt data and invalid input", () => {
	assert.throws(() => parseOrchestration({ version: 2, folders: {}, threads: {} }), /invalid or newer/);
	assert.throws(() => parseOrchestration({ version: 1, folders: { a: { tools: { nope: true } } }, threads: {} }), /invalid or newer/);
	assert.deepEqual(parseFolderConfigInput({ instructions: "  hi ", tools: { pdf: false, demo: null }, paths: [" ~/Math ", "", "~/Math"] }), { instructions: "hi", tools: { pdf: false }, paths: ["~/Math"] });
	assert.throws(() => parseFolderConfigInput({ paths: ["relative/dir"] }), /absolute/);
	assert.throws(() => parseFolderConfigInput({ tools: { shell: true } }), /Unknown permission/);
	assert.equal(parseThreadProposal({ resource: "book.pdf", chunks: [] }), undefined);
	assert.deepEqual(parseThreadProposal({ resource: " book.pdf ", chunks: [{ title: " Ch 1 ", brief: "pp 1-20" }] }), { resource: "book.pdf", chunks: [{ title: "Ch 1", brief: "pp 1-20" }] });
});

it("threadForChunk finds the session a proposal chunk started", () => {
	const state = emptyOrchestration();
	state.threads.t9 = { folderId: "math", createdAt: "x", from: { chatId: "o1", toolCallId: "call_1", chunk: 2 } };
	assert.equal(threadForChunk(state, "o1", "call_1", 2), "t9");
	assert.equal(threadForChunk(state, "o1", "call_1", 1), null);
});

it("an orchestrator prober drops probing tools, adds propose_threads, and gets its own base prompt plus the folder layer", async () => {
	const { createProberAgent } = await import("../src/agent/teacher-agent.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { jobStore } = await import("../src/store/jobs.ts");
	const { createFauxCore } = await import("@earendil-works/pi-ai");
	const faux = createFauxCore({});
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const chatId = chatStore.createChat("orchestrator pin").id;
	const ctx = { chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} };
	const plain = createProberAgent(ctx, { engine, chatId });
	const orch = createProberAgent(ctx, { engine, chatId, folderLayer: { instructions: ["# Folder instructions: MATH\n\nExam on 12 Dec."], orchestrator: true } });
	const names = (a: typeof plain) => a.state.tools.map((t) => t.name);
	assert.ok(names(plain).includes("probe_done"));
	assert.ok(!names(orch).includes("probe_done") && !names(orch).includes("quiz"));
	assert.ok(names(orch).includes("propose_threads") && names(orch).includes("read"));
	assert.match(orch.state.systemPrompt, /You are this folder's orchestrator/);
	assert.match(orch.state.systemPrompt, /Exam on 12 Dec\./);
	assert.doesNotMatch(plain.state.systemPrompt, /orchestrator/);
	const layered = createProberAgent(ctx, { engine, chatId, folderLayer: { instructions: ["BRIEF-MARKER"], orchestrator: false } });
	assert.ok(names(layered).includes("probe_done"));
	assert.match(layered.state.systemPrompt, /BRIEF-MARKER$/);
});

it("an orchestrator with a settings saver gets update_folder_settings, which merges onto the current settings", async () => {
	const { createProberAgent } = await import("../src/agent/teacher-agent.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { jobStore } = await import("../src/store/jobs.ts");
	const { createFauxCore } = await import("@earendil-works/pi-ai");
	const faux = createFauxCore({});
	const chatId = chatStore.createChat("settings pin").id;
	const saved: unknown[] = [];
	const agent = createProberAgent({ chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} }, {
		engine: { model: faux.getModel(), streamFn: faux.streamSimple }, chatId,
		folderLayer: { instructions: [], orchestrator: true, saveFolderSettings: (input) => { saved.push(input); return "Saved."; } },
	});
	const tool = agent.state.tools.find((t) => t.name === "update_folder_settings");
	assert.ok(tool);
	await tool.execute("call_x", { instructions: "Always begin with an example.", paths: ["~/Griffiths"], tools: { demo: true } }, new AbortController().signal);
	assert.deepEqual(saved, [{ instructions: "Always begin with an example.", paths: ["~/Griffiths"], tools: { demo: true } }]);
});

it("server: spawn an orchestrator, save settings from chat, start chunk 1 by number, refuse a duplicate", async () => {
	const { changeOrchestration, saveFolderSettingsFromChat, startThreadFromChat, orchestrationContextFor } = await import("../src/server/orchestration.ts");
	const { sourceDirectory } = await import("../src/server/source-organization.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const folderId = sourceDirectory.change({ action: "create-folder", name: "Griffiths", parentId: null }).createdFolderId!;
	const orch = changeOrchestration({ action: "spawn-orchestrator", folderId }).chatId!;
	assert.equal(sourceDirectory.read().organization.placements[orch]?.folderId, folderId);
	assert.equal(changeOrchestration({ action: "spawn-orchestrator", folderId }).chatId, orch, "spawning again reopens the same orchestrator");
	assert.match(saveFolderSettingsFromChat(folderId, { instructions: "Always begin with an example.", paths: ["~/Griffiths"], tools: { demo: true } }), /Saved/);
	assert.match(saveFolderSettingsFromChat(folderId, { tools: { research: false } }), /demo on, research off/, "omitted fields keep their values");
	assert.throws(() => startThreadFromChat(orch, { chunk: 1 }), /no proposal yet/i);
	chatStore.saveMessages(orch, [{ id: "m1", role: "assistant", content: [{ type: "toolCall", id: "call_p", name: "propose_threads",
		arguments: { resource: "Griffiths 4e", chunks: [{ title: "Ch. 1 Vector analysis", brief: "pp 1-60" }, { title: "Ch. 2 Electrostatics", brief: "pp 61-120" }] } }],
		timestamp: 0 } as never]);
	assert.match(startThreadFromChat(orch, { chunk: 1 }), /Started the session "Ch\. 1 Vector analysis"/);
	assert.match(startThreadFromChat(orch, { chunk: 1 }), /already exists/);
	assert.throws(() => startThreadFromChat(orch, { chunk: 3 }), /1 to 2/);
	const thread = chatStore.listChats().find((c) => c.title === "Ch. 1 Vector analysis")!;
	assert.equal(sourceDirectory.read().organization.placements[thread.id]?.folderId, folderId);
	const ctx = orchestrationContextFor(thread.id);
	assert.equal(ctx.orchestrates, null);
	assert.match(ctx.instructions.join("\n"), /Always begin with an example[\s\S]*~\/Griffiths[\s\S]*pp 1-60/);
	assert.deepEqual(ctx.tools, { demo: true, research: false });
});
