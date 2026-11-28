// Quick Fire: a corner card of quick questions while the tutor is thinking.
import { createCard } from "./assets/card.js";
import { mathsQuestion } from "./assets/maths.js";

const MODES = [{ value: "related", label: "Related" }, { value: "maths", label: "Maths" }];

function el(doc, tag, props = {}, children = []) {
	const node = doc.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "text") node.textContent = value;
		else if (key === "onclick") node.addEventListener("click", value);
		else node.setAttribute(key, value);
	}
	node.append(...children);
	return node;
}

export function activate(ctx) {
	const doc = document;
	let settings = { enabled: true, mode: "related" };
	let activeChat = null;
	let watch = null;
	let box = null;
	let settingsHandle = null;

	const onChat = chatId => ctx.app.pathname().endsWith(`/${chatId}`);

	async function save(change) {
		settings = await ctx.call("save-settings", change);
		settingsHandle?.update({ rows: rows() });
	}

	async function nextQuestion() {
		if (settings.mode === "maths") return mathsQuestion();
		let note = "";
		try {
			const taken = await ctx.call("take", { chatId: activeChat });
			if (taken?.question) return taken.question;
			note = taken?.note ?? "";
		} catch { note = "Could not reach related questions."; }
		return { ...mathsQuestion(), note: note ? `${note} Showing Maths.` : "" };
	}

	// Buttons never take keyboard focus, so typing in the answer box is not interrupted.
	function button(props, onPress) {
		const node = el(doc, "button", { type: "button", tabindex: "-1", ...props });
		node.addEventListener("mousedown", event => event.preventDefault());
		node.addEventListener("click", onPress);
		return node;
	}

	function render(state) {
		if (!state) { box?.remove(); box = null; return; }
		if (!box) { box = el(doc, "div", { class: "quick-fire-card", role: "group", "aria-label": "Quick Fire" }); doc.body.append(box); }
		const { question, picked, streak, note } = state;
		const choices = question.choices.map((choice, index) => {
			const marks = picked === null ? "" : index === question.answer ? " is-right" : index === picked ? " is-wrong" : " is-dim";
			return button({ class: `quick-fire-choice${marks}`, text: choice, ...(picked === null ? {} : { disabled: "" }) }, () => card.choose(index));
		});
		const modes = MODES.map(mode => button(
			{ class: "quick-fire-mode", text: mode.label, "aria-pressed": String(settings.mode === mode.value) },
			() => { if (settings.mode !== mode.value) void switchMode(mode.value); },
		));
		box.replaceChildren(
			el(doc, "p", { class: "quick-fire-prompt", text: question.prompt }),
			el(doc, "div", { class: "quick-fire-choices" }, choices),
			...(note ? [el(doc, "p", { class: "quick-fire-note", text: note })] : []),
			el(doc, "div", { class: "quick-fire-footer" }, [
				el(doc, "div", { class: "quick-fire-modes", role: "group", "aria-label": "Question type" }, modes),
				button({ class: "quick-fire-skip", text: "Skip" }, () => { void card.skip(); }),
				el(doc, "span", { class: "quick-fire-streak", title: "Right answers in a row", text: String(streak) }),
			]),
		);
	}

	const card = createCard({ nextQuestion, render });

	async function switchMode(mode) {
		settings = { ...settings, mode }; // switch at once; saving follows
		void card.skip();
		try { await save({ mode }); } catch { /* the choice still holds for this session */ }
	}

	function hide() {
		if (watch !== null) { clearInterval(watch); watch = null; }
		activeChat = null;
		card.close();
	}

	const stopEvents = ctx.onAppEvent(event => {
		if (event.type === "turn-started") {
			if (!settings.enabled || !onChat(event.chatId)) return;
			hide();
			activeChat = event.chatId;
			// Leaving the lesson mid-turn closes the card.
			watch = setInterval(() => { if (activeChat && !onChat(activeChat)) hide(); }, 500);
			void card.open();
		} else if (event.type === "turn-settled" && event.chatId === activeChat) hide();
	});

	// Events are hints: after a reconnect the settle may have been missed, so do not
	// leave a card up on a turn that might already be over.
	const stopResync = ctx.onResync(() => hide());

	function rows() {
		return [
			{ key: "enabled", type: "toggle", label: "Show questions while the tutor is thinking", value: settings.enabled,
				onChange: async value => { await save({ enabled: value }); if (!value) hide(); } },
			{ key: "mode", type: "dropdown", label: "Start in", description: "Related questions are written by your Cheap model. Maths is made on the spot and costs nothing.",
				options: MODES, value: settings.mode, onChange: value => save({ mode: value }) },
		];
	}
	settingsHandle = ctx.registerSettings({ rows: rows() });

	void ctx.call("settings").then(saved => { settings = saved; settingsHandle?.update({ rows: rows() }); }).catch(() => {});

	const dispose = () => { stopEvents(); stopResync(); hide(); settingsHandle?.dispose?.(); settingsHandle = null; };
	ctx.cleanup(dispose);
	return dispose;
}
