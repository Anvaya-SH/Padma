/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   padma -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@anvaya.sh/padma-coding-agent";
import { createBashTool } from "@anvaya.sh/padma-coding-agent";

export default function (padma: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, PADMA_SPAWN_HOOK: "1" },
		}),
	});

	padma.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
