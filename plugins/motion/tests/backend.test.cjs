const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const backend = require("../dist/backend.cjs");
const { unsafeReason, sequenceStore, commentTargets, renderScene, lessonBrief, revisePrompt, MAX_ATTEMPTS } = backend._internal;

const GOOD = "from manimlib import *\nimport numpy as np\n\nclass Beat(Scene):\n    def construct(self):\n        self.wait(1)\n";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "motion-test-"));

test("a plain manimgl scene is accepted", () => assert.equal(unsafeReason(GOOD), null));
test("unsafe or malformed scenes are refused with a reason", () => {
	for (const [code, pattern] of [
		["", /empty/],
		["class Beat(Scene): pass", /from manimlib import/],
		["from manimlib import *\nclass Other(Scene): pass", /named Beat/],
		[`${GOOD}import os\n`, /"os" is not allowed/],
		[`${GOOD}from subprocess import run\n`, /"subprocess" is not allowed/],
		[`${GOOD}        open("/etc/passwd")\n`, /open\(/],
		[`${GOOD}        __import__("os")\n`, /__import__/],
		[`${GOOD}        x = ().__class__\n`, /__class__/],
	]) assert.match(unsafeReason(code) ?? "", pattern);
});

test("the store creates once, lists newest first and rejects bad ids", () => {
	const store = sequenceStore(temp());
	const a = store.create({ id: "seq_aaaaaaaa", concept: "A", origin: "learner" });
	assert.equal(store.create({ id: "seq_aaaaaaaa", concept: "changed", origin: "learner" }).concept, "A");
	a.createdAt = "2026-01-01T00:00:00.000Z"; store.write(a);
	store.create({ id: "seq_bbbbbbbb", concept: "B", origin: "teacher" });
	assert.deepEqual(store.list().map(item => item.concept), ["B", "A"]);
	assert.throws(() => store.dir("../escape"), /Unknown animation/);
	assert.equal(store.read("seq_missing00"), null);
});

test("a comment targets its own clip, or every clip", () => {
	const sequence = { beats: [{ index: 1 }, { index: 2 }, { index: 3 }] };
	assert.deepEqual(commentTargets(sequence, 2), [2]);
	assert.deepEqual(commentTargets(sequence, null), [1, 2, 3]);
	assert.throws(() => commentTargets(sequence, 9), /Unknown clip/);
});

function fakeManim({ code = 0, writes = true, output = "", hang = false }) {
	return (_command, args, options) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
		child.kill = () => setImmediate(() => child.emit("close", null));
		if (!hang) setImmediate(() => {
			if (writes) { fs.mkdirSync(path.join(options.cwd, "videos"), { recursive: true }); fs.writeFileSync(path.join(options.cwd, "videos", "clip.mp4"), "mp4"); }
			if (output) child.stderr.emit("data", Buffer.from(output));
			child.emit("close", code);
		});
		assert.deepEqual(args.slice(0, 3), ["scene.py", "Beat", "-w"]);
		return child;
	};
}
test("a successful render reports the clip it wrote", async () => {
	const folder = temp();
	const result = await renderScene({ folder, run: fakeManim({}) });
	assert.equal(result.ok, true);
	assert.equal(path.basename(result.clip), "clip.mp4");
});
test("a failed render returns manim's error text", async () => {
	const result = await renderScene({ folder: temp(), run: fakeManim({ code: 1, writes: false, output: "NameError: name 'Circl' is not defined" }) });
	assert.equal(result.ok, false);
	assert.match(result.error, /NameError/);
});
test("exit 0 with no video is a failure", async () => {
	const result = await renderScene({ folder: temp(), run: fakeManim({ writes: false }) });
	assert.equal(result.ok, false);
});
test("a render that hangs times out", async () => {
	const result = await renderScene({ folder: temp(), run: fakeManim({ hang: true }), timeoutMs: 20 });
	assert.match(result.error, /took longer/);
});
test("a cancelled render stops", async () => {
	const controller = new AbortController();
	const pending = renderScene({ folder: temp(), run: fakeManim({ hang: true }), signal: controller.signal });
	controller.abort();
	assert.match((await pending).error, /Cancelled/);
});

