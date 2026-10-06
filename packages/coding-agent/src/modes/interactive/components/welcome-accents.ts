import {
	sliceByColumn,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@anvaya.sh/padma-tui";
import { theme } from "../theme/theme.ts";
import { WELCOME_TIPS } from "./welcome-quick-actions.ts";

const FACTS = WELCOME_TIPS.flatMap((tip) => (tip.kind === "fact" && typeof tip.text === "string" ? [tip.text] : []));

/** A quiet Sanskrit fact; clicking it reveals the next one. */
export class WelcomeFact {
	private index = Math.max(
		0,
		FACTS.findIndex((text) => text.includes("meditation")),
	);
	private width = 1;

	invalidate(): void {}

	render(width: number): string[] {
		this.width = width;
		return wrapTextWithAnsi(
			`${theme.fg("accent", "Tathya [fact]")}  ${theme.fg("muted", FACTS[this.index])}`,
			width,
		).map((line) => {
			const left = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
			return " ".repeat(left) + line;
		});
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.x < 0 || event.x >= this.width || event.button !== "left") return undefined;
		if (event.type === "press") return { handled: true };
		if (event.type !== "click") return undefined;
		this.index = (this.index + 1) % FACTS.length;
		return { handled: true, render: true };
	}
}

const WORDS = ["śānti [peace]", "ākāśa [sky]", "svapna [dream]", "jyoti [light]", "ananta [infinite]"];
// A solid crescent cut from two circles, with no outline or marks inside the dark face.
const MOON = Array.from({ length: 6 }, (_, row) =>
	Array.from({ length: 12 }, (_, column) => {
		let bits = 0;
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 2; x++) {
				const dx = column * 2 + x + 0.5 - 12;
				const dy = row * 4 + y + 0.5 - 12;
				if (dx * dx + dy * dy <= 11.5 ** 2 && (dx - 6) ** 2 + dy * dy > 11.8 ** 2) {
					bits |= [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80][y * 2 + x];
				}
			}
		}
		return bits ? String.fromCharCode(0x2800 + bits) : " ";
	}).join(""),
);
const CONSTELLATIONS = [
	{
		name: "Ursa Major — Big Dipper",
		lines: ["*", "  ╲", "    +───*", "        ╲", "          *─────+", "           ╲   ╱", "            +─*"],
	},
	{
		name: "Orion",
		lines: [" +         *", "  ╲       ╱", "   ╲     ╱", "    +─*─+", "   ╱  ·  ╲", "  ╱   ·   ╲", " *         +"],
	},
	{
		name: "Cassiopeia",
		lines: ["+       *       +", " ╲     ╱ ╲     ╱", "  ╲   ╱   ╲   ╱", "   *       +"],
	},
];
const MAX_STARS = 44;

/** A quiet, irregular star field around the main content, with no controls or captions. */
export class WelcomeAccents {
	private readonly firstSide = Math.floor(Math.random() * 2);
	private readonly scatter = Array.from(
		{ length: WORDS.length + CONSTELLATIONS.length + 2 + MAX_STARS },
		(_, index) => ({
			side: (index + this.firstSide) % 2,
			points: Array.from({ length: 32 }, () => ({ x: Math.random(), y: Math.random() })),
		}),
	);
	private layout:
		| { width: number; height: number; positions: Array<{ column: number; row: number } | undefined> }
		| undefined;

	render(lines: string[], width: number, height: number): string[] {
		const gutter = Math.floor((width - 72) / 2);
		const zoneWidth = gutter - 2;
		if (zoneWidth <= 0 || height < 16) return lines;
		const starCount = gutter < 8 ? 8 : gutter < 16 ? 18 : gutter < 28 ? 30 : MAX_STARS;
		const motifs: Array<{ lines: string[]; color: "accent" | "muted" | "dim" }> = [
			{ lines: MOON, color: "muted" },
			...CONSTELLATIONS.map(({ lines }) => ({
				lines: lines.map((line) =>
					Array.from(line, (glyph) => theme.fg(glyph === "*" || glyph === "+" ? "muted" : "dim", glyph)).join(""),
				),
				color: "dim" as const,
			})),
			{ lines: [" │", "─*─", " │"], color: "accent" },
			...WORDS.map((word) => ({ lines: [word], color: "dim" as const })),
			...Array.from({ length: starCount }, (_, index) => ({
				lines: [[".", "+", "·", ".", "+", "*"][index % 6]],
				color: index % 4 === 0 ? ("muted" as const) : ("dim" as const),
			})),
		];
		const reuseLayout = this.layout?.width === width && this.layout.height === height;
		const positions = reuseLayout ? this.layout!.positions : [];
		const output = [...lines];
		for (const [index, motif] of motifs.entries()) {
			const motifWidth = Math.max(...motif.lines.map(visibleWidth));
			if (motifWidth > zoneWidth || motif.lines.length > height - 4) continue;
			const scatter = this.scatter[index];
			const start = scatter.side === 0 ? 1 : width - gutter + 1;
			const saved = positions[index];
			const candidates = reuseLayout
				? saved
					? [saved]
					: []
				: scatter.points.map((point) => ({
						column: start + Math.floor(point.x * (zoneWidth - motifWidth + 1)),
						row: 2 + Math.floor(point.y * (height - motif.lines.length - 3)),
					}));
			for (const { column, row } of candidates) {
				// Leave breathing room around every motif, and preserve all existing text and logo pixels.
				const occupied = Array.from(
					{ length: motif.lines.length + 2 },
					(_, offset) => output[row + offset - 1] ?? "",
				).some((line) => stripTerminalSequences(sliceByColumn(line, column - 1, motifWidth + 2)).trim().length > 0);
				if (occupied) continue;
				positions[index] = { column, row };
				while (output.length < row + motif.lines.length) output.push("");
				for (const [offset, text] of motif.lines.entries()) {
					const y = row + offset;
					const before = sliceByColumn(output[y], 0, column);
					const after = sliceByColumn(output[y], column + motifWidth, Math.max(0, width - column - motifWidth));
					output[y] =
						before +
						" ".repeat(Math.max(0, column - visibleWidth(before))) +
						theme.fg(motif.color, text + " ".repeat(motifWidth - visibleWidth(text))) +
						after;
				}
				break;
			}
		}
		this.layout = { width, height, positions };
		return output;
	}
}
