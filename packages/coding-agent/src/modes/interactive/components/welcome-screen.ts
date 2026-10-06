import {
	type Component,
	Container,
	CURSOR_MARKER,
	Spacer,
	sliceByColumn,
	stripTerminalSequences,
	type TUI,
	type TuiMouseEvent,
	visibleWidth,
	wrapTextWithAnsi,
} from "@anvaya.sh/padma-tui";
import { PADMA_WORDMARK } from "../../../cli/brand.ts";
import {
	defaultLaunchSlot,
	LaunchLogoAnimation,
	type LaunchLogoSlot,
	type LaunchTimeline,
	launchProgress,
} from "../../../cli/launch-animation.ts";
import { getStartupLaunch } from "../../../cli/startup-screen.ts";
import { CustomEditor } from "./custom-editor.ts";
import { padmaLogo3d } from "./padma-logo.ts";
import { WelcomeAccents, WelcomeFact } from "./welcome-accents.ts";

/** Position a component without changing its editor state or mouse coordinates. */
class CenteredContent extends Container {
	private contentWidth = 1;
	private left = 0;
	private lines: string[] = [];
	private lineOrigins: Array<{ row: number; column: number; left: number }> = [];
	private readonly getBlankMargin: (() => number) | undefined;

	constructor(component: Component, getBlankMargin?: () => number) {
		super();
		this.addChild(component);
		this.getBlankMargin = getBlankMargin;
	}

	override render(width: number): string[] {
		const margin = width >= 48 ? 4 : width >= 12 ? 2 : 0;
		this.contentWidth = Math.max(1, Math.min(72, width - margin * 2));
		this.left = Math.max(0, Math.floor((width - this.contentWidth) / 2));
		this.lines = [];
		this.lineOrigins = [];
		let blankRow: number | undefined;
		for (const [row, line] of super.render(this.contentWidth).entries()) {
			if (this.getBlankMargin && stripTerminalSequences(line).trim().length === 0) {
				blankRow ??= row;
				continue;
			}
			if (blankRow !== undefined && this.lines.length > 0) {
				for (let index = 0; index < (this.getBlankMargin?.() ?? 0); index++) {
					this.lines.push("");
					this.lineOrigins.push({ row: blankRow, column: 0, left: 0 });
				}
			}
			blankRow = undefined;
			let column = 0;
			const overflow = visibleWidth(line) > this.contentWidth;
			for (const part of wrapTextWithAnsi(line, this.contentWidth)) {
				const left = overflow ? Math.floor((this.contentWidth - visibleWidth(part)) / 2) : 0;
				this.lines.push(" ".repeat(left) + part);
				this.lineOrigins.push({ row, column, left });
				column += visibleWidth(part);
			}
		}
		return this.lines.map((line) => " ".repeat(this.left) + line);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.x < this.left || event.x >= this.left + this.contentWidth) return undefined;
		const origin = this.lineOrigins[event.y];
		if (!origin) return undefined;
		return super.handleMouse({
			...event,
			x: event.x - this.left - origin.left + origin.column,
			y: origin.row,
			width: this.contentWidth,
		});
	}

	/** Autocomplete follows the input card; it must not move the input upward. */
	getEditorHeight(): number {
		const content = this.children[0];
		const editor = content instanceof Container ? content.children[0] : content;
		if (editor instanceof CustomEditor) {
			const bottom = this.lineOrigins.findIndex((origin) => origin.row === editor.getRenderedEditorHeight() - 1);
			if (bottom >= 0) return bottom + 1;
		}
		const bottomBorder = this.lines.findIndex(
			(line, index) => index > 0 && /^[─╰]/.test(stripTerminalSequences(line)),
		);
		return bottomBorder < 0 ? this.lines.length : bottomBorder + 1;
	}
}

export interface WelcomeScreenOptions {
	readonly heading: Component;
	readonly editor: Component;
	readonly above?: Component;
	readonly below: Component;
	readonly getHeight: () => number;
	readonly launch?: LaunchTimeline | false;
}

