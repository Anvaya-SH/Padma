/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   padma --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@anvaya.sh/padma-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(padma: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = padma.getSessionName();
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

export default function (padma: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(padma));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = padma.getSessionName();
			const title = session ? `${frame} π - ${session} - ${cwd}` : `${frame} π - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	padma.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	padma.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	padma.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
