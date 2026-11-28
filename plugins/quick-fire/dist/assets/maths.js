// Quick mental-maths questions, made on the spot. No dependencies, no DOM.
// Every question is { kind, prompt, choices: string[4], answer: 0-3 }.

export const KINDS = ["times", "addsub", "percent", "twodigit", "returns", "sequence", "series", "thumb"];

const int = (random, low, high) => low + Math.floor(random() * (high - low + 1));
const pick = (random, list) => list[Math.floor(random() * list.length)];
const num = value => String(Math.round(value * 10_000) / 10_000);
const signedPercent = value => {
	const rounded = Math.round(value * 10) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded}%`;
};
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const fraction = (top, bottom) => {
	const divisor = gcd(top, bottom);
	return bottom / divisor === 1 ? String(top / divisor) : `${top / divisor}/${bottom / divisor}`;
};

function shuffle(random, list) {
	const out = [...list];
	for (let index = out.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[out[index], out[other]] = [out[other], out[index]];
	}
	return out;
}

// right: the correct choice. wrongs: likely slips, best first. more(n): further
// wrong choices for n = 1, 2, ... used only when the slips collide.
function build(random, kind, prompt, right, wrongs, more) {
	const choices = [right];
	for (const wrong of wrongs) if (choices.length < 4 && !choices.includes(wrong)) choices.push(wrong);
	for (let n = 1; choices.length < 4 && n < 50; n++) {
		const extra = more(n);
		if (!choices.includes(extra)) choices.push(extra);
	}
	const shuffled = shuffle(random, choices);
	return { kind, prompt, choices: shuffled, answer: shuffled.indexOf(right) };
}

// Whole-number answers: slips that would go negative are dropped.
function whole(random, kind, prompt, right, slips, step = 1) {
	const valid = slips.filter(value => Number.isFinite(value) && value >= 0).map(num);
	return build(random, kind, prompt, num(right), valid, n => num(right + n * step));
}

function times(random) {
	const a = int(random, 2, 19), b = int(random, 2, 12), right = a * b;
	return whole(random, "times", `${a} x ${b} = ?`, right, [right + b, right - b, right + a, right + 10, right - 10]);
}

function addsub(random) {
	let a = int(random, 12, 999), b = int(random, 12, 999);
	const plus = random() < 0.5;
	if (!plus && a < b) [a, b] = [b, a];
	const right = plus ? a + b : a - b;
	return whole(random, "addsub", `${a} ${plus ? "+" : "-"} ${b} = ?`, right, [right + 10, right - 10, right + 100, right - 100, right + 2], 20);
}

function percent(random) {
	if (random() < 0.5) {
		const share = pick(random, [5, 10, 15, 20, 25, 30, 40, 60, 75]);
		const base = 20 * int(random, 1, 40);
		const right = (share * base) / 100;
		return whole(random, "percent", `${share}% of ${base} = ?`, right, [right + base / 20, right - base / 20, right * 2, right / 2, right + base / 10], base / 20);
	}
	const bottom = pick(random, [4, 5, 8, 16, 20]);
	const top = int(random, 1, bottom - 1);
	const right = top / bottom;
	return build(random, "percent", `${top}/${bottom} as a decimal = ?`, num(right),
		[num((top + 1) / bottom), ...(top > 1 ? [num((top - 1) / bottom)] : []), num(right + 0.1), num(right / 2)],
		n => num(right + n * 0.02));
}

function twodigit(random) {
	const a = int(random, 11, 99), b = int(random, 11, 99), right = a * b;
	return whole(random, "twodigit", `${a} x ${b} = ?`, right, [right + 10, right - 10, right + 100, right - 100, right + a], 20);
}

function returns(random) {
	if (random() < 0.7) {
		for (;;) {
			const legs = Array.from({ length: int(random, 2, 3) }, () => (random() < 0.5 ? 1 : -1) * pick(random, [5, 10, 20, 25, 50]));
			const sum = legs.reduce((total, leg) => total + leg, 0);
			const net = (legs.reduce((total, leg) => total * (1 + leg / 100), 1) - 1) * 100;
			if (signedPercent(net) === signedPercent(sum)) continue; // the trap choice must be wrong
			const words = legs.map((leg, index) => `${index ? "then " : ""}${leg > 0 ? "up" : "down"} ${Math.abs(leg)}%`).join(", ");
			return build(random, "returns", `${words[0].toUpperCase()}${words.slice(1)}. Net change?`, signedPercent(net),
				[signedPercent(sum), signedPercent(net + 2), signedPercent(net - 2), signedPercent(-net)],
				n => signedPercent(net + 3 * n));
		}
	}
	// Starts of 1,000 and up keep the compound answer exact and different from simple interest.
	const start = pick(random, [1000, 2000, 10000]), rate = pick(random, [5, 10, 20]);
	const years = rate === 5 ? 2 : int(random, 2, 3); // 5% over 3 years has no tidy answer
	const grow = n => start * (1 + rate / 100) ** n;
	const right = grow(years);
	return whole(random, "returns", `${start} at ${rate}% a year for ${years} years = ?`, right,
		[start * (1 + (rate * years) / 100), grow(years - 1), right + start / 10, right + start / 20],
		start / 20);
}

function sequence(random) {
	const form = int(random, 0, 4);
	let terms;
	if (form === 0) { const start = int(random, 1, 20), step = int(random, 2, 12); terms = [0, 1, 2, 3, 4].map(i => start + i * step); }
	else if (form === 1) { const start = int(random, 1, 5), ratio = int(random, 2, 3); terms = [0, 1, 2, 3, 4].map(i => start * ratio ** i); }
	else if (form === 2) { terms = [int(random, 1, 5)]; while (terms.length < 5) terms.push(terms.at(-1) * 2 + 1); }
	else if (form === 3) { const start = int(random, 1, 6); terms = [0, 1, 2, 3, 4].map(i => (start + i) ** 2); }
	else { terms = [int(random, 1, 5), int(random, 1, 5)]; while (terms.length < 5) terms.push(terms.at(-1) + terms.at(-2)); }
	const right = terms[4], last = terms[3], before = terms[2];
	return whole(random, "sequence", `${terms.slice(0, 4).join(", ")}, ?`, right, [last + (last - before), last * 2, right + 1, right - 1, right + 2]);
}

function series(random) {
	if (random() < 0.5) {
		const n = 10 * int(random, 1, 10), right = (n * (n + 1)) / 2;
		return whole(random, "series", `1 + 2 + ... + ${n} = ?`, right, [(n * n) / 2, (n * (n - 1)) / 2, n * (n + 1), right + n], n);
	}
	const first = int(random, 1, 4), k = int(random, 2, 4);
	const prompt = `${first} + ${fraction(first, k)} + ${fraction(first, k * k)} + ... = ?`;
	return build(random, "series", prompt, fraction(first * k, k - 1),
		[fraction(first * (k + 1), k), fraction(first * k, 1), fraction(first * (k * k + k + 1), k * k), fraction(first, k - 1)],
		n => fraction(first * k + n, k - 1));
}

const ODDS = [["0.125", "1/8"], ["0.375", "3/8"], ["0.625", "5/8"], ["0.875", "7/8"], ["0.167", "1/6"], ["0.333", "1/3"], ["0.667", "2/3"], ["0.0625", "1/16"]];

function thumb(random) {
	const form = int(random, 0, 2);
	// "Roughly" answers: every wrong choice sits at least 10% away from the right one.
	const rough = (prompt, right, format, slips) => {
		const far = slips.filter(value => Math.abs(value - right) >= 0.12 * right).map(format);
		return build(random, "thumb", prompt, format(right), far, n => format(right * (1 + 0.3 * n)));
	};
	if (form === 0) {
		const rate = pick(random, [2, 3, 4, 6, 8, 9, 12]), right = 72 / rate;
		return rough(`Roughly how many years to double at ${rate}%?`, right, num, [Math.round(100 / rate), Math.round(50 / rate), Math.round(right * 1.5), Math.round(right / 2)]);
	}
	if (form === 1) {
		const base = 1 + int(random, 1, 10) / 100, power = int(random, 2, 10), right = base ** power;
		return rough(`${base.toFixed(2)} to the power ${power}, roughly?`, right, value => value.toFixed(2), [right * 1.15, right * 0.85, right * 1.3]);
	}
	const [decimal, right] = pick(random, ODDS);
	const others = shuffle(random, ODDS.map(([, text]) => text).filter(text => text !== right));
	return build(random, "thumb", `${decimal} as a fraction?`, right, others, n => `1/${20 + n}`);
}

const MAKERS = { times, addsub, percent, twodigit, returns, sequence, series, thumb };

export function mathsQuestion(random = Math.random, kind) {
	const chosen = KINDS.includes(kind) ? kind : pick(random, KINDS);
	return MAKERS[chosen](random);
}
