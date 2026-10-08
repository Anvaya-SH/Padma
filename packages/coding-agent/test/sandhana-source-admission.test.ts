import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observedFile } from "../src/core/sandhana/io.ts";
import { type KernelOptions, SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { digest } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { type BashToolInput, createShellToolDefinition } from "../src/core/tools/bash.ts";
import { type ShellOutputReceipt, withShellDispatchGuard } from "../src/core/tools/dispatch-guard.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { createStatusToolDefinition } from "../src/core/tools/status.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(options: Pick<KernelOptions, "configuration" | "limits" | "beforeDispatch"> = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-source-admission-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ ...options, cwd: () => cwd, session: () => "source-admission", store });
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.register(createBashTool(cwd), "bash");
	kernel.register(wrapToolDefinition(createStatusToolDefinition()), "status");
	return {
		cwd,
		store,
		kernel,
		start: (instruction: string) => {
			kernel.captureInput(instruction, "USER");
			kernel.begin("");
		},
	};
}

describe("source authorization and artifact admission", () => {
	it("checks source authority before opening even a missing file", () => {
		const directory = mkdtempSync(join(tmpdir(), "padma-source-order-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		const authorize = vi.fn(() => {
			throw new Error("source authorization denied");
		});
		const reserve = vi.fn(() => () => {});
		expect(() => observedFile(join(directory, "missing"), { authorize, reserve })).toThrow(
			"source authorization denied",
		);
		expect(authorize).toHaveBeenCalledOnce();
		expect(reserve).not.toHaveBeenCalled();
	});
	it("validates the opened descriptor before reserving or reading source bytes", () => {
		const directory = mkdtempSync(join(tmpdir(), "padma-source-descriptor-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		const path = join(directory, "a.txt");
		writeFileSync(path, "source");
		const reserve = vi.fn(() => () => {});
		expect(() =>
			observedFile(path, {
				authorize: () => {},
				reserve,
				validate: (_path, descriptor) => {
					expect(descriptor.isFile()).toBe(true);
					expect(descriptor.size).toBe(6);
					throw new Error("descriptor identity changed");
				},
			}),
		).toThrow("descriptor identity changed");
		expect(reserve).not.toHaveBeenCalled();
		expect(() => observedFile(directory)).toThrow("regular file");
	});
	it("bounds spool bytes while counting all received bytes and never labels a prefix complete", async () => {
		const receipts: ShellOutputReceipt[] = [];
		await withShellDispatchGuard(
			() => {},
			async () => {
				const output = new OutputAccumulator({ maxBytes: 8, maxTotalBytes: 20 });
				output.append(Buffer.from("0123456789"));
				output.append(Buffer.from("abcdefghijklmnopqrstuvwxyz"));
				output.finish();
				await Promise.all([output.closeTempFile(), output.closeTempFile()]);
				await output.closeTempFile();
				expect(output.snapshot()).toMatchObject({ outputLimitExceeded: true, fullOutputPath: undefined });
			},
			(receipt) => {
				receipts.push(receipt);
				if (receipt.spool_path) cleanups.push(() => rmSync(receipt.spool_path!, { force: true }));
			},
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ output_bytes: 36, spool_bytes: 20, source: null });
		expect(receipts[0].limitation).toContain("complete output was not retained");
		expect(statSync(receipts[0].spool_path!).size).toBe(20);
		expect(readFileSync(receipts[0].spool_path!, "utf8")).toBe("0123456789abcdefghij");
	});
	it("an exact file grant cannot read another file during target binding", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "authorized");
		writeFileSync(join(f.cwd, "b.txt"), "outside the exact grant");
		f.start("read a.txt");
		await expect(f.kernel.execute("read", "other-source", { path: "b.txt" })).rejects.toThrow("source read");
		expect(f.kernel.state!.used.retrieval_bytes).toBe(0);
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.operations).toEqual([]);
		expect(f.store.records(f.kernel.state!.mission_id).some((record) => record.record_type === "Artifact")).toBe(
			false,
		);
		await f.kernel.execute("read", "authorized-source", { path: "a.txt" });
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it("hypothesis binding cannot expand an exact file grant", () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "authorized");
		writeFileSync(join(f.cwd, "b.txt"), "outside scope");
		f.start("read a.txt");
		expect(() =>
			f.kernel.proposeHypothesis({
				target: "b.txt",
				cause: "INPUT_FORMAT",
				mechanism: "INVESTIGATE",
				failure_signature: "bad",
				expected_result: "good",
			}),
		).toThrow("source read");
		expect(f.kernel.state!.used.retrieval_bytes).toBe(0);
		expect(f.kernel.state!.hypotheses).toEqual([]);
	});
	it("expired and revoked grants prevent preparation reads", async () => {
		for (const revoke of [false, true]) {
			const now = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			// Keep the mission deadline live so this case reaches the independently expired grant.
			const f = fixture({ limits: { elapsed_ms: 60 * 60 * 1000 } });
			writeFileSync(join(f.cwd, "a.txt"), "authorized");
			f.start("read a.txt");
			if (revoke) f.kernel.revoke();
			else {
				clock.mockReturnValue(now + 30 * 60 * 1000 + 1);
				const state = f.kernel.state!;
				expect(f.store.get(state.mission_id, state.authorizations[0], "Authorization").expires_at).toBeLessThan(
					Date.now(),
				);
				expect(Date.now() - state.started_at).toBeLessThan(state.ceilings.elapsed_ms);
			}
			await expect(f.kernel.execute("read", "invalid-grant", { path: "a.txt" })).rejects.toThrow("source read");
			expect(f.kernel.state!.used.retrieval_bytes).toBe(0);
			expect(f.kernel.state!.used.execution).toBe(0);
			clock.mockRestore();
		}
	});
	it("revocation also prevents freshness rereads while retaining the actual observation", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "authorized");
		f.start("read a.txt");
		await f.kernel.execute("read", "first", { path: "a.txt" });
		const used = f.kernel.state!.used.retrieval_bytes;
		f.kernel.revoke();
		expect(f.kernel.ready()).toBe(false);
		const report = f.kernel.finalize();
		expect(report.status).toBe("PARTIALLY_COMPLETE");
		expect(report.verified).toEqual([]);
		expect(f.kernel.state!.used.retrieval_bytes).toBe(used);
		const operation = f.store.get(report.mission_id, f.kernel.state!.operations[0], "OperationRecord");
		const observation = f.store.get(report.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(f.store.artifact(report.mission_id, observation.artifact_ref!).toString()).toContain("authorized");
	});
	it("revocation during real process output retains the result and leaves quality proof inconclusive", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "check.cjs"), "console.log('revoke-at-output');");
		const command = "node check.cjs";
		f.start(
			`padma: ${JSON.stringify({ objective: "check", requirements: [{ text: "process", rule: "PROCESS", target: ".", expected: command }], quality_checks: [command] })}`,
		);
		let retrievalAtRevocation: number | null = null;
		await expect(
			f.kernel.execute("bash", "revoked-result", { command }, undefined, (partial) => {
				if (
					retrievalAtRevocation === null &&
					partial.content.some((part) => part.type === "text" && part.text.includes("revoke-at-output"))
				) {
					f.kernel.revoke();
					retrievalAtRevocation = f.kernel.state!.used.retrieval_bytes;
				}
			}),
		).rejects.toThrow("source read");
		expect(retrievalAtRevocation).not.toBeNull();
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		const raw = JSON.parse(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()) as {
			structuredContent: { exit_code: number };
		};
		expect(raw.structuredContent.exit_code).toBe(0);
		const report = f.kernel.finalize("BLOCKED");
		expect(report.status).toBe("BLOCKED");
		expect(report.checks_skipped).toContain(`Quality check lacks current proof: ${command}`);
		expect(f.kernel.state!.used.retrieval_bytes).toBe(retrievalAtRevocation);
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("a denied edit publishes no preimage artifact or checkpoint", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "old");
		f.start("read a.txt");
		await expect(f.kernel.execute("write", "denied-edit", { path: "a.txt", content: "new" })).rejects.toThrow(
			"does not cover",
		);
		expect(f.kernel.state!.checkpoints).toEqual([]);
		expect(f.kernel.state!.used.artifact_bytes).toBe(0);
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.store.records(f.kernel.state!.mission_id).some((record) => record.record_type === "Artifact")).toBe(
			false,
		);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("old");
	});
	it("checkpoint capacity is admitted before publication and replacement", async () => {
		const f = fixture({ limits: { artifact_bytes: 2 } });
		writeFileSync(join(f.cwd, "a.txt"), "old");
		f.start("Fix a.txt");
		await expect(f.kernel.execute("write", "too-large-preimage", { path: "a.txt", content: "new" })).rejects.toThrow(
			"Checkpoint publication",
		);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("old");
		expect(f.kernel.state!.used.artifact_bytes).toBe(0);
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.checkpoints).toEqual([]);
		expect(f.store.records(f.kernel.state!.mission_id).some((record) => record.record_type === "Artifact")).toBe(
			false,
		);
	});
	it("trusted workspace identity can read only its Git-file pointer within an exact file mission", async () => {
		const f = fixture();
		const pointer = "gitdir: ../private-repository\n";
		writeFileSync(join(f.cwd, ".git"), pointer);
		writeFileSync(join(f.cwd, "a.txt"), "authorized");
		f.start("read a.txt");
		await f.kernel.execute("read", "exact", { path: "a.txt" });
		expect(f.kernel.state!.used.retrieval_bytes).toBeGreaterThan(Buffer.byteLength(pointer));
		await expect(f.kernel.execute("read", "metadata", { path: ".git" })).rejects.toThrow();
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it("status metadata remains available under an exact STATUS grant", async () => {
		const f = fixture();
		execFileSync("git", ["init", f.cwd], { stdio: "pipe", windowsHide: true });
		f.start("status .");
		await f.kernel.execute("status", "status", { path: "." });
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
		expect(f.kernel.state!.used.retrieval_bytes).toBeGreaterThan(0);
	});
	it("a returned output path cannot authorize reading an unrelated file", async () => {
		const f = fixture();
		mkdirSync(join(f.cwd, ".padma"));
		const privatePath = join(f.cwd, ".padma", "private.txt");
		writeFileSync(privatePath, "private bytes must stay out of observations");
		const native = createBashTool(f.cwd, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("safe returned tail"));
					return { exitCode: 0, outputComplete: true };
				},
			},
		});
		f.kernel.register(
			{
				...native,
				execute: async (id, args, signal, onUpdate) => {
					const result = await native.execute(id, args as BashToolInput, signal, onUpdate);
					return { ...result, details: { fullOutputPath: privatePath } };
				},
			},
			"bash",
		);
		f.start("run: printf observed");
		await expect(f.kernel.execute("bash", "forged-output", { command: "printf observed" })).rejects.toThrow(
			"Complete output",
		);
		const state = f.kernel.state!;
		expect(state.used.retrieval_bytes).toBe(0);
		expect(state.used.execution).toBe(1);
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(observation.payload).toMatchObject({ full_output_ref: null });
		const raw = f.store.artifact(state.mission_id, observation.artifact_ref!).toString();
		expect(raw).toContain("safe returned tail");
		expect(raw).not.toContain("private bytes must stay out");
	});
	it("reserves combined output before launching a read that may retain source bytes", async () => {
		const f = fixture({
			configuration: { version: "sandhana/1", artifact: { max_bytes: 1024 } },
			limits: { output_bytes: 1024 },
		});
		writeFileSync(join(f.cwd, "a.txt"), "actual");
		f.start("read a.txt");
		await expect(f.kernel.execute("read", "insufficient-output", { path: "a.txt" })).rejects.toThrow(
			"output_bytes capacity",
		);
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.used.output_bytes).toBe(0);
		expect(f.kernel.state!.used.artifact_bytes).toBe(0);
		expect(f.kernel.state!.operations).toEqual([]);
	});
	it("reserves result and delivered replacement capacity before mutation", async () => {
		const f = fixture({
			configuration: { version: "sandhana/1", artifact: { max_bytes: 1024 } },
			limits: { artifact_bytes: 1100 },
		});
		writeFileSync(join(f.cwd, "a.txt"), "a".repeat(100));
		f.start("Fix a.txt");
		await expect(
			f.kernel.execute("write", "insufficient-result-capacity", { path: "a.txt", content: "b".repeat(100) }),
		).rejects.toThrow("artifact_bytes capacity");
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("a".repeat(100));
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.used.artifact_bytes).toBe(100);
		expect(f.kernel.state!.operations).toEqual([]);
	});
	it("settles preimage, raw result and delivered bytes once under their storage owners", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "old");
		f.start(
			`padma: ${JSON.stringify({ objective: "replace content", allow_edits: true, requirements: [{ text: "content", rule: "CONTENT", target: "a.txt", expected: "new content" }] })}`,
		);
		await f.kernel.execute("write", "replace", { path: "a.txt", content: "new content" });
		const state = f.kernel.state!;
		const storedBytes = f.store
			.records(state.mission_id)
			.filter((record) => record.record_type === "Artifact")
			.reduce((sum, artifact) => sum + artifact.bytes, 0);
		const chargedBytes = state.reservations
			.map((ref) => f.store.get(state.mission_id, ref, "BudgetReservation"))
			.reduce((sum, reservation) => sum + (reservation.actual?.artifact_bytes ?? 0), 0);
		expect(state.used.artifact_bytes).toBe(storedBytes);
		expect(chargedBytes).toBe(storedBytes);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it("an actual accumulator log is retained through its invocation's output custody", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "emit.cjs"), "process.stdout.write('actual output\\n'.repeat(6000));");
		f.start("run: node emit.cjs");
		await f.kernel.execute("bash", "large-output", { command: "node emit.cjs" });
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		const raw = JSON.parse(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()) as {
			details: { fullOutputPath: string };
		};
		cleanups.push(() => rmSync(raw.details.fullOutputPath, { force: true }));
		const payload = observation.payload as { full_output_ref: string };
		expect(f.store.artifact(state.mission_id, payload.full_output_ref).toString()).toBe(
			"actual output\n".repeat(6000),
		);
		expect(state.used.retrieval_bytes).toBeGreaterThan(84000);
		const usage = f.store.get(state.mission_id, operation.reservation_ref!, "BudgetReservation");
		expect(usage.actual?.output_bytes).toBe(state.used.output_bytes);
		expect(usage.actual?.artifact_bytes).toBe(state.used.artifact_bytes);
		expect(usage.actual?.output_bytes).toBe(
			f.store.artifact(state.mission_id, observation.artifact_ref!).length + 84000,
		);
		const storedBytes = f.store
			.records(state.mission_id)
			.reduce((sum, record) => sum + (record.record_type === "Artifact" ? record.bytes : 0), 0);
		expect(usage.actual?.artifact_bytes).toBe(storedBytes + 84000);
		expect(observation.payload).toMatchObject({ native_output_bytes: 84000, spool_bytes: 84000 });
		expect(usage.amounts.output_bytes).toBeGreaterThanOrEqual(usage.actual!.output_bytes);
		expect(usage.amounts.artifact_bytes).toBeGreaterThanOrEqual(usage.actual!.artifact_bytes);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it.each(["replacement", "same-length content", "size"])(
		"rejects a native log after %s changes without turning its tail into complete proof",
		async (change) => {
			const f = fixture();
			writeFileSync(join(f.cwd, "emit.cjs"), "process.stdout.write('actual output\\n'.repeat(6000));");
			const native = createBashTool(f.cwd);
			let retrievalBeforeCapture = 0;
			f.kernel.register(
				{
					...native,
					execute: async (callId, args, signal, onUpdate) => {
						const result = await native.execute(callId, args as BashToolInput, signal, onUpdate);
						const details = result.details as { fullOutputPath: string };
						const path = details.fullOutputPath;
						cleanups.push(() => rmSync(path, { force: true }));
						if (change === "replacement") {
							renameSync(path, `${path}.original`);
							cleanups.push(() => rmSync(`${path}.original`, { force: true }));
						}
						writeFileSync(path, "x".repeat(change === "size" ? 84001 : 84000));
						retrievalBeforeCapture = f.kernel.state!.used.retrieval_bytes;
						return result;
					},
				},
				"bash",
			);
			f.start("run: node emit.cjs");
			await expect(f.kernel.execute("bash", "changed-log", { command: "node emit.cjs" })).rejects.toThrow(
				"Complete output",
			);
			const state = f.kernel.state!;
			const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
			const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
			expect(observation.payload).toMatchObject({
				full_output_ref: null,
				native_output_bytes: 84000,
				spool_bytes: 84000,
			});
			const limitations = (observation.payload as { capture_limitations: string[] }).capture_limitations;
			expect(limitations.join(" ")).toContain(
				change === "same-length content" ? "native stream digest" : "native receipt",
			);
			// The command source is revalidated in each case. Only the unchanged log descriptor is read.
			expect(state.used.retrieval_bytes - retrievalBeforeCapture).toBe(
				readFileSync(join(f.cwd, "emit.cjs")).length + (change === "same-length content" ? 84000 : 0),
			);
			expect(operation.status).toBe("CONFIRMED_COMPLETE");
			expect(state.used.execution).toBe(1);
			expect(f.kernel.finalize("BUDGET_EXHAUSTED").status).toBe("BUDGET_EXHAUSTED");
		},
	);
	it("measures a short native stream even when no spool is needed", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "emit.cjs"), "process.stdout.write('short');");
		f.start("run: node emit.cjs");
		await f.kernel.execute("bash", "short-output", { command: "node emit.cjs" });
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(observation.payload).toMatchObject({ native_output_bytes: 5, spool_bytes: 0 });
		const usage = f.store.get(state.mission_id, operation.reservation_ref!, "BudgetReservation");
		expect(usage.actual?.output_bytes).toBe(f.store.artifact(state.mission_id, observation.artifact_ref!).length + 5);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it.each([4096, 128 * 1024])(
		"cancels native output beyond %i bytes, retains spending and fences possible effects",
		async (cap) => {
			const f = fixture({ configuration: { version: "sandhana/1", artifact: { max_bytes: cap } } });
			writeFileSync(
				join(f.cwd, "emit.cjs"),
				"require('node:fs').writeFileSync('effect.txt', 'started'); process.stdout.write(Buffer.alloc(600000, 120)); setInterval(() => {}, 1000);",
			);
			f.start("run: node emit.cjs");
			await expect(f.kernel.execute("bash", "overflow", { command: "node emit.cjs" })).rejects.toThrow(
				"may have taken effect",
			);
			const state = f.kernel.state!;
			const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
			const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
			const payload = observation.payload as {
				output_bytes: number;
				native_output_bytes: number;
				spool_bytes: number;
				native_spools: { path: string }[];
				capture_limitations: string[];
				full_output_ref: string | null;
			};
			for (const spool of payload.native_spools) cleanups.push(() => rmSync(spool.path, { force: true }));
			expect(payload.native_output_bytes).toBeGreaterThan(cap);
			expect(payload.spool_bytes).toBe(cap);
			expect(payload.full_output_ref).toBeNull();
			expect(statSync(payload.native_spools[0].path).size).toBe(cap);
			expect(payload.capture_limitations.join(" ")).toContain("admitted limit");
			expect(readFileSync(join(f.cwd, "effect.txt"), "utf8")).toBe("started");
			expect(operation.status).toBe("OUTCOME_UNKNOWN");
			expect(state.used.execution).toBe(1);
			const usage = f.store.get(state.mission_id, operation.reservation_ref!, "BudgetReservation");
			expect(usage.state).toBe("RETAINED");
			expect(usage.actual?.output_bytes).toBe(payload.output_bytes + payload.native_output_bytes);
			expect(usage.actual?.artifact_bytes).toBe((observation.artifact_ref ? payload.output_bytes : 0) + cap);
			if (cap === 4096) {
				expect(observation.artifact_ref).toBeNull();
				expect(observation.payload).toMatchObject({ omitted: true, unknown: true });
				expect(observation.digest).toBe(digest(observation.payload));
			} else expect(observation.artifact_ref).not.toBeNull();
			await expect(f.kernel.execute("bash", "duplicate-overflow", { command: "node emit.cjs" })).rejects.toThrow(
				"no repeat",
			);
			expect(f.kernel.state!.used.execution).toBe(1);
			expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
		},
		30000,
	);
	it("keeps unmeasured spool capacity when native output storage fails", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "emit.cjs"), "process.stdout.write('actual output\\n'.repeat(6000));");
		f.kernel.register(
			wrapToolDefinition(
				createShellToolDefinition(f.cwd, {
					name: "bash",
					label: "bash",
					shellName: "bash",
					prompt: "$",
					promptSnippet: "Execute shell",
					tempFilePrefix: join(f.cwd, "missing-parent", "out"),
				}),
			),
			"bash",
		);
		f.start("run: node emit.cjs");
		await expect(f.kernel.execute("bash", "failed-spool", { command: "node emit.cjs" })).rejects.toThrow(
			"may have taken effect",
		);
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(observation.payload).toMatchObject({
			native_output_bytes: 84000,
			spool_bytes: null,
			full_output_ref: null,
		});
		expect((observation.payload as { capture_limitations: string[] }).capture_limitations.join(" ")).toContain(
			"written volume is unknown",
		);
		const usage = f.store.get(state.mission_id, operation.reservation_ref!, "BudgetReservation");
		expect(usage.state).toBe("RETAINED");
		expect(usage.amounts.artifact_bytes).toBe(8 * 1024 * 1024);
		expect(usage.actual?.output_bytes).toBe(
			f.store.artifact(state.mission_id, observation.artifact_ref!).length + 84000,
		);
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
	});
	it("a quiet inherited pipe cannot prove completion while a descendant can still act", async () => {
		const f = fixture();
		writeFileSync(
			join(f.cwd, "descendant.cjs"),
			"setTimeout(() => require('node:fs').writeFileSync('delayed-effect.txt', 'done'), 700);",
		);
		writeFileSync(
			join(f.cwd, "parent.cjs"),
			"const child = require('node:child_process').spawn(process.execPath, ['descendant.cjs'], { stdio: 'inherit', detached: true, windowsHide: true }); require('node:fs').writeFileSync('descendant.pid', String(child.pid)); child.unref(); process.stdout.write('parent-exiting\\n');",
		);
		cleanups.push(() => {
			const path = join(f.cwd, "descendant.pid");
			if (!existsSync(path)) return;
			const pid = Number(readFileSync(path, "utf8"));
			if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid owned fixture PID");
			try {
				if (process.platform === "win32")
					execFileSync(
						join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
						["/F", "/T", "/PID", String(pid)],
						{ windowsHide: true, stdio: "ignore" },
					);
				else process.kill(-pid, "SIGKILL");
			} catch {
				/* The owned fixture may already have exited. */
			}
		});
		f.start("run: node parent.cjs");
		await expect(f.kernel.execute("bash", "inherited-pipe", { command: "node parent.cjs" })).rejects.toThrow(
			"may have taken effect",
		);
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(operation.status).toBe("OUTCOME_UNKNOWN");
		expect(observation.payload).toMatchObject({
			unknown: true,
			full_output_ref: null,
			native_output_bytes: 15,
			spool_bytes: 0,
		});
		expect((observation.payload as { capture_limitations: string[] }).capture_limitations.join(" ")).toContain(
			"before stdout/stderr closure",
		);
		const raw = JSON.parse(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()) as {
			structuredContent: { exit_code: number; output_complete: boolean };
		};
		expect(raw.structuredContent).toMatchObject({ exit_code: 0, output_complete: false });
		expect(observation.payload).toMatchObject({ isError: true });
		// The native wait returned before pipe closure; the delayed effect still occurs.
		await vi.waitFor(() => expect(readFileSync(join(f.cwd, "delayed-effect.txt"), "utf8")).toBe("done"), {
			timeout: 5000,
			interval: 25,
		});
		await expect(f.kernel.execute("bash", "duplicate-parent", { command: "node parent.cjs" })).rejects.toThrow(
			"no repeat",
		);
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
	}, 30000);
});
