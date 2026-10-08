import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";

test("persistent memory uses the logical session directory and survives opening another mission database", () => {
	const root = mkdtempSync(join(tmpdir(), "padma-persistent-memory-"));
	const sessions = join(root, "a-session-directory-with-long-enough-path");
	mkdirSync(sessions);
	const stores: MissionStore[] = [];
	const kernels: SandhanaKernel[] = [];
	try {
		const firstStore = new MissionStore(join(sessions, "first.sandhana.sqlite"));
		stores.push(firstStore);
		const first = new SandhanaKernel({ cwd: () => root, session: () => "first", store: firstStore });
		kernels.push(first);
		expect(firstStore.logicalDatabasePath).toBe(join(sessions, "first.sandhana.sqlite"));
		expect(first.smritikosha.underlying.path).toBe(join(sessions, "smritikosha.sqlite"));
		const record = first.smritikosha.storeVerified({
			kind: "PROJECT_CONVENTION",
			subject: "Probe report format",
			content: { text: "Use decimal commas in probe reports" },
			origin: "EXPLICIT_USER",
			projectScope: root,
		});
		first.closeKnowledge();
		const secondStore = new MissionStore(join(sessions, "second.sandhana.sqlite"));
		stores.push(secondStore);
		const second = new SandhanaKernel({ cwd: () => root, session: () => "second", store: secondStore });
		kernels.push(second);
		expect(second.smritikosha.underlying.path).toBe(first.smritikosha.underlying.path);
		expect(second.smritikosha.inspect(record.memoryId)).toMatchObject({
			memoryId: record.memoryId,
			subject: record.subject,
			content: record.content,
			version: 1,
			origin: "EXPLICIT_USER",
			lifecycle: "VERIFIED",
			projectScope: root,
		});
		const { hits } = second.smritikosha.recall({ query: "decimal commas", projectScope: root });
		expect(hits.map((hit) => hit.record.memoryId)).toEqual([record.memoryId]);
		expect(second.smritikosha.forget(record.memoryId, record.version).lifecycle).toBe("REVOKED");
		expect(second.smritikosha.recall({ query: "decimal commas", projectScope: root }).hits).toEqual([]);
		firstStore.close();
		stores.splice(stores.indexOf(firstStore), 1);
		second.closeKnowledge();
		const reopened = new SandhanaKernel({ cwd: () => root, session: () => "second", store: secondStore });
		kernels.push(reopened);
		expect(reopened.smritikosha.inspect(record.memoryId).lifecycle).toBe("REVOKED");
		expect(reopened.smritikosha.underlying.counts()).toMatchObject({ total: 1, byLifecycle: { REVOKED: 1 } });
	} finally {
		for (const kernel of kernels) kernel.closeKnowledge();
		for (const store of stores) store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
