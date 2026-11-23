/**
 * Local patch (visual-plots): the `plot` fence — instant inline 2D/3D math
 * figures the teacher writes straight into a lesson, no background job.
 *
 * The fence body is JSON. Either raw Plotly (`{"data": [...], "layout": {...}}`)
 * or the compact math spec below, whose expressions are strings sampled here
 * (the model never has to hand-compute point arrays):
 *
 * {
 *   "title": "Unit circle under A",
 *   "params": { "a": { "min": -2, "max": 2, "value": 1, "step": 0.1 } },
 *   "xrange": [-3, 3], "yrange": [-3, 3], "zrange": [0, 8],
 *   "items": [
 *     { "kind": "function", "y": "x^2 - 1", "x": [-2, 2] },
 *     { "kind": "curve", "x": "cos(t)", "y": "sin(t)", "t": [0, "2pi"], "label": "unit circle" },
 *     { "kind": "levels", "f": "3x^2 + 2x*y + y^2", "levels": [1, 4, 9] },
 *     { "kind": "surface", "z": "x^2 - y^2", "x": [-2, 2], "y": [-2, 2] },
 *     { "kind": "surface", "x": "cos(u)*sin(v)", "y": "...", "z": "...", "u": [0, "2pi"], "v": [0, "pi"] },
 *     { "kind": "vector", "from": [0, 0], "to": ["a", 1], "label": "v₁" },
 *     { "kind": "line", "points": [[0, 0, 0], [1, 1, 2]] },
 *     { "kind": "points", "points": [[1, 0], [0, 1]], "labels": ["e₁", "e₂"] }
 *   ]
 * }
 *
 * Pure: compiles to Plotly {data, layout}; the component only draws.
 */

// ─── A tiny safe expression language ─────────────────────────────────────────

export type Env = Record<string, number>;
type Fn = (env: Env) => number;

const FUNCS: Record<string, (...a: number[]) => number> = {
	sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
	atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt,
	cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10,
	log2: Math.log2, min: Math.min, max: Math.max, pow: Math.pow, floor: Math.floor, ceil: Math.ceil,
	sign: Math.sign, round: Math.round, sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x),
	cot: (x) => 1 / Math.tan(x),
};
const CONSTS: Env = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	const s = src.replace(/\*\*/g, "^").replace(/π/g, "pi").replace(/[·×]/g, "*").replace(/−/g, "-");
	let i = 0;
	while (i < s.length) {
		const c = s[i]!;
		if (/\s/.test(c)) { i++; continue; }
		const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
		if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
		const id = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(s.slice(i));
		if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
		if ("+-*/^(),".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
		throw new Error(`Unexpected "${c}" in "${src}"`);
	}
	return out;
}

/** Compile an expression string to a function of named variables. Supports
 *  + - * / ^, implicit multiplication (2x, 3(x+1), x y), unary minus binding
 *  looser than ^ (-x^2 = -(x²)), the usual functions and pi/e/tau. */
