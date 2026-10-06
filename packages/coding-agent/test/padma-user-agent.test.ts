import { describe, expect, it } from "vitest";
import { getPadmaUserAgent } from "../src/utils/padma-user-agent.ts";

describe("getPadmaUserAgent", () => {
	it("formats the user agent expected by padma.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPadmaUserAgent("1.2.3");

		expect(userAgent).toBe(`padma/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^padma\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
