/** Motion player: the plugin's own view (opened in its own window from the
 * sidebar), plus the card the teacher's `motion` tool shows in the lesson. */

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3-9 6-9 9 0s6 9 9 0"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>';

function el(doc, tag, attrs = {}, children = []) {
	const node = doc.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value === true ? "" : String(value));
	}
	for (const child of [].concat(children)) if (child) node.append(child);
	return node;
}

const KIND = { hook: "Question", example: "Worked example", step: "Step", predict: "Pause and predict", general: "In general", recap: "Recap" };
const STATUS = { queued: "Waiting to start", running: "Working", succeeded: "Ready", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };

function mountPlayer(ctx, container, signal) {
	const doc = container.ownerDocument;
	const state = { list: [], current: null, beat: 1, version: null, env: null, error: "", busy: false, showSource: false, source: "", outlineOpen: null };
	let clipUrl = null;
	let clipKey = "";
	let timer = null;
	let stageKey = "";
	let statusNode = null;
	const alive = () => !signal.aborted;

	const root = el(doc, "div", { class: "motion" });
	const notice = el(doc, "div", { class: "motion-notice", role: "alert", hidden: true });
	const conceptInput = el(doc, "input", { class: "motion-input", type: "text", placeholder: "What should it show? e.g. why the area under 1/x is a logarithm", "aria-label": "Concept to animate" });
	const matchLesson = el(doc, "input", { type: "checkbox", checked: true });
	const createButton = el(doc, "button", { class: "motion-button motion-primary", type: "submit", text: "Animate" });
	const depth = el(doc, "select", { class: "motion-select", "aria-label": "Depth" }, [
		el(doc, "option", { value: "auto", text: "Depth: auto" }),
		el(doc, "option", { value: "quick", text: "Quick look" }),
		el(doc, "option", { value: "full", text: "Full derivation" }),
	]);
	const composer = el(doc, "form", { class: "motion-composer" }, [
		conceptInput, createButton,
		el(doc, "div", { class: "motion-options" }, [
			el(doc, "label", { class: "motion-check" }, [matchLesson, el(doc, "span", { text: "Match my current lesson" })]),
			depth,
		]),
	]);
	const listPane = el(doc, "nav", { class: "motion-list", "aria-label": "Animations" });
	const stage = el(doc, "section", { class: "motion-stage" });
	root.append(notice, composer, el(doc, "div", { class: "motion-body" }, [listPane, stage]));
	container.append(root);

	const fail = error => { state.error = error instanceof Error ? error.message : String(error); render(); };
	// A learner action clears the last error; background refreshes must not, or an error would vanish within seconds.
	const ACTIONS = new Set(["create", "comment", "cancel", "resume"]);
	const call = async (name, input) => {
		try { if (ACTIONS.has(name)) state.error = ""; return await ctx.call(name, input); }
		catch (error) { if (alive()) fail(error); return undefined; }
	};

	function latestOk(beat) { return [...beat.versions].reverse().find(version => version.status === "ok"); }
	function shownVersion(beat) {
		return beat.versions.find(version => version.v === state.version) ?? latestOk(beat) ?? beat.versions.at(-1) ?? null;
	}

	async function refreshList() {
		const list = await call("list");
		if (!alive() || !list) return;
		state.list = list;
		if (!state.current && list[0]) await select(list[0].id);
		else render();
	}
	async function refreshCurrent() {
		if (!state.current) return;
		const sequence = await call("get", { id: state.current.id });
		if (!alive() || !sequence) return;
		state.current = sequence;
		render();
	}
	async function select(id) {
		const sequence = await call("get", { id });
		if (!alive() || !sequence) return;
		state.current = sequence; state.beat = sequence.beats[0]?.index ?? 1; state.version = null; state.showSource = false; state.outlineOpen = null;
		render();
	}
	function schedule() {
		clearTimeout(timer);
		const working = state.current?.working || state.list.some(item => item.working);
		if (!working || doc.hidden || !alive()) return;
		timer = setTimeout(async () => { await refreshCurrent(); await refreshList(); }, 3000);
	}

	async function loadClip(sequence, beat, version, video) {
		const key = `${sequence.id}/${beat.index}/${version.v}`;
		if (clipKey === key && clipUrl) { video.src = clipUrl; return; }
		const clip = await call("clip", { id: sequence.id, beat: beat.index, v: version.v });
		if (!alive() || !clip) return;
		const bytes = Uint8Array.from(atob(clip.base64), char => char.charCodeAt(0));
		if (clipUrl) URL.revokeObjectURL(clipUrl);
		clipUrl = URL.createObjectURL(new Blob([bytes], { type: clip.type }));
		clipKey = key;
		if (video.isConnected) video.src = clipUrl;
	}

	function renderNotice() {
		const env = state.env;
		const missing = env && !env.ready ? ["manimgl", "ffmpeg", "latex"].filter(name => !env[name]) : [];
		const lines = [];
		if (missing.length) lines.push(`Motion is not set up yet. Missing: ${missing.join(", ")}. Run plugins/motion/scripts/setup.sh in the LearnHarness folder, then reopen this window.`);
		if (state.error) lines.push(state.error);
		notice.hidden = lines.length === 0;
		notice.replaceChildren(...lines.map(line => el(doc, "p", { text: line })));
		createButton.disabled = state.busy || missing.length > 0;
	}

	function renderList() {
		listPane.replaceChildren(...(state.list.length ? state.list.map(item => el(doc, "button", {
			class: `motion-item${state.current?.id === item.id ? " is-current" : ""}`, type: "button", onclick: () => select(item.id),
		}, [
			el(doc, "span", { class: "motion-item-title", text: item.concept }),
			el(doc, "span", { class: "motion-item-meta", text: `${item.working ? "Working…" : STATUS[item.status] ?? item.status} · ${item.beats} clip${item.beats === 1 ? "" : "s"}${item.mode === "derivation" ? " · derivation" : ""}${item.origin === "teacher" ? " · from the lesson" : ""}` }),
		])) : [el(doc, "p", { class: "motion-empty", text: "No animations yet." })]));
	}

	/** The reasoning the clips are built from; shown as soon as it exists. */
	function outlinePanel(sequence, beat) {
		const outline = sequence.outline;
		if (!outline || outline.mode !== "derivation") return null;
		const anyClip = sequence.beats.some(item => latestOk(item));
		const open = state.outlineOpen ?? !anyClip;
		const panel = el(doc, "details", { class: "motion-outline", open });
		panel.addEventListener("toggle", () => { state.outlineOpen = panel.open; });
		panel.append(
			el(doc, "summary", { text: `Outline: ${outline.question}` }),
			el(doc, "p", {}, [el(doc, "strong", { text: "Running picture. " }), doc.createTextNode(outline.picture)]),
			el(doc, "p", {}, [el(doc, "strong", { text: "Worked example. " }), doc.createTextNode(outline.example)]),
			el(doc, "ol", { class: "motion-steps" }, outline.steps.map((step, index) => el(doc, "li", { class: beat?.step === index + 1 ? "is-current" : "" }, [
				el(doc, "span", { class: "motion-step-claim", text: step.claim }),
				el(doc, "span", { class: "motion-step-why", text: `Why: ${step.why}` }),
				el(doc, "span", { class: "motion-step-why", text: `Uses: ${step.uses}` }),
			]))),
		);
		return panel;
	}

	function renderStage() {
		const sequence = state.current;
		const restarts = sequence?.autoResumes ? ` · restarted automatically ${sequence.autoResumes} of 5 after a blocked request` : "";
		const statusText = sequence ? (sequence.working ? `${STATUS[sequence.status]}${sequence.activity ? `: ${sequence.activity}` : "…"}` : STATUS[sequence.status] ?? sequence.status) + restarts : "";
		// Polling re-renders every few seconds; rebuilding would restart the video and wipe a half-typed comment.
		const key = JSON.stringify([sequence && { ...sequence, activity: undefined, updatedAt: undefined }, state.beat, state.version, state.showSource, state.source.length, state.busy]);
		if (key === stageKey && stage.childElementCount) { if (statusNode) statusNode.textContent = statusText; return; }
		stageKey = key;
		if (!sequence) { stage.replaceChildren(el(doc, "p", { class: "motion-empty", text: "Type a concept above, or let the lesson send one here." })); return; }
		const beat = sequence.beats.find(item => item.index === state.beat) ?? sequence.beats[0];
		const head = el(doc, "header", { class: "motion-head" }, [
			el(doc, "h2", { text: sequence.concept }),
			statusNode = el(doc, "span", { class: "motion-status", text: statusText }),
			sequence.working ? el(doc, "button", { class: "motion-button", type: "button", text: "Cancel", onclick: async () => { const next = await call("cancel", { id: sequence.id }); if (next && alive()) { state.current = next; render(); } } }) : null,
			sequence.resumable ? el(doc, "button", { class: "motion-button", type: "button", text: "Continue", title: sequence.beats.length ? "Make the clips that are still missing" : "Plan and make the clips from the saved outline", onclick: async event => { event.currentTarget.disabled = true; const next = await call("resume", { id: sequence.id }); if (next && alive()) state.current = next; if (alive()) { stageKey = ""; render(); } } }) : null,
		]);
		if (!beat) { stage.replaceChildren(head, ...[outlinePanel(sequence, null)].filter(Boolean), el(doc, "p", { class: "motion-empty", text: sequence.working ? (sequence.outline ? "Outline written. Planning the clips…" : "Working out the reasoning…") : sequence.resumable ? "This run stopped after the outline. Press Continue to make the clips from it." : "This animation has no clips." })); return; }

		const strip = el(doc, "ol", { class: "motion-strip" }, sequence.beats.map(item => {
			const last = item.versions.at(-1);
			const mark = latestOk(item) ? "" : last?.status === "rendering" || last?.status === "review" ? " is-rendering" : last ? " is-failed" : " is-pending";
			return el(doc, "li", {}, el(doc, "button", {
				class: `motion-beat${item.index === beat.index ? " is-current" : ""}${mark}${item.kind ? ` is-${item.kind}` : ""}`, type: "button", title: item.kind ? KIND[item.kind] : undefined,
				onclick: () => { state.beat = item.index; state.version = null; state.showSource = false; render(); },
			}, [el(doc, "span", { class: "motion-beat-n", text: String(item.index) }), el(doc, "span", { text: item.title })]));
		}));

		const version = shownVersion(beat);
		const video = el(doc, "video", { class: "motion-video", controls: true, autoplay: true, loop: true, playsinline: true });
		video.muted = true;
		let screen;
		if (version?.status === "ok") { screen = video; void loadClip(sequence, beat, version, video); }
		else if (version?.status === "rendering") screen = el(doc, "div", { class: "motion-placeholder", text: "Rendering this clip…" });
		else if (version?.status === "review") screen = el(doc, "div", { class: "motion-placeholder", text: "Checking this clip before showing it…" });
		else if (version?.status === "replaced") screen = el(doc, "div", { class: "motion-placeholder", text: "This render was replaced after the check found a problem." });
		else if (version) screen = el(doc, "div", { class: "motion-placeholder is-error" }, [el(doc, "p", { text: "This clip failed to render." }), el(doc, "pre", { text: (version.error || "").slice(-1200) })]);
		else screen = el(doc, "div", { class: "motion-placeholder", text: sequence.working ? "Waiting its turn…" : "Not rendered." });

		const versions = el(doc, "select", { class: "motion-select", "aria-label": "Version", onchange: event => { state.version = Number(event.target.value); state.showSource = false; render(); } },
			beat.versions.map(item => el(doc, "option", { value: item.v, selected: item.v === version?.v, text: `Version ${item.v}${item.status === "ok" ? (item.unchecked ? " (not checked)" : "") : item.status === "review" ? " (checking)" : ` (${item.status})`}${item.comment ? `: ${item.comment.slice(0, 40)}` : ""}` })));
		const sourceToggle = el(doc, "button", { class: "motion-button", type: "button", text: state.showSource ? "Hide code" : "Show code", onclick: async () => {
			state.showSource = !state.showSource;
			if (state.showSource && version) { const source = await call("source", { id: sequence.id, beat: beat.index, v: version.v }); state.source = source?.code ?? ""; }
			if (alive()) render();
		} });

		const comment = el(doc, "textarea", { class: "motion-input", rows: 2, placeholder: "Comment on this clip, e.g. slow down the second half and label the axes", "aria-label": "Comment on this clip" });
		const scope = el(doc, "select", { class: "motion-select", "aria-label": "Apply to" }, [el(doc, "option", { value: "beat", text: `Clip ${beat.index} only` }), el(doc, "option", { value: "all", text: "All clips" })]);
		const send = el(doc, "button", { class: "motion-button motion-primary", type: "button", text: "Re-render", disabled: sequence.working || state.busy });
		send.addEventListener("click", async () => {
			if (!comment.value.trim()) { comment.focus(); return; }
			state.busy = true; render();
			const next = await call("comment", { id: sequence.id, beat: scope.value === "all" ? null : beat.index, text: comment.value });
			state.busy = false;
			if (!alive()) return;
			if (next) { state.current = next; state.version = null; }
			render();
		});
		const history = sequence.comments.filter(item => item.beat === null || item.beat === beat.index);

		stage.replaceChildren(...[head, outlinePanel(sequence, beat), strip, screen,
			version?.status === "ok" && version.unchecked ? el(doc, "p", { class: "motion-kind", text: "Not checked: this clip was shown without passing the frame check." }) : null,
			beat.kind ? el(doc, "p", { class: "motion-kind", text: `${KIND[beat.kind]}${beat.step ? ` · outline step ${beat.step}` : ""}` }) : null,
			el(doc, "p", { class: "motion-caption", text: beat.caption }),
			beat.why ? el(doc, "p", { class: "motion-why", text: `Why: ${beat.why}` }) : null,
			beat.note ? el(doc, "p", { class: "motion-note", text: beat.note }) : null,
			el(doc, "div", { class: "motion-row" }, [beat.versions.length > 1 ? versions : null, version ? sourceToggle : null]),
			state.showSource ? el(doc, "pre", { class: "motion-source", text: state.source }) : null,
			el(doc, "div", { class: "motion-comment" }, [comment, el(doc, "div", { class: "motion-row" }, [scope, send])]),
			history.length ? el(doc, "ul", { class: "motion-history" }, history.map(item => el(doc, "li", { text: `${item.beat === null ? "All clips" : `Clip ${item.beat}`}: ${item.text}` }))) : null,
		].filter(Boolean));
	}

	function render() { if (!alive()) return; renderNotice(); renderList(); renderStage(); schedule(); }

	composer.addEventListener("submit", async event => {
		event.preventDefault();
		if (!conceptInput.value.trim() || state.busy) { conceptInput.focus(); return; }
		state.busy = true; render();
		const sequence = await call("create", { concept: conceptInput.value, matchLesson: matchLesson.checked, depth: depth.value });
		state.busy = false;
		if (!alive()) return;
		if (sequence) { conceptInput.value = ""; state.current = sequence; state.beat = 1; state.version = null; state.outlineOpen = null; await refreshList(); }
		render();
	});

	const stopNotifications = ctx.onNotification(event => {
		if (event.topic === "motion-focus" && event.data?.id) void select(event.data.id).then(refreshList);
		else if (event.topic === "motion-changed") { if (event.data?.id === state.current?.id) void refreshCurrent(); void refreshList(); }
	});
	const stopResync = ctx.onResync(() => { void refreshList(); void refreshCurrent(); });
	const onVisible = () => { if (!doc.hidden) { void refreshList(); void refreshCurrent(); } };
	doc.addEventListener("visibilitychange", onVisible);

	void (async () => { state.env = await call("environment"); await refreshList(); render(); })();

	return () => {
		clearTimeout(timer); stopNotifications(); stopResync();
		doc.removeEventListener("visibilitychange", onVisible);
		if (clipUrl) URL.revokeObjectURL(clipUrl);
		container.replaceChildren();
	};
}

