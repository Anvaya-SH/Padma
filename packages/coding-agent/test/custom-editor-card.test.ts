import { fileURLToPath } from "node:url";
import { stripTerminalSequences, TuiMainScreen, visibleWidth } from "@anvaya.sh/padma-tui";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import {
	getEditorTheme,
	initTheme,
	loadThemeFromPath,
	setThemeInstance,
} from "../src/modes/interactive/theme/theme.ts";

function createEditor() {
	const ui = new TuiMainScreen(new VirtualTerminal(80, 10));
	const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager(), {
		paddingX: 1,
		embedWorkingStatus: true,
	});
	return { ui, editor };
}

beforeEach(() => {
	setThemeInstance(
		loadThemeFromPath(
			fileURLToPath(new URL("../src/modes/interactive/theme/padma.json", import.meta.url)),
			"truecolor",
		),
	);
});
afterEach(() => initTheme("padma"));

describe("Padma input card", () => {
	it.each(["", "hello"])(
		"fills the card through the cursor reset for %j and leaves the surrounding terminal unchanged",
		async (text) => {
			const { editor } = createEditor();
			editor.setText(text);
			const lines = editor.render(80);
			const terminal = new xterm.Terminal({ cols: 82, rows: 6, allowProposedApi: true });
			try {
				await new Promise<void>((resolve) => terminal.write(`${lines.join("\r\n")}\r\nOutside`, resolve));
				for (let row = 0; row < 3; row++) {
					const line = terminal.buffer.active.getLine(row)!;
					for (let column = 0; column < 80; column++) {
						expect(line.getCell(column)!.isBgRGB()).toBe(true);
						expect(line.getCell(column)!.getBgColor()).toBe(0x4a342a);
					}
					expect(line.getCell(80)!.isBgDefault()).toBe(true);
				}
				expect(terminal.buffer.active.getLine(1)!.getCell(21)!.getFgColor()).toBe(text ? 0xf5f1ea : 0xd7c9b8);
				expect(terminal.buffer.active.getLine(3)!.getCell(0)!.isBgDefault()).toBe(true);
				expect(lines.map(stripTerminalSequences).join("\n")).not.toMatch(/[╭╮╰╯─]/);
				expect(editor.getRenderedEditorHeight()).toBe(3);
			} finally {
				terminal.dispose();
			}
		},
	);

	it("preserves scroll indicators and working status within the card", () => {
		const { ui, editor } = createEditor();
		const indicator = new WorkingStatusIndicator(ui, "Kārya [working]");
		editor.setWorkingStatusIndicator(indicator);
		editor.setText(Array.from({ length: 15 }, (_, index) => `Line ${index + 1}`).join("\n"));
		try {
			let lines = editor.render(40).map(stripTerminalSequences);
			expect(lines[0]).toContain("Kārya [working]");
			expect(lines[0]).toContain("↑ 10");
			for (let index = 0; index < 20; index++) editor.handleInput("\x1b[A");
			lines = editor.render(40).map(stripTerminalSequences);
			expect(lines.at(-1)).toContain("↓ 10");
			for (const width of [1, 2, 3, 4, 10, 20, 40, 80]) {
				expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		} finally {
			indicator.dispose();
		}
	});

	it.each([20, 40, 72])("places the prompt label beside the input at %s columns", (width) => {
		const { editor } = createEditor();
		const empty = editor.render(width).map(stripTerminalSequences);
		const inputColumn = width >= 40 ? 20 : 11;
		expect(empty[1].indexOf("Praśna")).toBe(3);
		expect(empty[1].indexOf(width >= 40 ? "Ask anything…" : "Ask…")).toBe(inputColumn);
		expect(empty[0].trim()).toBe("▎");
		expect(empty[2].trim()).toBe("▎");
		editor.setText("hello");
		expect(stripTerminalSequences(editor.render(width)[1]).indexOf("hello")).toBe(inputColumn);
	});

	it("wraps long drafts within the input column without repeating the label", () => {
		const { editor } = createEditor();
		const draft = "x".repeat(70);
		editor.setText(draft);
		const lines = editor.render(72).map(stripTerminalSequences);
		expect(lines).toHaveLength(4);
		expect(lines[1].indexOf("Praśna [prompt]")).toBe(3);
		expect(lines[1].indexOf("x")).toBe(20);
		expect(lines[2].indexOf("x")).toBe(20);
		expect(lines[2]).not.toContain("Praśna");
		expect(lines.every((line) => visibleWidth(line) === 72)).toBe(true);
		expect(editor.getText()).toBe(draft);
	});
});
