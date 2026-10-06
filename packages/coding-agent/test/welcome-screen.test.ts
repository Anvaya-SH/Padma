import {
	CombinedAutocompleteProvider,
	Container,
	isViewportTUI,
	Spacer,
	setKeybindings,
	Text,
	type TuiMode,
	VStack,
	visibleWidth,
} from "@anvaya.sh/padma-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { PADMA_WORDMARK } from "../src/cli/brand.ts";
import type { LaunchTimeline } from "../src/cli/launch-animation.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { padmaLogo3d, padmaLogoLines } from "../src/modes/interactive/components/padma-logo.ts";
import { IdleStatus } from "../src/modes/interactive/components/status-indicator.ts";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { WelcomeQuickActions } from "../src/modes/interactive/components/welcome-quick-actions.ts";
import {
	CenteredWelcomeHeading,
	WelcomeChatLayout,
	WelcomeScreen,
} from "../src/modes/interactive/components/welcome-screen.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";

function createWelcomeTui(
	mode: TuiMode,
	width = 80,
	height = 24,
	options?: {
		tagline?: string;
		footer?: string;
		tipIndex?: number;
		rotateTips?: boolean;
		launch?: LaunchTimeline;
		activity?: string;
	},
) {
	initTheme("padma");
	setKeybindings(new KeybindingsManager());
	const terminal = new VirtualTerminal(width, height);
	const ui = createInteractiveTui({
		tuiMode: mode,
		showHardwareCursor: true,
		terminal,
		logDirectory: "",
		animateTheme: false,
	});
	const editor = new CustomEditor(
		ui,
		{
			borderColor: (text) => text,
			selectList: {
				selectedPrefix: (text) => text,
				selectedText: (text) => text,
				description: (text) => text,
				scrollInfo: (text) => text,
				noMatch: (text) => text,
			},
		},
		new KeybindingsManager(),
		{ paddingX: 1 },
	);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const document = new Container();
	document.addChild(new Text("Conversation", 0, 0));
	const footer = new Text(options?.footer ?? "Pratimāna [model]", 0, 0);
	const conversation = new Container();
	conversation.children = [document, editorContainer, footer];
	let showWelcome = true;
	const below = new Container();
	below.addChild(
		new WelcomeQuickActions((prompt) => editor.setText(prompt), {
			tipIndex: options?.tipIndex ?? 0,
			rotate: options?.rotateTips ?? false,
		}),
	);
	below.addChild(new IdleStatus());
	below.addChild(new CenteredWelcomeHeading(footer));
	const welcome = new WelcomeScreen({
		heading: new CenteredWelcomeHeading(
			new ThemedText(
				() =>
					`${padmaLogoLines().join("\n")}\nv1.0.0\n\n\x1b[1m${options?.tagline ?? "The praśna [prompt] is yours."}\x1b[22m`,
				0,
				0,
			),
			undefined,
			() => PADMA_WORDMARK.length,
		),
		editor: editorContainer,
		above: options?.activity ? new Text(options.activity, 0, 0) : new Spacer(1),
		below,
		getHeight: () => terminal.rows,
		launch: options?.launch ?? false,
	});
	ui.addChild(new WelcomeChatLayout(welcome, conversation, () => showWelcome));
	if (isViewportTUI(ui)) {
		const viewport = createChatViewport({
			document,
			editor: editorContainer,
			footer,
			pendingMessages: new Container(),
			status: new Container(),
		});
		ui.setLayoutRoot(
			new VStack([
				{ component: welcome, basis: 0, grow: 1, visible: () => showWelcome },
				{ component: viewport.root, basis: 0, grow: 1, visible: () => !showWelcome },
			]),
		);
	}
	editor.onSubmit = (text) => {
		if (!text.trim()) return;
		showWelcome = false;
		document.addChild(new Text(text, 0, 0));
		ui.requestRender(true);
	};
	ui.setFocus(editor);
	return { terminal, ui, editor, welcome };
}

