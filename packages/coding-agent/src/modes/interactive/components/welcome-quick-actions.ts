import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@anvaya.sh/padma-tui";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@anvaya.sh/padma-tui";
import { BUILTIN_SLASH_COMMANDS } from "../../../core/slash-commands.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export interface WelcomeTip {
	readonly kind: "tip" | "fact";
	readonly text: string | (() => string);
	readonly prompt?: string;
}

export const WELCOME_TIPS: readonly WelcomeTip[] = [
	{ kind: "tip", text: "Type / to discover ājñā [commands] and their English meanings." },
	...BUILTIN_SLASH_COMMANDS.map(
		(command): WelcomeTip => ({
			kind: "tip",
			text: `/${command.name} ${command.description}.`,
			prompt: `/${command.name}`,
		}),
	),
	{ kind: "tip", text: "Start with ! to run a kośa [shell] command, such as !git status.", prompt: "!git status" },
	{ kind: "tip", text: () => `Press ${keyText("tui.input.newLine")} for another line in your praśna [prompt].` },
	{ kind: "tip", text: () => `Press ${keyText("app.interrupt")} for virāma [cancel] while Padma is working.` },
	{ kind: "fact", text: "Accents are optional: /dhyana and /Dhyāna open the same command.", prompt: "/dhyana" },
	// Monier-Williams, s.v. dhyāna: https://www.sanskrit-lexicon.uni-koeln.de/scans/MWScan/MWScanpdf/mw0521-dhmApita.pdf
	{ kind: "fact", text: "Dhyāna [meditation] gives /dhyana [thinking] its name.", prompt: "/dhyana" },
	{
		kind: "fact",
		text: "Sanskrit commands accept English spellings too: /pratimana or /model.",
		prompt: "/pratimana",
	},
	{ kind: "tip", text: "Ask Padma to explain your project, audit code, or suggest parīkṣā [tests]." },
];

/** Discover commands through one quiet tip instead of a row of buttons. */
export class WelcomeQuickActions implements Component {
	private readonly onSelectPrompt: (prompt: string) => void;
	private readonly initialTip: number;
	private readonly startedAt = performance.now();
	private readonly rotate: boolean;
	private tipLines: Array<{ left: number; right: number }> = [];
	private currentTip: WelcomeTip;

	constructor(onSelectPrompt: (prompt: string) => void, options?: { tipIndex?: number; rotate?: boolean }) {
		this.onSelectPrompt = onSelectPrompt;
		this.initialTip = options?.tipIndex ?? Math.floor(Math.random() * WELCOME_TIPS.length);
		this.rotate = options?.rotate ?? true;
		this.currentTip = WELCOME_TIPS[this.initialTip % WELCOME_TIPS.length];
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.tipLines = [];
		if (width <= 0) return [];
		const elapsed = this.rotate ? Math.floor((performance.now() - this.startedAt) / 30000) : 0;
		this.currentTip = WELCOME_TIPS[(this.initialTip + elapsed) % WELCOME_TIPS.length];
		const label = this.currentTip.kind === "tip" ? "Yukti [tip]" : "Tathya [fact]";
		const text = typeof this.currentTip.text === "function" ? this.currentTip.text() : this.currentTip.text;
		const lines = wrapTextWithAnsi(`${theme.fg("accent", label)}  ${theme.fg("muted", text)}`, width).map((line) => {
			const content = stripTerminalSequences(line).trimEnd();
			const left = Math.max(0, Math.floor((width - visibleWidth(content)) / 2));
			this.tipLines.push({ left, right: left + visibleWidth(content) });
			return " ".repeat(left) + line;
		});
		// The welcome layout adapts this margin between the tip and context/model information.
		return [...lines, "", ""];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const line = this.tipLines[event.y];
		if (!line || event.x < line.left || event.x >= line.right || !this.currentTip.prompt) return undefined;
		if (event.type === "click" && event.button === "left") {
			this.onSelectPrompt(this.currentTip.prompt);
			return { handled: true };
		}
		return event.type === "press" && event.button === "left" ? { handled: true } : undefined;
	}
}
