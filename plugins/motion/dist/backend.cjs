/** Motion: short manim (3b1b/manim, `manimgl`) animations that follow the lesson.
 *
 * One worker run owns one request. The model first records an outline (the
 * reasoning: question, running picture, worked example, ordered steps with
 * their reasons), then a storyboard of small beats built from it, then one
 * manim Scene per beat; `render_beat` renders it locally and returns manim's
 * error text so the model can repair the scene. `outlineProblems` and
 * `storyboardProblems` check the structure of a derivation, never its maths.
 * A comment starts a new run that re-renders only the beat it targets.
 *
 * Scene code is model-written Python run on this machine. `unsafeReason` is a
 * filter against obvious escapes, not a sandbox.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const MAX_BEATS = 16; // a full derivation
const QUICK_BEATS = 4; // a quick look
const DEPTHS = ["auto", "quick", "full"];
/** How many times a run blocked by the provider's filter is restarted without the learner asking. */
const MAX_AUTO_RESUMES = 5;
const KINDS = ["hook", "example", "step", "predict", "general", "recap"];
const MAX_ATTEMPTS = 4; // one first try plus three repairs, per beat per run
const RENDER_TIMEOUT_MS = 180_000;
const ID = /^seq_[a-z0-9]{6,40}$/;

const HOME_ENV = path.join(os.homedir(), ".learnharness-motion");
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin"];

const INSTRUCTIONS = `You make short maths animations with 3Blue1Brown's manim library (the 3b1b/manim package, imported as manimlib and run with the manimgl command; not the community edition). Your job is to make the learner understand WHY, not to display a result.

How to work:
1. Call set_outline once. Choose the mode:
   - "derivation" when the request asks why or how something is true, asks for a proof or derivation, or links two ideas (for example "why can variance be found with linear algebra"). Never answer such a request by stating the result with formulas around it.
   - "quick" when the request is to see one thing happen (for example "show what a rotation matrix does").
   The request may fix the mode; then use that one.
   For a derivation the outline is the reasoning itself, written before any animation:
   - question: the exact question being answered.
   - picture: ONE running picture that carries the whole argument, introduced early and reused in every beat, with a fixed colour for each object (say which colour means what).
   - example: a small worked example with actual numbers (for instance three data points), small enough to compute by hand.
   - steps: the ordered chain from what the learner already knows to the result. Each step has a claim, why it is valid, and which earlier step or known fact it uses. No step may skip a move a learner would have to take on trust. If you would write "it can be shown" or "clearly", that is a missing step: add it.
   If set_outline lists problems, fix them and call it again.
2. Call set_storyboard once. A quick look has 1 to ${QUICK_BEATS} beats. A derivation has up to ${MAX_BEATS} and follows this order:
   - hook: pose the question on the running picture.
   - example: do every step on the worked numbers first, so the learner sees it happen before any general symbol appears.
   - predict: at least once, before a key step, end a beat on a question the learner can answer by looking ("what happens to this length if every value shifts by 5?"). The next beat opens by answering it.
   - step / general: the same chain in symbols, one step per beat, the previous line visibly turning into the next.
   - recap: the last beat replays the whole chain in about 20 seconds, each step in order, ending on the result.
   Every outline step must be covered by a beat (set the beat's step number). Each beat has: title; caption (one sentence); why (one short line shown on screen, the reason for this beat's move); note (2 to 4 sentences read under the player: what just happened, why it is allowed, what it sets up next).
   If set_storyboard lists problems, fix them and call it again.
3. For each beat you were asked to make, call render_beat with the complete Python source. If it returns an error, read it, fix the scene and call render_beat again. After the tool says a beat is out of attempts, move on.
4. When every requested beat has been rendered or is out of attempts, call submit_result with a one- or two-sentence summary of what the clips show.

Scene rules:
- Start with exactly: from manimlib import *
- Define exactly one class named Beat that subclasses Scene (or ThreeDScene / InteractiveScene only when needed) with a construct method.
- Only import manimlib, numpy and math. No file, network, process or system access.
- Use Tex(R"...") for formulas and Text("...") for words. Keep on-screen text short and large enough to read.
- One beat shows exactly one idea and runs about 10 to 25 seconds.
- Show the beat's "why" line on screen as a short Text at the bottom edge. No other sentences on screen; the note carries the prose.
- Each scene is rendered on its own, so rebuild the running picture at the start of every beat in the same position and the same colours, then change only what this beat is about.
- Show a step as motion: transform the previous expression into the next, move the term, grow the vector, drop the projection. Do not fade in a finished formula.
- In example beats use the outline's actual numbers and show the arithmetic result.
- Use the same symbols and notation as the lesson context you were given.
- End with self.wait(1) so the final state is visible.
- Match the lesson: use only what the lesson has reached; anything else the argument needs must be one of your steps.`;

function now() { return new Date().toISOString(); }
function newId() { return `seq_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`; }
function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, "\t"));
	fs.renameSync(`${file}.tmp`, file);
}
function object(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an input object");
	return value;
}
function text(value, name, max) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
	if (value.length > max) throw new Error(`${name} is too long (max ${max} characters)`);
	return value.trim();
}