describe.each<TuiMode>(["regular", "fullscreen"])("centered welcome (%s)", (mode) => {
	afterEach(() => padmaLogo3d.stop());
	it("keeps all activity above the centered prompt and preserves its label and draft", async () => {
		const { terminal, ui, editor } = createWelcomeTui(mode, 120, 40, {
			activity: "Kriyā [working]\nDelegating to reviewer",
		});
		editor.setText("keep this draft");
		ui.start();
		try {
			await terminal.waitForRender();
			const lines = terminal.getViewport();
			const input = lines.findIndex((line) => line.includes("Praśna [prompt]"));
			expect(lines.findIndex((line) => line.includes("Kriyā [working]"))).toBeLessThan(input - 1);
			expect(lines.findIndex((line) => line.includes("Delegating to reviewer"))).toBe(input - 2);
			expect(lines[input]).toContain("Praśna [prompt]  keep this draft");
			expect(editor.getText()).toBe("keep this draft");
		} finally {
			ui.stop();
		}
	});
	it("plays fullscreen for 1.5 seconds, brief handoff, then reveals the complete TUI", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
		const startedAt = performance.now();
		const { terminal, ui, editor } = createWelcomeTui(mode, 120, 40, {
			launch: { startedAt, fullscreenUntil: startedAt + 1500 },
		});
		ui.start();
		try {
			await vi.advanceTimersByTimeAsync(20);
			const initial = terminal.getViewport().join("\n");
			expect(initial).toMatch(/[\u2801-\u28ff]/);
			expect(initial).not.toContain("Ask anything");
			expect(initial).not.toContain(PADMA_WORDMARK[0].trim());
			await vi.advanceTimersByTimeAsync(1479);
			expect(terminal.getViewport().join("\n")).not.toContain(PADMA_WORDMARK[0].trim());
			await vi.advanceTimersByTimeAsync(100);
			const landing = terminal.getViewport().join("\n");
			// Pure original fullscreen animation - no ASCII overlay mid-landing.
			expect(landing).not.toContain(PADMA_WORDMARK[0].trim());
			expect(landing).toMatch(/[\u2801-\u28ff]/);
			expect(landing).not.toContain("Ask anything");
			await vi.advanceTimersByTimeAsync(320);
			const complete = terminal.getViewport();
			expect(padmaLogo3d.isActive()).toBe(true);
			expect(complete.join("\n")).toContain("Praśna [prompt]  Ask anything…");
			expect(complete.join("\n")).toContain("Tathya [fact]");
			expect(complete.join("\n")).toContain("Yukti [tip]");
			expect(complete.join("\n")).toContain("Pratimāna [model]");
			for (const [index, row] of PADMA_WORDMARK.entries()) {
				expect(complete.some((line) => line.slice(30).startsWith(row + (index === 0 ? "    v1.0.0" : "")))).toBe(
					true,
				);
			}
			terminal.sendInput("my draft");
			await vi.advanceTimersByTimeAsync(20);
			expect(editor.getText()).toBe("my draft");
		} finally {
			padmaLogo3d.stop();
			ui.stop();
			vi.useRealTimers();
		}
	});

	it("preserves typing and refreshes the landing position when resized during the intro", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
		const startedAt = performance.now();
		const { terminal, ui, editor } = createWelcomeTui(mode, 80, 24, {
			launch: { startedAt, fullscreenUntil: startedAt + 1500 },
		});
		ui.start();
		try {
			await vi.advanceTimersByTimeAsync(100);
			terminal.sendInput("early draft");
			terminal.resize(120, 40);
			await vi.advanceTimersByTimeAsync(1700);
			expect(editor.getText()).toBe("early draft");
			expect(terminal.getViewport().join("\n")).not.toContain("Praśna [prompt]");
			await vi.advanceTimersByTimeAsync(400);
			const complete = terminal.getViewport();
			expect(complete.some((line) => line.slice(30).startsWith(`${PADMA_WORDMARK[0]}    v1.0.0`))).toBe(true);
			expect(complete.join("\n")).toContain("Praśna [prompt]  early draft");
			expect(terminal.getCursorPosition().x).toBe(24 + 20 + "early draft".length);
		} finally {
			padmaLogo3d.stop();
			ui.stop();
			vi.useRealTimers();
		}
	});

	it("releases the intro timer when the terminal stops before landing", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
		const startedAt = performance.now();
		const { ui } = createWelcomeTui(mode, 80, 24, {
			launch: { startedAt, fullscreenUntil: startedAt + 1500 },
		});
		ui.start();
		try {
			await vi.advanceTimersByTimeAsync(20);
			ui.stop();
			await vi.advanceTimersByTimeAsync(1100);
			expect(vi.getTimerCount()).toBe(0);
			expect(padmaLogo3d.isActive()).toBe(false);
		} finally {
			ui.stop();
			vi.useRealTimers();
		}
	});

	it.each([
		[120, 40],
		[160, 50],
	])("adds quiet scattered decoration at %s × %s while keeping the draft and cursor intact", async (width, height) => {
		const { terminal, ui, editor } = createWelcomeTui(mode, width, height);
		const gutter = Math.floor((width - 72) / 2);
		editor.setText("keep this draft");
		ui.start();
		try {
			await terminal.waitForRender();
			const initial = terminal.getViewport();
			const cursor = terminal.getCursorPosition();
			expect(initial.join("\n")).not.toContain("click to");
			expect(initial.join("\n")).not.toContain("Cakra [wheel]");
			const gutterInk = initial.reduce(
				(count, line) => count + (line.slice(0, gutter) + line.slice(width - gutter)).replace(/\s/g, "").length,
				0,
			);
			expect(gutterInk).toBeGreaterThan(0);
			expect(gutterInk / (gutter * height * 2)).toBeLessThan(0.15);
			const mouse = {
				type: "click" as const,
				button: "left" as const,
				x: 0,
				y: 0,
				screenX: 0,
				screenY: 0,
				width,
				height,
				shift: false,
				alt: false,
				ctrl: false,
			};
			const click = async (x: number, y: number) => {
				if (mode === "fullscreen") {
					terminal.sendInput(`\x1b[<0;${x + 1};${y + 1}M`);
					terminal.sendInput(`\x1b[<0;${x + 1};${y + 1}m`);
				} else ui.handleMouse?.({ ...mouse, x, y, screenX: x, screenY: y });
				await terminal.waitForRender();
			};
			await click(1, 2);
			expect(editor.getText()).toBe("keep this draft");
			expect(terminal.getCursorPosition()).toEqual(cursor);
			const factRow = terminal.getViewport().findIndex((line) => line.includes("Tathya [fact]"));
			await click(terminal.getViewport()[factRow].indexOf("Tathya [fact]"), factRow);
			expect(terminal.getViewport().join("\n")).toContain("English spellings");
			expect(editor.getText()).toBe("keep this draft");
		} finally {
			ui.stop();
		}
	});

	it("omits large decorations in narrow gutters so the prompt and details retain their space", async () => {
		const { terminal, ui } = createWelcomeTui(mode, 80, 24);
		ui.start();
		try {
			await terminal.waitForRender();
			const screen = terminal.getViewport().join("\n");
			expect(screen).not.toContain("śānti [peace]");
			expect(screen).not.toContain(" /  .-'");
			expect(screen).toContain("Tathya [fact]");
			expect(screen).toContain("Pratimāna [model]");
		} finally {
			ui.stop();
		}
	});
	it("changes the visible tip every 30 seconds while idle with animation disabled", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
		const { terminal, ui } = createWelcomeTui(mode, 80, 24, { rotateTips: true });
		ui.start();
		try {
			await vi.advanceTimersByTimeAsync(20);
			const cursor = terminal.getCursorPosition();
			expect(terminal.getViewport().join("\n")).toContain("Type /");
			await vi.advanceTimersByTimeAsync(29979);
			expect(terminal.getViewport().join("\n")).toContain("Type /");
			await vi.advanceTimersByTimeAsync(21);
			expect(terminal.getViewport().join("\n")).toContain("/dhyana [thinking]");
			expect(terminal.getCursorPosition()).toEqual(cursor);
			await vi.advanceTimersByTimeAsync(30000);
			expect(terminal.getViewport().join("\n")).toContain("Yukti [tip]  /pratimana [model]");
		} finally {
			ui.stop();
			vi.useRealTimers();
		}
	});
	it("keeps a long tagline, tip, and full context data visible in 24 rows", async () => {
		const { terminal, ui, editor } = createWelcomeTui(mode, 80, 24, {
			tagline:
				"The praśna [prompt] is yours; describe the change you need and include the relevant files or errors.",
			footer: "Padma (phase6-sukshmashastra)\n0.0%/200k [context]\nPratimāna [model] • Madhyama [medium]",
			tipIndex: 1,
		});
		ui.start();
		try {
			await terminal.waitForRender();
			const lines = terminal.getViewport();
			expect(lines.join("\n")).toContain("relevant files or errors.");
			expect(lines.join("\n")).toContain("0.0%/200k [context]");
			expect(lines.join("\n")).toContain("Pratimāna [model]");
			expect(lines.at(-1)).toBe("");
			const tipRow = lines.findIndex((line) => line.includes("Yukti [tip]"));
			const column = lines[tipRow].indexOf("/dhyana");
			ui.handleMouse?.({
				type: "click",
				button: "left",
				x: column,
				y: tipRow,
				screenX: column,
				screenY: tipRow,
				shift: false,
				alt: false,
				ctrl: false,
				width: 80,
				height: 24,
			});
			expect(editor.getText()).toBe("/dhyana");
		} finally {
			ui.stop();
		}
	});
	it.each([
		[80, 24],
		[120, 40],
	])("centers the input and branding at %s × %s", async (width, height) => {
		const { terminal, ui } = createWelcomeTui(mode, width, height);
		ui.start();
		try {
			await terminal.waitForRender();
			const lines = terminal.getViewport();
			const top = lines.findIndex((line) => line.includes("▎"));
			const left = Math.floor((width - 72) / 2);
			expect(top).toBe(height === 24 ? 13 : 20);
			expect(lines[top].indexOf("▎")).toBe(left);
			expect(lines[top + 1]).toContain("Praśna [prompt]");
			expect(lines[top + 1]).toContain("Praśna [prompt]  Ask anything…");
			expect(terminal.getCursorPosition()).toEqual({ x: left + 20, y: top + 1 });
			const logoLeft = Math.floor((width - Math.max(...PADMA_WORDMARK.map((row) => row.length))) / 2);
			for (const [index, row] of PADMA_WORDMARK.entries()) {
				expect(lines.some((line) => line.slice(logoLeft).startsWith(row + (index === 0 ? "    v1.0.0" : "")))).toBe(
					true,
				);
			}
			const tagline = lines.find((line) => line.includes("The praśna"))!;
			expect(tagline.indexOf("The praśna")).toBe(Math.floor((width - "The praśna [prompt] is yours.".length) / 2));
			const status = lines.find((line) => line.includes("Pratimāna [model]"))!;
			expect(status.indexOf("Pratimāna")).toBe(Math.floor((width - "Pratimāna [model]".length) / 2));
			const logoTop = lines.findIndex((line) => line.includes(PADMA_WORDMARK[0].trim()));
			const tipTop = lines.findIndex((line) => line.includes("Yukti [tip]"));
			const factTop = lines.findIndex((line) => line.includes("Tathya [fact]"));
			const taglineTop = lines.findIndex((line) => line.includes("The praśna"));
			const gap = height >= 36 ? 3 : 1;
			expect(logoTop).toBeGreaterThanOrEqual(height >= 32 ? 2 : 1);
			expect(taglineTop - (logoTop + 6)).toBeGreaterThanOrEqual(gap + 1);
			expect(factTop - taglineTop).toBeGreaterThanOrEqual(gap + 1);
			expect(top - factTop).toBeGreaterThanOrEqual(gap + 1);
			expect(tipTop - (top + 2)).toBeGreaterThanOrEqual(gap + 1);
			expect(lines.at(-1)).toBe("");
		} finally {
			ui.stop();
		}
	});

	it("keeps screen rows stable when the side animation updates beside a tip", async () => {
		const { terminal, ui } = createWelcomeTui(mode);
		ui.start();
		try {
			await terminal.waitForRender();
			const before = terminal.getViewport();
			const logoTop = before.findIndex((line) => line.includes(PADMA_WORDMARK[0].trim()));
			const inputTop = before.findIndex((line) => line.includes("▎"));
			padmaLogo3d.resume(ui, { time: 0, opacity: 1, scale: 1 });
			await terminal.waitForRender();
			const after = terminal.getViewport();
			expect(after.findIndex((line) => line.includes("▎"))).toBe(inputTop);
			for (let row = 0; row < PADMA_WORDMARK.length; row++)
				expect(
					after[logoTop + row].slice(10).startsWith(PADMA_WORDMARK[row] + (row === 0 ? "    v1.0.0" : "")),
				).toBe(true);
			expect(after[logoTop + 7].slice(10)).not.toBe(PADMA_WORDMARK[6]);
			expect(terminal.getCursorPosition()).toEqual({ x: 24, y: inputTop + 1 });
			expect(after.join("\n")).toContain("Yukti [tip]");
			expect(after.join("\n")).not.toContain("preṣaṇa [send]");
		} finally {
			padmaLogo3d.stop();
			ui.stop();
		}
	});

	it("keeps a draft through resize and restores conversation layout after submission", async () => {
		const { terminal, ui, editor } = createWelcomeTui(mode);
		ui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("hello Padma");
			terminal.resize(100, 30);
			await terminal.waitForRender();
			expect(editor.getText()).toBe("hello Padma");
			expect(terminal.getCursorPosition().y).toBe(17);
			terminal.sendInput("\r");
			await terminal.waitForRender();
			const lines = terminal.getViewport();
			expect(lines.some((line) => line.includes("Conversation"))).toBe(true);
			expect(lines.some((line) => line.includes("hello Padma"))).toBe(true);
			const conversationInput = lines.find((line) => line.includes("Ask anything"))!;
			expect(conversationInput.indexOf("▎")).toBe(0);
			expect(visibleWidth(editor.render(100)[0])).toBe(100);
			expect(lines.some((line) => line.includes("The praśna"))).toBe(false);
			terminal.sendInput("next prompt");
			await terminal.waitForRender();
			expect(editor.getText()).toBe("next prompt");
		} finally {
			ui.stop();
		}
	});

	it("routes a mouse click to the centered input's local coordinates", async () => {
		const { terminal, ui, editor } = createWelcomeTui(mode);
		editor.setText("abcdef");
		ui.start();
		try {
			await terminal.waitForRender();
			const cursor = terminal.getCursorPosition();
			const x = cursor.x - 4; // Character 3, after the inline prompt label.
			if (mode === "fullscreen") {
				terminal.sendInput(`\x1b[<0;${x + 1};${cursor.y + 1}M`);
				terminal.sendInput(`\x1b[<0;${x + 1};${cursor.y + 1}m`);
			} else {
				// Regular mode leaves physical mouse handling to the terminal.
				ui.handleMouse?.({
					type: "click",
					button: "left",
					x,
					y: cursor.y,
					screenX: x,
					screenY: cursor.y,
					width: 80,
					height: 24,
					shift: false,
					alt: false,
					ctrl: false,
				});
			}
			await terminal.waitForRender();
			expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
			terminal.sendInput("X");
			await terminal.waitForRender();
			expect(editor.getText()).toBe("abXcdef");
		} finally {
			ui.stop();
		}
	});

	it("keeps the input centered when command completion opens", async () => {
		const { terminal, ui, editor } = createWelcomeTui(mode);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "pratimana", description: "Pratimāna [model]" }], process.cwd()),
		);
		ui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("/");
			await terminal.waitForRender();
			expect(editor.isShowingAutocomplete()).toBe(true);
			const lines = terminal.getViewport();
			expect(lines.findIndex((line) => line.includes("▎"))).toBe(13);
			expect(lines.some((line) => line.includes("pratimana"))).toBe(true);
			expect(terminal.getCursorPosition().y).toBe(14);
		} finally {
			ui.stop();
		}
	});

	it("keeps the active cursor visible in a narrow, short terminal", async () => {
		const { terminal, ui, editor } = createWelcomeTui(mode, 20, 4);
		editor.setText("one\ntwo\nthree\nfour\nfive\nsix");
		ui.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getViewport().some((line) => line.includes("six"))).toBe(true);
			expect(terminal.getCursorPosition().y).toBeLessThan(4);
			expect(editor.getText()).toBe("one\ntwo\nthree\nfour\nfive\nsix");
		} finally {
			ui.stop();
		}
	});
});

