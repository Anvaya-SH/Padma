import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { getStartupAnimationWorkerSpecifier } from "../src/config.ts";

it("keeps drawing during synchronous startup and stops before terminal handoff", async () => {
	const dir = mkdtempSync(join(tmpdir(), "padma-launch-worker-"));
	const file = join(dir, "frames.ansi");
	const fd = openSync(file, "w");
	const state = new Int32Array(new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT));
	state[2] = 80;
	state[3] = 24;
	const worker = new Worker(getStartupAnimationWorkerSpecifier(), {
		workerData: { state: state.buffer, startedAt: performance.now(), fd },
	});
	try {
		await once(worker, "online");
		const deadline = performance.now() + 2000;
		while (!Atomics.load(state, 4) && performance.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(Atomics.load(state, 4)).toBeGreaterThan(0);
		const before = Atomics.load(state, 4);
		const busyUntil = performance.now() + 300;
		while (performance.now() < busyUntil) {
			// Simulate the launcher's synchronous runtime import; its timers cannot run here.
		}
		expect(Atomics.load(state, 4) - before).toBeGreaterThanOrEqual(6);
		Atomics.store(state, 0, 1);
		while (Atomics.load(state, 1)) Atomics.wait(state, 1, 1, 20);
		const sizeAtHandoff = statSync(file).size;
		await worker.terminate();
		expect(statSync(file).size).toBe(sizeAtHandoff);
		expect(readFileSync(file, "utf8")).toMatch(/\x1b8.*[\u2801-\u28ff]/s);
	} finally {
		Atomics.store(state, 0, 1);
		await worker.terminate();
		closeSync(fd);
		rmSync(file);
		rmdirSync(dir);
	}
});
