"use strict";
// Quick Fire backend: writes small batches of lesson questions ahead of time and
// hands them to the card one at a time. Batches live in memory only.

const fs = require("node:fs");
const path = require("node:path");

const BATCH = 5;
const LOW = 3;
const NOTE_NO_MODEL = "No Cheap model is set in Settings.";
const NOTE_NOT_READY = "Related questions are not ready yet.";
const NOTE_FAILED = "Could not write related questions.";
const DEFAULTS = { enabled: true, mode: "related" };
const MODES = ["related", "maths"];

const QUESTION_TOOLS = new Set(["quiz", "probe", "explain", "recall", "ask_user_question"]);

function blockText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(block => block && block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
}

// What the tutor showed the learner in one message: prose, send_to_user messages,
// and the questions it asked with the explanation it committed to. A question is
// included only when its id is in `answered`, so one the learner has not answered
// (pending, rejected or dismissed) never brings its answer along.
function teacherText(content, answered) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		if (block.type !== "toolCall" || !block.arguments || typeof block.arguments !== "object") continue;
		const args = block.arguments;
		if (block.name === "send_to_user" && typeof args.message === "string") parts.push(args.message);
		if (QUESTION_TOOLS.has(block.name) && answered.has(block.id) && typeof args.question === "string") {
			const answer = [args.correctAnswer, args.explanation].filter(value => typeof value === "string" && value.trim()).join(" ");
			parts.push(`Question asked: ${args.question}${answer ? `\nIts answer: ${answer}` : ""}`);
		}
	}
	return parts.join("\n");
}

// A real answer to a question: not a rejected call and not a dismissed question.
const isAnswer = message => Boolean(message) && message.role === "toolResult" && QUESTION_TOOLS.has(message.toolName)
	&& !message.isError && message.details?.dismissed !== true;
// A learner message is something the learner typed or an answer to a question.
// Results of the tutor's own file and research tools are not.
const isLearner = message => Boolean(message) && (message.role === "user" || isAnswer(message));

// The lesson up to and including the learner's last message. Whatever the tutor
// said or asked after it (the check it is waiting on) is left out, so a question
// can never give that answer away.
function lessonText(session) {
	if (!session || !Array.isArray(session.messages)) return "";
	let end = session.messages.length - 1;
	while (end >= 0 && !isLearner(session.messages[end])) end--;
	if (end < 0) return "";
	const answered = new Set();
	for (let index = 0; index <= end; index++) {
		const message = session.messages[index];
		if (isAnswer(message) && typeof message.toolCallId === "string") answered.add(message.toolCallId);
	}
	const excerpts = [];
	for (let index = end; index >= 0 && excerpts.length < 8; index--) {
		const message = session.messages[index];
		const learner = isLearner(message);
		if (!learner && message?.role !== "assistant") continue;
		const body = (learner ? blockText(message.content) : teacherText(message.content, answered)).trim();
		if (body) excerpts.unshift(`${learner ? "Learner" : "Teacher"}: ${body.slice(0, learner ? 400 : 1_500)}`);
	}
	if (!excerpts.some(excerpt => excerpt.startsWith("Teacher: "))) return "";
	const title = typeof session.title === "string" && session.title.trim() ? `Lesson: ${session.title.trim()}\n\n` : "";
	return `${title}${excerpts.join("\n\n")}`;
}

function batchPrompt(lesson) {
	return [
		"You write quick recall questions for a learner who is waiting for their tutor.",
		"",
		`Write ${BATCH} multiple-choice questions on the lesson excerpt below.`,
		"- Use only facts the excerpt has already taught. Never introduce new material and never ask about anything the excerpt has not explained.",
		"- Each question is one line and answerable in under ten seconds.",
		"- Exactly four short choices, one correct, three plausible.",
		"- Plain text only: no LaTeX, no Markdown. Write maths in words or simple symbols such as x^2.",
		"",
		'Reply with JSON only: [{"prompt": "...", "choices": ["...", "...", "...", "..."], "answer": 0}] where answer is the index of the correct choice.',
		"",
		"Lesson excerpt:",
		lesson,
	].join("\n");
}

