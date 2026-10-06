import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ShellOutputReceipt, withShellDispatchGuard } from "../src/core/tools/dispatch-guard.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import * as storage from "../src/utils/private-storage.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(): string {
	const directory = mkdtempSync(join(tmpdir(), "padma-private-storage-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function windowsAccess(path: string): { protected: boolean; allowed: boolean; sddl: string } {
	const script = `
$ErrorActionPreference = 'Stop'
$path = $env:PADMA_PRIVATE_STORAGE_TEST_PATH
$acl = if ([System.IO.Directory]::Exists($path)) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
$self = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($self, 'S-1-5-18', 'S-1-5-32-544')
$valid = $true
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow' -or $allowed -notcontains $rule.IdentityReference.Value) { $valid = $false }
}
@{ protected = $acl.AreAccessRulesProtected; allowed = $valid; sddl = $acl.Sddl } | ConvertTo-Json -Compress
`;
	return JSON.parse(
		execFileSync(
			join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(script, "utf16le").toString("base64"),
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PSModulePath: join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules"),
					PADMA_PRIVATE_STORAGE_TEST_PATH: path,
				},
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		),
	) as { protected: boolean; allowed: boolean; sddl: string };
}

describe("private retained storage", () => {
	it("restricts its own directory and inherited files without changing the parent", () => {
		const parent = fixture();
		const before = process.platform === "win32" ? windowsAccess(parent).sddl : lstatSync(parent).mode;
		const directory = storage.ensurePrivateDirectory(join(parent, "owned"));
		const path = join(directory, "raw.log");
		writeFileSync(path, "retained evidence", { mode: 0o600 });
		if (process.platform === "win32") {
			expect(windowsAccess(directory)).toMatchObject({ protected: true, allowed: true });
			expect(windowsAccess(path).allowed).toBe(true);
			expect(windowsAccess(parent).sddl).toBe(before);
		} else {
			expect(lstatSync(directory).mode & 0o077).toBe(0);
			expect(lstatSync(path).mode & 0o077).toBe(0);
			expect(lstatSync(parent).mode).toBe(before);
		}
	});
	it("rejects a directory junction before changing the referenced directory", () => {
		const parent = fixture();
		const target = join(parent, "target");
		mkdirSync(target);
		const before = process.platform === "win32" ? windowsAccess(target).sddl : lstatSync(target).mode;
		const link = join(parent, "link");
		symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
		expect(() => storage.ensurePrivateDirectory(link)).toThrow("custody changed");
		expect(() => storage.ensurePrivateDirectory(join(link, "child"))).toThrow("custody changed");
		expect(existsSync(join(target, "child"))).toBe(false);
		expect(process.platform === "win32" ? windowsAccess(target).sddl : lstatSync(target).mode).toBe(before);
	});
	it("retains exact native bytes in a private spool", async () => {
		const receipts: ShellOutputReceipt[] = [];
		const bytes = Buffer.from([0, 255, 195, 169, 10, 128, 42]);
		await withShellDispatchGuard(
			() => {},
			async () => {
				const output = new OutputAccumulator({ maxBytes: 2 });
				output.append(bytes.subarray(0, 3));
				output.append(bytes.subarray(3));
				await output.closeTempFile();
				expect(output.snapshot().fullOutputPath).toBeDefined();
			},
			(receipt) => {
				receipts.push(receipt);
				if (receipt.spool_path) cleanups.push(() => rmSync(receipt.spool_path!, { force: true }));
			},
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ output_bytes: bytes.length, spool_bytes: bytes.length, limitation: null });
		const path = receipts[0].spool_path!;
		expect(dirname(path)).toBe(storage.privateOutputDirectory());
		expect(readFileSync(path)).toEqual(bytes);
		if (process.platform === "win32") expect(windowsAccess(path).allowed).toBe(true);
		else expect(lstatSync(path).mode & 0o077).toBe(0);
	});
	it("accounts received bytes and emits uncertainty when private spool admission fails", async () => {
		vi.spyOn(storage, "privateOutputDirectory").mockImplementation(() => {
			throw new Error("private storage denied");
		});
		const receipts: ShellOutputReceipt[] = [];
		await withShellDispatchGuard(
			() => {},
			async () => {
				const output = new OutputAccumulator({ maxBytes: 2 });
				expect(() => output.append(Buffer.from("received bytes"))).not.toThrow();
				await expect(output.closeTempFile()).rejects.toThrow("private storage denied");
				expect(output.snapshot().fullOutputPath).toBeUndefined();
			},
			(receipt) => receipts.push(receipt),
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ output_bytes: 14, spool_bytes: null, spool_path: null, source: null });
		expect(receipts[0].limitation).toContain("written volume is unknown");
	});
	it("rejects file prefixes that would escape the private directory", async () => {
		const output = new OutputAccumulator({ maxBytes: 1, tempFilePrefix: "../escaped" });
		expect(() => output.append(Buffer.from("received"))).not.toThrow();
		await expect(output.closeTempFile()).rejects.toThrow("Invalid private output file prefix");
		expect(output.snapshot().fullOutputPath).toBeUndefined();
	});
	it.skipIf(process.platform !== "win32")("native publication cannot overwrite an existing destination", () => {
		const parent = fixture();
		const source = join(parent, "source");
		const target = join(parent, "target");
		writeFileSync(source, "new redirect");
		writeFileSync(target, "retained history");
		expect(() => storage.windowsPrivateStorageAction([], undefined, { source, target })).toThrow(
			"publication failed",
		);
		expect(readFileSync(source, "utf8")).toBe("new redirect");
		expect(readFileSync(target, "utf8")).toBe("retained history");
	});
});