export function compileExpr(src: string | number): Fn {
	if (typeof src === "number") return () => src;
	const toks = tokenize(String(src));
	let p = 0;
	const peek = () => toks[p];
	const isOp = (v: string) => { const k = peek(); return k?.t === "op" && k.v === v; };
	const expect = (v: string) => { if (!isOp(v)) throw new Error(`Expected "${v}" in "${src}"`); p++; };

	const startsPrimary = () => { const k = peek(); return !!k && (k.t === "num" || k.t === "id" || (k.t === "op" && k.v === "(")); };

	function expr(): Fn {
		let l = term();
		while (isOp("+") || isOp("-")) {
			const op = (toks[p++] as { v: string }).v; const r = term(); const a = l;
			l = op === "+" ? (e) => a(e) + r(e) : (e) => a(e) - r(e);
		}
		return l;
	}
	function term(): Fn {
		let l = unary();
		for (;;) {
			if (isOp("*") || isOp("/")) {
				const op = (toks[p++] as { v: string }).v; const r = unary(); const a = l;
				l = op === "*" ? (e) => a(e) * r(e) : (e) => a(e) / r(e);
			} else if (startsPrimary()) {
				const r = power(); const a = l; l = (e) => a(e) * r(e);
			} else return l;
		}
	}
	function unary(): Fn {
		if (isOp("-")) { p++; const a = unary(); return (e) => -a(e); }
		if (isOp("+")) { p++; return unary(); }
		return power();
	}
	function power(): Fn {
		const b = primary();
		if (isOp("^")) { p++; const x = unary(); return (e) => Math.pow(b(e), x(e)); }
		return b;
	}
	function primary(): Fn {
		const k = toks[p++];
		if (!k) throw new Error(`Unexpected end of "${src}"`);
		if (k.t === "num") { const v = k.v; return () => v; }
		if (k.t === "op" && k.v === "(") { const a = expr(); expect(")"); return a; }
		if (k.t === "id") {
			const name = k.v;
			if (isOp("(") && FUNCS[name]) {
				p++;
				const args: Fn[] = [];
				if (!isOp(")")) { args.push(expr()); while (isOp(",")) { p++; args.push(expr()); } }
				expect(")");
				const f = FUNCS[name]!;
				return (e) => f(...args.map((g) => g(e)));
			}
			// "2pi" / "xy" style glued names: split into known single letters + consts.
			if (name in CONSTS) { const v = CONSTS[name]!; return (e) => (name in e ? e[name]! : v); }
			return (e) => {
				if (name in e) return e[name]!;
				// fall back to a product of single-letter vars ("xy" = x*y)
				if (/^[a-z]+$/.test(name) && [...name].every((ch) => ch in e || ch in CONSTS)) {
					return [...name].reduce((acc, ch) => acc * (ch in e ? e[ch]! : CONSTS[ch]!), 1);
				}
				throw new Error(`Unknown name "${name}"`);
			};
		}
		throw new Error(`Unexpected "${k.v}" in "${src}"`);
	}

	const f = expr();
	if (p < toks.length) throw new Error(`Unexpected "${(toks[p] as { v: unknown }).v}" in "${src}"`);
	return f;
}

const num = (v: unknown, env: Env): number => compileExpr(v as string | number)(env);

// ─── The spec ────────────────────────────────────────────────────────────────

export interface PlotParam { min: number; max: number; value: number; step?: number; label?: string }
export interface PlotSpec {
	title?: string;
	params?: Record<string, PlotParam>;
	xrange?: unknown[]; yrange?: unknown[]; zrange?: unknown[];
	equalAxes?: boolean;
	height?: number;
	items?: Record<string, unknown>[];
	data?: unknown[];
	layout?: Record<string, unknown>;
}

export const PLOT_PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];

export function parsePlotSpec(source: string): PlotSpec {
	const spec = JSON.parse(source) as PlotSpec;
	if (!spec || typeof spec !== "object") throw new Error("Plot spec must be a JSON object");
	if (!spec.data && !Array.isArray(spec.items)) throw new Error('Plot spec needs "items" (or raw Plotly "data")');
	return spec;
}

export function defaultParams(spec: PlotSpec): Env {
	const out: Env = {};
	for (const [k, p] of Object.entries(spec.params ?? {})) out[k] = Number(p.value ?? p.min ?? 0);
	return out;
}

const linspace = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const finite = (v: number) => (Number.isFinite(v) ? v : null);

function isThreeD(spec: PlotSpec): boolean {
	return (spec.items ?? []).some((it) => {
		if (it.kind === "surface") return true;
		if (it.kind === "curve" && it.z !== undefined) return true;
		const pts = (it.points as unknown[][] | undefined) ?? [];
		if (pts.some((q) => Array.isArray(q) && q.length === 3)) return true;
		const to = it.to as unknown[] | undefined;
		return Array.isArray(to) && to.length === 3;
	});
}

export interface CompiledPlot { data: Record<string, unknown>[]; layout: Record<string, unknown>; threeD: boolean }

