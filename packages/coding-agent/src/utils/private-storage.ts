import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

const privateDirectories = new Map<string, Stats>();
// Fixed operating-system maintenance code. Path values enter as JSON data, never as executable source.
const windowsStorageAction = `
$ErrorActionPreference = 'Stop'
$request = ConvertFrom-Json $env:PADMA_PRIVATE_STORAGE_REQUEST
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
foreach ($entry in $request.paths) {
    $attributes = [System.IO.File]::GetAttributes($entry.path)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private storage reparse point rejected' }
    $directory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    if ($directory -ne $entry.directory) { throw 'Private storage type changed' }
    $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($entry.path) } else { [System.IO.File]::GetAccessControl($entry.path) }
    if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Private storage owner differs' }
    $inherit = if ($entry.directory) { 'OICI' } else { '' }
    $acl.SetSecurityDescriptorSddlForm("D:P(A;$inherit;FA;;;$sid)(A;$inherit;FA;;;SY)(A;$inherit;FA;;;BA)", [System.Security.AccessControl.AccessControlSections]::Access)
    if ($directory) { [System.IO.Directory]::SetAccessControl($entry.path, $acl) } else { [System.IO.File]::SetAccessControl($entry.path, $acl) }
    $checked = if ($directory) { [System.IO.Directory]::GetAccessControl($entry.path) } else { [System.IO.File]::GetAccessControl($entry.path) }
    if (-not $checked.AreAccessRulesProtected) { throw 'Private storage inheritance was not protected' }
    foreach ($rule in $checked.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $allowed -notcontains $rule.IdentityReference.Value) { throw 'Private storage grants another account' }
    }
}
if ($request.replace) {
    [System.IO.File]::Replace($request.replace.source, $request.replace.target, $request.replace.backup, $false)
}
if ($request.move) {
    [System.IO.File]::Move($request.move.source, $request.move.target)
}
Write-Output 'PRIVATE_STORAGE/1'
`;

export function windowsPrivateStorageAction(
	paths: { path: string; directory: boolean }[],
	replace?: { source: string; target: string; backup: string | null },
	move?: { source: string; target: string },
): void {
	if (process.platform !== "win32") throw new Error("Windows private storage action is unavailable on this platform");
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) throw new Error("Private storage requires the system Windows runtime");
	try {
		const result = execFileSync(
			join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(windowsStorageAction, "utf16le").toString("base64"),
			],
			{
				env: {
					...process.env,
					PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
					PADMA_PRIVATE_STORAGE_REQUEST: JSON.stringify({ paths, replace, move }),
				},
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				timeout: 30000,
				maxBuffer: 65536,
			},
		);
		if (result.trim() !== "PRIVATE_STORAGE/1") throw new Error("Private storage access was not confirmed");
	} catch (cause) {
		throw new Error("Private storage access or publication failed; retained data must not be reset", { cause });
	}
}

/** Restrict only an application-owned storage directory; existing ancestor permissions remain intact. */
export function ensurePrivateDirectory(input: string): string {
	const directory = resolve(input);
	for (let cursor = directory; ; cursor = dirname(cursor)) {
		try {
			const stat = lstatSync(cursor);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private storage directory custody changed");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		if (cursor === parse(cursor).root) break;
	}
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = lstatSync(directory);
	const previous = privateDirectories.get(directory);
	if (
		previous &&
		previous.dev === stat.dev &&
		previous.ino === stat.ino &&
		previous.birthtimeMs === stat.birthtimeMs &&
		previous.ctimeMs === stat.ctimeMs
	)
		return directory;
	if (process.platform === "win32") windowsPrivateStorageAction([{ path: directory, directory: true }]);
	else if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
		throw new Error("Private storage directory must be owned and private");
	privateDirectories.set(directory, lstatSync(directory));
	return directory;
}

export function privateOutputDirectory(): string {
	const account = createHash("sha256").update(homedir()).digest("hex").slice(0, 24);
	return ensurePrivateDirectory(join(tmpdir(), `.padma-private-${account}`));
}
