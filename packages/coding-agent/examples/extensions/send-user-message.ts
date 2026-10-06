/**
 * Send User Message Example
 *
 * Demonstrates padma.sendUserMessage() for sending user messages from extensions.
 * Unlike padma.sendMessage() which sends custom messages, sendUserMessage() sends
 * actual user messages that appear in the conversation as if typed by the user.
 *
 * Usage:
 *   /ask What is 2+2?     - Sends a user message (always triggers a turn)
 *   /steer Focus on X     - Sends while streaming with steer delivery
 *   /followup And then?   - Sends while streaming with followUp delivery
 */

import type { ExtensionAPI } from "@anvaya.sh/padma-coding-agent";

export default function (padma: ExtensionAPI) {
	// Simple command that sends a user message
	padma.registerCommand("ask", {
		description: "Send a user message to the agent",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /ask <message>", "warning");
				return;
			}

			// sendUserMessage always triggers a turn when not streaming
			// If streaming, it will throw (no deliverAs specified)
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Use /steer or /followup instead.", "warning");
				return;
			}

			padma.sendUserMessage(args);
		},
	});

	// Command that steers the agent mid-conversation
	padma.registerCommand("steer", {
		description: "Send a steering message (interrupts current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /steer <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				// Not streaming, just send normally
				padma.sendUserMessage(args);
			} else {
				// Streaming - use steer to interrupt
				padma.sendUserMessage(args, { deliverAs: "steer" });
			}
		},
	});

	// Command that queues a follow-up message
	padma.registerCommand("followup", {
		description: "Queue a follow-up message (waits for current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /followup <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				// Not streaming, just send normally
				padma.sendUserMessage(args);
			} else {
				// Streaming - queue as follow-up
				padma.sendUserMessage(args, { deliverAs: "followUp" });
				ctx.ui.notify("Follow-up queued", "info");
			}
		},
	});

	// Example with content array (text + images would go here)
	padma.registerCommand("askwith", {
		description: "Send a user message with structured content",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /askwith <message>", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}

			// sendUserMessage accepts string or (TextContent | ImageContent)[]
			padma.sendUserMessage([
				{ type: "text", text: `User request: ${args}` },
				{ type: "text", text: "Please respond concisely." },
			]);
		},
	});
}
