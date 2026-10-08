import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";

test.each([
	"Do not edit files or create any other memories.",
	"Do not store memories.",
	"Don't save any other memories.",
	"Never retain memory for this task.",
])("automatic extraction respects an explicit memory restriction: %s", (restriction) => {
	const cwd = mkdtempSync(join(tmpdir(), "padma-memory-opt-out-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "memory-opt-out", store });
	try {
		kernel.captureInput(`Inspect configuration. ${restriction}`, "USER");
		kernel.begin("");
		const explicit = kernel.smritikosha.storeVerified({
			kind: "USER_PREFERENCE",
			subject: "Requested temporary preference",
			content: { text: "Use decimal commas in the probe-only report" },
			origin: "EXPLICIT_USER",
		});
		kernel.smritikosha.forget(explicit.memoryId, explicit.version);
		expect(kernel.smritikosha.extractCandidates(kernel.state!, store)).toEqual([]);
		expect(kernel.smritikosha.underlying.counts()).toMatchObject({ total: 1, byLifecycle: { REVOKED: 1 } });
	} finally {
		kernel.closeKnowledge();
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a file restriction preserves automatic preference extraction", () => {
	const cwd = mkdtempSync(join(tmpdir(), "padma-memory-opt-out-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "memory-opt-out", store });
	try {
		kernel.captureInput("Inspect configuration. Do not edit files.", "USER");
		kernel.begin("");
		expect(kernel.smritikosha.extractCandidates(kernel.state!, store)).toContainEqual(
			expect.objectContaining({ kind: "USER_PREFERENCE", origin: "EXPLICIT_USER" }),
		);
	} finally {
		kernel.closeKnowledge();
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});