// Keeps only well-formed questions and shuffles each one's choices: models tend to
// list the right answer first. Never throws.
function parseBatch(text, random = Math.random) {
	if (typeof text !== "string") return [];
	const start = text.indexOf("["), end = text.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let items;
	try { items = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
	if (!Array.isArray(items)) return [];
	const out = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const prompt = typeof item.prompt === "string" ? item.prompt.trim().slice(0, 160) : "";
		if (!prompt || !Array.isArray(item.choices) || item.choices.length !== 4) continue;
		if (!item.choices.every(choice => typeof choice === "string" && choice.trim())) continue;
		const choices = item.choices.map(choice => choice.trim().slice(0, 60));
		if (new Set(choices).size !== 4) continue;
		if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) continue;
		const right = choices[item.answer];
		for (let index = choices.length - 1; index > 0; index--) {
			const other = Math.floor(random() * (index + 1));
			[choices[index], choices[other]] = [choices[other], choices[index]];
		}
		out.push({ prompt, choices, answer: choices.indexOf(right) });
		if (out.length === BATCH) break;
	}
	return out;
}

// Per-chat queues of unseen questions. settled(chatId) tops a queue up when it is
// low, with at most one write in flight per chat. A failed write is swallowed.
function createPool({ write, low = LOW }) {
	const queues = new Map();
	const writing = new Map();
	const size = chatId => queues.get(chatId)?.length ?? 0;
	return {
		size,
		take(chatId) { return queues.get(chatId)?.shift() ?? null; },
		settled(chatId) {
			if (writing.has(chatId)) return writing.get(chatId);
			if (size(chatId) >= low) return Promise.resolve();
			const job = Promise.resolve().then(() => write(chatId)).then(questions => {
				if (Array.isArray(questions) && questions.length) queues.set(chatId, [...(queues.get(chatId) ?? []), ...questions]);
			}).catch(() => {}).finally(() => { writing.delete(chatId); });
			writing.set(chatId, job);
			return job;
		},
	};
}

function readSettings(file) {
	try {
		const saved = JSON.parse(fs.readFileSync(file, "utf8"));
		return {
			enabled: typeof saved?.enabled === "boolean" ? saved.enabled : DEFAULTS.enabled,
			mode: MODES.includes(saved?.mode) ? saved.mode : DEFAULTS.mode,
		};
	} catch { return { ...DEFAULTS }; }
}

function writeSettings(file, settings) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(settings));
	fs.renameSync(temp, file);
}

exports.activate = ctx => {
	const file = path.join(ctx.dataDirectory, "config.json");
	let settings = readSettings(file);
	const notes = new Map();

	async function write(chatId) {
		const lesson = lessonText(ctx.learning.getSession(chatId));
		if (!lesson) return [];
		try {
			const slot = (await ctx.inference.catalog()).slots?.cheap;
			if (!slot?.model) { notes.set(chatId, NOTE_NO_MODEL); return []; }
			const reply = await ctx.inference.complete({
				// Thinking off whatever the slot says: five recall questions do not need it.
				model: { provider: slot.model.provider, id: slot.model.id, thinkingLevel: "off" },
				context: { messages: [{ role: "user", content: batchPrompt(lesson), timestamp: Date.now() }] },
				purpose: "background",
				options: { maxTokens: 1_200 },
				signal: ctx.signal,
			});
			const questions = reply?.stopReason === "error" || reply?.stopReason === "aborted" ? [] : parseBatch(blockText(reply?.content));
			if (questions.length) notes.delete(chatId); else notes.set(chatId, NOTE_FAILED);
			return questions;
		} catch {
			notes.set(chatId, NOTE_FAILED);
			return [];
		}
	}

	const pool = createPool({ write });
	const stop = ctx.events.on(event => {
		if (event?.type !== "turn-settled" || typeof event.chatId !== "string") return;
		if (!settings.enabled || settings.mode !== "related") return;
		void pool.settled(event.chatId);
	});
	ctx.cleanup?.(() => stop?.());

	ctx.handle("settings", () => ({ ...settings }));
	ctx.handle("save-settings", input => {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Settings must be an object");
		for (const key of Object.keys(input)) if (key !== "enabled" && key !== "mode") throw new Error(`Unknown setting: ${key}`);
		if ("enabled" in input && typeof input.enabled !== "boolean") throw new Error("enabled must be true or false");
		if ("mode" in input && !MODES.includes(input.mode)) throw new Error("mode must be related or maths");
		const next = { ...settings, ...input };
		writeSettings(file, next);
		settings = next;
		return { ...settings };
	});
	ctx.handle("take", input => {
		const chatId = input && typeof input === "object" ? input.chatId : undefined;
		if (typeof chatId !== "string" || !chatId) throw new Error("A chat id is required");
		const question = pool.take(chatId);
		return { question, note: question ? "" : notes.get(chatId) ?? NOTE_NOT_READY };
	});
};

exports._internal = { lessonText, batchPrompt, parseBatch, createPool };