/** Anchor the first input box at the terminal's center, with branding above it. */
export class WelcomeScreen extends Container {
	private readonly options: WelcomeScreenOptions;
	private readonly editor: CenteredContent;
	private readonly above: CenteredContent;
	private readonly below: CenteredContent;
	private readonly fact = new CenteredContent(new WelcomeFact());
	private readonly accents = new WelcomeAccents();
	private readonly ui: TUI | undefined;
	private launch: LaunchTimeline | undefined;
	private readonly launchLogo = new LaunchLogoAnimation();
	private launchTimer: ReturnType<typeof setInterval> | undefined;
	private lastRender = performance.now();
	private launchLayout: { width: number; height: number; screen: string[]; slot: LaunchLogoSlot } | undefined;
	private clipTop = 0;
	private contentHeight = 0;

	constructor(options: WelcomeScreenOptions) {
		super();
		this.options = options;
		this.editor = new CenteredContent(options.editor);
		this.above = new CenteredContent(options.above ?? new Container(), () => 1);
		this.below = new CenteredContent(options.below, () =>
			options.getHeight() >= 36 ? 3 : options.getHeight() >= 28 ? 2 : 1,
		);
		const editor = options.editor instanceof Container ? options.editor.children[0] : options.editor;
		this.ui = editor instanceof CustomEditor ? editor.renderTarget : undefined;
		this.launch = options.launch === false ? undefined : (options.launch ?? getStartupLaunch());
		if (this.launch && this.ui) {
			this.launchTimer = setInterval(() => {
				if (performance.now() - this.lastRender > 1000) {
					if (this.launchTimer) clearInterval(this.launchTimer);
					this.launchTimer = undefined;
					this.launch = undefined;
					this.launchLayout = undefined;
				} else this.ui?.requestRender();
			}, 1000 / 60);
			this.launchTimer.unref?.();
		}
		this.children = [options.heading, this.editor, this.below];
	}

	override render(width: number): string[] {
		const height = Math.max(1, this.options.getHeight());
		this.lastRender = performance.now();
		// During the intro only the logo changes; layout is refreshed on resize and after landing.
		if (this.launch && this.launchLayout?.width === width && this.launchLayout.height === height) {
			return this.renderLaunch(width, height, this.launchLayout.screen, this.launch, this.launchLayout.slot);
		}
		const gap = height >= 36 ? 3 : height >= 28 ? 2 : 1;
		const topMargin = height >= 32 ? 2 : 1;
		const editorLines = this.editor.render(width);
		const aboveLines = this.above.render(width);
		const belowLines = this.below.render(width);
		const factLines = height >= 24 && width >= 40 ? this.fact.render(width) : [];
		const factHeight = factLines.length;
		const beforeInput = gap + (factHeight > 0 ? factHeight + gap : 0) + aboveLines.length;
		if (this.options.heading instanceof CenteredWelcomeHeading) this.options.heading.blankMargin = gap;
		this.options.heading.invalidate();
		let headingLines = this.options.heading.render(width);
		const bottomBudget = belowLines.length > 0 ? gap + belowLines.length + gap : gap;
		// Keep a long draft and its completion menu intact when they fill the viewport.
		const inputTop = Math.max(
			0,
			Math.min(
				Math.max(
					Math.floor((height - this.editor.getEditorHeight()) / 2),
					headingLines.length + beforeInput + topMargin,
				),
				height - editorLines.length - bottomBudget,
			),
		);
		const availableHeadingHeight = Math.max(0, inputTop - beforeInput - topMargin);
		if (this.options.heading instanceof CenteredWelcomeHeading) {
			headingLines = this.options.heading.render(width, availableHeadingHeight);
		}
		const headingHeight = Math.min(headingLines.length, availableHeadingHeight);
		const heading: Component = {
			render: () => headingLines.slice(headingLines.length - headingHeight),
			invalidate: () => this.options.heading.invalidate(),
			handleMouse: (event) =>
				this.options.heading.handleMouse?.({
					...event,
					y: event.y + headingLines.length - headingHeight,
				}),
		};
		this.children = [
			new Spacer(
				Math.max(
					0,
					inputTop -
						headingHeight -
						(headingHeight > 0 ? gap : 0) -
						(factHeight > 0 ? factHeight + gap : 0) -
						aboveLines.length,
				),
			),
			heading,
			new Spacer(headingHeight > 0 ? gap : 0),
			...(factHeight > 0 ? [this.fact, new Spacer(gap)] : []),
			this.above,
			this.editor,
			new Spacer(gap),
			this.below,
		];
		const lines = super.render(width);
		this.clipTop = 0;
		this.contentHeight = lines.length;
		if (lines.length > height) {
			const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
			const start = Math.max(0, cursor - height + 1);
			// Extremely short terminals still keep the active input row visible.
			this.clipTop = start;
		}
		const screen = lines.slice(this.clipTop, this.clipTop + height);
		if (this.launch && this.ui) {
			const logoTop = Math.max(
				0,
				screen.findIndex((line) => stripTerminalSequences(line).includes(PADMA_WORDMARK[0].trim())),
			);
			const slot = defaultLaunchSlot(width, logoTop);
			this.launchLayout = { width, height, screen, slot };
			return this.renderLaunch(width, height, screen, this.launch, slot);
		}
		return this.accents.render(screen, width, height);
	}

