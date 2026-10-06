import * as fs from "node:fs";
import * as workerThreads from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { clearStartupScreen, getStartupLaunch, showStartupScreen } from "../src/cli/startup-screen.ts";

vi.mock("node:fs", { spy: true });
vi.mock("node:worker_threads", { spy: true });

afterEach(() => {
	clearStartupScreen();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("launcher first paint", () => {
	it("paints the fullscreen logo before runtime startup and hands off its clock without a jump", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const properties = [
			{ target: process.stdin, key: "isTTY", value: true },
			{ target: process.stdout, key: "isTTY", value: true },
			{ target: process.stdout, key: "columns", value: 80 },
			{ target: process.stdout, key: "rows", value: 24 },
		].map((property) => ({ ...property, original: Object.getOwnPropertyDescriptor(property.target, property.key) }));
		const terminal = new VirtualTerminal(80, 24);
		const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		vi.spyOn(fs, "readFileSync").mockReturnValue('{"quietStartup":false}');
		vi.spyOn(workerThreads, "Worker").mockImplementation(() => {
			throw new Error("Exercise the fallback renderer");
		});
		vi.stubEnv("PADMA_NO_STARTUP_SCREEN", "0");
		for (const property of properties)
			Object.defineProperty(property.target, property.key, { value: property.value, configurable: true });
		vi.spyOn(process.stdout, "write").mockImplementation((data) => {
			terminal.write(data.toString());
			return true;
		});
		try {
			terminal.write("padma\r\n");
			showStartupScreen([]);
			await vi.advanceTimersByTimeAsync(20);
			const screen = terminal.getViewport().join("\n");
			expect(screen).toMatch(/[\u2801-\u28ff]/);
			expect(screen).not.toContain("Ask anything");
			expect(terminal.getScrollBuffer().join("\n")).toContain("padma");
			expect(getStartupLaunch()).toEqual({ startedAt: 1000, fullscreenUntil: 2500 });
			clock.mockReturnValue(3000);
			clearStartupScreen();
			await vi.advanceTimersByTimeAsync(20);
			expect(getStartupLaunch()).toEqual({ startedAt: 1000, fullscreenUntil: 3000 });
			expect(terminal.getViewport().every((line) => line === "")).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			clearStartupScreen();
			for (const property of properties) {
				if (property.original) Object.defineProperty(property.target, property.key, property.original);
				else Reflect.deleteProperty(property.target, property.key);
			}
		}
	});
});
