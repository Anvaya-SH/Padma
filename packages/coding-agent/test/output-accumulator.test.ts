import { rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

describe("guarded structured shell output", () => {
	it("projects received bytes without reopening a changed private spool", async () => {
		const output = new OutputAccumulator({ maxBytes: 2, maxTotalBytes: 128 });
		const original = "original output with a middle error and a final line";
		output.append(Buffer.from(original.slice(0, 13)));
		output.append(Buffer.from(original.slice(13)));
		await output.closeTempFile();
		const path = output.snapshot().fullOutputPath;
		expect(path).toBeDefined();
		try {
			writeFileSync(path!, "replacement output");
			expect(await output.readFullOutput(1024 * 1024)).toEqual({ content: original, truncated: false });
		} finally {
			rmSync(path!, { force: true });
		}
	});

	it("bounds large guarded projections to raw head and tail bytes", async () => {
		const output = new OutputAccumulator({ maxBytes: 16, maxTotalBytes: 3 * 1024 * 1024 });
		const head = `START\n${"a".repeat(700_000)}`;
		const middle = `UNPROJECTED_MIDDLE${"b".repeat(700_000)}`;
		const tail = `${"c".repeat(700_000)}\nEND`;
		for (const text of [head, middle, tail]) output.append(Buffer.from(text));
		await output.closeTempFile();
		try {
			const result = await output.readFullOutput(1024 * 1024);
			expect(result.truncated).toBe(true);
			expect(result.content).toBe(
				`${(head + middle + tail).slice(0, 512 * 1024)}\n\n[... ${Buffer.byteLength(head + middle + tail) - 1024 * 1024} bytes omitted ...]\n\n${(head + middle + tail).slice(-512 * 1024)}`,
			);
			expect(result.content).not.toContain("UNPROJECTED_MIDDLE");
		} finally {
			rmSync(output.snapshot().fullOutputPath!, { force: true });
		}
	});

	it("handles split UTF-8, odd limits, ring wrap, and zero-byte limits", async () => {
		const original = Buffer.from("prefix-é-🙂-middle-🙂-é-suffix");
		const output = new OutputAccumulator({ maxBytes: 2, maxTotalBytes: 512 });
		for (const byte of original) output.append(Buffer.from([byte]));
		await output.closeTempFile();
		try {
			expect(await output.readFullOutput(512)).toEqual({ content: original.toString("utf8"), truncated: false });
			const clipped = await output.readFullOutput(13);
			expect(clipped.truncated).toBe(true);
			expect(clipped.content).not.toContain("\ufffd");
			expect((await output.readFullOutput(0)).content).toContain(`${original.length} bytes omitted`);
		} finally {
			rmSync(output.snapshot().fullOutputPath!, { force: true });
		}
	});

	it("preserves small output after both capture edges are used", async () => {
		const original = Buffer.from("0123456789abcdefghijklmn");
		const output = new OutputAccumulator({ maxBytes: 2, maxTotalBytes: original.length });
		for (let offset = 0; offset < original.length; offset += 3) output.append(original.subarray(offset, offset + 3));
		await output.closeTempFile();
		try {
			expect(await output.readFullOutput(128)).toEqual({ content: original.toString(), truncated: false });
		} finally {
			rmSync(output.snapshot().fullOutputPath!, { force: true });
		}
	});
});
