import { stripTerminalSequences } from "@anvaya.sh/padma-tui";
import { describe, expect, it } from "vitest";
import { PADMA_WORDMARK, padmaGradient } from "../src/cli/brand.ts";

function glyphColours(text: string): number[][] {
	const colours: number[][] = [];
	let current = [0, 0, 0];
	for (const match of text.matchAll(/\x1b\[(?:38;2;(\d+);(\d+);(\d+)|[\d;]*)m|([^\x1b])/gu)) {
		if (match[1]) current = [Number(match[1]), Number(match[2]), Number(match[3])];
		if (match[4]) colours.push(current);
	}
	return colours;
}

describe("Padma ASCII colour sweep", () => {
	it("preserves the exact ASCII and applies colour only to its foreground", () => {
		for (const [row, line] of PADMA_WORDMARK.entries()) {
			const styled = padmaGradient(line, 1, 0, 60, row);
			expect(stripTerminalSequences(styled)).toBe(line);
			expect(styled).not.toContain("\x1b[48;");
		}
	});

	it("uses a visible range of warm tones and changes gradually between animation frames", () => {
		const text = "M".repeat(60);
		const first = glyphColours(padmaGradient(text, 0, 0, 60, 0));
		const next = glyphColours(padmaGradient(text, 50 / 1800, 0, 60, 0));
		expect(first).toHaveLength(60);
		expect(next).toHaveLength(60);
		expect(
			Math.max(...first.map((colour) => colour[0])) - Math.min(...first.map((colour) => colour[0])),
		).toBeGreaterThan(100);
		expect(next).not.toEqual(first);
		for (let glyph = 0; glyph < first.length; glyph++) {
			for (let channel = 0; channel < 3; channel++) {
				expect(Math.abs(next[glyph][channel] - first[glyph][channel])).toBeLessThanOrEqual(5);
			}
		}
	});

	it("loops seamlessly and offsets the sweep across wordmark rows", () => {
		const text = "M".repeat(60);
		const first = padmaGradient(text, 0, 0, 60, 0);
		expect(padmaGradient(text, Math.PI * 2, 0, 60, 0)).toBe(first);
		expect(padmaGradient(text, 0, 0, 60, 6)).not.toBe(first);
	});
});
