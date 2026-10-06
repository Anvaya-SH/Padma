import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile, extractShellRequests } from "../src/core/sandhana/compiler.ts";
import { type KernelOptions, SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { makeRecord, type RecordOf } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { type BashToolOptions, createBashTool } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(options: Partial<KernelOptions> = {}, shellOptions: BashToolOptions = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "padma-command-cwd-")));
	const child = join(root, "Onedrive", "Desktop", "Padma");
	mkdirSync(join(child, "descendant"), { recursive: true });
	mkdirSync(join(root, "sibling"));
	writeFileSync(join(root, "file.txt"), "not a directory");
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => root, session: () => "command-cwd", store, ...options });
	cleanups.push(() => {
		kernel.closeKnowledge();
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	const launches: { command: string; cwd: string }[] = [];
	const shell = kernel.register(
		createBashTool(root, {
			operations: {
				exec: async (command, cwd, opts) => {
					launches.push({ command, cwd });
					opts.onData(Buffer.from(cwd));
					return { exitCode: 0, outputComplete: true };
				},
			},
			...shellOptions,
		}),
		"bash",
	);
	const start = (instruction = "run the command npm run check in the dir Onedrive\\Desktop\\Padma") => {
		kernel.captureInput(instruction, "USER");
		return kernel.begin(instruction);
	};
	return { root, child, store, kernel, shell, launches, start };
}

// Explicit user command/cwd authority regression; never run fixture project scripts.
describe("literal command and native cwd authority", () => {
	it.skipIf(process.platform !== "win32")(
		"binds the exact reported Windows request to PROCESS and executes once",
		async () => {
			const f = fixture();
			f.start();
			const state = f.kernel.state!;
			const req = f.store.get(state.mission_id, state.requirements[0], "Requirement");
			expect(req).toMatchObject({ rule: "PROCESS", target: f.child, expected: "npm run check" });
			const grants = state.authorizations.map((ref) => f.store.get(state.mission_id, ref, "Authorization"));
			expect(grants.find((grant) => grant.classes.includes("SHELL:npm run check"))?.target).toBe(f.child);
			expect(grants.find((grant) => grant.classes.includes("READ"))?.classes).not.toContain("SHELL:npm run check");
			const result = await f.shell.execute("exact", { command: "npm run check", cwd: "Onedrive\\Desktop\\Padma" });
			expect(result.isError).not.toBe(true);
			expect(f.launches).toEqual([{ command: "npm run check", cwd: f.child }]);
			expect(f.kernel.ready()).toBe(true);
		},
	);
	it.each([".", "sibling", "Onedrive/Desktop/Padma/descendant"])(
		"denies same command at unrequested cwd %s",
		async (cwd) => {
			const f = fixture();
			f.start("run the command npm run check in the dir Onedrive/Desktop/Padma");
			const result = await f.shell.execute("wrong-cwd", { command: "npm run check", cwd });
			expect(result.isError).toBe(true);
			expect(f.launches).toEqual([]);
			expect(f.kernel.state!.used.execution).toBe(0);
		},
	);
	it.each([
		"npm run checks",
		"npm run check suffix",
		"npm run check && echo changed",
		"npm run check | echo changed",
		"cd /c/Users/Hp/Onedrive/Desktop/Padma && npm run check",
		"npm run check ",
	])("denies changed command bytes: %s", async (command) => {
		const f = fixture();
		f.start("run the command npm run check in the dir Onedrive/Desktop/Padma");
		expect((await f.shell.execute("wrong-command", { command, cwd: f.child })).isError).toBe(true);
		expect(f.launches).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("keeps no-cwd authority at the exact selected root", async () => {
		const f = fixture();
		f.start("run: npm run check");
		expect((await f.shell.execute("invented", { command: "npm run check", cwd: f.child })).isError).toBe(true);
		expect(f.launches).toEqual([]);
	});
	it.each(["run:", "execute:"])("preserves meaningful typed literal bytes for %s", (prefix) => {
		const command = "printf 'in the dir not-a-path'  ";
		expect(extractShellRequests(`${prefix} ${command}`)).toEqual([{ command }]);
	});
	it.each([
		["run ` printf 'in the dir not-a-path'  `", " printf 'in the dir not-a-path'  "],
		["run the command \"printf 'in the dir not-a-path'\"", "printf 'in the dir not-a-path'"],
		["run the command printf 'in the dir not-a-path'", "printf 'in the dir not-a-path'"],
	])("does not reinterpret quoted path-like command contents: %s", (instruction, command) => {
		expect(extractShellRequests(instruction)).toEqual([{ command, cwd: undefined }]);
	});
	it.each(["run `npm run check`", 'run the command "npm run check"', "run the command 'npm run check'"])(
		"preserves cwd outside literal command: %s",
		(prefix) => {
			expect(extractShellRequests(`${prefix} in the folder "Onedrive/Desktop/Padma"`)).toEqual([
				{ command: "npm run check", cwd: "Onedrive/Desktop/Padma" },
			]);
		},
	);
	it("does not mint shell authority from command-like text in inert cwd data", () => {
		expect(extractShellRequests('run `npm run check` in the dir "run `echo untrusted`"')).toEqual([
			{ command: "npm run check", cwd: "run `echo untrusted`" },
		]);
	});
	it("does not derive a child check grant from root edit authority", async () => {
		const f = fixture();
		writeFileSync(join(f.child, "source.test.cjs"), "source");
		f.start("fix parser, run node --test source.test.cjs");
		expect(
			(await f.shell.execute("invented-check-cwd", { command: "node --test source.test.cjs", cwd: f.child }))
				.isError,
		).toBe(true);
		expect(f.launches).toEqual([]);
	});
	it.each(["run:", "execute:"])("executes literal trailing bytes unchanged for %s", async (prefix) => {
		const f = fixture();
		const command = "printf 'literal'  ";
		f.start(`${prefix} ${command}`);
		expect((await f.shell.execute("trailing", { command })).isError).not.toBe(true);
		expect(f.launches).toEqual([{ command, cwd: f.root }]);
	});
	it("accepts native paths with spaces without injecting shell text", async () => {
		const f = fixture();
		const cwd = join(f.root, "directory with spaces");
		mkdirSync(cwd);
		f.start(`run \`npm run check\` in the directory "${cwd}"`);
		expect((await f.shell.execute("spaces", { command: "npm run check", cwd })).isError).not.toBe(true);
		expect(f.launches).toEqual([{ command: "npm run check", cwd }]);
	});
	it.skipIf(process.platform !== "win32")("canonicalizes Windows case aliases", async () => {
		const f = fixture();
		f.start(`run \`npm run check\` in the dir ${f.child.toUpperCase()}`);
		const result = await f.shell.execute("case", { command: "npm run check", cwd: f.child.toLowerCase() });
		expect(result.isError).not.toBe(true);
		expect(f.launches[0].cwd).toBe(realpathSync(f.child));
	});
	it.each(["absent", "file.txt", "../escape", "Onedrive/../sibling"])("rejects invalid requested cwd %s", (cwd) => {
		const f = fixture();
		expect(() => f.start(`run \`npm run check\` in the dir ${cwd}`)).toThrow();
		expect(f.launches).toEqual([]);
	});
	it.each(["absent", "file.txt", "../escape", "Onedrive/../Desktop/Padma"])(
		"rejects invalid proposed cwd %s",
		async (cwd) => {
			const f = fixture();
			f.start("run: npm run check");
			expect((await f.shell.execute("invalid", { command: "npm run check", cwd })).isError).toBe(true);
			expect(f.launches).toEqual([]);
		},
	);
	it("rejects a symlink/junction ancestor even when it points inside the workspace", () => {
		const f = fixture();
		symlinkSync(join(f.root, "Onedrive"), join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
		expect(() => f.start("run `npm run check` in the dir alias/Desktop/Padma")).toThrow();
	});
	it("rejects an absolute directory outside the selected workspace", () => {
		const f = fixture();
		expect(() => f.start(`run \`npm run check\` in the dir ${tmpdir()}`)).toThrow();
	});
	it("rejects a directory replaced after preparation, before native launch", async () => {
		const f = fixture();
		f.start("run `npm run check` in the dir Onedrive/Desktop/Padma");
		const id = await f.kernel.prepareOperation("bash", "replace", { command: "npm run check", cwd: f.child });
		renameSync(f.child, `${f.child}-old`);
		mkdirSync(f.child);
		await expect(f.kernel.dispatchPrepared(id)).rejects.toThrow(/PREIMAGE_CONFLICT/);
		expect(f.launches).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it.each(["command", "cwd", "env"] as const)("rejects spawnHook %s mutation with zero launch", async (field) => {
		const f = fixture(
			{},
			{
				spawnHook: (context) => ({
					...context,
					...(field === "command" ? { command: `${context.command} && echo changed` } : {}),
					...(field === "cwd" ? { cwd: join(context.cwd, "descendant") } : {}),
					...(field === "env" ? { env: { ...context.env, UNAUTHORIZED: "yes" } } : {}),
				}),
			},
		);
		f.start("run `npm run check` in the dir Onedrive/Desktop/Padma");
		expect((await f.shell.execute("hook", { command: "npm run check", cwd: f.child })).isError).toBe(true);
		expect(f.launches).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("rechecks directory identity after a spawn hook at the final native guard", async () => {
		let replaced = false;
		const f = fixture(
			{},
			{
				spawnHook: (context) => {
					if (!replaced) {
						replaced = true;
						renameSync(context.cwd, `${context.cwd}-old`);
						mkdirSync(context.cwd);
					}
					return context;
				},
			},
		);
		f.start("run `npm run check` in the dir Onedrive/Desktop/Padma");
		expect((await f.shell.execute("replaced-hook", { command: "npm run check", cwd: f.child })).isError).toBe(true);
		expect(f.launches).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("fences an unknown child process outcome across resume without replay", async () => {
		let launched = 0;
		const f = fixture(
			{},
			{
				operations: {
					exec: async () => {
						launched++;
						throw new Error("Lost process outcome");
					},
				},
			},
		);
		f.start("run `npm run check` in the dir Onedrive/Desktop/Padma");
		expect((await f.shell.execute("unknown", { command: "npm run check", cwd: f.child })).isError).toBe(true);
		f.kernel.finalize("OUTCOME_UNKNOWN", "Lost process result");
		expect(() => f.start(`resume ${f.kernel.state!.mission_id}`)).toThrow(/reconciliation/);
		expect(launched).toBe(1);
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("rejects a selected workspace change before spawn", async () => {
		let cwd = ".";
		const f = fixture({
			cwd: () => cwd,
			beforeDispatch: async () => {
				cwd = join(f.root, "sibling");
			},
		});
		cwd = f.root;
		f.start("run `npm run check` in the dir Onedrive/Desktop/Padma");
		expect((await f.shell.execute("workspace-change", { command: "npm run check", cwd: f.child })).isError).toBe(
			true,
		);
		expect(f.launches).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("rejects a selected session change before spawn", async () => {
		let session = "command-cwd";
		const f = fixture({
			session: () => session,
			beforeDispatch: async () => {
				session = "other-session";
			},
		});
		f.start("run `npm run check` in the dir Onedrive/Desktop/Padma");
		expect((await f.shell.execute("session-change", { command: "npm run check", cwd: f.child })).isError).toBe(true);
		expect(f.launches).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("rejects a symlink/junction in proposed cwd before launch", async () => {
		const f = fixture();
		symlinkSync(join(f.root, "Onedrive"), join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
		f.start("run `npm run check` in the dir Onedrive/Desktop/Padma");
		expect(
			(
				await f.shell.execute("proposed-alias", {
					command: "npm run check",
					cwd: join(f.root, "alias", "Desktop", "Padma"),
				})
			).isError,
		).toBe(true);
		expect(f.launches).toEqual([]);
	});
	it("automatic acceptance dispatch supplies the original requirement cwd", async () => {
		const f = fixture();
		f.start("run the command npm run check in the dir Onedrive/Desktop/Padma");
		await f.kernel.runAcceptanceChecks(new AbortController().signal);
		expect(f.launches).toEqual([{ command: "npm run check", cwd: f.child }]);
		expect(f.kernel.ready()).toBe(true);
	});
	it("resumes natural command/cwd grants without deriving a root grant", async () => {
		const f = fixture();
		f.start("run the command npm run check in the dir Onedrive/Desktop/Padma");
		f.kernel.finalize("BLOCKED", "Deferred exact command");
		const id = f.kernel.state!.mission_id;
		f.start(`resume ${id}`);
		await f.kernel.runAcceptanceChecks(new AbortController().signal);
		expect(f.launches).toEqual([{ command: "npm run check", cwd: f.child }]);
		expect(f.kernel.ready()).toBe(true);
	});
	it("keeps revocation across resume", async () => {
		const f = fixture();
		f.start("run the command npm run check in the dir Onedrive/Desktop/Padma");
		f.kernel.revoke();
		f.kernel.finalize("BLOCKED", "Revoked exact command");
		f.start(`resume ${f.kernel.state!.mission_id}`);
		expect((await f.shell.execute("revoked", { command: "npm run check", cwd: f.child })).isError).toBe(true);
		expect(f.launches).toEqual([]);
	});
	it("keeps expired shell grants denied across resume", async () => {
		const f = fixture();
		f.start("run the command npm run check in the dir Onedrive/Desktop/Padma");
		const state = f.kernel.state!;
		const previous = state.revision++;
		const grants = state.authorizations.map((ref) => f.store.get(state.mission_id, ref, "Authorization"));
		const expired = grants
			.filter((grant) => grant.classes.some((kind) => kind.startsWith("SHELL:")))
			.map((grant) =>
				makeRecord(state.mission_id, state.revision, "Authorization", { ...grant, expires_at: Date.now() - 1 }),
			);
		state.authorizations = state.authorizations.map(
			(ref) =>
				expired.find(
					(grant) => grants.find((prior) => prior.record_id === ref)?.authorization_id === grant.authorization_id,
				)?.record_id ?? ref,
		);
		f.store.commit(previous, state, expired);
		f.kernel.finalize("BLOCKED", "Expired exact command");
		f.start(`resume ${state.mission_id}`);
		expect((await f.shell.execute("expired", { command: "npm run check", cwd: f.child })).isError).toBe(true);
		expect(f.launches).toEqual([]);
	});
	it("captures relative Node sources from the invocation child and rejects stale proof", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "source.test.cjs"), "root source must not be captured");
		writeFileSync(
			join(f.child, "source.test.cjs"),
			"const test = require('node:test'); const assert = require('node:assert/strict'); test('child cwd', () => assert.equal(require('node:path').basename(process.cwd()), 'Padma')); ",
		);
		const shell = f.kernel.register(createBashTool(f.root), "bash");
		f.start("run `node --test source.test.cjs` in the dir Onedrive/Desktop/Padma");
		expect(
			(await shell.execute("source", { command: "node --test source.test.cjs", cwd: f.child })).isError,
		).not.toBe(true);
		expect(f.kernel.ready()).toBe(true);
		const observations = f.store
			.records(f.kernel.state!.mission_id)
			.filter(
				(record): record is RecordOf<"EvidenceRecord"> =>
					record.record_type === "EvidenceRecord" && record.source === "local-process-source/2",
			);
		expect(observations.map((record) => record.payload)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ canonical_path: join(f.child, "source.test.cjs"), target_kind: "FILE" }),
			]),
		);
		expect(JSON.stringify(observations)).not.toContain(join(f.root, "source.test.cjs").replaceAll("\\", "\\\\"));
		writeFileSync(join(f.child, "source.test.cjs"), "changed child source");
		expect(f.kernel.ready()).toBe(false);
	});
	it.skipIf(process.platform !== "win32")(
		"executes the exact native PowerShell command at host child cwd",
		async () => {
			const f = fixture();
			const command = "(Get-Location).Path";
			const shell = f.kernel.register(createPowerShellTool(f.root), "powershell");
			f.start(`run \`${command}\` in the dir Onedrive\\Desktop\\Padma`);
			const result = await shell.execute("native", { command, cwd: f.child });
			expect(result.isError).not.toBe(true);
			expect(result.content).toEqual(
				expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(f.child) })]),
			);
			expect(f.kernel.state!.used.execution).toBe(1);
			expect(f.kernel.ready()).toBe(true);
		},
	);
	it("compilation keeps typed cwd-like text entirely literal", () => {
		const f = fixture();
		const command = "npm run check in the dir absent";
		const compiled = compile(`execute: ${command}`, f.root, "literal");
		expect(compiled.records.find((record) => record.record_type === "Requirement")).toMatchObject({
			target: f.root,
			expected: command,
		});
	});
});
