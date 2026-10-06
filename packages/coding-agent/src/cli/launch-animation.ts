import { PADMA_LOGO_MODEL_PIXELS } from "../modes/interactive/components/padma-logo-model.ts";
import { PADMA_WORDMARK } from "./brand.ts";
import { BlockRaster, type Box, clamp01 } from "./logo-raster.ts";

export const LAUNCH_FULLSCREEN_MS = 1500;
export const LAUNCH_LANDING_MS = 300;

export interface LaunchTimeline {
	startedAt: number;
	fullscreenUntil: number;
}

export interface LaunchLogoSlot {
	column: number;
	row: number;
	width: number;
	height: number;
}

export function launchProgress(timeline: LaunchTimeline, now = performance.now()): number {
	const progress = clamp01((now - timeline.fullscreenUntil) / LAUNCH_LANDING_MS);
	return progress * progress * progress * (progress * (progress * 6 - 15) + 10);
}

/** Use the same voxel model and lighting as the interactive easter egg. */
export class LaunchLogoAnimation {
	private readonly raster = new BlockRaster(40);
	private readonly boxes: Box[] = PADMA_LOGO_MODEL_PIXELS.flatMap((color, index): Box[] => {
		if (!color) return [];
		const column = index % 16;
		const row = Math.floor(index / 16);
		return [{ min: [column - 8, row - 8, -0.35], max: [column - 7, row - 7, 0.35], color }];
	});

	render(width: number, height: number, elapsedMs: number, progress = 0, slot?: LaunchLogoSlot): string[] {
		width = Math.max(1, width);
		height = Math.max(1, height);
		const radius = Math.hypot(8, 8, 1.35);
		const reach = radius * (40 / (40 - radius));
		const fullScale = Math.max(0.1, Math.min(width * 2 * 0.35, Math.max(1, height * 4 - 8) * 0.48) / reach);
		const target = slot ?? { column: 0, row: 0, width, height };
		const targetScale = Math.min(target.width * 2, target.height * 4) / 22;
		// Single rotation cycle, then hold front face and hand off to TUI.
		const turn = clamp01(Math.max(0, elapsedMs) / LAUNCH_FULLSCREEN_MS);
		const phase = Math.PI * 2 * turn - Math.sin(Math.PI * 2 * turn);
		const landingPhase = Math.round(phase / (Math.PI * 2)) * Math.PI * 2;
		const foreground = [74, 52, 42] as const;
		this.raster.render(
			width,
			height,
			{
				centerX: width + (target.column * 2 + target.width - width) * progress,
				centerY: height * 2 - 2 + (target.row * 4 + target.height * 2 - (height * 2 - 2)) * progress,
				scale: fullScale * (targetScale / fullScale) ** progress,
				yaw: phase + (landingPhase - phase) * progress,
				pitch: 0.22 * Math.sin(phase) * (1 - progress),
				roll: 0.05 * Math.sin(2 * phase) * (1 - progress),
			},
			this.boxes,
			foreground,
			0,
		);
		const lines: string[] = [];
		for (let row = 0; row < height; row++) {
			let line = "";
			let previousColor = "";
			for (let column = 0; column < width; column++) {
				const index = row * width + column;
				const bits = this.raster.bits[index]!;
				if (!bits) {
					line += " ";
					continue;
				}
				const step = 5 * this.raster.counts[index]!;
				const rgb = this.raster.rgb;
				const color = [0, 1, 2].map((channel) => Math.round(rgb[index * 3 + channel]! / step) * 5);
				const ansi = `\x1b[38;2;${color.join(";")}m`;
				if (ansi !== previousColor) line += ansi;
				previousColor = ansi;
				line += String.fromCharCode(0x2800 + bits);
			}
			lines.push(`${line}\x1b[39m`);
		}
		return lines;
	}
}

/** A default slot used only before the real welcome layout is available. */
export function defaultLaunchSlot(width: number, row = 1): LaunchLogoSlot {
	const wordmarkWidth = Math.max(...PADMA_WORDMARK.map((line) => line.length));
	const sideWidth = Math.min(22, Math.max(4, Math.floor((width - wordmarkWidth) / 2) - 2));
	return {
		column: Math.max(0, Math.floor((width - wordmarkWidth) / 2) - sideWidth - 2),
		row,
		width: sideWidth,
		height: 7,
	};
}
