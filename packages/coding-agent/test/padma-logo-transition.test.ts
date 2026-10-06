import {
	type Component,
	sliceByColumn,
	stripTerminalSequences,
	type TUI,
	type TuiMode,
	type TuiMouseEvent,
} from "@anvaya.sh/padma-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { PADMA_WORDMARK } from "../src/cli/brand.ts";
import {
	EasterEgg3dAnimation,
	playEasterEgg3d,
	renderSideLogoLines,
} from "../src/modes/interactive/components/easter-egg-3d.ts";
import { PADMA_LOGO_WIDTH, padmaLogo3d, padmaLogoLines } from "../src/modes/interactive/components/padma-logo.ts";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { CenteredWelcomeHeading } from "../src/modes/interactive/components/welcome-screen.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";

interface LogoClickState {
	renderer: TUI;
	lastLogoClickTime: number;
	logoClickTimer: ReturnType<typeof setTimeout> | undefined;
}

const handleLogoClick = (
	InteractiveMode.prototype as unknown as {
		handlePadmaLogoClick(this: LogoClickState, column: number, row: number, count: number): void;
	}
).handlePadmaLogoClick;

afterEach(() => {
	padmaLogo3d.stop();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe.each<TuiMode>(["regular", "fullscreen"])("Padma clicks (%s)", (mode) => {
	it("opens beside the centered ASCII on a single click and fullscreen on a double click", async () => {
		initTheme("padma");
		const terminal = new VirtualTerminal(120, 40);
		const ui = createInteractiveTui({
			tuiMode: mode,
			terminal,
			showHardwareCursor: false,
			logDirectory: "",
			animateTheme: false,
		});
		const state: LogoClickState = { renderer: ui, lastLogoClickTime: 0, logoClickTimer: undefined };
		const overlaySpy = vi.spyOn(ui, "showOverlay");
		const heading = new CenteredWelcomeHeading(
			new ThemedText(() => padmaLogoLines().join("\n"), 0, 0),
			(column, row, count) => handleLogoClick.call(state, column, row, count),
			() => PADMA_WORDMARK.length,
		);
		ui.addChild(heading);
		ui.start();
		try {
			await terminal.waitForRender();
			const mouse: TuiMouseEvent = {
				type: "click",
				button: "left",
				x: 40,
				y: 2,
				screenX: 40,
				screenY: 2,
				width: 120,
				height: 40,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			};
			heading.handleMouse(mouse);
			await terminal.waitForRender();
			expect(padmaLogo3d.isActive()).toBe(true);
			expect(ui.hasOverlay()).toBe(false);
			expect(overlaySpy).not.toHaveBeenCalled();
			const lines = terminal.getViewport();
			const left = (120 - PADMA_LOGO_WIDTH) / 2;
			for (let row = 0; row < PADMA_WORDMARK.length; row++) expect(lines[row].slice(left)).toBe(PADMA_WORDMARK[row]);
			expect(padmaLogo3d.getOrigin()).toEqual({ column: 6, row: 0, width: 22, height: 7 });

			heading.handleMouse({ ...mouse, clickCount: 2 });
			await terminal.waitForRender();
			expect(ui.hasOverlay()).toBe(true);
			expect(overlaySpy).toHaveBeenCalledTimes(1);
			const animation = overlaySpy.mock.calls[0][0];
			expect(animation).toBeInstanceOf(EasterEgg3dAnimation);
			terminal.sendInput("\x1b");
			await new Promise((resolve) => setTimeout(resolve, 1200));
			await terminal.waitForRender();
			expect(ui.hasOverlay()).toBe(false);
			expect(padmaLogo3d.isActive()).toBe(true);
			const restored = terminal.getViewport();
			for (let row = 0; row < PADMA_WORDMARK.length; row++)
				expect(restored[row].slice(left)).toBe(PADMA_WORDMARK[row]);
			heading.handleMouse(mouse);
			await new Promise((resolve) => setTimeout(resolve, 700));
			await terminal.waitForRender();
			expect(padmaLogo3d.isActive()).toBe(false);
			expect(overlaySpy).toHaveBeenCalledTimes(1);
		} finally {
			if (state.logoClickTimer) clearTimeout(state.logoClickTimer);
			ui.hideOverlay();
			for (const [component] of overlaySpy.mock.calls) {
				if (component instanceof EasterEgg3dAnimation) {
					component.close();
					component.close();
				}
			}
			padmaLogo3d.stop();
			ui.stop();
		}
	});
});

it("lifts off and lands on exactly the same braille pose and size", () => {
	initTheme("padma");
	let now = 1000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	let overlay: Component | undefined;
	const tui = {
		terminal: { rows: 24 },
		hasOverlay: () => false,
		requestRender: () => {},
		showOverlay: (component: Component) => {
			overlay = component;
			return { hide: () => {}, isFocused: () => true };
		},
	} as unknown as TUI;
	const frame = { time: 3.7, opacity: 0.6, scale: 0.94 };
	const side = renderSideLogoLines(22, 7, frame.time, undefined, frame).map(stripTerminalSequences);
	const onDone = vi.fn();
	playEasterEgg3d(tui, [], { kind: "padma-logo", column: 6, row: 3, width: 22, height: 7, frame }, onDone);
	expect(overlay).toBeInstanceOf(EasterEgg3dAnimation);
	const animation = overlay as EasterEgg3dAnimation;
	try {
		const takeSide = (lines: string[]) =>
			lines.slice(3, 10).map((line) => stripTerminalSequences(sliceByColumn(line, 6, 22)));
		expect(takeSide(animation.render(120))).toEqual(side);
		now += 2000;
		const expanded = animation.render(120).map(stripTerminalSequences);
		expect(expanded.some((line) => /[\u2801-\u28ff]/.test(line.slice(40, 80)))).toBe(true);
		animation.close();
		now += 1100;
		expect(takeSide(animation.render(120))).toEqual(side);
	} finally {
		animation.close();
	}
	expect(onDone).toHaveBeenCalledOnce();
});

it("does not restart the side animation after the TUI stops rendering", () => {
	initTheme("padma");
	vi.useFakeTimers();
	const hide = vi.fn();
	const tui = {
		terminal: { rows: 24 },
		hasOverlay: () => false,
		requestRender: () => {},
		showOverlay: () => ({ hide, isFocused: () => true }),
	} as unknown as TUI;
	const restore = vi.fn();
	playEasterEgg3d(tui, [], { kind: "padma-logo", column: 6, row: 3 }, restore);
	vi.advanceTimersByTime(1100);
	// Focus can remain on a stopped TUI's overlay; stale frames must still prevent resuming it.
	expect(hide).toHaveBeenCalledOnce();
	expect(restore).not.toHaveBeenCalled();
});
