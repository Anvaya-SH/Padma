import {
	sliceByColumn,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@anvaya.sh/padma-tui";
import { PADMA_WORDMARK } from "../../../cli/brand.ts";
import { PADMA_LOGO_WIDTH, padmaLogo3d } from "./padma-logo.ts";
import { ThemedText } from "./themed-text.ts";
import { WelcomeFact } from "./welcome-accents.ts";

/** Center branding and compact shortcuts while retaining the normal transcript alignment. */
export class BuiltInHeader extends ThemedText {
	onLogoClick: ((column: number, row: number, clickCount: number) => void) | undefined;
	private readonly state: { expanded: boolean };
	private logoLeft = 0;
	private logoHeight = 1;
	private logoWidth = 5;
	private sideWidth = 8;
	private readonly fact = new WelcomeFact();
	private factRow = 0;
	private factHeight = 0;

	constructor(getCollapsedText: () => string, getExpandedText: () => string, expanded = false) {
		const state = { expanded };
		super(() => (state.expanded ? getExpandedText() : getCollapsedText()), 1, 0);
		this.state = state;
	}

	setExpanded(expanded: boolean): void {
		this.state.expanded = expanded;
		this.invalidate();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const fullLogo = stripTerminalSequences(lines[0] ?? "").includes(PADMA_WORDMARK[0].trim());
		this.logoHeight = fullLogo ? PADMA_WORDMARK.length : padmaLogo3d.isActive() ? 4 : 1;
		this.sideWidth = fullLogo ? padmaLogo3d.getSideWidth(width) : 8;
		const inset = padmaLogo3d.isActive() ? this.sideWidth + 2 : 0;
		this.logoWidth = (fullLogo ? PADMA_LOGO_WIDTH : 5) + inset;
		this.logoLeft = Math.max(0, Math.floor((width - (this.logoWidth - inset)) / 2) - inset);
		const centered = lines.map((line, row) => {
			if (this.state.expanded && row >= this.logoHeight) return line;
			const padding = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
			const unpadded = sliceByColumn(line, padding, Math.max(1, width - padding * 2));
			const text = sliceByColumn(unpadded, 0, visibleWidth(stripTerminalSequences(unpadded).trimEnd()), true);
			const left = row < this.logoHeight ? this.logoLeft : Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
			return " ".repeat(left) + text;
		});
		const gap = (process.stdout.rows ?? 40) >= 48 ? 4 : (process.stdout.rows ?? 40) >= 32 ? 3 : 2;
		const spaced: string[] = [];
		for (let row = 0; row < centered.length; row++) {
			if (stripTerminalSequences(centered[row]).trim()) {
				spaced.push(centered[row]);
				continue;
			}
			let blanks = 1;
			while (row + 1 < centered.length && !stripTerminalSequences(centered[row + 1]).trim()) {
				blanks++;
				row++;
			}
			// Keep the shortcut rows together; enlarge the margins between header sections.
			spaced.push(...Array<string>(blanks >= 2 ? gap : blanks).fill(""));
		}
		spaced.push("");
		this.factRow = spaced.length;
		const factLines = this.fact.render(width);
		this.factHeight = factLines.length;
		return [...spaced, ...factLines, ...Array<string>(Math.max(0, gap - 2)).fill("")];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y >= this.factRow && event.y < this.factRow + this.factHeight) {
			return this.fact.handleMouse({ ...event, y: event.y - this.factRow });
		}
		if (
			event.y >= this.logoHeight ||
			event.x < this.logoLeft ||
			event.x >= this.logoLeft + this.logoWidth ||
			!this.onLogoClick
		)
			return undefined;
		if (event.type === "click") {
			const column = event.screenX - event.x + this.logoLeft - (padmaLogo3d.isActive() ? 0 : this.sideWidth + 2);
			const row = event.screenY - event.y;
			padmaLogo3d.setOrigin(Math.max(0, column), row, this.sideWidth, this.logoHeight);
			this.onLogoClick(Math.max(0, column), row, event.clickCount ?? 1);
		}
		return { handled: true };
	}
}
