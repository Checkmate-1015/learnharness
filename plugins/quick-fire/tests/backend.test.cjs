const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const backend = require("../dist/backend.cjs");
const { lessonText, batchPrompt, parseBatch, createPool } = backend._internal;

const q = n => ({ prompt: `Q${n}?`, choices: ["a", "b", "c", "d"], answer: 0 });
const text = t => [{ type: "text", text: t }];

test("lesson text stops at the last learner message", () => {
	const session = { title: "Bonds", messages: [
		{ role: "assistant", content: text("Duration measures rate sensitivity.") },
		{ role: "user", content: "It rises with maturity." },
		{ role: "assistant", content: text("PENDING CHECK: what is convexity?") },
	] };
	const out = lessonText(session);
	assert.match(out, /Duration measures/);
	assert.match(out, /Learner: It rises/);
	assert.doesNotMatch(out, /PENDING CHECK/);
});
const call = (name, args, id = "t") => ({ type: "toolCall", id, name, arguments: args });
const result = (toolName, toolCallId, body, extra = {}) => ({ role: "toolResult", toolName, toolCallId, content: text(body), ...extra });
test("lesson text reads what the tutor sent and asked, and only answered questions", () => {
	const session = { messages: [
		{ role: "assistant", content: [call("send_to_user", { message: "A diagonal matrix has zeros off the diagonal." })] },
		{ role: "toolResult", toolName: "send_to_user", content: text("Delivered.") },
		{ role: "assistant", content: [call("quiz", { question: "Is the zero matrix diagonal?", explanation: "Yes, every off-diagonal entry is zero.", correctAnswer: ["a"] })] },
		{ role: "toolResult", toolName: "quiz", toolCallId: "t", content: text('{"answers":[{"label":"Yes"}],"correct":true}') },
		{ role: "assistant", content: [call("read", { path: "/secret/file" })] },
		{ role: "toolResult", toolName: "read", content: text("FILE BODY") },
		{ role: "assistant", content: [call("quiz", { question: "PENDING: is I_n a permutation matrix?", explanation: "PENDING ANSWER" }, "pending")] },
	] };
	const out = lessonText(session);
	assert.match(out, /Teacher: A diagonal matrix/);
	assert.match(out, /Question asked: Is the zero matrix diagonal\?\nIts answer: Yes, every/);
	assert.match(out, /Learner: \{"answers"/);
	assert.doesNotMatch(out, /PENDING|FILE BODY|Delivered|secret/);
});
test("a rejected, dismissed or unanswered question never puts its answer in the lesson text", () => {
	const taught = { role: "assistant", content: text("Taught fact.") };
	const learner = { role: "user", content: "ok" };
	const secret = id => call("quiz", { question: `PENDING-Q ${id}`, explanation: "SECRET-ANSWER", correctAnswer: "SECRET-KEY" }, id);
	const cases = {
		"rejected first attempt, retried and pending": [taught, learner,
			{ role: "assistant", content: [secret("a")] }, result("quiz", "a", "Invalid tool input", { isError: true }),
			{ role: "assistant", content: [secret("b")] }],
		"two questions in one message, one answered": [taught, learner,
			{ role: "assistant", content: [call("quiz", { question: "Answered one?", explanation: "Fine to show." }, "a"), secret("b")] },
			result("quiz", "a", '{"correct":true}')],
		"dismissed question": [taught, learner,
			{ role: "assistant", content: [secret("a")] }, result("quiz", "a", "Dismissed", { details: { dismissed: true } })],
	};
	for (const [name, messages] of Object.entries(cases)) {
		const out = lessonText({ messages });
		assert.doesNotMatch(out, /SECRET|PENDING-Q|Invalid tool input|Dismissed/, name);
		assert.match(out, /Taught fact/, name);
	}
	assert.match(lessonText({ messages: cases["two questions in one message, one answered"] }), /Answered one\?\nIts answer: Fine to show/);
});
test("parseBatch keeps at most 5 questions", () => {
	assert.equal(parseBatch(JSON.stringify(Array.from({ length: 9 }, (_, n) => q(n)))).length, 5);
});
test("a tool result from the tutor's own tools is not a learner message", () => {
	assert.equal(lessonText({ messages: [
		{ role: "assistant", content: text("Intro.") },
		{ role: "toolResult", toolName: "read", content: text("file") },
	] }), "");
});
test("lesson text is empty with no learner message or no session", () => {
	assert.equal(lessonText(null), "");
	assert.equal(lessonText({ messages: [{ role: "assistant", content: text("Hi") }] }), "");
});
test("the prompt asks for 5 questions and forbids new material", () => {
	const prompt = batchPrompt("Teacher: x");
	assert.match(prompt, /5/);
	assert.match(prompt, /only .*already/i);
	assert.match(prompt, /JSON/);
});
test("parseBatch reads plain and fenced JSON", () => {
	const body = JSON.stringify([q(1), q(2)]);
	assert.equal(parseBatch(body).length, 2);
	assert.equal(parseBatch("Here you go:\n```json\n" + body + "\n```").length, 2);
});
test("parseBatch drops malformed questions and never throws", () => {
	const bad = [
		{ prompt: "", choices: ["a", "b", "c", "d"], answer: 0 },
		{ prompt: "x", choices: ["a", "b", "c"], answer: 0 },
		{ prompt: "x", choices: ["a", "a", "c", "d"], answer: 0 },
		{ prompt: "x", choices: ["a", "b", "c", "d"], answer: 4 },
		{ prompt: "x", choices: ["a", "b", "c", 5], answer: 1 },
		null,
		q(9),
	];
	assert.deepEqual(parseBatch(JSON.stringify(bad), () => 0.99), [q(9)]);
	for (const junk of ["", "not json", "{}", "[1,2]", "null", undefined]) assert.deepEqual(parseBatch(junk), []);
});
test("the pool tops up below 3, once at a time, and hands questions out once", async () => {
	let calls = 0;
	const pool = createPool({ write: async () => { calls++; return [q(1), q(2), q(3), q(4), q(5)]; } });
	assert.equal(pool.take("c1"), null);
	await Promise.all([pool.settled("c1"), pool.settled("c1")]);
	assert.equal(calls, 1);
	assert.equal(pool.size("c1"), 5);
	await pool.settled("c1");
	assert.equal(calls, 1);
	assert.equal(pool.take("c1").prompt, "Q1?");
	pool.take("c1"); pool.take("c1");
	await pool.settled("c1");
	assert.equal(calls, 2);
	assert.equal(pool.size("c2"), 0);
});
test("a failed write leaves the pool usable", async () => {
	let fail = true;
	const pool = createPool({ write: async () => { if (fail) throw new Error("no"); return [q(1)]; } });
	await pool.settled("c1");
	assert.equal(pool.size("c1"), 0);
	fail = false;
	await pool.settled("c1");
	assert.equal(pool.size("c1"), 1);
});

// The activated plugin, against a fake host.
function host({ cheap = { model: { provider: "p", id: "m" } }, reply, session } = {}) {
	const handlers = {}; const listeners = []; const calls = [];
	const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quick-fire-test-"));
	const ctx = {
		dataDirectory, signal: new AbortController().signal, cleanup() {},
		handle: (name, fn) => { handlers[name] = fn; },
		events: { on: fn => { listeners.push(fn); return () => {}; }, emit() {} },
		learning: { getSession: () => session ?? { messages: [{ role: "assistant", content: text("Taught.") }, { role: "user", content: "ok" }] } },
		inference: {
			catalog: async () => ({ slots: { cheap } }),
			complete: async request => { calls.push(request); return reply ? reply() : { stopReason: "stop", content: text(JSON.stringify([q(1), q(2), q(3), q(4), q(5)])) }; },
		},
	};
	backend.activate(ctx);
	const settle = async chatId => { for (const fn of listeners) fn({ type: "turn-settled", chatId }); await new Promise(resolve => setTimeout(resolve, 10)); };
	return { handlers, settle, calls, dataDirectory };
}

test("settings default on and related, save atomically, and reject bad input", async () => {
	const { handlers, dataDirectory } = host();
	assert.deepEqual(await handlers.settings(), { enabled: true, mode: "related" });
	assert.deepEqual(await handlers["save-settings"]({ mode: "maths" }), { enabled: true, mode: "maths" });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDirectory, "config.json"), "utf8")), { enabled: true, mode: "maths" });
	await assert.rejects(async () => handlers["save-settings"]({ mode: "other" }));
	await assert.rejects(async () => handlers["save-settings"]({ enabled: "yes" }));
	await assert.rejects(async () => handlers["save-settings"]({ colour: "red" }));
	assert.deepEqual(fs.readdirSync(dataDirectory), ["config.json"]);
});
test("a settled turn writes a background batch with the cheap model, then take hands it out", async () => {
	const { handlers, settle, calls } = host();
	assert.deepEqual(await handlers.take({ chatId: "c1" }), { question: null, note: "Related questions are not ready yet." });
	await settle("c1");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].purpose, "background");
	assert.deepEqual(calls[0].model, { provider: "p", id: "m", thinkingLevel: "off" });
	const taken = await handlers.take({ chatId: "c1" });
	assert.equal(taken.note, "");
	assert.equal(taken.question.prompt, "Q1?");
	assert.equal(taken.question.choices[taken.question.answer], "a");
});
test("no cheap model: no call, and take says why", async () => {
	const { handlers, settle, calls } = host({ cheap: null });
	await settle("c1");
	assert.equal(calls.length, 0);
	assert.deepEqual(await handlers.take({ chatId: "c1" }), { question: null, note: "No Cheap model is set in Settings." });
});
test("a failed or refused model call gives the could-not-write note and does not throw", async () => {
	for (const reply of [() => { throw new Error("consent refused"); }, () => ({ stopReason: "error", content: [] })]) {
		const { handlers, settle } = host({ reply });
		await settle("c1");
		assert.deepEqual(await handlers.take({ chatId: "c1" }), { question: null, note: "Could not write related questions." });
	}
});
test("maths mode or disabled: a settled turn makes no model call", async () => {
	for (const change of [{ mode: "maths" }, { enabled: false }]) {
		const { handlers, settle, calls } = host();
		await handlers["save-settings"](change);
		await settle("c1");
		assert.equal(calls.length, 0);
	}
});
test("take rejects a missing chat id", async () => {
	const { handlers } = host();
	await assert.rejects(async () => handlers.take({}));
});
test("the batch call asks with thinking off, whatever the cheap slot's thinking level", async () => {
	const { settle, calls } = host({ cheap: { model: { provider: "claude-code", id: "sonnet" }, thinkingLevel: "high" } });
	await settle("c1");
	assert.deepEqual(calls[0].model, { provider: "claude-code", id: "sonnet", thinkingLevel: "off" });
});
test("parseBatch shuffles the choices so the right one is not always first", () => {
	const body = JSON.stringify(Array.from({ length: 5 }, (_, n) => q(n)));
	const spots = new Set();
	for (let round = 0; round < 40; round++) for (const item of parseBatch(body)) {
		assert.equal(item.choices[item.answer], "a");
		assert.deepEqual([...item.choices].sort(), ["a", "b", "c", "d"]);
		spots.add(item.answer);
	}
	assert.equal(spots.size, 4);
});