describe("welcome branding in a constrained viewport", () => {
	it("keeps every wordmark row when the version and tagline exceed the available height", () => {
		const heading = new CenteredWelcomeHeading(
			new Text(`${PADMA_WORDMARK.join("\n")}\nv1.0.0\n\n${"Long tagline ".repeat(10)}`, 0, 0),
			undefined,
			() => PADMA_WORDMARK.length,
		);
		const lines = heading.render(80, 9);
		expect(lines).toHaveLength(9);
		for (const [index, row] of PADMA_WORDMARK.entries()) {
			expect(lines.some((line) => line.trim() === row.trim() + (index === 0 ? "    v1.0.0" : ""))).toBe(true);
		}
		expect(lines.join("\n")).toContain("Long tagline");
		expect(lines[0]).toContain(`${PADMA_WORDMARK[0]}    v1.0.0`);
		expect(lines.join("\n").match(/v1\.0\.0/g)).toHaveLength(1);
	});

	it("hides the wordmark as a whole when a long draft leaves insufficient space", () => {
		const heading = new CenteredWelcomeHeading(
			new Text(PADMA_WORDMARK.join("\n"), 0, 0),
			undefined,
			() => PADMA_WORDMARK.length,
		);
		expect(heading.render(80, 3)).toEqual([]);
	});
});