/** Compile a spec (with current slider values) into Plotly data + layout. */
export function compilePlot(spec: PlotSpec, values: Env, mode: "light" | "dark" = "light"): CompiledPlot {
	const ink = mode === "dark" ? "#e5e7eb" : "#1f2937";
	const grid = mode === "dark" ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)";
	const env: Env = { ...values };
	const range = (r: unknown[] | undefined) => (Array.isArray(r) && r.length === 2 ? [num(r[0], env), num(r[1], env)] : undefined);
	const xr = range(spec.xrange), yr = range(spec.yrange), zr = range(spec.zrange);
	const baseLayout = {
		paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
		font: { color: ink, family: "ui-sans-serif, system-ui, sans-serif", size: 13 },
		margin: { l: 40, r: 20, t: spec.title ? 40 : 16, b: 36 },
		title: spec.title ? { text: spec.title, font: { size: 15 } } : undefined,
		showlegend: true, legend: { orientation: "h", y: -0.12 },
		height: spec.height ?? 420,
	};

	if (spec.data) {
		return { data: spec.data as Record<string, unknown>[], layout: { ...baseLayout, ...(spec.layout ?? {}) }, threeD: (spec.data as { type?: string }[]).some((d) => /3d|surface|mesh|cone/.test(String(d.type))) };
	}

	const threeD = isThreeD(spec);
	const data: Record<string, unknown>[] = [];
	const annotations: Record<string, unknown>[] = [];
	const dx = xr ?? [-3, 3], dy = yr ?? [-3, 3];
	let ci = 0;

	for (const it of spec.items ?? []) {
		const color = (it.color as string | undefined) ?? PLOT_PALETTE[ci++ % PLOT_PALETTE.length];
		const name = it.label as string | undefined;
		const legend = name ? { name, showlegend: true } : { showlegend: false };
		const kind = String(it.kind ?? "");
		const dash = it.dash as string | undefined;

		if (kind === "function") {
			const f = compileExpr(it.y as string);
			const [a, b] = Array.isArray(it.x) ? [num((it.x as unknown[])[0], env), num((it.x as unknown[])[1], env)] : dx;
			const xs = linspace(a!, b!, 400);
			data.push({ type: "scatter", mode: "lines", x: xs, y: xs.map((x) => finite(f({ ...env, x }))), line: { color, width: 2.5, dash }, ...legend });
		} else if (kind === "curve") {
			const fx = compileExpr(it.x as string), fy = compileExpr(it.y as string);
			const fz = it.z !== undefined ? compileExpr(it.z as string) : null;
			const tr = (it.t as unknown[] | undefined) ?? [0, "2pi"];
			const ts = linspace(num(tr[0], env), num(tr[1], env), 400);
			const xs = ts.map((t) => finite(fx({ ...env, t }))), ys = ts.map((t) => finite(fy({ ...env, t })));
			if (threeD) data.push({ type: "scatter3d", mode: "lines", x: xs, y: ys, z: ts.map((t) => (fz ? finite(fz({ ...env, t })) : 0)), line: { color, width: 6, dash }, ...legend });
			else data.push({ type: "scatter", mode: "lines", x: xs, y: ys, line: { color, width: 2.5, dash }, ...legend });
		} else if (kind === "levels") {
			const f = compileExpr(it.f as string);
			const n = 160;
			const xs = linspace(dx[0]!, dx[1]!, n), ys = linspace(dy[0]!, dy[1]!, n);
			const z = ys.map((y) => xs.map((x) => finite(f({ ...env, x, y }))));
			const levels = ((it.levels as unknown[] | undefined) ?? [1]).map((l) => num(l, env));
			levels.forEach((L, li) => {
				const c = Array.isArray(it.colors) ? (it.colors as string[])[li] ?? color : color;
				data.push({
					type: "contour", x: xs, y: ys, z, showscale: false, hoverinfo: "skip",
					contours: { coloring: "none", start: L, end: L, size: 1, showlabels: it.showLabels !== false, labelfont: { color: c, size: 11 } },
					line: { color: c, width: 2, dash }, name: li === 0 ? name : undefined, showlegend: li === 0 && !!name,
				});
			});
		} else if (kind === "surface") {
			const n = Number(it.resolution ?? 50);
			const opacity = Number(it.opacity ?? 0.85);
			const colorscale = (it.colorscale as string | undefined) ?? "Viridis";
			if (typeof it.x === "string") {
				const fx = compileExpr(it.x), fy = compileExpr(it.y as string), fz = compileExpr(it.z as string);
				const ur = (it.u as unknown[] | undefined) ?? [0, "2pi"], vr = (it.v as unknown[] | undefined) ?? [0, "pi"];
				const us = linspace(num(ur[0], env), num(ur[1], env), n), vs = linspace(num(vr[0], env), num(vr[1], env), n);
				const grid3 = (f: Fn) => vs.map((v) => us.map((u) => finite(f({ ...env, u, v }))));
				data.push({ type: "surface", x: grid3(fx), y: grid3(fy), z: grid3(fz), opacity, colorscale, showscale: false, ...legend });
			} else {
				const fz = compileExpr(it.z as string);
				const ax = Array.isArray(it.x) ? [num((it.x as unknown[])[0], env), num((it.x as unknown[])[1], env)] : dx;
				const ay = Array.isArray(it.y) ? [num((it.y as unknown[])[0], env), num((it.y as unknown[])[1], env)] : dy;
				const xs = linspace(ax[0]!, ax[1]!, n), ys = linspace(ay[0]!, ay[1]!, n);
				const z = ys.map((y) => xs.map((x) => finite(fz({ ...env, x, y }))));
				data.push({
					type: "surface", x: xs, y: ys, z, opacity, colorscale, showscale: false, ...legend,
					contours: it.contours === false ? undefined : { z: { show: true, usecolormap: true, project: { z: true } } },
				});
			}
		} else if (kind === "vector") {
			const from = ((it.from as unknown[] | undefined) ?? (threeD ? [0, 0, 0] : [0, 0])).map((v) => num(v, env));
			const to = (it.to as unknown[]).map((v) => num(v, env));
			if (threeD) {
				const [x0, y0, z0 = 0] = from, [x1, y1, z1 = 0] = to;
				data.push({ type: "scatter3d", mode: "lines", x: [x0, x1], y: [y0, y1], z: [z0, z1], line: { color, width: 7 }, ...legend });
				data.push({ type: "cone", x: [x1], y: [y1], z: [z1], u: [x1! - x0!], v: [y1! - y0!], w: [z1 - z0], anchor: "tip", sizemode: "absolute", sizeref: 0.25, showscale: false, colorscale: [[0, color], [1, color]], hoverinfo: "skip" });
			} else {
				annotations.push({ x: to[0], y: to[1], ax: from[0], ay: from[1], xref: "x", yref: "y", axref: "x", ayref: "y", showarrow: true, arrowhead: 3, arrowsize: 1.3, arrowwidth: 2.5, arrowcolor: color, text: "" });
				if (name) annotations.push({ x: to[0], y: to[1], xref: "x", yref: "y", text: name, showarrow: false, font: { color, size: 14 }, xshift: 12, yshift: 10 });
			}
		} else if (kind === "line" || kind === "points") {
			const pts = ((it.points as unknown[][] | undefined) ?? []).map((q) => q.map((v) => num(v, env)));
			const labels = it.labels as string[] | undefined;
			const isPts = kind === "points";
			const m = isPts ? (labels ? "markers+text" : "markers") : "lines";
			const common = { mode: m, text: labels, textposition: "top right", marker: { color, size: isPts ? 8 : undefined }, line: { color, width: 2.5, dash }, ...legend };
			if (threeD) data.push({ type: "scatter3d", x: pts.map((q) => q[0]), y: pts.map((q) => q[1]), z: pts.map((q) => q[2] ?? 0), ...common, marker: { color, size: isPts ? 4 : undefined }, line: { color, width: 5 } });
			else data.push({ type: "scatter", x: pts.map((q) => q[0]), y: pts.map((q) => q[1]), ...common });
		} else {
			throw new Error(`Unknown plot item kind "${kind}"`);
		}
	}

	const axis = (r?: number[]) => ({ range: r, gridcolor: grid, zerolinecolor: mode === "dark" ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)", color: ink });
	const layout: Record<string, unknown> = threeD
		? { ...baseLayout, height: spec.height ?? 480, scene: { xaxis: { ...axis(xr), title: "x" }, yaxis: { ...axis(yr), title: "y" }, zaxis: { ...axis(zr), title: "z" }, aspectmode: spec.equalAxes ? "data" : "cube" } }
		: { ...baseLayout, xaxis: axis(dx), yaxis: { ...axis(dy), ...(spec.equalAxes === false ? {} : { scaleanchor: "x", scaleratio: 1 }) }, annotations };
	return { data, layout, threeD };
}
