import { Container, Spacer, stripTerminalSequences, Text, visibleWidth } from "@anvaya.sh/padma-tui";
import { afterEach, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { PADMA_WORDMARK } from "../src/cli/brand.ts";
import { BuiltInHeader } from "../src/modes/interactive/components/built-in-header.ts";
import { PADMA_LOGO_WIDTH, padmaLogo3d, padmaLogoLines } from "../src/modes/interactive/components/padma-logo.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";

const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
afterEach(() => {
	padmaLogo3d.stop();
	if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
	else Reflect.deleteProperty(process.stdout, "columns");
	if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
	else Reflect.deleteProperty(process.stdout, "rows");
});

it.each([80, 120, 160])(
	"centers branding, shortcuts and facts at %s columns while keeping expanded help left",
	(width) => {
		initTheme("padma");
		Object.defineProperty(process.stdout, "columns", { value: width, configurable: true });
		const hints = [
			"/ ājñā [commands] · ctrl+l pratimāna [model] · escape virāma [stop]",
			"ctrl+o vistāra [help and resources] · ctrl+d prasthāna [exit]",
		];
		const branding = () => {
			const logo = padmaLogoLines();
			logo[0] += "    v1.0.0";
			return logo.join("\n");
		};
		const header = new BuiltInHeader(
			() => `${branding()}\n\n${hints.join("\n")}\n\nTagline`,
			() => `${branding()}\n\nExpanded help\n\nTagline`,
		);
		const logoLeft = Math.floor((width - PADMA_LOGO_WIDTH) / 2);
		const check = () => {
			const lines = header.render(width).map(stripTerminalSequences);
			for (const [row, ascii] of PADMA_WORDMARK.entries())
				expect(lines[row].slice(logoLeft).startsWith(ascii)).toBe(true);
			for (const hint of hints) {
				const line = lines.find((line) => line.includes(hint))!;
				expect(line.indexOf(hint)).toBe(Math.floor((width - hint.length) / 2));
			}
			const factRow = lines.findIndex((line) => line.includes("Tathya [fact]"));
			expect(factRow).toBeGreaterThan(0);
			for (const line of lines.slice(factRow).filter((line) => line.trim()))
				expect(line.indexOf(line.trim())).toBe(Math.floor((width - visibleWidth(line.trim())) / 2));
			expect(lines.find((line) => line.includes("Tagline"))!.indexOf("Tagline")).toBe(
				Math.floor((width - "Tagline".length) / 2),
			);
		};
		check();
		const ui = createInteractiveTui({
			tuiMode: "regular",
			terminal: new VirtualTerminal(width, 40),
			showHardwareCursor: true,
			logDirectory: "",
			animateTheme: false,
		});
		padmaLogo3d.resume(ui, { time: 0, opacity: 1, scale: 1 });
		check();
		let origin: number | undefined;
		header.onLogoClick = (column) => {
			origin = column;
		};
		header.handleMouse({
			type: "click",
			button: "left",
			x: logoLeft + 2,
			y: 0,
			screenX: logoLeft + 2,
			screenY: 5,
			width,
			height: 40,
			shift: false,
			alt: false,
			ctrl: false,
		});
		const sideWidth = padmaLogo3d.getSideWidth(width);
		const sideLeft = logoLeft - sideWidth - 2;
		expect(origin).toBe(sideLeft);
		expect(padmaLogo3d.getOrigin()).toEqual({ column: sideLeft, row: 5, width: sideWidth, height: 7 });
		header.setExpanded(true);
		expect(
			header
				.render(width)
				.map(stripTerminalSequences)
				.find((line) => line.includes("Expanded help"))!
				.indexOf("Expanded help"),
		).toBe(1);
	},
);

it.each([
	[24, 2],
	[40, 3],
	[50, 4],
])("adds %s-row terminal margins between branding, commands, facts and the first message", (height, gap) => {
	initTheme("padma");
	Object.defineProperty(process.stdout, "rows", { value: height, configurable: true });
	const content = `${PADMA_WORDMARK.join("\n")}\n\n\n/ ājñā [commands]\nctrl+o vistāra [help]\n\n\nTagline`;
	const header = new BuiltInHeader(
		() => content,
		() => content,
	);
	const layout = new Container();
	layout.addChild(new Spacer(2));
	layout.addChild(header);
	layout.addChild(new Spacer(2));
	layout.addChild(new Text("Sent message", 1, 0));
	let lines = layout.render(120).map(stripTerminalSequences);
	const commandRow = lines.findIndex((line) => line.includes("/ ājñā"));
	const helpRow = lines.findIndex((line) => line.includes("ctrl+o"));
	const taglineRow = lines.findIndex((line) => line.includes("Tagline"));
	const factRow = lines.findIndex((line) => line.includes("Tathya [fact]"));
	const messageRow = lines.findIndex((line) => line.includes("Sent message"));
	expect(commandRow - (2 + PADMA_WORDMARK.length)).toBe(gap);
	expect(helpRow - commandRow).toBe(1);
	expect(taglineRow - helpRow - 1).toBe(gap);
	expect(messageRow - factRow - 1).toBe(gap);
	expect(lines[messageRow].indexOf("Sent message")).toBe(1);
	const originalFact = lines[factRow];
	expect(
		header.handleMouse({
			type: "click",
			button: "left",
			x: 60,
			y: factRow - 2,
			screenX: 60,
			screenY: factRow,
			width: 120,
			height,
			shift: false,
			alt: false,
			ctrl: false,
		})?.render,
	).toBe(true);
	lines = layout.render(120).map(stripTerminalSequences);
	expect(lines[factRow]).not.toBe(originalFact);
	expect(lines[factRow].indexOf(lines[factRow].trim())).toBe(
		Math.floor((120 - visibleWidth(lines[factRow].trim())) / 2),
	);
});