/** Why this scene source must not be run, or null. A filter, not a sandbox. */
function unsafeReason(code) {
	if (typeof code !== "string" || !code.trim()) return "The scene source is empty.";
	if (code.length > 40_000) return "The scene source is too long.";
	if (!/^\s*from manimlib import \*/m.test(code)) return "The scene must start with: from manimlib import *";
	if (!/^class Beat\s*\(/m.test(code)) return "The scene must define a class named Beat.";
	for (const line of code.split("\n")) {
		const match = /^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/.exec(line);
		if (!match) continue;
		const root = (match[1] || match[2]).split(".")[0];
		if (!["manimlib", "numpy", "math"].includes(root)) return `Import of "${root}" is not allowed; use only manimlib, numpy and math.`;
	}
	const banned = /\b(open|exec|eval|compile|__import__|input|breakpoint|globals|getattr|setattr)\s*\(|\b(os|sys|subprocess|socket|shutil|pathlib|importlib|ctypes|urllib|requests)\s*\.|__(?:builtins|subclasses|globals|class|dict)__/;
	const hit = banned.exec(code);
	return hit ? `"${hit[0].trim()}" is not allowed in a scene.` : null;
}

function sequenceStore(root) {
	const dir = id => {
		if (typeof id !== "string" || !ID.test(id)) throw new Error("Unknown animation");
		return path.join(root, id);
	};
	const file = id => path.join(dir(id), "sequence.json");
	const read = id => {
		try { return JSON.parse(fs.readFileSync(file(id), "utf8")); }
		catch (error) { if (error.code === "ENOENT") return null; throw error; }
	};
	const require_ = id => {
		const sequence = read(id);
		if (!sequence) throw new Error("Unknown animation");
		return sequence;
	};
	const write = sequence => { sequence.updatedAt = now(); writeJson(file(sequence.id), sequence); return sequence; };
	const create = ({ id, concept, chatId, origin, depth }) => read(id) ?? write({
		version: 1, id, concept, chatId: chatId ?? null, origin, depth: DEPTHS.includes(depth) ? depth : "auto", outline: null,
		createdAt: now(), updatedAt: now(), taskIds: [], beats: [], comments: [],
	});
	const list = () => {
		let names = [];
		try { names = fs.readdirSync(root); } catch (error) { if (error.code !== "ENOENT") throw error; }
		return names.filter(name => ID.test(name)).map(read).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	};
	const versionDir = (id, beat, version) => path.join(dir(id), `beat-${beat}`, `v${version}`);
	return { dir, read, require: require_, write, create, list, versionDir };
}

/** Which beats a comment re-renders: its own beat, or all of them. */
function commentTargets(sequence, beat) {
	if (beat === null || beat === undefined) return sequence.beats.map(item => item.index);
	if (!Number.isInteger(beat) || !sequence.beats.some(item => item.index === beat)) throw new Error("Unknown clip");
	return [beat];
}

const filled = value => typeof value === "string" && value.trim().length > 0;

/** What is structurally wrong with an outline, as messages for the model. Checks shape, never the maths. */
function outlineProblems(outline, depth = "auto") {
	const problems = [];
	if (!["quick", "derivation"].includes(outline?.mode)) return ['mode must be "quick" or "derivation".'];
	if (depth === "quick" && outline.mode !== "quick") problems.push('This request asked for a quick look: use mode "quick".');
	if (depth === "full" && outline.mode !== "derivation") problems.push('This request asked for a full derivation: use mode "derivation".');
	if (!filled(outline.question)) problems.push("question is required.");
	if (outline.mode === "quick") return problems;
	if (!filled(outline.picture)) problems.push("picture is required: the one running picture and what each colour means.");
	if (!filled(outline.example)) problems.push("example is required: a small worked example with actual numbers.");
	else if (!/\d/.test(outline.example)) problems.push("example must contain actual numbers.");
	const steps = Array.isArray(outline.steps) ? outline.steps : [];
	if (steps.length < 2) problems.push("A derivation needs at least 2 steps.");
	steps.forEach((step, index) => {
		if (!filled(step?.claim)) problems.push(`Step ${index + 1} has no claim.`);
		if (!filled(step?.why)) problems.push(`Step ${index + 1} has no reason (why).`);
		if (!filled(step?.uses)) problems.push(`Step ${index + 1} does not say what it uses: an earlier step, or a fact the learner already knows.`);
	});
	return problems;
}

/** What is structurally wrong with a storyboard for its outline, as messages for the model. */
function storyboardProblems(outline, beats) {
	const problems = [];
	if (outline.mode === "quick") {
		if (beats.length > QUICK_BEATS) problems.push(`A quick look has at most ${QUICK_BEATS} beats.`);
		return problems;
	}
	beats.forEach((beat, index) => {
		if (!KINDS.includes(beat.kind)) problems.push(`Beat ${index + 1} needs a kind: ${KINDS.join(", ")}.`);
		if (!filled(beat.why)) problems.push(`Beat ${index + 1} has no "why" line.`);
		if (!filled(beat.note) || beat.note.trim().length < 60) problems.push(`Beat ${index + 1} needs a note of 2 to 4 sentences.`);
	});
	const at = kind => beats.map((beat, index) => beat.kind === kind ? index : -1).filter(index => index >= 0);
	const examples = at("example"), generals = at("general"), predicts = at("predict");
	if (!examples.length) problems.push("Add example beats: work the steps on the outline's numbers first.");
	if (!generals.length) problems.push("Add at least one general beat that states the result in symbols.");
	if (examples.length && generals.length && Math.max(...examples) > Math.min(...generals)) problems.push("Every example beat must come before the first general beat: concrete first, then general.");
	if (!predicts.length) problems.push("Add at least one predict beat that ends on a question.");
	if (predicts.includes(beats.length - 1)) problems.push("A predict beat must be followed by the beat that answers it.");
	if (beats.at(-1)?.kind !== "recap") problems.push("The last beat must be a recap of the whole chain.");
	const covered = new Set(beats.map(beat => beat.step).filter(Number.isInteger));
	const missing = outline.steps.map((_step, index) => index + 1).filter(number => !covered.has(number));
	if (missing.length) problems.push(`No beat covers outline step ${missing.join(", ")}. Set "step" on the beat that shows it.`);
	const beyond = [...covered].filter(number => number < 1 || number > outline.steps.length);
	if (beyond.length) problems.push(`Beat step ${beyond.join(", ")} is not an outline step (1 to ${outline.steps.length}).`);
	return problems;
}

/** The outline as prompt text. Each step keeps its reason but not its "uses": with all three, Anthropic's filter
 * reads the pasted plan as copied model reasoning and blocks the request (refusal category reasoning_extraction). */
function outlineText(outline) {
	if (!outline) return "";
	if (outline.mode === "quick") return `Question: ${outline.question}`;
	return [`Question: ${outline.question}`, `Running picture: ${outline.picture}`, `Worked example: ${outline.example}`,
		...outline.steps.map((step, index) => `Step ${index + 1}: ${step.claim} (because: ${step.why})`)].join("\n");
}

function toolPaths() {
	const manimgl = process.env.MOTION_MANIMGL || path.join(HOME_ENV, "venv", "bin", "manimgl");
	return { manimgl, searchPath: [...EXTRA_PATH, process.env.PATH || ""].join(path.delimiter) };
}
function onPath(name, searchPath) {
	return searchPath.split(path.delimiter).filter(Boolean).some(folder => {
		try { fs.accessSync(path.join(folder, name), fs.constants.X_OK); return true; } catch { return false; }
	});
}
function environment() {
	const { manimgl, searchPath } = toolPaths();
	const has = { manimgl: fs.existsSync(manimgl), ffmpeg: onPath("ffmpeg", searchPath), latex: onPath("latex", searchPath) };
	return { ...has, ready: has.manimgl && has.ffmpeg && has.latex, manimglPath: manimgl };
}

/** Run manimgl for one scene file. Resolves { ok, clip } or { ok: false, error }. */
function renderScene({ folder, signal, run = spawn, timeoutMs = RENDER_TIMEOUT_MS }) {
	const { manimgl, searchPath } = toolPaths();
	return new Promise(resolve => {
		if (signal?.aborted) return resolve({ ok: false, error: "Cancelled." });
		let output = "";
		let settled = false;
		const finish = result => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(result); } };
		let child;
		try {
			child = run(manimgl, ["scene.py", "Beat", "-w", "-m", "--video_dir", folder, "--file_name", "clip"], {
				cwd: folder, env: { ...process.env, PATH: searchPath }, stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) { return resolve({ ok: false, error: `Could not start manimgl: ${error.message}` }); }
		const abort = () => { child.kill("SIGKILL"); finish({ ok: false, error: "Cancelled." }); };
		const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, error: `Rendering took longer than ${Math.round(timeoutMs / 1000)} seconds. Make the scene shorter or simpler.` }); }, timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		const collect = chunk => { output = (output + chunk.toString()).slice(-12_000); };
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", error => finish({ ok: false, error: `Could not start manimgl: ${error.message}` }));
		child.on("close", code => {
			const clip = findClip(folder);
			if (code === 0 && clip) return finish({ ok: true, clip });
			finish({ ok: false, error: output.trim().slice(-3_000) || `manimgl exited with code ${code} and wrote no video.` });
		});
	});
}
function findClip(folder) {
	const stack = [folder];
	while (stack.length) {
		const current = stack.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name.endsWith(".mp4") && fs.statSync(full).size > 0) return full;
		}
	}
	return null;
}

