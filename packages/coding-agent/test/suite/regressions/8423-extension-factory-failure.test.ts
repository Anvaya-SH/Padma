import { describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI, ProviderConfig } from "../../../src/core/extensions/types.ts";

const providerConfig = {
	baseUrl: "https://provider.test/v1",
	apiKey: "provider-test-key",
} satisfies ProviderConfig;

describe("issue #8423 extension factory failure", () => {
	it("discards runtime changes and disables the failed API", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let capturedApi: ExtensionAPI | undefined;
		let eventCalls = 0;
		let flagDuringLoad: boolean | string | undefined;

		await loadExtensionFromFactory(
			(padma) => padma.registerProvider("working-provider", providerConfig),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);
		await expect(
			loadExtensionFromFactory(
				(padma) => {
					capturedApi = padma;
					padma.events.on("factory-failure", () => {
						eventCalls++;
					});
					padma.registerFlag("failed-flag", { type: "boolean", default: true });
					flagDuringLoad = padma.getFlag("failed-flag");
					padma.unregisterProvider("working-provider");
					padma.registerProvider("failed-provider", providerConfig);
					throw new Error("factory failed");
				},
				process.cwd(),
				eventBus,
				runtime,
				"<failing>",
			),
		).rejects.toThrow("factory failed");

		eventBus.emit("factory-failure", undefined);
		expect(flagDuringLoad).toBe(true);
		expect(runtime.flagValues.has("failed-flag")).toBe(false);
		expect(runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["working-provider"]);
		expect(eventCalls).toBe(0);
		expect(capturedApi).toBeDefined();
		expect(() => capturedApi?.registerFlag("late-flag", { type: "boolean", default: true })).toThrow(
			'Extension "<failing>" failed to load and its API is no longer active.',
		);
	});

	it("does not discard a concurrently loaded factory's provider", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let releaseFailure!: () => void;
		const waitBeforeFailure = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		const failingLoad = loadExtensionFromFactory(
			async (padma) => {
				padma.registerProvider("failed-provider", providerConfig);
				await waitBeforeFailure;
				throw new Error("factory failed");
			},
			process.cwd(),
			eventBus,
			runtime,
			"<failing>",
		);

		await loadExtensionFromFactory(
			(padma) => padma.registerProvider("working-provider", providerConfig),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);
		releaseFailure();

		await expect(failingLoad).rejects.toThrow("factory failed");
		expect(runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["working-provider"]);
	});
});
