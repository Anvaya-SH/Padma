import { type Component, stripTerminalSequences, type TUI } from "@anvaya.sh/padma-tui";
import { afterEach, expect, it, vi } from "vitest";
import {
	EasterEgg3dAnimation,
	type PadmaLogoFrame,
	playEasterEgg3d,
} from "../src/modes/interactive/components/easter-egg-3d.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => vi.restoreAllMocks());

function openFullscreen(frame: PadmaLogoFrame): EasterEgg3dAnimation {
	let overlay: Component | undefined;
	const ui = {
		terminal: { columns: 120, rows: 40 },
		hasOverlay: () => false,
		requestRender: () => {},
		showOverlay: (component: Component) => {
			overlay = component;
			return { hide: () => {}, isFocused: () => true };
		},
	} as unknown as TUI;
	playEasterEgg3d(ui, [], { kind: "padma-logo", column: 6, row: 3, width: 22, height: 7, frame });
	if (!(overlay instanceof EasterEgg3dAnimation)) throw new Error("Expected the fullscreen easter egg overlay");
	return overlay;
}

it("preserves the original fullscreen spin and puzzle timing regardless of the small logo's current pose", () => {
	initTheme("padma");
	let now = 1000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const captures: string[][][] = [];
	for (const time of [0, 0.25, 3.7, 12.6]) {
		now = 1000;
		const animation = openFullscreen({ time, opacity: 1, scale: 1 });
		try {
			captures.push(
				[2000, 5000, 9300, 14500].map((elapsed) => {
					now = 1000 + elapsed;
					return animation.render(120);
				}),
			);
		} finally {
			animation.close();
			animation.close();
		}
	}
	for (const frames of captures.slice(1)) expect(frames).toEqual(captures[0]);
	// The original animation still spins, shuffles its blocks and assembles them again.
	expect(captures[0][0].map(stripTerminalSequences)).not.toEqual(captures[0][1].map(stripTerminalSequences));
	expect(captures[0][1].map(stripTerminalSequences)).not.toEqual(captures[0][2].map(stripTerminalSequences));
});
