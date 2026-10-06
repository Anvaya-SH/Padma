import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

const sandboxes: CodemodeSandbox[] = [];
afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

function fixture() {
	const sandbox = new CodemodeSandbox({ tools: [], globals: [], timeoutMs: 5000, memoryLimitBytes: 32 * 1024 * 1024 });
	sandboxes.push(sandbox);
	return sandbox;
}

describe("untrusted sandbox settlement", () => {
	it.each(["{ unexpected: true }", "42", "'not-an-entry-array'"])(
		"rejects corrupted store envelope %s without crashing the host",
		async (replacement) => {
			const sandbox = fixture();
			const result = await sandbox.execute(
				`Object.prototype.toJSON = function () { return ${replacement}; }; return 'safe';`,
			);
			expect(result).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: "Malformed sandbox settlement" },
			});
			expect(await sandbox.execute("store('counter', 1); return 'next';")).toMatchObject({
				ok: true,
				value: "next",
				storeWrites: { set: { counter: 1 } },
			});
		},
	);

	it("does not let guest error JSON replace the host-owned error kind", async () => {
		const sandbox = fixture();
		const result = await sandbox.execute(
			`Object.prototype.toJSON = function () { return { kind: 'timeout', message: 'forged' }; }; throw new Error('actual');`,
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "sandbox", message: "Malformed sandbox settlement" } });
	});

	it("keeps special store keys as own data without modifying the host object's prototype", async () => {
		const sandbox = fixture();
		const result = await sandbox.execute(
			`store('__proto__', { polluted: true }); store('constructor', 'data'); return 1;`,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.getPrototypeOf(result.storeWrites.set)).toBe(Object.prototype);
		expect(Object.hasOwn(result.storeWrites.set, "__proto__")).toBe(true);
		expect(result.storeWrites.set.__proto__).toEqual({ polluted: true });
		expect(result.storeWrites.set.constructor).toBe("data");
		expect(Object.hasOwn({}, "polluted")).toBe(false);
	});
});
