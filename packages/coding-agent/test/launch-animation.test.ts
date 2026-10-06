import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@anvaya.sh/padma-tui";
import { describe, expect, it } from "vitest";
import { defaultLaunchSlot, LaunchLogoAnimation, launchProgress } from "../src/cli/launch-animation.ts";
import { renderSideLogoLines } from "../src/modes/interactive/components/easter-egg-3d.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("launch logo", () => {
	it("makes one turn, then holds its front face without looping", () => {
		const animation = new LaunchLogoAnimation();
		const slot = defaultLaunchSlot(120, 2);
		expect(animation.render(120, 40, 400)).not.toEqual(animation.render(120, 40, 750));
		const front = animation.render(120, 40, 1500);
		for (const elapsed of [1900, 2100, 5000, 15000]) expect(animation.render(120, 40, elapsed)).toEqual(front);
		expect(animation.render(120, 40, 2100, 1, slot).map(stripTerminalSequences)).toEqual(
			animation.render(120, 40, 1500, 1, slot).map(stripTerminalSequences),
		);
	});
	it("holds fullscreen for 1.5 seconds before easing into its heading slot", () => {
		const timeline = { startedAt: 1000, fullscreenUntil: 2500 };
		expect(launchProgress(timeline, 2499)).toBe(0);
		expect(launchProgress(timeline, 2500)).toBe(0);
		expect(launchProgress(timeline, 2650)).toBeCloseTo(0.5);
		expect(launchProgress(timeline, 2800)).toBe(1);
	});

	it.each([
		[80, 24],
		[120, 40],
	])("lands on the exact inline easter egg pose at %s × %s", (width, height) => {
		initTheme("padma");
		const animation = new LaunchLogoAnimation();
		const slot = defaultLaunchSlot(width, 2);
		const full = animation.render(width, height, 750).map(stripTerminalSequences);
		const occupiedRows = full.filter((line) => /[\u2801-\u28ff]/.test(line));
		expect(occupiedRows.length).toBeGreaterThan(7);
		const landed = animation.render(width, height, 1500, 1, slot);
		expect(landed).toHaveLength(height);
		expect(landed.every((line) => visibleWidth(line) === width)).toBe(true);
		const inline = renderSideLogoLines(slot.width, slot.height, 0);
		expect(
			landed
				.slice(slot.row, slot.row + slot.height)
				.map((line) => stripTerminalSequences(sliceByColumn(line, slot.column, slot.width))),
		).toEqual(inline.map(stripTerminalSequences));
		expect(landed.slice(0, slot.row).every((line) => stripTerminalSequences(line).trim() === "")).toBe(true);
	});
});