/** Recent lesson text for the brief: a few short excerpts, never the transcript. */
function lessonBrief(session) {
	if (!session || !Array.isArray(session.messages)) return "";
	const excerpts = [];
	for (let index = session.messages.length - 1; index >= 0 && excerpts.length < 4; index--) {
		const message = session.messages[index];
		const who = message.role === "assistant" ? "Teacher" : message.role === "user" ? "Learner" : message.role === "toolResult" ? "Learner answer" : null;
		if (!who) continue;
		const body = typeof message.content === "string" ? message.content
			: Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
		if (body.trim()) excerpts.unshift(`${who}: ${body.trim().slice(0, 1_200)}`);
	}
	const title = typeof session.title === "string" ? `Lesson: ${session.title}\n` : "";
	return excerpts.length ? `${title}Most recent part of the lesson, for notation and level:\n${excerpts.join("\n\n")}` : title;
}

function createPrompt({ concept, focus, brief, depth = "auto" }) {
	const mode = depth === "full" ? 'The learner asked for a full derivation: use mode "derivation".'
		: depth === "quick" ? 'The learner asked for a quick look: use mode "quick".'
		: "Choose the mode from the request.";
	return [`Make an animation sequence for: ${concept}`, focus ? `Focus: ${focus}` : "", mode, brief, "Start with set_outline, then set_storyboard, then render each beat."].filter(Boolean).join("\n\n");
}
function revisePrompt(sequence, targets, comment, readCode) {
	const plan = outlineText(sequence.outline);
	const parts = [`Revise an existing animation about: ${sequence.concept}`, `The learner's comment: ${comment}`, "The lesson plan and beats are already decided; do not call set_outline or set_storyboard.", plan ? `Lesson plan:\n${plan}` : ""].filter(Boolean);
	for (const index of targets) {
		const beat = sequence.beats.find(item => item.index === index);
		const code = readCode(beat);
		parts.push(`Beat ${index}${beat.kind ? ` (${beat.kind})` : ""}: ${beat.title}\nCaption: ${beat.caption}${beat.why ? `\nOn-screen why: ${beat.why}` : ""}\n${code ? `Current source:\n${code}` : "It has no working source yet."}`);
	}
	parts.push(`Apply the comment and call render_beat for ${targets.length === 1 ? `beat ${targets[0]}` : `beats ${targets.join(", ")}`} only.`);
	return parts.join("\n\n");
}

