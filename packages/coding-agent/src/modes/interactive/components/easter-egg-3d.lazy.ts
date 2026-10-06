import { type TUI, TuiAltScreen, TuiMainScreen } from "@anvaya.sh/padma-tui";
import { type EasterEgg3d, playEasterEgg3d as play3d } from "./easter-egg-3d.ts";
import { padmaLogo3d } from "./padma-logo.ts";

/**
 * Plays a 3D easter egg (see easter-egg-3d.ts). Only fullscreen mode can show it, because
 * it dissolves the rendered screen.
 */
function playEasterEgg3d(tui: TUI, egg: EasterEgg3d): boolean {
	if (!(tui instanceof TuiAltScreen)) return false;
	if (tui.hasOverlay()) return true;
	const screen = tui.getScreenLines();
	play3d(tui, screen, egg);
	return true;
}

/** Plays the 3D padma logo, lifting off from the logo at `column`, `row`. */
export function playPadmaLogo3d(
	tui: TUI,
	column: number,
	row: number,
	originWidth?: number,
	originHeight?: number,
): void {
	if (tui.hasOverlay()) return;
	let screen: string[];
	if (tui instanceof TuiAltScreen) screen = tui.getScreenLines();
	else if (tui instanceof TuiMainScreen) {
		const state = tui.captureRenderState();
		screen = state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + tui.terminal.rows);
	} else return;
	const frame = padmaLogo3d.getFullscreenFrame();
	play3d(tui, screen, { kind: "padma-logo", column, row, width: originWidth, height: originHeight, frame }, () =>
		padmaLogo3d.resume(tui, frame),
	);
}

/** Plays the 3D Armin. Returns false when it cannot play, so the caller can fall back to the inline version. */
export function playArmin3d(tui: TUI): boolean {
	return playEasterEgg3d(tui, { kind: "armin" });
}
