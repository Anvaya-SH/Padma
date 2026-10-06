/** Kept dependency-free so the launcher can draw before loading the agent. */
export const PADMA_WORDMARK = [
	'    `7MM"""Mq.             `7MM',
	"      MM   `MM.              MM",
	'      MM   ,M9 ,6"Yb.   ,M""bMM  `7MMpMMMb.pMMMb.   ,6"Yb.',
	"      MMmmdM9 8)   MM ,AP    MM    MM    MM    MM  8)   MM",
	"      MM       ,pm9MM 8MI    MM    MM    MM    MM   ,pm9MM",
	"      MM      8M   MM `Mb    MM    MM    MM    MM  8M   MM",
	'    .JMML.    `Moo9^Yo.`Wbmd"MML..JMML  JMML  JMML.`Moo9^Yo.',
] as const;

export const PADMA_PALETTE = {
	linen: "#F5F1EA",
	khaki: "#D7C9B8",
	camel: "#B2967D",
	cocoa: "#7D5A44",
	espresso: "#4A342A",
} as const;

/** Warm ink gradient. Supplying a wordmark row enables a continuous diagonal colour sweep. */
export function padmaGradient(text: string, phase = 0, offset = 0, span = text.length, shimmerRow?: number): string {
	const colors =
		shimmerRow === undefined
			? [
					[245, 241, 234],
					[215, 201, 184],
					[178, 150, 125],
				]
			: [
					[178, 150, 125],
					[125, 90, 68],
					[178, 150, 125],
					[215, 201, 184],
					[245, 241, 234],
					[215, 201, 184],
					[178, 150, 125],
				];
	let result = "\x1b[23m";
	let column = offset;
	let lastColor = "";
	for (const glyph of text) {
		if (glyph === " ") {
			result += glyph;
			column++;
			continue;
		}
		const progress = Math.max(0, Math.min(1, column / Math.max(1, span - 1)));
		const wave = Math.sin(progress * Math.PI * 2 - phase) * 0.06;
		const sweep = progress * 0.7 - phase / (Math.PI * 2) + (shimmerRow ?? 0) * 0.015;
		const position =
			shimmerRow === undefined ? Math.max(0, Math.min(2, progress * 2 + wave)) : (((sweep % 1) + 1) % 1) * 6;
		const segment = Math.min(colors.length - 2, Math.floor(position));
		const fraction = position - segment;
		// Ease at each colour stop, including the loop boundary, to avoid abrupt changes.
		const blend = shimmerRow === undefined ? fraction : fraction * fraction * (3 - 2 * fraction);
		const color = colors[segment].map((value, channel) =>
			Math.round(value + (colors[segment + 1][channel] - value) * blend),
		);
		const ansi = `\x1b[38;2;${color.join(";")}m`;
		if (ansi !== lastColor) result += ansi;
		lastColor = ansi;
		result += glyph;
		column++;
	}
	return `${result}\x1b[39m`;
}
