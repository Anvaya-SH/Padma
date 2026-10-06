import { stripTerminalSequences, Text, type TUI } from "@anvaya.sh/padma-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PADMA_WORDMARK } from "../src/cli/brand.ts";
import { renderSideLogoLines } from "../src/modes/interactive/components/easter-egg-3d.ts";
import {
	getPadmaLogoWidth,
	PADMA_LOGO_WIDTH,
	padmaLogo3d,
	padmaLogoLines,
	padmaWordmark,
} from "../src/modes/interactive/components/padma-logo.ts";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { CenteredWelcomeHeading } from "../src/modes/interactive/components/welcome-screen.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("padma logo 3d animation", () => {
	initTheme("padma");
	afterEach(() => {
		padmaLogo3d.stop();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("renders standard logo lines when inactive", () => {
		padmaLogo3d.stop();
		const lines = padmaLogoLines();
		expect(lines).toHaveLength(PADMA_WORDMARK.length);
		expect(getPadmaLogoWidth()).toBe(PADMA_LOGO_WIDTH);
	});

	it("renders 3D braille lines with renderSideLogoLines", () => {
		const sideLines = renderSideLogoLines(14, 7);
		expect(sideLines).toHaveLength(7);
		expect(sideLines.every((line) => line.length > 0)).toBe(true);
	});

	it("prepends side animation on the left of wordmark when active", () => {
		padmaLogo3d.stop();
		const mockTui = { requestRender: () => {} } as unknown as TUI;
		padmaLogo3d.start(mockTui);
		expect(padmaLogo3d.isActive()).toBe(true);

		const activeLines = padmaLogoLines();
		expect(activeLines).toHaveLength(PADMA_WORDMARK.length);
		expect(getPadmaLogoWidth()).toBeGreaterThan(PADMA_LOGO_WIDTH);

		// Narrow terminal wordmark also includes side lines
		const wordmark = padmaWordmark();
		expect(wordmark.split("\n")).toHaveLength(4);

		padmaLogo3d.stop();
		expect(padmaLogo3d.isActive()).toBe(false);
	});

	it("dispatches single and double clicks in CenteredWelcomeHeading", () => {
		const clicks: Array<{ column: number; row: number; count: number }> = [];
		const heading = new CenteredWelcomeHeading(
			new Text("Padma", 0, 0),
			(column, row, count) => {
				clicks.push({ column, row, count });
			},
			() => 1,
		);

		heading.render(80);

		// Mouse press then release (single click)
		const pressResult = heading.handleMouse({
			type: "press",
			button: "left",
			x: 40,
			y: 0,
			screenX: 40,
			screenY: 2,
			width: 80,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(pressResult?.handled).toBe(true);

		const clickResult1 = heading.handleMouse({
			type: "click",
			button: "left",
			clickCount: 1,
			x: 40,
			y: 0,
			screenX: 40,
			screenY: 2,
			width: 80,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(clickResult1?.handled).toBe(true);
		expect(clicks).toHaveLength(1);
		expect(clicks[0]?.count).toBe(1);

		// Double click
		const clickResult2 = heading.handleMouse({
			type: "click",
			button: "left",
			clickCount: 2,
			x: 40,
			y: 0,
			screenX: 40,
			screenY: 2,
			width: 80,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(clickResult2?.handled).toBe(true);
		expect(clicks).toHaveLength(2);
		expect(clicks[1]?.count).toBe(2);
	});

	it("eases entry and exit without resetting rotation when the fade is reversed", () => {
		vi.useFakeTimers();
		padmaLogo3d.stop();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		padmaLogo3d.start(tui);
		expect(padmaLogo3d.getFrame().opacity).toBe(0);
		vi.advanceTimersByTime(150);
		expect(padmaLogo3d.getFrame().opacity).toBeCloseTo(0.5);
		vi.advanceTimersByTime(150);
		expect(padmaLogo3d.getFrame().opacity).toBe(1);
		padmaLogo3d.stop(tui);
		expect(padmaLogo3d.isActive()).toBe(true);
		vi.advanceTimersByTime(150);
		const fading = padmaLogo3d.getFrame();
		expect(fading.opacity).toBeCloseTo(0.5);
		padmaLogo3d.start(tui);
		expect(padmaLogo3d.getFrame()).toEqual(fading);
		vi.advanceTimersByTime(300);
		expect(padmaLogo3d.getFrame().opacity).toBe(1);
		expect(padmaLogo3d.getFrame().time).toBeCloseTo(0.75);
		padmaLogo3d.stop(tui);
		vi.advanceTimersByTime(340);
		expect(padmaLogo3d.isActive()).toBe(false);
	});

	it.each([80, 100, 120, 160])("keeps the ASCII at the same center with animation at %s columns", (width) => {
		vi.useFakeTimers();
		const terminal = { columns: width };
		const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
		const heading = new CenteredWelcomeHeading(
			new ThemedText(() => `${padmaLogoLines().join("\n")}\nThe praśna [prompt] is yours.`, 0, 0),
			undefined,
			() => PADMA_WORDMARK.length,
		);
		const before = heading.render(width).map(stripTerminalSequences);
		padmaLogo3d.start(tui);
		vi.advanceTimersByTime(500);
		const after = heading.render(width).map(stripTerminalSequences);
		const asciiLeft = Math.floor((width - PADMA_LOGO_WIDTH) / 2);
		for (let row = 0; row < PADMA_WORDMARK.length; row++) {
			expect(after[row].slice(asciiLeft)).toBe(PADMA_WORDMARK[row]);
			expect(after[row].slice(asciiLeft)).toBe(before[row].slice(asciiLeft));
		}
		expect(after.slice(0, 7).some((line) => /[\u2801-\u28ff]/.test(line.slice(0, asciiLeft)))).toBe(true);
		expect(after[7]).toBe(before[7]);
		if (width >= 120) expect(padmaLogo3d.getSideWidth()).toBe(22);
		terminal.columns = 80;
		const resized = heading.render(80).map(stripTerminalSequences);
		for (let row = 0; row < PADMA_WORDMARK.length; row++) expect(resized[row].slice(10)).toBe(PADMA_WORDMARK[row]);
		padmaLogo3d.stop(tui);
		vi.advanceTimersByTime(340);
		expect(heading.render(80).map(stripTerminalSequences)).toEqual(
			resized.map((line, row) => (row < 7 ? " ".repeat(10) + PADMA_WORDMARK[row] : line)),
		);
	});
});