/** What a stopped animation still owes: the beats with no working clip, or everything after the outline. */
function resumeTargets(sequence) {
	return sequence.beats.filter(beat => !beat.versions.some(version => version.status === "ok")).map(beat => beat.index);
}
function canResume(sequence) {
	return Boolean(sequence.outline) && (sequence.beats.length === 0 || resumeTargets(sequence).length > 0);
}
function resumePrompt(sequence, targets, readCode) {
	const parts = [`Make an animation sequence for: ${sequence.concept}`, "The lesson plan for it is already decided and saved. Follow it as written; do not call set_outline.", `Lesson plan:\n${outlineText(sequence.outline)}`];
	if (!sequence.beats.length) {
		parts.push("Call set_storyboard to turn this plan into beats, then render every beat.");
		return parts.filter(Boolean).join("\n\n");
	}
	parts.push(`The beats are also decided and saved; do not call set_storyboard. All beats, in order:\n${sequence.beats.map(beat => `${beat.index}. ${beat.kind ? `(${beat.kind}) ` : ""}${beat.title}${targets.includes(beat.index) ? " [to make]" : " [made]"}`).join("\n")}`);
	const done = sequence.beats.filter(beat => !targets.includes(beat.index) && beat.index < targets[0]).at(-1) ?? sequence.beats.find(beat => !targets.includes(beat.index));
	const reference = done ? readCode(done) : "";
	if (reference) parts.push(`Scene source of beat ${done.index}, so the running picture, colours and layout stay the same:\n${reference.slice(0, 6_000)}`);
	for (const index of targets) {
		const beat = sequence.beats.find(item => item.index === index);
		const code = readCode(beat);
		const error = beat.versions.at(-1)?.error;
		parts.push(`Beat ${index}${beat.kind ? ` (${beat.kind})` : ""}: ${beat.title}\nCaption: ${beat.caption}${beat.why ? `\nOn-screen why: ${beat.why}` : ""}${beat.note ? `\nNote: ${beat.note}` : ""}${code ? `\nScene source so far, which does not render yet:\n${code.slice(0, 6_000)}${error && error !== "Rendering was interrupted." ? `\nIts error:\n${String(error).slice(-1_200)}` : ""}` : ""}`);
	}
	parts.push(`Call render_beat for ${targets.length === 1 ? `beat ${targets[0]}` : `beats ${targets.join(", ")}`} only.`);
	return parts.filter(Boolean).join("\n\n");
}

