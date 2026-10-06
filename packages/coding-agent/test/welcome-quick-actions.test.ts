import { setKeybindings, stripTerminalSequences, visibleWidth } from "@anvaya.sh/padma-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { normalizeBuiltinCommand } from "../src/core/slash-commands.ts";
import { WELCOME_TIPS, WelcomeQuickActions } from "../src/modes/interactive/components/welcome-quick-actions.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => {
	initTheme("padma");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	vi.restoreAllMocks();
	setKeybindings(new KeybindingsManager());
});

describe("welcome tips", () => {
	it.each([20, 40, 72])("shows one centered tip with bounded wrapping at %s columns", (width) => {
		const lines = new WelcomeQuickActions(() => {}, { tipIndex: 0, rotate: false })
			.render(width)
			.map(stripTerminalSequences);
		expect(lines.join("\n")).toContain("Yukti [tip]");
		expect(lines.join("\n")).not.toContain("Vyākhyā [explain]");
		expect(lines.join("\n")).not.toContain("preṣaṇa [send]");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		for (const line of lines.filter((line) => line.trim().length > 0)) {
			expect(line.indexOf(line.trimStart())).toBe(Math.floor((width - visibleWidth(line.trim())) / 2));
		}
	});

	it("rotates tips at 30-second boundaries and cycles through the list", () => {
		const time = vi.spyOn(performance, "now").mockReturnValue(1000);
		const tips = new WelcomeQuickActions(() => {}, { tipIndex: 0 });
		expect(tips.render(100).map(stripTerminalSequences).join("\n")).toContain("Type /");
		time.mockReturnValue(30999);
		expect(tips.render(100).map(stripTerminalSequences).join("\n")).toContain("Type /");
		time.mockReturnValue(31000);
		expect(tips.render(100).map(stripTerminalSequences).join("\n")).toContain("/dhyana [thinking]");
		time.mockReturnValue(61000);
		expect(tips.render(100).map(stripTerminalSequences).join("\n")).not.toContain("/dhyana [thinking]");
		time.mockReturnValue(1000 + WELCOME_TIPS.length * 30000);
		expect(tips.render(100).map(stripTerminalSequences).join("\n")).toContain("Type /");
	});

	it("populates the command from a clicked tip", () => {
		let selected = "";
		const tips = new WelcomeQuickActions(
			(prompt) => {
				selected = prompt;
			},
			{ tipIndex: 1, rotate: false },
		);
		const line = stripTerminalSequences(tips.render(100)[0]);
		const column = line.indexOf("/dhyana");
		const result = tips.handleMouse({
			type: "click",
			button: "left",
			x: column,
			y: 0,
			screenX: column,
			screenY: 0,
			shift: false,
			alt: false,
			ctrl: false,
			width: 100,
			height: 3,
		});
		expect(result?.handled).toBe(true);
		expect(selected).toBe("/dhyana");
	});

	it("contains Sanskrit facts and working command aliases", () => {
		const index = WELCOME_TIPS.findIndex(
			(tip) => tip.kind === "fact" && typeof tip.text === "string" && tip.text.includes("meditation"),
		);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(
			new WelcomeQuickActions(() => {}, { tipIndex: index, rotate: false })
				.render(100)
				.map(stripTerminalSequences)
				.join("\n"),
		).toContain("Tathya [fact]");
		for (const tip of WELCOME_TIPS) {
			if (tip.prompt?.startsWith("/")) expect(normalizeBuiltinCommand(tip.prompt)).not.toBe(tip.prompt);
		}
		expect(normalizeBuiltinCommand("/Dhyāna")).toBe(normalizeBuiltinCommand("/dhyana"));
	});

	it("uses configured keyboard shortcuts in tips", () => {
		setKeybindings(new KeybindingsManager({ "tui.input.newLine": "ctrl+enter", "app.interrupt": "ctrl+g" }));
		const text = WELCOME_TIPS.filter((tip) => typeof tip.text === "function")
			.map((tip) => (typeof tip.text === "function" ? tip.text() : tip.text))
			.join("\n");
		expect(text).toContain("ctrl+enter");
		expect(text).toContain("ctrl+g");
	});
});
