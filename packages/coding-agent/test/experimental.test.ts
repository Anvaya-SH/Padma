import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPadmaExperimental = process.env.PADMA_EXPERIMENTAL;

	afterEach(() => {
		if (originalPadmaExperimental === undefined) {
			delete process.env.PADMA_EXPERIMENTAL;
		} else {
			process.env.PADMA_EXPERIMENTAL = originalPadmaExperimental;
		}
	});

	it("returns false when PADMA_EXPERIMENTAL is unset", () => {
		delete process.env.PADMA_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when PADMA_EXPERIMENTAL is empty", () => {
		process.env.PADMA_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when PADMA_EXPERIMENTAL is set to 1", () => {
		process.env.PADMA_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when PADMA_EXPERIMENTAL is set to 0", () => {
		process.env.PADMA_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when PADMA_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.PADMA_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