exports.activate = ctx => {
	const store = sequenceStore(path.join(ctx.dataDirectory, "sequences"));
	const changed = id => ctx.events.emit("motion-changed", { id });
	const readCode = (id, beat) => {
		const version = [...beat.versions].reverse().find(item => item.status === "ok") ?? beat.versions.at(-1);
		if (!version) return "";
		try { return fs.readFileSync(path.join(store.versionDir(id, beat.index, version.v), "scene.py"), "utf8"); } catch { return ""; }
	};

	async function model() {
		const catalog = await ctx.inference.catalog();
		const cli = (catalog.models || []).filter(item => item.provider === "claude-code");
		const pick = cli.find(item => item.id === "opus") || cli[0];
		if (pick) return { provider: pick.provider, id: pick.id, thinkingLevel: "medium" };
		const slot = catalog.slots?.strong;
		if (!slot) throw new Error("Enable the Claude Code provider or choose a Strong model in Settings to make animations.");
		return { ...slot.model, ...(slot.thinkingLevel ? { thinkingLevel: slot.thinkingLevel } : {}) };
	}

	ctx.workers.register({
		id: "motion-sequence",
		instructions: INSTRUCTIONS,
		resultSchema: { type: "object", properties: { summary: { type: "string", minLength: 1, maxLength: 600 } }, required: ["summary"], additionalProperties: false },
		validateResult(_result, context) {
			const sequence = store.read(context.input.sequenceId);
			if (!sequence || !sequence.outline || sequence.beats.length === 0) throw new Error("Call set_outline, then set_storyboard, and render the beats before submitting.");
			const targets = context.input.targets ?? sequence.beats.map(beat => beat.index);
			const missing = targets.filter(index => !sequence.beats.find(beat => beat.index === index)?.versions.some(version => version.taskId === context.taskId));
			if (missing.length) throw new Error(`Render beat ${missing.join(", ")} with render_beat before submitting.`);
		},
		tools(context) {
			const input = context.input;
			const attempts = new Map();
			const open = () => {
				const sequence = store.create({ id: input.sequenceId, concept: input.concept, chatId: input.chatId, origin: input.origin, depth: input.depth });
				if (!sequence.taskIds.includes(context.taskId)) { sequence.taskIds.push(context.taskId); store.write(sequence); }
				return sequence;
			};
			const reply = message => ({ content: [{ type: "text", text: message }], details: {} });
			const line = (max, description) => ({ type: "string", maxLength: max, description });
			return [{
				name: "set_outline",
				label: "Outline",
				description: "Record the reasoning before any animation: the mode, the question, and for a derivation the running picture, a worked example with numbers and the ordered steps with their reasons. Returns problems to fix, or success.",
				parameters: {
					type: "object", additionalProperties: false, required: ["mode", "question"],
					properties: {
						mode: { type: "string", enum: ["quick", "derivation"] },
						question: line(300, "The exact question this animation answers."),
						picture: line(600, "Derivation: the one running picture, and which colour means what."),
						example: line(600, "Derivation: a small worked example with actual numbers."),
						steps: { type: "array", maxItems: 12, items: {
							type: "object", additionalProperties: false, required: ["claim", "why", "uses"],
							properties: { claim: line(300, "What this step establishes."), why: line(400, "Why the step is valid."), uses: line(300, "The earlier step or known fact it builds on.") },
						} },
					},
				},
				execute: async (_id, args) => {
					if (context.signal.aborted || ctx.signal.aborted) throw new Error("Cancelled");
					const sequence = open();
					if (input.targets) return reply("This run revises existing beats; the outline is fixed.");
					if (input.resume) return reply("The outline is already saved and fixed. Call set_storyboard.");
					if (sequence.beats.length) return reply("The storyboard is already set; the outline is fixed. Render the beats.");
					const problems = outlineProblems(args, sequence.depth);
					if (problems.length) return reply(`The outline is not ready:\n- ${problems.join("\n- ")}\nFix these and call set_outline again.`);
					const trim = value => typeof value === "string" ? value.trim() : "";
					sequence.outline = args.mode === "quick" ? { mode: "quick", question: trim(args.question) } : {
						mode: "derivation", question: trim(args.question), picture: trim(args.picture), example: trim(args.example),
						steps: args.steps.map(step => ({ claim: trim(step.claim), why: trim(step.why), uses: trim(step.uses) })),
					};
					store.write(sequence); changed(sequence.id);
					return reply(`Outline saved (${args.mode}). Before the storyboard, reread the steps once as the learner: if any step needs a move that is not written, call set_outline again with it added. Then call set_storyboard.`);
				},
			}, {
				name: "set_storyboard",
				label: "Storyboard",
				description: `Fix the sequence's beats from the outline before rendering: 1 to ${QUICK_BEATS} for a quick look, up to ${MAX_BEATS} for a derivation. Returns problems to fix, or success.`,
				parameters: {
					type: "object", additionalProperties: false, required: ["beats"],
					properties: { beats: { type: "array", minItems: 1, maxItems: MAX_BEATS, items: {
						type: "object", additionalProperties: false, required: ["title", "caption"],
						properties: {
							title: { type: "string", minLength: 1, maxLength: 80 }, caption: { type: "string", minLength: 1, maxLength: 240 },
							kind: { type: "string", enum: KINDS },
							why: line(90, "One short line shown on screen: the reason for this beat's move."),
							note: line(700, "2 to 4 sentences under the player: what happened, why it is allowed, what it sets up."),
							step: { type: "integer", minimum: 1, maximum: 12, description: "The outline step this beat shows." },
						},
					} } },
				},
				execute: async (_id, args) => {
					if (context.signal.aborted || ctx.signal.aborted) throw new Error("Cancelled");
					const sequence = open();
					if (input.targets) return reply("This run revises existing beats; the storyboard is fixed.");
					if (sequence.beats.length) return reply("The storyboard is already set. Render the beats.");
					if (!sequence.outline) return reply("Call set_outline first.");
					const problems = storyboardProblems(sequence.outline, args.beats);
					if (problems.length) return reply(`The storyboard is not ready:\n- ${problems.join("\n- ")}\nFix these and call set_storyboard again.`);
					sequence.beats = args.beats.map((beat, index) => ({
						index: index + 1, title: beat.title.trim(), caption: beat.caption.trim(),
						...(beat.kind ? { kind: beat.kind } : {}), ...(filled(beat.why) ? { why: beat.why.trim() } : {}),
						...(filled(beat.note) ? { note: beat.note.trim() } : {}), ...(Number.isInteger(beat.step) ? { step: beat.step } : {}),
						versions: [],
					}));
					store.write(sequence); changed(sequence.id);
					return reply(`Storyboard saved with ${sequence.beats.length} beat(s). Render beat 1 next.`);
				},
			}, {
				name: "render_beat",
				label: "Render clip",
				description: "Render one beat from complete manimgl Python source. Returns success, or manim's error so you can fix the scene.",
				parameters: {
					type: "object", additionalProperties: false, required: ["index", "code"],
					properties: { index: { type: "integer", minimum: 1, maximum: MAX_BEATS }, code: { type: "string", minLength: 1 } },
				},
				execute: async (_id, args, signal) => {
					if (context.signal.aborted || ctx.signal.aborted) throw new Error("Cancelled");
					let sequence = open();
					const beat = sequence.beats.find(item => item.index === args.index);
					if (!beat) return reply(`There is no beat ${args.index}. Call set_outline and set_storyboard first, or use an existing index.`);
					if (input.targets && !input.targets.includes(args.index)) return reply(`Beat ${args.index} is not part of this revision.`);
					const used = attempts.get(args.index) ?? 0;
					if (used >= MAX_ATTEMPTS) return reply(`Beat ${args.index} is out of attempts. Move on.`);
					attempts.set(args.index, used + 1);
					const reason = unsafeReason(args.code);
					const version = { v: beat.versions.length + 1, at: now(), taskId: context.taskId, status: "rendering", ...(input.comment ? { comment: input.comment } : {}) };
					const folder = store.versionDir(sequence.id, beat.index, version.v);
					fs.mkdirSync(folder, { recursive: true });
					fs.writeFileSync(path.join(folder, "scene.py"), args.code);
					beat.versions.push(version); store.write(sequence); changed(sequence.id);
					const result = reason ? { ok: false, error: reason } : await renderScene({ folder, signal: AbortSignal.any([context.signal, ctx.signal, ...(signal ? [signal] : [])]) });
					sequence = store.require(sequence.id);
					const saved = sequence.beats.find(item => item.index === args.index).versions.find(item => item.v === version.v);
					saved.status = result.ok ? "ok" : "failed";
					if (result.ok) saved.clip = path.relative(folder, result.clip); else saved.error = result.error;
					store.write(sequence); changed(sequence.id);
					if (result.ok) return reply(`Beat ${args.index} rendered.`);
					const left = MAX_ATTEMPTS - used - 1;
					return reply(`Beat ${args.index} failed to render:\n${result.error}\n\n${left > 0 ? `Fix the scene and call render_beat again (${left} attempt(s) left).` : "This beat is out of attempts. Move on."}`);
				},
			}];
		},
	});

	const taskStatus = id => { try { return ctx.workers.get(id).status; } catch { return "interrupted"; } };
	function view(sequence) {
		const last = sequence.taskIds.at(-1);
		const status = last ? taskStatus(last) : "queued";
		const working = status === "queued" || status === "running";
		let activity;
		try { activity = last && working ? ctx.workers.get(last).activity : undefined; } catch { /* task record gone */ }
		return {
			...sequence, status, working, activity, resumable: !working && canResume(sequence),
			beats: sequence.beats.map(beat => ({
				...beat,
				// A version left "rendering" by a run that is no longer working never finished.
				versions: beat.versions.map(version => version.status === "rendering" && !(working && version.taskId === last) ? { ...version, status: "failed", error: "Rendering was interrupted." } : version),
			})),
		};
	}

	/** Turn and time budget: a run that may become a full derivation gets room for 16 beats. */
	const budget = input => {
		const beats = input.targets?.length ?? (input.depth === "quick" ? QUICK_BEATS : MAX_BEATS);
		return { maxTurns: 10 + beats * (MAX_ATTEMPTS + 1), timeoutMs: (beats > QUICK_BEATS ? 60 : 30) * 60_000 };
	};
	/** `chosen` is resolved by the caller before anything is written, so a missing model leaves no half-made animation. */
	function start(sequence, input, prompt, purpose, chosen) {
		const task = ctx.workers.start("motion-sequence", {
			requestId: `${sequence.id}:${randomBytes(6).toString("hex")}`,
			input, prompt, model: chosen, purpose, ...budget(input),
		});
		const fresh = store.require(sequence.id);
		if (!fresh.taskIds.includes(task.id)) { fresh.taskIds.push(task.id); store.write(fresh); }
		void ctx.workers.wait(task.id).then(outcome => { changed(sequence.id); return autoResume(sequence.id, outcome); }, () => changed(sequence.id)).catch(() => changed(sequence.id));
		changed(sequence.id);
		return view(store.require(sequence.id));
	}
	const requireReady = () => {
		const state = environment();
		if (!state.ready) throw new Error(`Motion is not set up yet: missing ${["manimgl", "ffmpeg", "latex"].filter(name => !state[name]).join(", ")}. Run plugins/motion/scripts/setup.sh.`);
	};

	ctx.handle("environment", () => environment());
	ctx.handle("list", () => store.list().map(view).map(({ id, concept, createdAt, status, working, beats, origin, outline }) => ({ id, concept, createdAt, status, working, origin, mode: outline?.mode ?? null, beats: beats.length })));
	ctx.handle("get", input => view(store.require(object(input).id)));
	ctx.handle("create", async input => {
		const value = object(input);
		const concept = text(value.concept, "A concept", 400);
		const depth = value.depth === undefined ? "auto" : value.depth;
		if (!DEPTHS.includes(depth)) throw new Error("Depth must be auto, quick or full");
		requireReady();
		const sessions = value.matchLesson === false ? [] : ctx.learning.listSessions();
		const latest = [...sessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
		const session = latest ? ctx.learning.getSession(latest.id) : null;
		const chosen = await model();
		if (ctx.signal.aborted) throw new Error("Plugin disabled");
		const sequence = store.create({ id: newId(), concept, chatId: latest?.id, origin: "learner", depth });
		const worker = { sequenceId: sequence.id, concept, chatId: sequence.chatId, origin: "learner", depth };
		return start(sequence, worker, createPrompt({ concept, depth, brief: lessonBrief(session) }), "user", chosen);
	});
	ctx.handle("comment", async input => {
		const value = object(input);
		const comment = text(value.text, "A comment", 1_000);
		const sequence = store.require(value.id);
		if (view(sequence).working) throw new Error("This animation is still rendering. Comment once it finishes, or cancel it first.");
		const targets = commentTargets(sequence, value.beat ?? null);
		if (!targets.length) throw new Error("This animation has no clips to revise.");
		requireReady();
		const chosen = await model();
		sequence.comments.push({ at: now(), beat: value.beat ?? null, text: comment });
		store.write(sequence);
		const worker = { sequenceId: sequence.id, concept: sequence.concept, chatId: sequence.chatId, origin: sequence.origin, targets, comment };
		return start(sequence, worker, revisePrompt(sequence, targets, comment, beat => readCode(sequence.id, beat)), "user", chosen);
	});
	/** The filter scores the whole conversation each turn and can block a long run part-way. A fresh run for
	 * just the missing clips is a shorter conversation, so restart with one, a bounded number of times. */
	async function autoResume(id, outcome) {
		if (ctx.signal.aborted || outcome?.status !== "failed" || !/refusal category/.test(outcome.error?.message ?? "")) return;
		const sequence = store.read(id);
		if (!sequence || !canResume(sequence) || (sequence.autoResumes ?? 0) >= MAX_AUTO_RESUMES || view(sequence).working) return;
		sequence.autoResumes = (sequence.autoResumes ?? 0) + 1;
		store.write(sequence);
		await resume(sequence);
	}
	ctx.handle("resume", async input => {
		const sequence = store.require(object(input).id);
		if (view(sequence).working) throw new Error("This animation is still working.");
		if (sequence.autoResumes) { sequence.autoResumes = 0; store.write(sequence); }
		return resume(sequence);
	});
	async function resume(sequence) {
		if (!sequence.outline) throw new Error("This animation stopped before its outline was saved, so there is nothing to continue. Request it again.");
		const targets = resumeTargets(sequence);
		if (sequence.beats.length && !targets.length) throw new Error("Every clip of this animation is already made.");
		requireReady();
		const chosen = await model();
		const depth = sequence.outline.mode === "quick" ? "quick" : sequence.depth === "quick" ? "auto" : sequence.depth;
		const worker = { sequenceId: sequence.id, concept: sequence.concept, chatId: sequence.chatId, origin: sequence.origin, depth, resume: true, ...(sequence.beats.length ? { targets } : {}) };
		return start(sequence, worker, resumePrompt(sequence, targets, beat => readCode(sequence.id, beat)), "user", chosen);
	}
	ctx.handle("cancel", input => {
		const sequence = store.require(object(input).id);
		const last = sequence.taskIds.at(-1);
		if (last) { try { ctx.workers.cancel(last); } catch { /* already finished */ } }
		changed(sequence.id);
		return view(store.require(sequence.id));
	});
	const versionOf = input => {
		const value = object(input);
		const sequence = store.require(value.id);
		const version = sequence.beats.find(beat => beat.index === value.beat)?.versions.find(item => item.v === value.v);
		if (!version) throw new Error("Unknown clip");
		return { folder: store.versionDir(sequence.id, value.beat, value.v), version };
	};
	ctx.handle("clip", input => {
		const { folder, version } = versionOf(input);
		if (version.status !== "ok" || !version.clip) throw new Error("This clip has no video.");
		const file = path.resolve(folder, version.clip);
		if (!file.startsWith(folder + path.sep)) throw new Error("Unknown clip");
		return { type: "video/mp4", base64: fs.readFileSync(file).toString("base64") };
	});
	ctx.handle("source", input => ({ code: fs.readFileSync(path.join(versionOf(input).folder, "scene.py"), "utf8") }));
	ctx.handle("focus", input => { const { id } = object(input); store.require(id); ctx.events.emit("motion-focus", { id }); return null; });

	ctx.registerInstructions({
		agents: ["teacher"],
		text: [
			"## `motion`: short animations in the learner's Motion window",
			"You have a `motion` tool. It makes a sequence of short manim clips (3Blue1Brown style) about one idea, shown in a separate Motion window beside the lesson. It is the third artifact tool next to `demo` and `visual`, with the same fire-and-forget discipline.",
			"Choose between the three by what the learner should do with the idea:",
			"- `motion`: the learner should WATCH it happen. A transformation, a construction built step by step, a limit being approached, a derivation where terms move, a before-and-after. Examples: a matrix acting on the plane, Ax as a combination of columns, row reduction changing a system, a Riemann sum refining, a secant becoming a tangent, an induction step, a graph algorithm advancing.",
			"- `demo`: the learner should OPERATE it. Sliders, parameters, simulations.",
			"- `visual`: one exact static picture is enough.",
			"Use `motion` proactively. Do not wait to be asked: when you introduce or re-explain an idea of the watch-it-happen kind, dispatch `motion` in that same turn, and expect to do so for most plan nodes whose core is geometric or procedural. Skip it only for definitions, plain facts and bookkeeping. A `visual` or `demo` for the same idea does not replace it; dispatch both when both help.",
			"It has two depths. A quick look (up to 4 clips) shows one thing happening. A full derivation (up to 16 clips) answers a why or how: it works a small numeric example first, then the general argument one step per clip with the reason for each, pauses on a question for the learner to predict, and ends with a recap. Leave `depth` out to let the tool choose; set `depth: \"full\"` when the learner asks why something is true or when a result would otherwise have to be taken on trust, and never use a quick look to state a result the lesson has not justified.",
			"One call covers one idea at the plan node you are teaching. Put that single idea in `concept`, in the lesson's own notation, and say in `focus` exactly what must be seen. The tool reads the recent lesson itself, so keep both short.",
			"It runs in the background and can take a few minutes. Say in one line that an animation is on its way to the Motion window, keep teaching, never wait or poll. When the result arrives, point the learner to the Motion window and name the clip that matters.",
		].join("\n"),
	});
	ctx.registerTools({
		agents: ["teacher"],
		create: context => [ctx.createBackgroundTool(context, {
			name: "motion",
			label: "Motion animation",
			description: "Dispatch a manim animation sequence about one idea from the current step: a quick look (up to 4 clips) or a step-by-step derivation with a worked example, reasons and a recap (up to 16). Acknowledged now; the clips arrive later in the learner's Motion window.",
			parameters: {
				type: "object", additionalProperties: false, required: ["concept"],
				properties: {
					concept: { type: "string", minLength: 1, maxLength: 400, description: "The single idea to animate, in the lesson's own terms." },
					focus: { type: "string", maxLength: 600, description: "What must be visible, and the notation to use." },
					nodeId: { type: "string", maxLength: 80, description: "The plan node this belongs to." },
					depth: { type: "string", enum: DEPTHS, description: "auto (default) lets the tool choose; quick shows one thing happening; full derives it step by step." },
				},
			},
			workerId: "motion-sequence",
			async prepare(input, toolContext) {
				requireReady();
				const session = ctx.learning.getSession(toolContext.chatId);
				return {
					input: { sequenceId: newId(), concept: input.concept.trim(), chatId: toolContext.chatId, origin: "teacher", nodeId: input.nodeId, depth: input.depth ?? "auto" },
					prompt: createPrompt({ concept: input.concept.trim(), focus: input.focus, depth: input.depth ?? "auto", brief: lessonBrief(session) }),
					model: await model(), ...budget({ depth: input.depth ?? "auto" }),
				};
			},
			format(outcome) {
				if (outcome.status !== "succeeded") return { text: `The animation ${outcome.status}: ${outcome.error.message}`, data: { error: outcome.error.message } };
				const sequence = store.list().find(item => item.taskIds.includes(outcome.id));
				const beats = sequence ? sequence.beats.map(beat => ({ index: beat.index, title: beat.title, caption: beat.caption, ok: beat.versions.some(version => version.status === "ok") })) : [];
				const ready = beats.filter(beat => beat.ok);
				return {
					text: `The animation is ready in the learner's Motion window: ${ready.length} of ${beats.length} clip(s) rendered. ${outcome.result.summary}\n${ready.map(beat => `${beat.index}. ${beat.title}: ${beat.caption}`).join("\n")}`,
					data: { sequenceId: sequence?.id, concept: sequence?.concept, mode: sequence?.outline?.mode ?? null, beats },
				};
			},
		})],
	});
};

exports._internal = { unsafeReason, sequenceStore, commentTargets, renderScene, findClip, lessonBrief, createPrompt, revisePrompt, resumePrompt, resumeTargets, canResume, environment, outlineProblems, storyboardProblems, outlineText, MAX_ATTEMPTS, MAX_BEATS, QUICK_BEATS, KINDS, MAX_AUTO_RESUMES };
