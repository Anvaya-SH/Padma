import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const parameters = Type.Object({ path: Type.String({ description: "Exact bound repository directory" }) });
export function createStatusToolDefinition(): ToolDefinition<typeof parameters> {
	return {
		name: "status",
		label: "status",
		description: "Observe Git status of one explicitly bound repository. Read-only; no optional Git locks.",
		parameters,
		execute: async () => {
			throw new Error("STATUS_CHECK must be dispatched through Sandhana's registered adapter");
		},
	};
}
