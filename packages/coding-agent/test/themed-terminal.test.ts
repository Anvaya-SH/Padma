import type { Terminal } from "@anvaya.sh/padma-tui";
import { describe, expect, it, vi } from "vitest";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createThemedTerminal } from "../src/modes/interactive/themed-terminal.ts";

describe("Padma terminal canvas", () => {
	it("preserves nested message colors and terminal control sequences", () => {
		initTheme("padma");
		const write = vi.fn();
		const original = { write, columns: 80 } as unknown as Terminal;
		const terminal = createThemedTerminal(original);
		const link = "\x1b]8;;https://example.com\x07text\x1b]8;;\x07";
		terminal.write(`\x1b[?2026h${theme.bg("selectedBg", "selected")} ${link}\x1b[K\x1b[?2026l`);
		const output = write.mock.calls[0][0] as string;
		expect(output).toContain(link);
		expect(output).toContain("\x1b[?2026h");
		expect(output).toContain(theme.getBgAnsi("selectedBg"));
		expect(output).toContain(theme.getFgAnsi("text"));
		expect(terminal.columns).toBe(80);
	});

	it("restores text after resets and leaves the terminal background untouched", () => {
		initTheme("padma");
		const write = vi.fn();
		const terminal = createThemedTerminal({ write } as unknown as Terminal);
		const foreground = theme.getFgAnsi("text");
		terminal.write("\x1b[38;2;0;39;49mcolor\x1b[0m\x1b[K\r\nnext\x1b[49m\x1b[K");
		const output = write.mock.calls[0][0] as string;
		expect(output).toContain("\x1b[38;2;0;39;49mcolor");
		expect(output).toContain(`\x1b[0m${foreground}\x1b[K`);
		expect(output).toContain("\x1b[49m\x1b[K");
		expect(output).not.toContain("\x1b[48;");
	});

	it("keeps explicit alternative themes available", () => {
		initTheme("light");
		const write = vi.fn();
		const terminal = createThemedTerminal({ write } as unknown as Terminal);
		terminal.write("message\x1b[K");
		expect(write).toHaveBeenCalledWith("message\x1b[K");
	});

	it("stops animation ticks when the terminal stops", () => {
		vi.useFakeTimers();
		try {
			initTheme("padma");
			const start = vi.fn();
			const stop = vi.fn();
			const frame = vi.fn();
			const terminal = createThemedTerminal({ start, stop } as unknown as Terminal, frame);
			terminal.start(
				() => {},
				() => {},
			);
			vi.advanceTimersByTime(150);
			expect(frame).toHaveBeenCalledTimes(3);
			terminal.stop();
			vi.advanceTimersByTime(150);
			expect(frame).toHaveBeenCalledTimes(3);
			expect(stop).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("refreshes every 30 seconds without animation and stops on terminal shutdown", () => {
		vi.useFakeTimers();
		try {
			initTheme("light");
			const start = vi.fn();
			const stop = vi.fn();
			const refresh = vi.fn();
			const terminal = createThemedTerminal({ start, stop } as unknown as Terminal, undefined, refresh);
			terminal.start(
				() => {},
				() => {},
			);
			terminal.start(
				() => {},
				() => {},
			);
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(29999);
			expect(refresh).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(refresh).toHaveBeenCalledOnce();
			vi.advanceTimersByTime(30000);
			expect(refresh).toHaveBeenCalledTimes(2);
			terminal.stop();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(30000);
			expect(refresh).toHaveBeenCalledTimes(2);
			expect(stop).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