export function activate(ctx) {
	ctx.registerView({ id: "motion", name: "Motion", mount: (container, signal) => mountPlayer(ctx, container, signal) });
	ctx.registerAction({ id: "open-motion", name: "Motion", icon: ICON, run: () => ctx.app.openViewInWindow("motion") });
	ctx.placeAction({ id: "motion-sidebar", actionId: "open-motion", location: "sidebar" });

	ctx.registerToolRenderer({
		toolName: "motion",
		backgroundPresentation: "card",
		mount(container, tool) {
			const doc = container.ownerDocument;
			const box = el(doc, "div", { class: "motion-card" });
			const data = tool.background ? tool.output : undefined;
			const title = el(doc, "strong", { text: tool.background ? `${data?.mode === "derivation" ? "Derivation" : "Animation"}: ${data?.concept ?? "ready"}` : "Animation requested" });
			box.append(title);
			if (tool.state === "output-error") box.append(el(doc, "p", { text: tool.errorText || "The animation failed." }));
			else if (tool.background && data?.error) box.append(el(doc, "p", { text: data.error }));
			else if (tool.background) {
				box.append(el(doc, "ol", {}, (data?.beats ?? []).map(beat => el(doc, "li", { text: `${beat.title}${beat.ok ? "" : " (failed)"}` }))));
				box.append(el(doc, "button", { class: "motion-button motion-primary", type: "button", text: "Open in Motion window", onclick: async () => {
					ctx.app.openViewInWindow("motion");
					// Give a newly opened window a moment to mount before asking it to focus this one.
					if (data?.sequenceId) setTimeout(() => { void ctx.call("focus", { id: data.sequenceId }).catch(() => {}); }, 1200);
				} }));
			} else box.append(el(doc, "p", { text: "Rendering in the background. The clips will appear in the Motion window." }));
			container.append(box);
			return () => container.replaceChildren();
		},
	});
}
