import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";

test("the live pin and unpin tools release retained context without changing mission authority", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "padma-context-pin-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "context-pin", store });
	try {
		kernel.captureInput("Inspect this workspace and its API contract", "USER");
		kernel.begin("");
		const authority = [...kernel.state!.authorizations];
		const requirements = [...kernel.state!.requirements];
		const invoke = async (name: string, args: Record<string, unknown>) => {
			const tool = kernel.knowledgeTools().find((entry) => entry.name === name);
			if (!tool) throw new Error(`Missing declared tool ${name}`);
			const result = await tool.execute(`call-${name}`, args as never);
			const text = result.content[0];
			if (text.type !== "text") throw new Error("Missing tool text result");
			return JSON.parse(text.text) as Record<string, unknown>;
		};
		const pinned = await invoke("sarasangraha_pin", {
			kind: "exact_ref",
			locator: "contract.txt:1-2",
			reason: "preserve the API contract during inspection",
		});
		const pin = pinned.pin as { pinId: string };
		await invoke("sarasangraha_compact", {});
		expect(await invoke("sarasangraha_status", {})).toMatchObject({ pins: 1, pinBytes: 16 });
		expect(await invoke("sarasangraha_unpin", { pinId: pin.pinId })).toMatchObject({
			status: "CURRENT",
			removed: true,
		});
		expect(await invoke("sarasangraha_status", {})).toMatchObject({ pins: 0, pinBytes: 0 });
		expect(await invoke("sarasangraha_unpin", { pinId: pin.pinId })).toMatchObject({
			status: "UNAVAILABLE",
			removed: false,
		});
		expect(kernel.state!.authorizations).toEqual(authority);
		expect(kernel.state!.requirements).toEqual(requirements);
		expect(kernel.state!.operations).toHaveLength(0);
	} finally {
		kernel.closeKnowledge();
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});