	private renderLaunch(
		width: number,
		height: number,
		screen: string[],
		timeline: LaunchTimeline,
		slot: LaunchLogoSlot,
	): string[] {
		const ui = this.ui;
		if (!ui) return screen;
		const progress = launchProgress(timeline);
		if (progress >= 1) {
			this.launch = undefined;
			this.launchLayout = undefined;
			if (this.launchTimer) clearInterval(this.launchTimer);
			this.launchTimer = undefined;
			padmaLogo3d.setOrigin(slot.column, slot.row, slot.width, slot.height);
			padmaLogo3d.resume(ui, { time: 0, opacity: 1, scale: 1 });
			return this.render(width);
		}
		// Freeze the departing pose at handoff, then ease it into the side animation's front-facing pose.
		const canvas = this.launchLogo.render(
			width,
			height,
			Math.min(performance.now(), timeline.fullscreenUntil) - timeline.startedAt,
			progress,
			slot,
		);
		// Restore original pure fullscreen animation - no ASCII overlay mid-rotation.
		return canvas;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (this.launch) {
			return {
				handled: true,
				target: {
					component: this,
					originX: event.screenX - event.x,
					originY: event.screenY - event.y,
					width: event.width,
					height: event.height,
				},
			};
		}
		const result = super.handleMouse({ ...event, y: event.y + this.clipTop, height: this.contentHeight });
		if (result?.render) this.ui?.requestRender();
		return result;
	}
}

/** Center the wordmark as one aligned block and the supporting text as individual lines. */
export class CenteredWelcomeHeading extends Container {
	public blankMargin = 1;
	private readonly content: Component;
	private readonly onLogoClick: ((column: number, row: number, clickCount: number) => void) | undefined;
	private readonly getLogoHeight: (() => number) | undefined;
	private renderedLines: string[] = [];
	private contentWidth = 1;
	private leftOffsets: number[] = [];
	private rowOffsets: number[] = [];
	private logoInset = 0;
	private sideWidth = 0;

	constructor(
		content: Component,
		onLogoClick?: (column: number, row: number, clickCount: number) => void,
		getLogoHeight?: () => number,
	) {
		super();
		this.content = content;
		this.addChild(content);
		this.onLogoClick = onLogoClick;
		this.getLogoHeight = getLogoHeight;
	}

