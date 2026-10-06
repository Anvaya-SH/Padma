import { Container, stripTerminalSequences, TuiMainScreen } from "@anvaya.sh/padma-tui";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

interface ActivityFixture {
	defaultEditor: CustomEditor;
	editor: CustomEditor;
	statusContainer: Container;
	activeStatusIndicator?: StatusIndicator;
	activeWorkingIndicatorEmbedded: boolean;
	showStatusIndicator(indicator: StatusIndicator): void;
	extensionStatuses: Map<string, string>;
	extensionWidgetsAbove: Map<string, Container>;
	extensionWidgetsBelow: Map<string, Container>;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	ui: TuiMainScreen;
	footerDataProvider: { setExtensionStatus(key: string, text: string | undefined): void };
	setExtensionStatus(key: string, text: string | undefined): void;
}

it("places working, delegation, retries, compaction, and summaries above the prompt", () => {
	initTheme("padma");
	const ui = new TuiMainScreen(new VirtualTerminal(120, 40));
	const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
	editor.setText("my draft");
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as ActivityFixture, {
		defaultEditor: editor,
		editor,
		ui,
		statusContainer: new Container(),
		activeWorkingIndicatorEmbedded: false,
		footerDataProvider: { setExtensionStatus: () => {} },
		extensionStatuses: new Map<string, string>(),
		extensionWidgetsAbove: new Map<string, Container>(),
		extensionWidgetsBelow: new Map<string, Container>(),
		widgetContainerAbove: new Container(),
		widgetContainerBelow: new Container(),
	});
	const indicators = [
		new WorkingStatusIndicator(ui, "Kriyā [working]"),
		new WorkingStatusIndicator(ui, "Delegating to reviewer"),
		new RetryStatusIndicator(ui, 1, 3, 1000),
		new CompactionStatusIndicator(ui, "manual"),
		new BranchSummaryStatusIndicator(ui),
	];
	try {
		for (const indicator of indicators) {
			mode.showStatusIndicator(indicator);
			expect(mode.statusContainer.children).toEqual([indicator]);
			expect(mode.activeWorkingIndicatorEmbedded).toBe(false);
			const card = editor.render(80).map(stripTerminalSequences);
			expect(card[0].trim()).toBe("▎");
			expect(card[1]).toContain("Praśna [prompt]  my draft");
		}
		mode.setExtensionStatus("subagents", "Reviewer is working");
		expect(mode.widgetContainerAbove.render(80).map(stripTerminalSequences).join("\n")).toContain(
			"Reviewer is working",
		);
		expect(editor.render(80).map(stripTerminalSequences).join("\n")).not.toContain("Reviewer is working");
		mode.setExtensionStatus("subagents", undefined);
		expect(mode.widgetContainerAbove.render(80).map(stripTerminalSequences).join("\n")).not.toContain(
			"Reviewer is working",
		);
	} finally {
		for (const indicator of indicators) indicator.dispose();
	}
});
