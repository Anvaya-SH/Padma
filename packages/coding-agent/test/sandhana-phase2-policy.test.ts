import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type PolicyContext, ScopePolicy } from "../src/core/sandhana/code.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool } from "../src/core/tools/index.ts";

it("intersecting predicates can narrow a base allow but cannot widen denial or missing authority", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "padma-phase2-policy-"));
	const store = new MissionStore(":memory:");
	try {
		writeFileSync(join(cwd, "target.txt"), "requested bytes");
		const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "policy", store });
		kernel.register(createReadTool(cwd), "read");
		kernel.captureInput("read target.txt", "USER");
		kernel.begin("");
		const id = await kernel.prepareOperation("read", "prepared", { path: "target.txt" });
		const state = kernel.state!;
		const operation = store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(operation.operation_id).toBe(id);
		const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
		const policy = new ScopePolicy();
		const context: PolicyContext = {
			revision: state.revision,
			policy_version: policy.version,
			binding: store.get(state.mission_id, action.binding_ref, "TargetBinding"),
			authorizations: state.authorizations.map((ref) => store.get(state.mission_id, ref, "Authorization")),
			now: Date.now(),
			predicates: [() => true],
		};
		expect(policy.evaluate(action, context).outcome).toBe("ALLOW");
		expect(policy.evaluate(action, { ...context, predicates: [() => false] }).outcome).toBe("DENY");
		expect(policy.evaluate(action, { ...context, binding: { ...context.binding, valid: false } }).outcome).toBe(
			"DENY",
		);
		expect(policy.evaluate(action, { ...context, authorizations: [] }).outcome).toBe("NEEDS_CURRENT_AUTHORIZATION");
		expect(kernel.state!.used.execution).toBe(0);
	} finally {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});
