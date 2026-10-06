import { stripTerminalSequences } from "@anvaya.sh/padma-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { padmaLogoLines } from "../src/modes/interactive/components/padma-logo.ts";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => {
	vi.restoreAllMocks();
	initTheme("dark");
});

describe("ThemedText", () => {
	it("builds lazily and rebuilds with the current theme after invalidation", () => {
		initTheme("dark");
		let builds = 0;
		const text = new ThemedText(() => {
			builds++;
			return theme.fg("accent", "hello");
		});
		expect(builds).toBe(0);
		const dark = text.render(20).join("");

		initTheme("light");
		expect(text.render(20).join("")).toBe(dark);
		text.invalidate();
		expect(text.render(20).join("")).toContain(theme.getFgAnsi("accent"));
		expect(builds).toBe(2);
	});

	it("refreshes animated wordmark colours without requiring a theme invalidation", () => {
		initTheme("padma");
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const text = new ThemedText(() => padmaLogoLines().join("\n"), 0, 0);
		const first = text.render(80);
		clock.mockReturnValue(1800);
		const second = text.render(80);
		expect(second).not.toEqual(first);
		expect(second.map(stripTerminalSequences)).toEqual(first.map(stripTerminalSequences));
	});

	it("retains the rendered layout cache when a Padma frame's text is unchanged", () => {
		initTheme("padma");
		const text = new ThemedText(() => theme.fg("accent", "hello"));
		const first = text.render(20);
		expect(text.render(20)).toBe(first);
	});
});
