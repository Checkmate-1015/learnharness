"use client";
/**
 * Local patch (visual-plots): renders a ```plot fence (components/plot-spec.ts)
 * inline in the lesson with Plotly — 2D figures, rotatable 3D surfaces, and
 * sliders for any declared params. Plotly loads lazily on first plot.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { compilePlot, defaultParams, parsePlotSpec, type Env, type PlotSpec } from "@/components/plot-spec";
import { useAppearance } from "@/components/settings/appearance";

type PlotlyLike = {
	react: (el: HTMLElement, data: unknown[], layout: unknown, config?: unknown) => Promise<unknown>;
	purge: (el: HTMLElement) => void;
	Plots?: { resize: (el: HTMLElement) => void };
};
let plotlyPromise: Promise<PlotlyLike> | null = null;
function loadPlotly(): Promise<PlotlyLike> {
	plotlyPromise ??= import("plotly.js-dist-min").then((m) => ((m as { default?: PlotlyLike }).default ?? (m as unknown as PlotlyLike)));
	return plotlyPromise;
}

export function PlotInline({ source, incomplete }: { source: string; incomplete?: boolean }) {
	const { resolvedMode } = useAppearance();
	const parsed = useMemo<{ spec?: PlotSpec; error?: string }>(() => {
		if (incomplete) return {};
		try { return { spec: parsePlotSpec(source) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
	}, [source, incomplete]);
	const [values, setValues] = useState<Env>({});
	useEffect(() => { if (parsed.spec) setValues(defaultParams(parsed.spec)); }, [parsed.spec]);
	const holder = useRef<HTMLDivElement>(null);
	const [renderError, setRenderError] = useState<string | null>(null);

	useEffect(() => {
		const el = holder.current;
		if (!el || !parsed.spec) return;
		let cancelled = false;
		let compiled;
		try {
			compiled = compilePlot(parsed.spec, { ...defaultParams(parsed.spec), ...values }, resolvedMode === "dark" ? "dark" : "light");
		} catch (e) {
			setRenderError(e instanceof Error ? e.message : String(e));
			return;
		}
		setRenderError(null);
		loadPlotly().then((Plotly) => {
			if (cancelled) return;
			void Plotly.react(el, compiled.data, compiled.layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["toImage", "sendDataToCloud", "lasso2d", "select2d"] });
		}).catch((e) => { if (!cancelled) setRenderError(e instanceof Error ? e.message : String(e)); });
		return () => { cancelled = true; };
	}, [parsed.spec, values, resolvedMode]);

	useEffect(() => () => { const el = holder.current; if (el) void loadPlotly().then((P) => P.purge(el)).catch(() => {}); }, []);

	if (incomplete) {
		return (
			<div data-testid="md-plot" className="my-4 flex justify-center p-4" aria-busy="true">
				<span className="inline-block size-4 animate-spin rounded-full border border-current border-b-2 text-muted-foreground" />
			</div>
		);
	}
	const error = parsed.error ?? renderError;
	if (error) {
		return (
			<div data-testid="md-plot-error" className="my-4 rounded-md border border-destructive/40 p-3 text-sm">
				<div className="mb-1 font-medium text-destructive">Couldn't draw this plot: {error}</div>
				<pre className="overflow-x-auto text-xs text-muted-foreground whitespace-pre-wrap">{source}</pre>
			</div>
		);
	}
	const params = Object.entries(parsed.spec?.params ?? {});
	return (
		<div data-testid="md-plot" className="my-4 w-full">
			{params.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
					{params.map(([k, p]) => (
						<label key={k} className="flex items-center gap-2">
							<span className="font-mono">{p.label ?? k}</span>
							<input
								type="range"
								min={p.min}
								max={p.max}
								step={p.step ?? (p.max - p.min) / 100}
								value={values[k] ?? p.value}
								onChange={(e) => setValues((v) => ({ ...v, [k]: Number(e.target.value) }))}
								className="w-36 accent-primary"
							/>
							<span className="w-12 font-mono tabular-nums text-muted-foreground">{(values[k] ?? p.value).toFixed(2)}</span>
						</label>
					))}
				</div>
			)}
			<div ref={holder} className="w-full" />
		</div>
	);
}
