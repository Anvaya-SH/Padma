import type { TUI } from "@anvaya.sh/padma-tui";
import { PADMA_WORDMARK, padmaGradient } from "../../../cli/brand.ts";
import { type PadmaLogoFrame, renderSideLogoLines } from "./easter-egg-3d.ts";

export const PADMA_LOGO_WIDTH = Math.max(...PADMA_WORDMARK.map((line) => line.length));

export interface PadmaLogoOrigin {
	column: number;
	row: number;
	width: number;
	height: number;
}

class PadmaLogo3dController {
	private active = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private startTime = performance.now();
	private origin: PadmaLogoOrigin | undefined;
	private tui: TUI | undefined;
	private transition = { start: performance.now(), from: 0, to: 1 };
	private lastFrame: PadmaLogoFrame | undefined;

	isActive(): boolean {
		return this.active;
	}

	getSideWidth(columns = this.tui?.terminal?.columns ?? process.stdout.columns ?? 80): number {
		// Use the left gutter without moving the centered lettering.
		return Math.min(22, Math.max(4, Math.floor((columns - PADMA_LOGO_WIDTH) / 2) - 2));
	}

	getSideHeight(): number {
		return 7;
	}

	setOrigin(column: number, row: number, width?: number, height?: number): void {
		this.origin = {
			column,
			row,
			width: width ?? this.getSideWidth(),
			height: height ?? this.getSideHeight(),
		};
	}

	getOrigin(): PadmaLogoOrigin | undefined {
		return this.origin;
	}

	start(tui: TUI): void {
		if (this.active && this.transition.to === 1) return;
		const from = this.active ? this.getFrame().opacity : 0;
		if (!this.active) this.startTime = performance.now();
		this.active = true;
		this.tui = tui;
		if (this.origin) this.origin.width = this.origin.height === 4 ? 8 : this.getSideWidth();
		this.transition = { start: performance.now(), from, to: 1 };
		this.lastFrame = undefined;
		if (!this.timer) {
			this.timer = setInterval(() => {
				if (this.transition.to === 0 && performance.now() - this.transition.start >= 300) this.stop();
				tui.requestRender();
			}, 1000 / 60);
			this.timer.unref?.();
		}
		tui.requestRender();
	}

	stop(tui?: TUI): void {
		if (!this.active) return;
		if (tui) {
			if (this.transition.to === 0) return;
			this.transition = { start: performance.now(), from: this.getFrame().opacity, to: 0 };
			tui.requestRender();
			return;
		}
		this.lastFrame ??= this.getFrame();
		this.active = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** Continue the same pose after the fullscreen logo lands in its original slot. */
	resume(tui: TUI, frame: PadmaLogoFrame): void {
		this.start(tui);
		this.startTime = performance.now() - frame.time * 1000;
		this.transition = { start: performance.now(), from: frame.opacity, to: 1 };
		this.lastFrame = frame;
	}

	getFrame(): PadmaLogoFrame {
		const progress = Math.max(0, Math.min(1, (performance.now() - this.transition.start) / 300));
		const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
		const opacity = this.transition.from + (this.transition.to - this.transition.from) * eased;
		return { time: (performance.now() - this.startTime) / 1000, opacity, scale: 0.85 + opacity * 0.15 };
	}

	getFullscreenFrame(): PadmaLogoFrame {
		return this.lastFrame ?? this.getFrame();
	}

	toggle(tui: TUI): void {
		if (this.active) {
			this.stop(tui);
		} else {
			this.start(tui);
		}
	}

	renderSideLines(height = 7, width?: number): string[] {
		const w = width ?? this.getSideWidth();
		const frame = this.getFrame();
		this.lastFrame = frame;
		return renderSideLogoLines(w, height, frame.time, undefined, frame);
	}
}

export const padmaLogo3d = new PadmaLogo3dController();

export function getPadmaLogoWidth(): number {
	const extra = padmaLogo3d.isActive() ? padmaLogo3d.getSideWidth() + 2 : 0;
	return PADMA_LOGO_WIDTH + extra;
}

/** The requested serif ASCII lettering, sharing one gradient across its aligned rows. */
export function padmaLogoLines(): string[] {
	const phase = performance.now() / 1800;
	const baseLines = PADMA_WORDMARK.map((line, row) => padmaGradient(line, phase, 0, PADMA_LOGO_WIDTH, row));
	if (!padmaLogo3d.isActive()) return baseLines;
	const sideWidth = padmaLogo3d.getSideWidth();
	const sideLines = padmaLogo3d.renderSideLines(baseLines.length, sideWidth);
	return baseLines.map((line, index) => `${sideLines[index]}  ${line}`);
}

/** Leave room for the version beside the wordmark. */
export function supportsPadmaLogo(): boolean {
	// The side animation uses the existing gutter; it must not force the lettering into compact mode.
	return (process.stdout.columns ?? 80) >= PADMA_LOGO_WIDTH + 8;
}

/** Compact wordmark for narrow terminals. */
export function padmaWordmark(): string {
	const text = padmaGradient("Padma", performance.now() / 1800, 0, 5, 0);
	if (!padmaLogo3d.isActive()) return text;
	const sideLines = padmaLogo3d.renderSideLines(4, 8);
	return sideLines.map((side, i) => (i === 1 ? `${side}  ${text}` : `${side}`)).join("\n");
}
