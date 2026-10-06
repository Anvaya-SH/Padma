import { stripTerminalSequences, visibleWidth } from "@anvaya.sh/padma-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeAccents } from "../src/modes/interactive/components/welcome-accents.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("scattered welcome decoration", () => {
	beforeEach(() => {
		initTheme("padma");
		let seed = 42;
		vi.spyOn(Math, "random").mockImplementation(() => {
			seed = (1664525 * seed + 1013904223) >>> 0;
			return seed / 4294967296;
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it.each([
		[80, 24],
		[112, 30],
		[120, 40],
		[160, 50],
	])("fits %s × %s while preserving the central content", (width, height) => {
		const accents = new WelcomeAccents();
		const left = Math.floor((width - 72) / 2);
		const lines = Array.from({ length: height }, () => " ".repeat(left) + "Central content".padEnd(72));
		const output = accents.render(lines, width, height);
		expect(output.join("\n")).not.toContain("click to");
		expect(output.join("\n")).not.toContain("Cakra");
		expect(output).not.toEqual(lines);
		expect(output).toHaveLength(height);
		for (const [row, line] of output.entries()) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(stripTerminalSequences(line).slice(left, left + 72)).toBe(lines[row].slice(left));
		}
	});

	it("scatters a moon, stars, and Sanskrit words without turning them into rows of captions", () => {
		const accents = new WelcomeAccents();
		const lines = Array<string>(50).fill("");
		const output = accents.render(lines, 160, 50).map(stripTerminalSequences);
		const text = output.join("\n");
		expect(output.filter((line) => /[\u2801-\u28ff]/.test(line))).toHaveLength(6);
		expect(text).not.toContain(" /  .-'");
		expect(text).toContain("+───*");
		expect(text).toContain("+─*─+");
		expect(text.match(/[*+.·]/g)!.length).toBeGreaterThanOrEqual(50);
		expect(text).toContain("śānti [peace]");
		expect(text).toContain("ākāśa [sky]");
		expect(text).toContain("svapna [dream]");
		expect(text).toContain("jyoti [light]");
		expect(text).toContain("ananta [infinite]");
		const wordRows = output.flatMap((line, row) => (line.includes("[") ? [row] : []));
		const wordColumns = output.flatMap((line) => line.match(/\S+(?= \[)/g)?.map((word) => line.indexOf(word)) ?? []);
		expect(new Set(wordRows).size).toBeGreaterThan(3);
		expect(new Set(wordColumns).size).toBeGreaterThan(3);
		expect(text.replace(/\s/g, "").length).toBeLessThan(420);
	});

	it("keeps its positions steady on redraw and picks a different scatter for another session", () => {
		const lines = Array<string>(40).fill("");
		const accents = new WelcomeAccents();
		const first = accents.render(lines, 120, 40);
		expect(accents.render(lines, 120, 40)).toEqual(first);
		expect(new WelcomeAccents().render(lines, 120, 40)).not.toEqual(first);
	});

	it("hides decorations behind existing content and restores them without moving them", () => {
		const accents = new WelcomeAccents();
		const blank = Array<string>(40).fill("");
		const shown = accents.render(blank, 120, 40);
		const occupied = Array<string>(40).fill("x".repeat(120));
		expect(accents.render(occupied, 120, 40)).toEqual(occupied);
		expect(accents.render(blank, 120, 40)).toEqual(shown);
		expect(accents.render(blank, 60, 12)).toEqual(blank);
	});
});
