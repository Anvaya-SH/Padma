import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentToolResult } from "@anvaya.sh/padma-agent-core";
import { splitBom } from "../../utils/text.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "../tools/edit-diff.ts";
import { withFileMutationQueue } from "../tools/file-mutation-queue.ts";
import { SandhanaError } from "./errors.ts";
import { acquireFileLock, FileLockError } from "./file-lock.ts";
import { MAX_FILE_BYTES, observedFile, type RetrievalMeter } from "./io.ts";
import {
	actionDigest,
	digest,
	makeRecord,
	POLICY_VERSION,
	type RecordOf,
	type Route,
	type Signals,
} from "./records.ts";

export const MAX_ARTIFACT_BYTES = MAX_FILE_BYTES;
export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
	);
}
export function secretPath(path: string): boolean {
	return (
		/(?:^|[\\/])(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|.*\.(?:pem|key))$/i.test(path) ||
		/(?:^|[\\/])(?:\.ssh|\.gnupg|\.git|\.padma|\.sandhana-storage)(?:[\\/]|$)/i.test(path)
	);
}
export { redact } from "./redaction.ts";
export function workspaceIdentity(cwd: string, meter?: RetrievalMeter): string {
	const canonical = realpathSync(cwd);
	const stat = statSync(canonical);
	let repo: string | null = null;
	try {
		const git = lstatSync(resolve(canonical, ".git"));
		repo = digest({
			dev: git.dev,
			ino: git.ino,
			birth: git.birthtimeMs,
			pointer: git.isFile()
				? observedFile(resolve(canonical, ".git"), meter, { kind: "WORKSPACE_IDENTITY", root: canonical }).toString(
						"utf8",
					)
				: null,
		});
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	return digest({ canonical, dev: stat.dev, ino: stat.ino, birth: stat.birthtimeMs, repo });
}
export interface TargetObservation {
	binding: RecordOf<"TargetBinding">;
	kind: "FILE" | "ABSENT" | "DIRECTORY" | "OTHER";
}
export function observeTarget(
	cwd: string,
	label: string,
	mission: string,
	revision: number,
	session: string,
	meter?: RetrievalMeter,
	requiredKind?: "DIRECTORY",
): TargetObservation {
	const root = realpathSync(cwd);
	if (requiredKind && label.split(/[\\/]/).includes(".."))
		throw new SandhanaError("SCOPE_DENIED", "Shell cwd cannot contain traversal segments");
	let path = resolve(root, label);
	if (!inside(root, path)) throw new SandhanaError("SCOPE_DENIED", "Target lies outside selected workspace");
	let cursor = path;
	while (relative(root, cursor) !== "") {
		try {
			if (lstatSync(cursor).isSymbolicLink())
				throw new SandhanaError("SCOPE_DENIED", "Symlink targets require a reviewed conditional adapter");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		cursor = dirname(cursor);
	}
	if (requiredKind) {
		if (!statSync(path, { throwIfNoEntry: false })?.isDirectory())
			throw new SandhanaError("SCOPE_DENIED", "Shell cwd must be an existing directory");
		// Preserve the selected root's drive spelling; Windows realpath may
		// retain an input drive-letter alias despite resolving segment casing.
		path = resolve(root, relative(root, realpathSync.native(path)));
		if (!inside(root, path)) throw new SandhanaError("SCOPE_DENIED", "Shell cwd escaped selected workspace");
	}
	let preimage: string | null = null;
	let identity: unknown = "MISSING";
	let kind: TargetObservation["kind"] = "ABSENT";
	try {
		const stat = statSync(path);
		kind = stat.isFile() ? "FILE" : stat.isDirectory() ? "DIRECTORY" : "OTHER";
		if (stat.isFile()) {
			if (stat.size > MAX_ARTIFACT_BYTES)
				throw new SandhanaError("BUDGET_REJECTED", "File exceeds bounded adapter limit (8 MiB)");
			preimage = digest(observedFile(path, meter));
		}
		identity = {
			dev: stat.dev,
			ino: stat.ino,
			birth: stat.birthtimeMs,
			mode: stat.mode,
			size: stat.size,
			modified: stat.mtimeMs,
		};
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		kind = "ABSENT";
	}
	const workspace = workspaceIdentity(root, meter);
	const binding = makeRecord(mission, revision, "TargetBinding", {
		binding_id: randomUUID(),
		canonical_path: path,
		user_label: label,
		workspace_id: workspace,
		session_id: session,
		repository_identity: workspace,
		worktree_identity: root,
		environment: `local:${root}`,
		generation: digest({ workspace, path, identity, preimage }),
		preimage_digest: preimage,
		establishment_evidence: [],
		valid: true,
	});
	return { binding, kind };
}
export function bindTarget(
	cwd: string,
	label: string,
	mission: string,
	revision: number,
	session: string,
	meter?: RetrievalMeter,
): RecordOf<"TargetBinding"> {
	return observeTarget(cwd, label, mission, revision, session, meter).binding;
}
export function sameBinding(binding: RecordOf<"TargetBinding">, meter?: RetrievalMeter): boolean {
	try {
		return (
			bindTarget(
				binding.worktree_identity,
				binding.canonical_path,
				binding.mission_id,
				binding.revision,
				binding.session_id,
				meter,
			).generation === binding.generation
		);
	} catch (error) {
		if (meter && error instanceof Error && "status" in error) throw error;
		return false;
	}
}
export function signalsForExact(exact: boolean): Signals {
	const supported = (key: string) => ({
		severity: 0 as const,
		provenance: key === "A" ? ("COMMAND" as const) : ("STRUCTURAL" as const),
		evidence: ["reviewed-local-observation/1"],
	});
	const unknown = () => ({ severity: 1 as const, provenance: "UNKNOWN" as const, evidence: [] });
	return exact
		? { S: supported("S"), A: supported("A"), D: supported("D"), O: supported("O"), E: supported("E"), H: unknown() }
		: { S: unknown(), A: unknown(), D: unknown(), O: unknown(), H: unknown(), E: unknown() };
}
export function routeFor(signals: Signals): Route {
	const fast = ["COMMAND", "STRUCTURAL", "PREFLIGHT"];
	if (
		[signals.S, signals.A, signals.D, signals.O, signals.E].every(
			(s) => s.severity === 0 && fast.includes(s.provenance),
		) &&
		signals.H.severity <= 1
	)
		return "SAKSHAT";
	const proved = (key: keyof Signals, severity: number) =>
		signals[key].severity >= severity &&
		!["UNKNOWN", "ESTIMATE"].includes(signals[key].provenance) &&
		signals[key].evidence.length > 0;
	if (
		(proved("S", 2) && proved("D", 2)) ||
		(proved("E", 2) && (proved("S", 1) || proved("A", 1))) ||
		(proved("H", 2) && proved("A", 1)) ||
		(["S", "A", "D", "O", "E"].filter((key) => proved(key as keyof Signals, 2)).length >= 2 &&
			["S", "A", "D", "E"].some((key) => proved(key as keyof Signals, 2)))
	)
		return "GAMBHIRA";
	return "MADHYAMA";
}
export interface PolicyContext {
	revision: number;
	policy_version: string;
	authorizations: RecordOf<"Authorization">[];
	binding: RecordOf<"TargetBinding">;
	now: number;
	/** Explicit user-selected full access: a valid "*" grant covers any action class. */
	fullAccess?: boolean;
	predicates?: ((action: RecordOf<"PreparedAction">) => boolean)[];
}
export class ScopePolicy {
	version = POLICY_VERSION;
	evaluate(action: RecordOf<"PreparedAction">, context: PolicyContext): RecordOf<"ScopeDecision"> {
		const reasons: string[] = [];
		let outcome: RecordOf<"ScopeDecision">["outcome"] = "ALLOW";
		const binding = context.binding;
		const fullAccess = context.fullAccess === true;
		if (
			context.policy_version !== this.version ||
			!binding.valid ||
			action.target_generation !== binding.generation ||
			action.action_digest !== actionDigest(action) ||
			!inside(binding.worktree_identity, binding.canonical_path) ||
			(!fullAccess && secretPath(binding.canonical_path))
		) {
			outcome = "DENY";
			reasons.push("Invalid policy, target boundary, digest, or restricted credential/Git metadata target");
		}
		const grant = context.authorizations.find((grant) => {
			if (
				grant.revoked ||
				grant.expires_at < context.now ||
				grant.policy_version !== context.policy_version ||
				grant.environment !== binding.environment
			)
				return false;
			if (grant.prepared_ref !== undefined && grant.prepared_ref !== action.record_id) return false;
			if (grant.action_digest !== null && grant.action_digest !== action.action_digest) return false;
			// A valid full-access grant covers every action class within the workspace.
			if (fullAccess && grant.classes.includes("*")) return inside(grant.target, binding.canonical_path);
			if (!grant.classes.includes(action.operation_class)) return false;
			return action.operation_class.startsWith("SHELL:")
				? grant.target === binding.canonical_path
				: inside(grant.target, binding.canonical_path);
		});
		if (!grant && outcome === "ALLOW") {
			outcome = "NEEDS_CURRENT_AUTHORIZATION";
			reasons.push("Current instruction/grant does not cover this exact operation and target");
		}
		if (context.predicates?.some((predicate) => !predicate(action))) {
			outcome = "DENY";
			reasons.push("Intersecting policy denied action");
		}
		return makeRecord(action.mission_id, context.revision + 1, "ScopeDecision", {
			operation_id: action.operation_id,
			outcome,
			policy_version: context.policy_version,
			action_digest: action.action_digest,
			target_generation: action.target_generation,
			risk: action.risk,
			reasons,
			authorization_ref: grant?.record_id ?? null,
			valid_until: Math.min(grant?.expires_at ?? context.now, context.now + 30000),
			evaluated_revision: context.revision,
		});
	}
}
export function editedContent(
	original: Buffer,
	args: { path: string; edits: { oldText: string; newText: string }[] },
): { bytes: Buffer; details: { diff: string; patch: string; firstChangedLine?: number } } {
	const { bom, text } = splitBom(original.toString("utf8"));
	const ending = detectLineEnding(text);
	const { baseContent, newContent } = applyEditsToNormalizedContent(normalizeToLF(text), args.edits, args.path);
	return {
		bytes: Buffer.from(bom + restoreLineEndings(newContent, ending)),
		details: {
			...generateDiffString(baseContent, newContent),
			patch: generateUnifiedPatch(args.path, baseContent, newContent),
		},
	};
}
/** Cooperating Padma writers lock, compare, and replace on the same filesystem. Other writers do not honor this lock; no portable filesystem CAS exists. */
export async function guardedReplace(
	binding: RecordOf<"TargetBinding">,
	content: Buffer | null,
	start: () => void,
	signal?: AbortSignal,
	beforeCommit?: () => Promise<void>,
	meter?: RetrievalMeter,
	operation: string = randomUUID(),
): Promise<void> {
	await withFileMutationQueue(binding.canonical_path, async () => {
		const rejectLegacyLock = () => {
			try {
				lstatSync(`${binding.canonical_path}.padma-lock`);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
				throw error;
			}
			throw new FileLockError(
				"LEGACY_FILE_LOCK",
				"anonymous marker requires ownership resolution before replacement",
			);
		};
		rejectLegacyLock();
		const releaseLock = acquireFileLock(binding, operation);
		const temporary = `${binding.canonical_path}.padma-${randomUUID()}.tmp`;
		let tempCreated = false;
		try {
			if (content !== null) {
				try {
					statSync(dirname(binding.canonical_path));
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
					start();
					await mkdir(dirname(binding.canonical_path), { recursive: true });
				}
			}
			signal?.throwIfAborted();
			await beforeCommit?.();
			rejectLegacyLock();
			if (!sameBinding(binding, meter))
				throw new SandhanaError("PREIMAGE_CONFLICT", "PREIMAGE_CONFLICT: target changed at commit");
			start();
			if (content === null) {
				await unlink(binding.canonical_path);
				return;
			}
			const file = await open(temporary, "wx", 0o600);
			tempCreated = true;
			try {
				await file.writeFile(content);
				await file.sync();
			} finally {
				await file.close();
			}
			if (binding.preimage_digest !== null) await chmod(temporary, statSync(binding.canonical_path).mode & 0o777);
			signal?.throwIfAborted();
			if (!sameBinding(binding, meter))
				throw new SandhanaError(
					"PREIMAGE_CONFLICT",
					"PREIMAGE_CONFLICT: non-cooperating writer changed target before replacement",
				);
			// Refresh current policy/authorization at the last controllable instant, after async temporary-file preparation.
			rejectLegacyLock();
			start();
			await rename(temporary, binding.canonical_path);
			tempCreated = false;
			// A final read is observation, not the commit precondition.
			if (digest(observedFile(binding.canonical_path, meter)) !== digest(content))
				throw new SandhanaError("EFFECT_OUTCOME_UNKNOWN", "Post-replacement content mismatch");
		} finally {
			if (tempCreated) await unlink(temporary).catch(() => {});
			releaseLock();
		}
	});
}
export async function completeList(path: string): Promise<AgentToolResult<unknown>> {
	const entries = await readdir(path, { withFileTypes: true });
	const text = entries
		.map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
		.sort()
		.join("\n");
	if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES)
		throw new Error("Listing exceeds 8 MiB output contract; complete result unavailable");
	return {
		content: [{ type: "text", text: text || "(empty directory)" }],
		details: { complete: true, entries: entries.length },
	};
}
const exec = promisify(execFile);
export async function repositoryStatus(
	path: string,
	signal?: AbortSignal,
	meter?: RetrievalMeter,
): Promise<AgentToolResult<unknown>> {
	// Do not let Git silently discover an unrelated repository above the explicitly selected target.
	if (!lstatSync(resolve(path, ".git")).isDirectory())
		throw new Error("Git-file/worktree status needs a reviewed repository-metadata adapter");
	for (const name of ["config", "config.worktree"]) {
		let config: string;
		try {
			config = observedFile(resolve(path, ".git", name), meter, { kind: "STATUS_METADATA", root: path }).toString(
				"utf8",
			);
		} catch (error) {
			if (name === "config.worktree" && error instanceof Error && "code" in error && error.code === "ENOENT")
				continue;
			throw error;
		}
		if (/^\s*\[\s*(?:filter|include(?:if)?)(?:\s|\.|\])/im.test(config))
			throw new Error(
				"Git filter/include configuration requires a reviewed status adapter; no implicit executable helpers",
			);
	}
	try {
		lstatSync(resolve(path, ".gitmodules"));
		throw new Error("Submodule status requires a reviewed adapter");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	Object.assign(env, {
		GIT_OPTIONAL_LOCKS: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
	});
	const result = await exec(
		"git",
		[
			"--no-optional-locks",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"-C",
			path,
			"status",
			"--porcelain=v1",
			"--branch",
		],
		{
			signal,
			timeout: 30000,
			maxBuffer: MAX_ARTIFACT_BYTES,
			env,
		},
	);
	return {
		content: [{ type: "text", text: `${path}\n${result.stdout}${result.stderr}` }],
		details: { target: path, complete: true },
	};
}
