"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Pencil, Quote, Workflow } from "lucide-react";
import { MenuShell } from "./menu-shell";
import { citationLabel, planNodeLabel, type ComposerCitation, type PlanNodeComment, type TutorCitation } from "@/src/core";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";

/** Where a composer chip's link sits in the draft (for comment edits). */
export type ComposerCitationSource = { start: number; end: number; link: string; host: HTMLElement };

/** The chat provides these; chips in the composer and the transcript read
 *  them through context (composer chips render in portals, which keep it). */
export interface CitationActions {
	openSource?: (citation: TutorCitation, anchor: HTMLElement) => void;
	editComment?: (citation: ComposerCitation, source: ComposerCitationSource) => void;
}
export const CitationActionsContext = createContext<CitationActions | null>(null);

export interface CitationChipProps {
	citation: TutorCitation;
	variant: "composer" | "transcript";
	/** Editors make the chip atomic; transcript renderers omit this. */
	contentEditable?: false;
	/** Composer chips only: the link's place in the draft. */
	source?: ComposerCitationSource;
}

/** A sent quote, opened from its transcript chip. */
export function CitationQuoteCard({ citation, onOpenSource }: { citation: TutorCitation; onOpenSource: () => void }) {
	return (
		<div className="flex flex-col gap-2">
			<blockquote className="max-h-64 overflow-y-auto whitespace-pre-wrap border-l-2 border-muted-foreground/30 pl-2 text-sm">{citation.text}</blockquote>
			{citation.comment ? <p className="whitespace-pre-wrap text-sm">{citation.comment}</p> : null}
			<button type="button" className="inline-flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground" onClick={onOpenSource}>
				<ArrowUpRight aria-hidden="true" className="size-3.5" />Go to source
			</button>
		</div>
	);
}

export function CitationChip({ citation, variant, contentEditable, source }: CitationChipProps) {
	const actions = useContext(CitationActionsContext);
	const controller = useOptionalInteractionLayers();
	const label = citationLabel(citation);
	const [cardOpen, setCardOpen] = useState(false);
	const labelRef = useRef<HTMLButtonElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!cardOpen) return;
		const inside = (node: EventTarget | null) => node instanceof Node && (!!labelRef.current?.contains(node) || !!cardRef.current?.contains(node));
		const onPointerDown = (event: PointerEvent) => {
			if (isInteractionScopeEligible(cardRef.current, controller) && !inside(event.target)) setCardOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [cardOpen, controller]);
	const openSource = (anchor: HTMLElement) => actions?.openSource?.(citation, anchor);
	return (
		<span
			data-testid="citation-chip"
			contentEditable={contentEditable}
			className="inline-flex max-w-[16em] items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 align-middle text-sm"
		>
			<button
				ref={labelRef}
				type="button"
				aria-label={variant === "composer" ? `View cited tutor text: ${label}` : `Quoted tutor text: ${label}`}
				aria-expanded={variant === "transcript" ? cardOpen : undefined}
				title={citation.text}
				className="inline-flex min-w-0 items-center gap-1 text-left"
				onPointerDown={(event) => event.preventDefault()}
				onClick={(event) => { if (variant === "composer") openSource(event.currentTarget); else setCardOpen((open) => !open); }}
			>
				<Quote aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">{label}</span>
			</button>
			{variant === "composer" ? (
				<button
					type="button"
					aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
					className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
					onPointerDown={(event) => event.preventDefault()}
					onClick={() => { if (source) actions?.editComment?.(citation, source); }}
				>
					<Pencil aria-hidden="true" className="size-3" />
				</button>
			) : null}
			{cardOpen ? (
				<MenuShell anchorRef={labelRef} onClose={() => { setCardOpen(false); return "closed"; }} testid="citation-quote-card" preferredSide="up" align="left" menuClass="w-80 rounded-xl border bg-popover p-3 text-sm shadow-xl">
					<div ref={cardRef}>
						<CitationQuoteCard citation={citation} onOpenSource={() => { setCardOpen(false); if (labelRef.current) openSource(labelRef.current); }} />
					</div>
				</MenuShell>
			) : null}
		</span>
	);
}

/** A learner's comment on one plan-map node. In the composer the whole chip
 *  edits the comment; in the transcript it opens the node's title and comment. */
export function PlanNodeChip({ planNode, variant, contentEditable, source }: {
	planNode: PlanNodeComment;
	variant: "composer" | "transcript";
	contentEditable?: false;
	source?: ComposerCitationSource;
}) {
	const actions = useContext(CitationActionsContext);
	const controller = useOptionalInteractionLayers();
	const label = planNodeLabel(planNode);
	const [cardOpen, setCardOpen] = useState(false);
	const labelRef = useRef<HTMLButtonElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!cardOpen) return;
		const inside = (node: EventTarget | null) => node instanceof Node && (!!labelRef.current?.contains(node) || !!cardRef.current?.contains(node));
		const onPointerDown = (event: PointerEvent) => {
			if (isInteractionScopeEligible(cardRef.current, controller) && !inside(event.target)) setCardOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [cardOpen, controller]);
	const edit = () => { if (source) actions?.editComment?.(planNode, source); };
	return (
		<span
			data-testid="plan-node-chip"
			contentEditable={contentEditable}
			className="inline-flex max-w-[16em] items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 align-middle text-sm"
		>
			<button
				ref={labelRef}
				type="button"
				aria-label={variant === "composer" ? `Edit comment on plan node ${planNode.title}: ${label}` : `Comment on plan node ${planNode.title}: ${label}`}
				aria-expanded={variant === "transcript" ? cardOpen : undefined}
				title={planNode.title}
				className="inline-flex min-w-0 items-center gap-1 text-left"
				onPointerDown={(event) => event.preventDefault()}
				onClick={() => { if (variant === "composer") edit(); else setCardOpen((open) => !open); }}
			>
				<Workflow aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">{label}</span>
			</button>
			{variant === "composer" ? (
				<button
					type="button"
					aria-label={planNode.comment ? "Edit plan node comment" : "Add comment to plan node"}
					className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
					onPointerDown={(event) => event.preventDefault()}
					onClick={edit}
				>
					<Pencil aria-hidden="true" className="size-3" />
				</button>
			) : null}
			{cardOpen ? (
				<MenuShell anchorRef={labelRef} onClose={() => { setCardOpen(false); return "closed"; }} testid="plan-node-card" preferredSide="up" align="left" menuClass="w-80 rounded-xl border bg-popover p-3 text-sm shadow-xl">
					<div ref={cardRef} className="flex flex-col gap-2">
						<p className="border-l-2 border-muted-foreground/30 pl-2 text-sm">{planNode.title}</p>
						{planNode.comment ? <p className="whitespace-pre-wrap text-sm">{planNode.comment}</p> : null}
					</div>
				</MenuShell>
			) : null}
		</span>
	);
}
