import type { AgentToolResult } from "@anvaya.sh/padma-agent-core";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
} from "@anvaya.sh/padma-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import { userFacingOperationStatus, userFacingReason } from "../../../core/sandhana/reporting.ts";
import type { Theme } from "../theme/theme.ts";

/**
 * What this component needs from a tool: how to draw it. It neither executes tools nor reads their
 * parameter schemas, so a definition and a bare renderer pair are equally acceptable.
 *
 * The renderer parameters are `any` on purpose: a `ToolDefinition` types them from its schema, and
 * narrowing them here would make those definitions unassignable.
 */
export interface ToolRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}

import { formatToolCallWithArgs, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

const FALLBACK_PREVIEW_LINES = 10;

const KNOWLEDGE_TITLES = new Map([
	["avartana", "Retrieve context"],
	["avartana_search", "Search context"],
	["avartana_read", "Read context"],
	["avartana_expand", "Expand context"],
	["avartana_analyze", "Analyze context"],
	["avartana_sources", "Available sources"],
	["avartana_context_status", "Context status"],
	["sarasangraha_compact", "Save context"],
	["sarasangraha_restore", "Restore context"],
	["sarasangraha_pin", "Pin context"],
	["sarasangraha_unpin", "Unpin context"],
	["sarasangraha_status", "Saved context status"],
	["sarasangraha_explain", "Context details"],
	["smritikosha_recall", "Recall memory"],
	["smritikosha_inspect", "Inspect memory"],
	["smritikosha_consider", "Consider memory"],
	["smritikosha_store", "Save memory"],
	["smritikosha_correct", "Correct memory"],
	["smritikosha_demote", "Update memory status"],
	["smritikosha_forget", "Forget memory"],
	["smritikosha_status", "Memory status"],
]);

/** Scheduler control envelopes are model/kernel state, never user chat text. */
function isControlEnvelope(text: string): boolean {
	const sample = text.slice(0, 2000);
	return (
		sample.includes("DIRGHAKRIYA/1") ||
		(sample.includes("operation_id") && sample.includes("OperationSchedule")) ||
		(sample.includes("operation_id") && sample.includes("progress_refs")) ||
		(sample.includes("operation_id") && sample.includes("control_ref")) ||
		/^[A-Z_]+: Original governed outcome/.test(text.trim())
	);
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private contentTextRegion: MouseRegion;
	private selfRenderContainer: Container;
	private selfRenderHeight = 0;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<
		number,
		{ sourceData: string; sourceMimeType: string; data: string; mimeType: string }
	> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentTextRegion = this.createResultRegion(this.contentText);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentTextRegion);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(
			this.toolName === "sandhana_operation"
				? this.formatOperationCall()
				: KNOWLEDGE_TITLES.has(this.toolName) && !this.expanded
					? theme.fg("toolTitle", theme.bold(KNOWLEDGE_TITLES.get(this.toolName)!))
					: formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded),
			0,
			0,
		);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			const sourceData = img.data;
			const sourceMimeType = img.mimeType;
			if (sourceMimeType === "image/png") continue;
			const cached = this.convertedImages.get(i);
			if (cached?.sourceData === sourceData && cached.sourceMimeType === sourceMimeType) continue;

			const index = i;
			convertToPng(sourceData, sourceMimeType).then((converted) => {
				const currentImage = this.result?.content.filter((content) => content.type === "image")[index];
				if (!converted || currentImage?.data !== sourceData || currentImage.mimeType !== sourceMimeType) return;
				this.convertedImages.set(index, {
					sourceData,
					sourceMimeType,
					...converted,
				});
				this.updateDisplay();
				this.ui.requestRender();
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			this.selfRenderHeight = contentLines.length;
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") return super.handleMouse(event);
		if (event.y <= 0 || event.y > this.selfRenderHeight) return undefined;
		return this.selfRenderContainer.handleMouse({
			...event,
			y: event.y - 1,
			height: this.selfRenderHeight,
		});
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.createResultRegion(component));
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(this.createResultRegion(component));
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const cached = this.convertedImages.get(i);
					const converted =
						cached?.sourceData === img.data && cached.sourceMimeType === img.mimeType ? cached : undefined;
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		const output = getRenderedTextOutput(this.result, this.showImages);
		if (KNOWLEDGE_TITLES.has(this.toolName) && !this.expanded && output) {
			try {
				const value: unknown = JSON.parse(output);
				if (value && typeof value === "object" && "snippets" in value && Array.isArray(value.snippets)) {
					const excerpts = value.snippets.flatMap((snippet: unknown) =>
						snippet && typeof snippet === "object" && "text" in snippet && typeof snippet.text === "string"
							? [snippet.text]
							: [],
					);
					if (excerpts.length) return excerpts.join("\n");
				}
				return this.result?.isError ? "Could not retrieve the requested result." : "Result saved in task history.";
			} catch {
				return output;
			}
		}
		if (this.toolName !== "sandhana_operation" || !output) return output;
		try {
			const value: unknown = JSON.parse(output);
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const fields = value as Record<string, unknown>;
				if (this.args?.action === "output" && typeof fields.text === "string") {
					return `${fields.omitted_before ? "[Earlier output omitted]\n" : ""}${fields.text}${fields.omitted_after ? "\n[Later output omitted]" : ""}`;
				}
				const schedule = fields.schedule ?? fields;
				if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
					const status = schedule as Record<string, unknown>;
					if (typeof status.status === "string" && typeof status.reason === "string") {
						const text = userFacingOperationStatus(status.status);
						if (text)
							return this.expanded ? [text, userFacingReason(status.reason)].filter(Boolean).join("\n") : text;
					}
				}
			}
			return "Operation details retained in execution history";
		} catch {
			return isControlEnvelope(output) ? "" : output;
		}
	}

	private formatOperationCall(): string {
		const args = this.args as Record<string, unknown> | null;
		const action = args?.action;
		let title = "Operation";
		if (action === "submit" && typeof args?.tool === "string") {
			const inner = args.arguments;
			const target = inner && typeof inner === "object" ? (inner as Record<string, unknown>) : {};
			const command =
				typeof target.command === "string" ? target.command : typeof target.path === "string" ? target.path : "";
			title = command ? `Run ${args.tool} ${command}` : `Run ${args.tool}`;
		} else if (action === "inspect") title = "Operation status";
		else if (action === "cancel") title = "Cancel operation";
		else if (action === "output") title = "Read operation output";
		else if (action === "reconcile") title = "Reconcile operation";
		return theme.fg("toolTitle", theme.bold(title));
	}

	private formatToolExecution(): string {
		if (this.toolName === "sandhana_operation") {
			let text = this.formatOperationCall();
			// Control-plane envelopes (schedule/operation IDs, DIRGHAKRIYA versions,
			// progress refs) are for the model/kernel, never user chat text.
			const output = this.getTextOutput();
			if (output && !isControlEnvelope(output)) {
				const preview = output.length > 500 ? `${output.slice(0, 497)}...` : output;
				text += `\n${preview}`;
			}
			return text;
		}
		if (KNOWLEDGE_TITLES.has(this.toolName)) {
			let text = theme.fg("toolTitle", theme.bold(KNOWLEDGE_TITLES.get(this.toolName)!));
			if (this.expanded) text += `\n${JSON.stringify(this.args, null, 2)}`;
			const output = this.getTextOutput();
			if (output) {
				const preview = !this.expanded && output.length > 500 ? `${output.slice(0, 497)}...` : output;
				text += `\n${preview}`;
			}
			return text;
		}
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