test("the lesson brief is a few short excerpts, not the transcript", () => {
	const messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message ${index} ${"x".repeat(3000)}` }));
	const brief = lessonBrief({ title: "Rough VIX", messages });
	assert.match(brief, /Lesson: Rough VIX/);
	assert.equal((brief.match(/message \d+/g) || []).length, 4);
	assert.ok(brief.length < 6000);
	assert.equal(lessonBrief(null), "");
});

test("a revision prompt carries the comment and only the targeted clip", () => {
	const sequence = { concept: "Jensen", beats: [{ index: 1, title: "One", caption: "c1" }, { index: 2, title: "Two", caption: "c2" }] };
	const prompt = revisePrompt(sequence, [2], "slow it down", () => GOOD);
	assert.match(prompt, /slow it down/);
	assert.match(prompt, /Beat 2: Two/);
	assert.doesNotMatch(prompt, /Beat 1: One/);
	assert.match(prompt, /do not call set_outline or set_storyboard/);
});

/** A minimal host: enough of the plugin context to drive the worker's tools. */
function host({ status = "running", outcome = {} } = {}) {
	const dataDirectory = temp();
	const handlers = new Map(); const workers = new Map(); const emitted = []; const started = [];
	const ctx = {
		dataDirectory, signal: new AbortController().signal,
		events: { emit: (topic, data) => emitted.push({ topic, data }) },
		workers: { register: definition => workers.set(definition.id, definition), get: () => ({ status }), start: (id, options) => { started.push(options); return { id: `task_x${started.length}` }; }, wait: async () => outcome, cancel() {} },
		handle: (name, handler) => handlers.set(name, handler),
		registerInstructions() {}, registerTools() {}, createBackgroundTool: () => ({}),
		inference: { catalog: async () => ({ models: [{ provider: "claude-code", id: "opus" }], slots: {} }) },
		learning: { listSessions: () => [], getSession: () => null },
	};
	backend.activate(ctx);
	return { ctx, handlers, worker: workers.get("motion-sequence"), emitted, dataDirectory, started };
}
const toolsFor = (worker, input, taskId = "task_1") => {
	const context = { taskId, input, signal: new AbortController().signal };
	const tools = Object.fromEntries(worker.tools(context).map(tool => [tool.name, tool]));
	return { context, tools, say: async (name, args) => (await tools[name].execute("call", args)).content[0].text };
};

test("worker tools: storyboard once, unsafe code is refused and counted, attempts run out", async () => {
	const { worker, handlers } = host();
	const input = { sequenceId: "seq_cccccccc", concept: "Jensen", origin: "teacher" };
	const { context, say } = toolsFor(worker, input);
	assert.match(await say("render_beat", { index: 1, code: GOOD }), /no beat 1/);
	assert.match(await say("set_storyboard", { beats: [{ title: "One", caption: "c1" }] }), /Call set_outline first/);
	assert.match(await say("set_outline", { mode: "quick", question: "What does it do?" }), /Outline saved \(quick\)/);
	assert.match(await say("set_storyboard", { beats: [{ title: "One", caption: "c1" }, { title: "Two", caption: "c2" }] }), /2 beat/);
	assert.match(await say("set_outline", { mode: "quick", question: "Again?" }), /outline is fixed/);
	assert.match(await say("set_storyboard", { beats: [{ title: "X", caption: "y" }] }), /already set/);
	await assert.rejects(async () => worker.validateResult({ summary: "s" }, context), /Render beat 1, 2/);
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const reply = await say("render_beat", { index: 1, code: `${GOOD}import os\n` });
		assert.match(reply, /"os" is not allowed/);
		assert.match(reply, attempt < MAX_ATTEMPTS ? /attempt\(s\) left/ : /out of attempts/);
	}
	assert.match(await say("render_beat", { index: 1, code: GOOD }), /out of attempts/);
	const saved = await handlers.get("get")({ id: "seq_cccccccc" });
	assert.equal(saved.beats[0].versions.length, MAX_ATTEMPTS);
	assert.ok(saved.beats[0].versions.every(version => version.status === "failed"));
	assert.equal(saved.beats[1].versions.length, 0);
});

test("a revision run cannot touch the storyboard or other clips", async () => {
	const { worker } = host();
	const first = toolsFor(worker, { sequenceId: "seq_dddddddd", concept: "X", origin: "learner" });
	await first.say("set_outline", { mode: "quick", question: "What does it do?" });
	await first.say("set_storyboard", { beats: [{ title: "One", caption: "c1" }, { title: "Two", caption: "c2" }] });
	const revise = toolsFor(worker, { sequenceId: "seq_dddddddd", concept: "X", origin: "learner", targets: [2], comment: "slower" }, "task_2");
	assert.match(await revise.say("set_outline", { mode: "quick", question: "New?" }), /outline is fixed/);
	assert.match(await revise.say("set_storyboard", { beats: [{ title: "Z", caption: "z" }] }), /storyboard is fixed/);
	assert.match(await revise.say("render_beat", { index: 1, code: GOOD }), /not part of this revision/);
});

test("handlers validate input", async () => {
	const { handlers } = host();
	await assert.rejects(async () => handlers.get("create")({ concept: "  " }), /concept is required/);
	await assert.rejects(async () => handlers.get("get")({ id: "nope" }), /Unknown animation/);
	await assert.rejects(async () => handlers.get("comment")({ id: "seq_zzzzzzzz", text: "x" }), /Unknown animation/);
	assert.deepEqual(Object.keys(await handlers.get("environment")()).sort(), ["ffmpeg", "latex", "manimgl", "manimglPath", "ready"]);
});

// ─── step-by-step derivations ────────────────────────────────────────────────

const { outlineProblems, storyboardProblems, outlineText, QUICK_BEATS, MAX_BEATS: CAP } = backend._internal;
const OUTLINE = {
	mode: "derivation", question: "Why is variance a squared length?",
	picture: "The data vector x in blue and its shadow on the all-ones direction in yellow; the leftover in red.",
	example: "Data 2, 4, 9: mean 5, deviations -3, -1, 4.",
	steps: [
		{ claim: "The mean is the shadow of x on the all-ones direction.", why: "Projecting onto 1 gives (x.1/1.1) 1 = mean times 1.", uses: "The projection formula." },
		{ claim: "x minus its shadow is the deviation vector.", why: "Subtracting the mean from each entry is subtracting mean times 1.", uses: "Step 1." },
		{ claim: "Variance is the squared length of the deviation vector over n.", why: "The squared length is the sum of squared deviations.", uses: "Step 2 and the definition of variance." },
	],
};
const NOTE = "We subtract the mean from every entry. That is allowed because the mean vector is the shadow we found. It leaves the deviation vector for the next step.";
const beat = (kind, step) => ({ title: kind, caption: "c", kind, why: "because", note: NOTE, ...(step ? { step } : {}) });
const BOARD = [beat("hook"), beat("example", 1), beat("example", 2), beat("predict"), beat("example", 3), beat("general", 3), beat("recap")];

test("a derivation outline needs a picture, numbers and a reason and a basis for every step", () => {
	assert.deepEqual(outlineProblems(OUTLINE), []);
	assert.deepEqual(outlineProblems({ mode: "quick", question: "What does it do?" }), []);
	assert.match(outlineProblems({ mode: "nope" }).join(), /mode must be/);
	assert.match(outlineProblems({ ...OUTLINE, picture: " " }).join(), /picture is required/);
	assert.match(outlineProblems({ ...OUTLINE, example: "some small data" }).join(), /actual numbers/);
	assert.match(outlineProblems({ ...OUTLINE, steps: OUTLINE.steps.slice(0, 1) }).join(), /at least 2 steps/);
	const gap = { ...OUTLINE, steps: [OUTLINE.steps[0], { claim: "Then variance appears.", why: "", uses: "" }] };
	assert.match(outlineProblems(gap).join(), /Step 2 has no reason/);
	assert.match(outlineProblems(gap).join(), /Step 2 does not say what it uses/);
});

test("the requested depth fixes the mode", () => {
	assert.match(outlineProblems(OUTLINE, "quick").join(), /asked for a quick look/);
	assert.match(outlineProblems({ mode: "quick", question: "q" }, "full").join(), /asked for a full derivation/);
	assert.deepEqual(outlineProblems(OUTLINE, "full"), []);
});

test("a derivation storyboard is concrete first, covers every step, pauses to predict and ends on a recap", () => {
	assert.deepEqual(storyboardProblems(OUTLINE, BOARD), []);
	const without = kind => BOARD.filter(item => item.kind !== kind);
	assert.match(storyboardProblems(OUTLINE, without("example").map(item => item.kind === "general" ? item : item)).join(), /Add example beats/);
	assert.match(storyboardProblems(OUTLINE, without("predict")).join(), /at least one predict/);
	assert.match(storyboardProblems(OUTLINE, without("recap")).join(), /last beat must be a recap/);
	assert.match(storyboardProblems(OUTLINE, without("general")).join(), /at least one general/);
	const generalFirst = [BOARD[0], BOARD[5], ...BOARD.slice(1, 5), BOARD[6]];
	assert.match(storyboardProblems(OUTLINE, generalFirst).join(), /concrete first/);
	const uncovered = BOARD.map(item => item.step === 2 ? { ...item, step: 1 } : item);
	assert.match(storyboardProblems(OUTLINE, uncovered).join(), /No beat covers outline step 2/);
	assert.match(storyboardProblems(OUTLINE, BOARD.map((item, index) => index === 2 ? { ...item, note: "Short." } : item)).join(), /Beat 3 needs a note/);
	assert.match(storyboardProblems(OUTLINE, BOARD.map((item, index) => index === 1 ? { ...item, why: "" } : item)).join(), /Beat 2 has no "why"/);
	assert.match(storyboardProblems(OUTLINE, [...BOARD.slice(0, 6), beat("predict")]).join(), /must be followed/);
	assert.match(storyboardProblems(OUTLINE, BOARD.map(item => item.step === 3 && item.kind === "general" ? { ...item, step: 9 } : item)).join(), /not an outline step/);
});

test("a quick look is capped and needs no kinds or notes", () => {
	const quick = { mode: "quick", question: "q" };
	assert.deepEqual(storyboardProblems(quick, [{ title: "a", caption: "b" }]), []);
	assert.match(storyboardProblems(quick, Array.from({ length: QUICK_BEATS + 1 }, () => ({ title: "a", caption: "b" }))).join(), /at most 4/);
	assert.equal(CAP, 16);
});

test("the worker refuses a storyboard that states the result without the reasoning, then accepts a full one", async () => {
	const { worker, handlers } = host();
	const { say } = toolsFor(worker, { sequenceId: "seq_eeeeeeee", concept: "variance", origin: "learner", depth: "full" });
	assert.match(await say("set_outline", { mode: "quick", question: "q" }), /asked for a full derivation/);
	assert.match(await say("set_outline", { ...OUTLINE, steps: [OUTLINE.steps[0], { claim: "So variance is a length.", why: " ", uses: " " }] }), /Step 2 has no reason/);
	assert.match(await say("set_outline", OUTLINE), /Outline saved \(derivation\)/);
	const resultOnly = [{ title: "The formula", caption: "c" }, { title: "The answer", caption: "c" }];
	const refused = await say("set_storyboard", { beats: resultOnly });
	assert.match(refused, /not ready/);
	assert.match(refused, /Add example beats/);
	assert.match(await say("set_storyboard", { beats: BOARD }), /7 beat/);
	const saved = await handlers.get("get")({ id: "seq_eeeeeeee" });
	assert.equal(saved.depth, "full");
	assert.equal(saved.outline.steps.length, 3);
	assert.deepEqual(saved.beats.map(item => item.kind), BOARD.map(item => item.kind));
	assert.equal(saved.beats[1].note, NOTE);
	assert.equal(saved.beats[1].step, 1);
	assert.match(outlineText(saved.outline), /Step 3: Variance is the squared length/);
	const listed = await handlers.get("list")();
	assert.equal(listed[0].mode, "derivation");
});

test("create rejects an unknown depth", async () => {
	const { handlers } = host();
	await assert.rejects(async () => handlers.get("create")({ concept: "x", depth: "deep" }), /Depth must be/);
});

test("create with no usable model fails before anything is written", async () => {
	const dataDirectory = temp();
	const handlers = new Map();
	process.env.MOTION_MANIMGL = process.execPath;
	try {
		backend.activate({
			dataDirectory, signal: new AbortController().signal, events: { emit() {} },
			workers: { register() {}, get: () => ({ status: "running" }), start: () => { throw new Error("must not start"); }, wait: async () => ({}), cancel() {} },
			handle: (name, handler) => handlers.set(name, handler), registerInstructions() {}, registerTools() {}, createBackgroundTool: () => ({}),
			inference: { catalog: async () => ({ models: [], slots: {} }) }, learning: { listSessions: () => [], getSession: () => null },
		});
		const state = await handlers.get("environment")();
		if (!state.ready) return; // ffmpeg or LaTeX missing here: the setup check refuses first, which is also before any write
		await assert.rejects(async () => handlers.get("create")({ concept: "x" }), /Enable the Claude Code provider/);
		assert.deepEqual(await handlers.get("list")(), []);
	} finally { delete process.env.MOTION_MANIMGL; }
});

// ─── continuing a run that was cut off ───────────────────────────────────────

const { resumePrompt, resumeTargets, canResume } = backend._internal;
const ready = () => { process.env.MOTION_MANIMGL = process.execPath; return backend._internal.environment().ready; };

test("a run that stopped after its outline continues from the storyboard, with the outline fixed", async () => {
	const { worker, handlers, started } = host({ status: "failed" });
	const first = toolsFor(worker, { sequenceId: "seq_ffffffff", concept: "variance", origin: "learner", depth: "auto" });
	await first.say("set_outline", OUTLINE);
	const stopped = await handlers.get("get")({ id: "seq_ffffffff" });
	assert.equal(stopped.resumable, true);
	try {
		if (!ready()) return;
		await handlers.get("resume")({ id: "seq_ffffffff" });
	} finally { delete process.env.MOTION_MANIMGL; }
	const { input, prompt } = started.at(-1);
	assert.equal(input.resume, true);
	assert.equal(input.targets, undefined);
	assert.match(prompt, /do not call set_outline/);
	assert.match(prompt, /Step 3: Variance is the squared length/);
	assert.match(prompt, /Call set_storyboard to turn this plan into beats/);
	assert.doesNotMatch(prompt, /earlier run|cut off|Why:|builds on|The projection formula/);
	assert.match(prompt, /because: Projecting onto 1/);
	const again = toolsFor(worker, input, "task_2");
	assert.match(await again.say("set_outline", { mode: "quick", question: "q" }), /already saved and fixed/);
	assert.match(await again.say("set_storyboard", { beats: BOARD }), /7 beat/);
	assert.equal((await handlers.get("get")({ id: "seq_ffffffff" })).outline.steps.length, 3);
});

test("a run that stopped mid-render continues with only the missing clips", () => {
	const version = status => ({ v: 1, status });
	const sequence = { concept: "variance", outline: OUTLINE, beats: BOARD.slice(0, 4).map((item, index) => ({ ...item, index: index + 1, title: `Beat ${index + 1}`, versions: index < 2 ? [version("ok")] : index === 2 ? [{ ...version("failed"), error: "NameError: x" }] : [] })) };
	assert.deepEqual(resumeTargets(sequence), [3, 4]);
	assert.equal(canResume(sequence), true);
	const prompt = resumePrompt(sequence, [3, 4], item => `code of ${item.index}`);
	assert.match(prompt, /do not call set_storyboard/);
	assert.match(prompt, /1\. \(hook\) Beat 1 \[made\]/);
	assert.match(prompt, /3\. \(example\) Beat 3 \[to make\]/);
	assert.match(prompt, /Scene source of beat 2/);
	assert.match(prompt, /NameError: x/);
	assert.match(prompt, /render_beat for beats 3, 4 only/);
	const whole = { ...sequence, beats: sequence.beats.map(item => ({ ...item, versions: [version("ok")] })) };
	assert.equal(canResume(whole), false);
	assert.equal(canResume({ beats: [] }), false);
});

test("resume refuses a working run, a run with no outline and a finished one", async () => {
	const busy = host();
	await toolsFor(busy.worker, { sequenceId: "seq_gggggggg", concept: "x", origin: "learner" }).say("set_outline", OUTLINE);
	await assert.rejects(async () => busy.handlers.get("resume")({ id: "seq_gggggggg" }), /still working/);
	const idle = host({ status: "failed" });
	const tools = toolsFor(idle.worker, { sequenceId: "seq_hhhhhhhh", concept: "x", origin: "learner" });
	await tools.say("render_beat", { index: 1, code: GOOD });
	await assert.rejects(async () => idle.handlers.get("resume")({ id: "seq_hhhhhhhh" }), /nothing to continue/);
	assert.equal((await idle.handlers.get("get")({ id: "seq_hhhhhhhh" })).resumable, false);
	assert.equal(idle.started.length, 0);
});

// ─── restarting after a blocked request ──────────────────────────────────────

const settle = async () => { for (let index = 0; index < 60; index++) await new Promise(resolve => setImmediate(resolve)); };
const REFUSED = { status: "failed", error: { message: "Blocked. (refusal category: reasoning_extraction)" } };

test("a run blocked by the filter restarts itself, a bounded number of times", async () => {
	const { worker, handlers, started } = host({ status: "failed", outcome: REFUSED });
	await toolsFor(worker, { sequenceId: "seq_iiiiiiii", concept: "variance", origin: "learner" }).say("set_outline", OUTLINE);
	try {
		if (!ready()) return;
		await handlers.get("resume")({ id: "seq_iiiiiiii" });
		await settle();
		assert.equal(started.length, 1 + backend._internal.MAX_AUTO_RESUMES);
		assert.equal((await handlers.get("get")({ id: "seq_iiiiiiii" })).autoResumes, backend._internal.MAX_AUTO_RESUMES);
		await handlers.get("resume")({ id: "seq_iiiiiiii" }); // asking by hand starts the count again
		await settle();
		assert.equal(started.length, 2 * (1 + backend._internal.MAX_AUTO_RESUMES));
	} finally { delete process.env.MOTION_MANIMGL; }
});

test("a run that failed for another reason, or has nothing left to make, is not restarted", async () => {
	const other = host({ status: "failed", outcome: { status: "failed", error: { message: "claude CLI ended the message without a stop reason" } } });
	await toolsFor(other.worker, { sequenceId: "seq_jjjjjjjj", concept: "variance", origin: "learner" }).say("set_outline", OUTLINE);
	try {
		if (!ready()) return;
		await other.handlers.get("resume")({ id: "seq_jjjjjjjj" });
		await settle();
		assert.equal(other.started.length, 1);
		const blocked = host({ status: "failed", outcome: REFUSED });
		await blocked.handlers.get("create")({ concept: "no outline yet" });
		await settle();
		assert.equal(blocked.started.length, 1);
	} finally { delete process.env.MOTION_MANIMGL; }
});

// ─── checking a clip before the learner sees it ──────────────────────────────

const { hooks } = backend._internal;
const withRenders = async (frames, body) => {
	const saved = { ...hooks };
	hooks.render = async ({ folder }) => { fs.writeFileSync(path.join(folder, "clip.mp4"), "video"); return { ok: true, clip: path.join(folder, "clip.mp4") }; };
	hooks.frames = async () => frames;
	try { await body(); } finally { Object.assign(hooks, saved); }
};
const FRAMES = ["early", "middle", "last"].map(name => ({ name, data: "AAAA", mimeType: "image/jpeg" }));
const quickRun = async (id, taskId = "task_1") => {
	const run = host({ status: "running" });
	const tools = toolsFor(run.worker, { sequenceId: id, concept: "x", origin: "learner" }, taskId);
	await tools.say("set_outline", { mode: "quick", question: "What does it do?" });
	await tools.say("set_storyboard", { beats: [{ title: "One", caption: "c1" }] });
	return { ...run, ...tools };
};

test("a rendered clip is hidden until the model approves it from its frames", () => withRenders(FRAMES, async () => {
	const { tools, say, handlers, worker, context } = await quickRun("seq_kkkkkkkk");
	const result = await tools.render_beat.execute("call", { index: 1, code: GOOD });
	assert.match(result.content[0].text, /hidden from the learner until you check it/);
	assert.deepEqual(result.content.slice(1).map(item => item.type), ["image", "image", "image"]);
	const hidden = await handlers.get("get")({ id: "seq_kkkkkkkk" });
	assert.equal(hidden.beats[0].versions[0].status, "review");
	await assert.rejects(async () => handlers.get("clip")({ id: "seq_kkkkkkkk", beat: 1, v: 1 }), /no video/);
	await assert.rejects(async () => worker.validateResult({ summary: "s" }, context), /waiting for its check/);
	assert.match(await say("approve_beat", { index: 1, checked: "Blue and orange arrows, nothing overlaps." }), /approved and shown/);
	const shown = (await handlers.get("get")({ id: "seq_kkkkkkkk" })).beats[0].versions[0];
	assert.equal(shown.status, "ok");
	assert.equal(shown.unchecked, undefined);
	assert.match(shown.checked, /Blue and orange/);
	worker.validateResult({ summary: "s" }, context);
	assert.match(await say("approve_beat", { index: 1, checked: "again" }), /no render waiting/);
}));

test("a fix replaces the render under check, and a clip never approved is shown as not checked", () => withRenders(FRAMES, async () => {
	const { say, handlers } = await quickRun("seq_llllllll");
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) await say("render_beat", { index: 1, code: GOOD });
	let versions = (await handlers.get("get")({ id: "seq_llllllll" })).beats[0].versions;
	assert.deepEqual(versions.map(version => version.status), ["replaced", "replaced", "replaced", "review"]);
	assert.match(await say("render_beat", { index: 1, code: GOOD }), /out of attempts\. Its last render is kept, marked as not checked/);
	versions = (await handlers.get("get")({ id: "seq_llllllll" })).beats[0].versions;
	assert.equal(versions.at(-1).status, "ok");
	assert.equal(versions.at(-1).unchecked, true);
}));

test("a render left under check when its run ends is released as not checked", () => withRenders(FRAMES, async () => {
	const { say, handlers, dataDirectory } = await quickRun("seq_mmmmmmmm");
	await say("render_beat", { index: 1, code: GOOD });
	const file = path.join(dataDirectory, "sequences", "seq_mmmmmmmm", "sequence.json");
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).beats[0].versions[0].status, "review");
	// The same data seen by a host whose run is no longer working.
	const later = { handlers: new Map() };
	backend.activate({ dataDirectory, signal: new AbortController().signal, events: { emit() {} },
		workers: { register() {}, get: () => ({ status: "failed" }), start() {}, wait: async () => ({}), cancel() {} },
		handle: (name, handler) => later.handlers.set(name, handler), registerInstructions() {}, registerTools() {}, createBackgroundTool: () => ({}),
		inference: { catalog: async () => ({ models: [], slots: {} }) }, learning: { listSessions: () => [], getSession: () => null } });
	const seen = (await later.handlers.get("get")({ id: "seq_mmmmmmmm" })).beats[0].versions[0];
	assert.equal(seen.status, "ok");
	assert.equal(seen.unchecked, true);
	assert.ok(handlers);
}));

test("a clip with no frames to look at is shown without a check", () => withRenders([], async () => {
	const { say, handlers } = await quickRun("seq_nnnnnnnn");
	assert.match(await say("render_beat", { index: 1, code: GOOD }), /shown without a check/);
	const version = (await handlers.get("get")({ id: "seq_nnnnnnnn" })).beats[0].versions[0];
	assert.equal(version.status, "ok");
	assert.equal(version.unchecked, true);
}));
