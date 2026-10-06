/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 */

import type { ExtensionAPI } from "@anvaya.sh/padma-coding-agent";

export default function (padma: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;

	// Track the current entry ID when user messages are saved
	padma.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	padma.on("turn_start", async () => {
		// Create a git stash entry before LLM makes changes
		const { stdout } = await padma.exec("git", ["stash", "create"]);
		const ref = stdout.trim();
		if (ref && currentEntryId) {
			checkpoints.set(currentEntryId, ref);
		}
	});

	padma.on("session_before_fork", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			await padma.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	padma.on("agent_settled", async () => {
		// Clear checkpoints after the full agent run completes
		checkpoints.clear();
	});
}
