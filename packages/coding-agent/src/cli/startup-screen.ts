import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { PADMA_TAGLINES } from "../modes/interactive/components/taglines.ts";
import { LAUNCH_FULLSCREEN_MS, type LaunchTimeline } from "./launch-animation.ts";

let drawnLines = 0;
let launch: LaunchTimeline | undefined;
let animation: ReturnType<typeof setInterval> | undefined;
let animationWorker: Worker | undefined;
let animationState: Int32Array | undefined;
let resizeAnimation: (() => void) | undefined;
const taglineIndex = Math.floor(Math.random() * PADMA_TAGLINES.length);
let didEnsureUtf8Console = false;
/** Braille/box UI needs UTF-8; legacy PowerShell/conhost often starts on CP437, which shows as Γóá mojibake. */
export function ensureWindowsUtf8Console(): void {
	if (didEnsureUtf8Console || process.platform !== "win32") return;
	didEnsureUtf8Console = true;
	try {
		execFileSync("chcp", ["65001"], { stdio: "ignore" });
	} catch {
		// Display still works when this fails; the TUI falls back to its normal rendering.
	}
}

export function getStartupTaglineIndex(): number {
	return taglineIndex;
}

export function getStartupLaunch(): LaunchTimeline | undefined {
	return launch;
}

export function shouldShowStartupScreen(args: readonly string[], stdinIsTTY: boolean, stdoutIsTTY: boolean): boolean {
	return stdinIsTTY && stdoutIsTTY && args.every((arg) => ["--offline", "--no-session", "--verbose"].includes(arg));
}

/** First paint before the runtime import. Stdin remains untouched so the terminal can buffer typing. */
export function showStartupScreen(args: readonly string[]): void {
	if (!shouldShowStartupScreen(args, !!process.stdin.isTTY, !!process.stdout.isTTY)) return;
	if (process.env.PADMA_NO_STARTUP_SCREEN === "1") return;
	// Read only presentation preferences; do not load settings, providers, or extensions here.
	for (const file of [
		join(process.env.PADMA_CODING_AGENT_DIR || join(homedir(), ".padma", "agent"), "settings.json"),
		join(process.cwd(), ".padma", "settings.json"),
	]) {
		try {
			const settings: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
			if (
				typeof settings === "object" &&
				settings !== null &&
				"quietStartup" in settings &&
				settings.quietStartup === true &&
				!args.includes("--verbose")
			)
				return;
		} catch {
			// Normal settings loading reports malformed files after the runtime loads.
		}
	}
	ensureWindowsUtf8Console();
	if (drawnLines) return;
	const startedAt = performance.now();
	launch = { startedAt, fullscreenUntil: startedAt + LAUNCH_FULLSCREEN_MS };
	const height = Math.max(1, process.stdout.rows || 24);
	// Reserve a full viewport while leaving the command and earlier output in scrollback.
	process.stdout.write(`\n${"\n".repeat(Math.max(0, height - 2))}\x1b[${Math.max(1, height - 1)}A\r\x1b7\x1b[?25l`);
	drawnLines = height;
	// Instant lightweight preload: no 3D yet. The single-spin easter egg starts inside the TUI once it is ready (see clearStartupScreen), so there is no frozen frame between rotation and handoff.
	{
		const width = Math.max(1, process.stdout.columns || 80);
		const message = "Prajvalana [firing up]  ";
		const left = Math.max(0, Math.floor((width - message.length) / 2));
		const top = Math.max(0, Math.floor(height / 2) - 1);
		process.stdout.write(`\x1b8${"\n".repeat(top)}${" ".repeat(left)}${message}\n`);
	}
}

/** Remove only our welcome lines when a real TUI or a startup dialog takes ownership. */
export function clearStartupScreen(): void {
	if (!drawnLines) return;
	if (animation) clearInterval(animation);
	animation = undefined;
	if (resizeAnimation) process.stdout.off("resize", resizeAnimation);
	resizeAnimation = undefined;
	if (animationState) {
		Atomics.store(animationState, 0, 1);
		// Let an in-flight descriptor write finish before clearing our reserved viewport.
		while (Atomics.load(animationState, 1)) Atomics.wait(animationState, 1, 1, 20);
	}
	void animationWorker?.terminate();
	animationWorker = undefined;
	animationState = undefined;
	// Restart the single-spin timeline so the easter egg plays fresh inside the ready TUI with no frozen gap.
	const now = performance.now();
	if (launch) {
		launch.startedAt = now;
		launch.fullscreenUntil = now + LAUNCH_FULLSCREEN_MS;
	}
	process.stdout.write("\x1b8\r\x1b[J\x1b[?25h");
	drawnLines = 0;
}