	override render(width: number, maxHeight?: number): string[] {
		this.contentWidth = Math.max(1, Math.min(120, width));
		this.leftOffsets = [];
		const lines = super.render(this.contentWidth);
		const logoHeight = this.getLogoHeight?.() ?? 0;
		if (logoHeight === PADMA_WORDMARK.length) {
			const versionRow = lines.findIndex(
				(line, row) => row >= logoHeight && /^v\d+\.\d+\.\d+\S*$/.test(stripTerminalSequences(line).trim()),
			);
			if (versionRow >= 0) {
				const topWidth = visibleWidth(stripTerminalSequences(lines[0]).trimEnd());
				lines[0] = `${sliceByColumn(lines[0], 0, topWidth, true)}    ${lines[versionRow].trim()}`;
				lines.splice(versionRow, 1);
			}
		}
		if (this.blankMargin > 1) {
			for (let row = lines.length - 1; row >= logoHeight; row--) {
				if (stripTerminalSequences(lines[row]).trim().length === 0)
					lines.splice(row, 1, ...Array<string>(this.blankMargin).fill(""));
			}
		}
		this.sideWidth = logoHeight === PADMA_WORDMARK.length ? padmaLogo3d.getSideWidth(width) : 8;
		this.logoInset = padmaLogo3d.isActive() && logoHeight > 1 ? this.sideWidth + 2 : 0;
		const logoWidth = Math.max(
			0,
			...lines.slice(0, logoHeight).map((line) => visibleWidth(stripTerminalSequences(line).trimEnd())),
		);
		this.rowOffsets = lines.map((_, row) => row);
		if (maxHeight !== undefined && lines.length > maxHeight) {
			// Preserve the complete wordmark and prefer supporting text over extra blank rows.
			this.rowOffsets =
				maxHeight < logoHeight
					? []
					: [
							...this.rowOffsets.slice(0, logoHeight),
							...this.rowOffsets.slice(lines.length - (maxHeight - logoHeight)),
						];
		}
		this.renderedLines = this.rowOffsets.map((row) => {
			const line = lines[row];
			const textWidth = visibleWidth(stripTerminalSequences(line).trimEnd());
			const text = sliceByColumn(line, 0, textWidth, true);
			const left = Math.max(
				0,
				row < logoHeight
					? Math.floor((width - (logoWidth - this.logoInset)) / 2) - this.logoInset
					: Math.floor((width - textWidth) / 2),
			);
			this.leftOffsets.push(left);
			return " ".repeat(left) + text;
		});
		return this.renderedLines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const line = this.renderedLines[event.y];
		const left = this.leftOffsets[event.y];
		if (!line || left === undefined || event.x < left || event.x >= visibleWidth(line)) return undefined;
		if (this.onLogoClick && event.y < (this.getLogoHeight?.() ?? 0)) {
			if (event.type === "click") {
				const column = Math.max(0, event.screenX - event.x + left - (this.logoInset > 0 ? 0 : this.sideWidth + 2));
				const row = event.screenY - event.y;
				padmaLogo3d.setOrigin(column, row, this.sideWidth, (this.getLogoHeight?.() ?? 1) > 4 ? 7 : 4);
				this.onLogoClick(column, row, event.clickCount ?? 1);
			}
			return {
				handled: true,
				target: {
					component: this,
					originX: event.screenX - event.x,
					originY: event.screenY - event.y,
					width: event.width,
					height: event.height,
				},
			};
		}
		return super.handleMouse({
			...event,
			x: event.x - left,
			y: this.rowOffsets[event.y],
			width: this.contentWidth,
		});
	}

	override invalidate(): void {
		this.content.invalidate();
	}
}

/** Switch the regular renderer's tree without replacing or refocusing the editor. */
export class WelcomeChatLayout extends Container {
	private readonly welcome: Component;
	private readonly conversation: Component;
	private readonly showWelcome: () => boolean;

	constructor(welcome: Component, conversation: Component, showWelcome: () => boolean) {
		super();
		this.welcome = welcome;
		this.conversation = conversation;
		this.showWelcome = showWelcome;
		this.children = [conversation, welcome];
	}

	override render(width: number): string[] {
		this.children = [this.showWelcome() ? this.welcome : this.conversation];
		return super.render(width);
	}
}
