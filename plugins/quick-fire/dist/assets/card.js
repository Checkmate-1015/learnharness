// The card's behaviour, with no DOM access so it can be tested in Node.
// render(state) is called with every new state, and with null when the card closes.
// state: { question: { prompt, choices, answer }, picked: number | null, streak, note }

export function createCard({ nextQuestion, render, setTimer = setTimeout, clearTimer = clearTimeout, pause = 800 }) {
	let generation = 0; // bumped on close: anything started before it is stale
	let current = null;
	let timer = null;
	let opening = null;
	let loading = false; // a question is on its way: taps and skips wait for it

	const show = () => render(current ? { ...current } : null);
	const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };

	function close() {
		generation++;
		stopTimer();
		opening = null;
		loading = false;
		current = null;
		show();
	}

	async function load(started, streak) {
		let next;
		loading = true;
		try { next = await nextQuestion(); } catch { if (started === generation) close(); return; }
		if (started !== generation) return;
		loading = false;
		const { note, ...question } = next;
		current = { question, picked: null, streak, note: typeof note === "string" ? note : "" };
		show();
	}

	function open() {
		if (opening) return opening;
		if (current) return Promise.resolve();
		const mine = load(generation, 0).finally(() => { if (opening === mine) opening = null; });
		opening = mine;
		return mine;
	}

	function choose(index) {
		if (!current || loading || current.picked !== null) return;
		if (!Number.isInteger(index) || index < 0 || index >= current.question.choices.length) return;
		const streak = index === current.question.answer ? current.streak + 1 : 0;
		current = { ...current, picked: index, streak };
		show();
		const started = generation;
		timer = setTimer(() => { timer = null; if (started === generation) void load(started, streak); }, pause);
	}

	function skip() {
		if (!current || loading) return Promise.resolve();
		stopTimer();
		return load(generation, current.streak);
	}

	return { open, close, choose, skip, state: () => (current ? { ...current } : null) };
}
