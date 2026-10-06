import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@anvaya.sh/padma-tui";
import { padmaGradient } from "../../../cli/brand.ts";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private bottomBorder = "";
	private renderedEditorHeight = 0;
	private promptLabel = "";
	public readonly renderTarget: TUI;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.renderTarget = tui;
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	/** Height of the input card, excluding its completion menu. */
	getRenderedEditorHeight(): number {
		return this.renderedEditorHeight;
	}

	private renderPlaceholder(line: string): string {
		if (this.getText().length > 0) return line;
		const cursorStart = line.indexOf("\x1b[7m \x1b[0m");
		if (cursorStart === -1) return line;
		const afterCursor = line.slice(cursorStart + 9);
		const spacesMatch = /^ +/.exec(afterCursor);
		if (!spacesMatch) return line;
		const available = spacesMatch[0].length + 1;
		const fullHint = "Ask anything…";
		const shortHint = "Ask…";
		const tinyHint = "…";
		const hint =
			available >= visibleWidth(fullHint)
				? fullHint
				: available >= visibleWidth(shortHint)
					? shortHint
					: available >= visibleWidth(tinyHint)
						? tinyHint
						: "";
		if (!hint) return line;
		const hintLen = visibleWidth(hint);
		const remainingSpaces = " ".repeat(available - hintLen);
		return (
			line.slice(0, cursorStart) +
			theme.fg("muted", `\x1b[7m${hint[0]}\x1b[0m`) +
			theme.fg("muted", hint.slice(1)) +
			remainingSpaces +
			afterCursor.slice(spacesMatch[0].length)
		);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (theme.name === "padma") {
			width += visibleWidth(this.promptLabel);
			const overflow = hiddenLineCount > 0 ? theme.fg("muted", ` ↑ ${hiddenLineCount} `) : "";
			const contentWidth = Math.max(0, width - visibleWidth(overflow));
			const padding = " ".repeat(Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2))));
			let content = "";
			if (this.embedWorkingStatus && this.workingStatusIndicator) {
				const status = this.workingStatusIndicator.renderInBorder(Math.max(1, contentWidth - padding.length));
				content = `${padding}${status}`;
			}
			return truncateToWidth(content, contentWidth, "", true) + truncateToWidth(overflow, width, "");
		}
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			const phase = performance.now() / 1800;
			const badgeText = width >= 32 ? "✦ Praśna [prompt]" : width >= 16 ? "✦ Praśna" : "";
			if (!badgeText) return super.renderTopBorder(width, hiddenLineCount);
			const badge = ` ${padmaGradient(badgeText, phase)} `;
			const badgeWidth = visibleWidth(badgeText) + 2;
			const hintText = width >= 54 ? "preṣaṇa ↵" : "";
			const hint = hintText ? ` ${theme.fg("dim", hintText)} ` : "";
			const hintWidth = hintText ? visibleWidth(hintText) + 2 : 0;
			const middleWidth = Math.max(0, width - 1 - badgeWidth - hintWidth - 1);
			return (
				this.borderColor("─") + badge + this.borderColor("─".repeat(middleWidth)) + hint + this.borderColor("─")
			);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (theme.name === "padma") {
			width += visibleWidth(this.promptLabel);
			const overflow = hiddenLineCount > 0 ? ` ↓ ${hiddenLineCount} ` : "";
			this.bottomBorder = theme.fg(
				"muted",
				" ".repeat(Math.max(0, width - visibleWidth(overflow))) + truncateToWidth(overflow, width, ""),
			);
		} else {
			this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount);
		}
		return this.bottomBorder;
	}

	override render(width: number): string[] {
		const framed = width >= 4;
		const paddedCard = theme.name === "padma" && width >= 6;
		const leftInset = paddedCard ? 2 : 1;
		this.promptLabel =
			theme.name === "padma" ? (width >= 40 ? "Praśna [prompt]  " : width >= 20 ? "Praśna  " : "") : "";
		const labelWidth = visibleWidth(this.promptLabel);
		const editorWidth = framed ? width - leftInset - 1 - labelWidth : width;
		const lines = super.render(editorWidth);
		const bottom = lines.indexOf(this.bottomBorder, 1);
		this.renderedEditorHeight = bottom < 0 ? lines.length : bottom + 1;
		if (!framed) return lines;
		const rendered = lines.map((line, row) => {
			let content = row === 1 && row < bottom ? this.renderPlaceholder(line) : line;
			if (theme.name === "padma") {
				if (row > 0 && row < bottom) {
					const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((editorWidth - 1) / 2)));
					const label =
						row === 1 ? theme.fg("accent", this.promptLabel) + theme.getFgAnsi("text") : " ".repeat(labelWidth);
					content = content.slice(0, padding) + label + content.slice(padding);
				}
				if (row > bottom) content = " ".repeat(labelWidth) + content;
				if (row > bottom) return `${" ".repeat(leftInset)}${content} `;
				// The editor's inverse cursor resets SGR; restore the card colours after it.
				const restore = theme.getBgAnsi("userMessageBg") + theme.getFgAnsi("text");
				const card = `${this.borderColor("▎")}${" ".repeat(leftInset - 1)}${theme.getFgAnsi("text")}${content.replaceAll("\x1b[0m", `\x1b[0m${restore}`)} `;
				return theme.bg("userMessageBg", theme.fg("text", card));
			}
			const left = row === 0 ? "╭" : row === bottom ? "╰" : row < bottom ? "│" : " ";
			const right = row === 0 ? "╮" : row === bottom ? "╯" : row < bottom ? "│" : " ";
			return this.borderColor(left) + content + this.borderColor(right);
		});
		return rendered;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.width < 4) return super.handleMouse(event);
		const paddedCard = theme.name === "padma" && event.width >= 6;
		const leftInset = paddedCard ? 2 : 1;
		const labelWidth = visibleWidth(this.promptLabel);
		return super.handleMouse({
			...event,
			x: Math.max(0, event.x - leftInset - labelWidth),
			width: event.width - leftInset - 1 - labelWidth,
		});
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
