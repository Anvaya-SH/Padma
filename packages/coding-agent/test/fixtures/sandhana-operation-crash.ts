import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SandhanaKernel } from "../../src/core/sandhana/kernel.ts";
import { MissionStore } from "../../src/core/sandhana/store.ts";
import { createReadTool, createWriteTool } from "../../src/core/tools/index.ts";

const [cwd, database] = process.argv.slice(2);
if (!cwd || !database) throw new Error("Expected workspace and durable database");
const store = new MissionStore(database);
const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "operation-crash", store });
kernel.register(createReadTool(cwd), "read");
kernel.register(createWriteTool(cwd), "write");
const instruction =
	'padma: {"objective":"replace bytes durably","allow_edits":true,"requirements":[{"text":"new bytes","rule":"CONTENT","target":"out.txt","expected":"new"}]}';
kernel.captureInput(instruction, "USER");
kernel.begin(instruction);
const commit = store.commit.bind(store);
store.commit = (expected, state, records, artifacts) => {
	if (
		readFileSync(join(cwd, "out.txt"), "utf8") === "new" &&
		records.some(
			(record) =>
				record.record_type === "BudgetReservation" &&
				record.state === "RESERVED" &&
				record.amounts.retrieval_bytes > 0,
		)
	)
		process.exit(91);
	commit(expected, state, records, artifacts);
};
await kernel.operations.prepare("write", { path: "out.txt", content: "new" });
await kernel.operations.pump();
setTimeout(() => process.exit(92), 10000);
