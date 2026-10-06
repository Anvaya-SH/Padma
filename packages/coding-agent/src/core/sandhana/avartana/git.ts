import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentToolResult } from "@anvaya.sh/padma-agent-core";
import { inside, repositoryStatus, secretPath } from "../code.ts";
import type { RetrievalMeter } from "../io.ts";
import { ContextError } from "./contracts.ts";

const exec = promisify(execFile);
/** Local Git only: no fetch, external diff, textconv, pager, user config or submodule recursion. */
export async function gitView(
	root: string,
	args: { view: "blob" | "diff" | "tree"; ref: string; locator: string; staged: boolean },
	meter: RetrievalMeter,
	signal?: AbortSignal,
): Promise<{ result: AgentToolResult<unknown>; bytes: Buffer }> {
	if (
		!/^[A-Za-z0-9_./~-]{1,200}$/.test(args.ref) ||
		args.ref.startsWith("-") ||
		args.ref.includes("..") ||
		args.locator.includes("\0") ||
		args.locator.startsWith("/") ||
		args.locator.split(/[\\/]/).includes("..") ||
		!inside(root, resolve(root, args.locator)) ||
		secretPath(resolve(root, args.locator))
	)
		throw new ContextError("MALFORMED_REQUEST", "Unsafe Git ref or relative path");
	meter.authorize?.(resolve(root, args.locator), { kind: "TARGET" });
	await repositoryStatus(root, signal, meter);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	Object.assign(env, {
		GIT_OPTIONAL_LOCKS: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_LITERAL_PATHSPECS: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
	});
	const read = async (command: string[], bound = 8 * 1024 ** 2) => {
		const settle = meter.reserve(bound * 2);
		let actual = bound * 2;
		try {
			const result = await exec(
				"git",
				[
					"--no-pager",
					"--no-optional-locks",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.untrackedCache=false",
					"-c",
					"diff.external=",
					"-C",
					root,
					...command,
				],
				{ env, signal, timeout: 30000, maxBuffer: bound, encoding: "buffer" },
			);
			actual = result.stdout.length + result.stderr.length;
			return result;
		} catch (error) {
			if (
				error instanceof Error &&
				"stdout" in error &&
				Buffer.isBuffer(error.stdout) &&
				"stderr" in error &&
				Buffer.isBuffer(error.stderr)
			)
				actual = error.stdout.length + error.stderr.length;
			throw error;
		} finally {
			settle(actual);
		}
	};
	const resolved = await read(["rev-parse", "--verify", "--end-of-options", `${args.ref}^{commit}`], 1024);
	const commit = resolved.stdout.toString().trim();
	if (!/^[0-9a-f]{40,64}$/.test(commit))
		throw new ContextError("EXTRACTION_FAILURE", "Git did not return a full object identity");
	const command =
		args.view === "blob"
			? ["show", `${commit}:${args.locator}`]
			: args.view === "tree"
				? ["ls-tree", "-r", "--full-tree", commit, "--", args.locator]
				: [
						"diff",
						"--no-ext-diff",
						"--no-textconv",
						"--ignore-submodules=all",
						...(args.staged ? ["--cached"] : []),
						commit,
						"--",
						args.locator,
					];
	const result = await read(command);
	return {
		bytes: result.stdout,
		result: {
			content: [{ type: "text", text: result.stdout.toString("utf8") }],
			details: {
				commit,
				locator: args.locator,
				view: args.view,
				staged: args.staged,
				stderr: result.stderr.toString("utf8"),
				exit_status: 0,
				complete: true,
				consistency:
					args.view === "diff"
						? "Bounded Git diff; working-tree/index may change during capture, no coherent corpus snapshot"
						: "Exact resolved commit object; Git output decoding is UTF-8",
			},
		},
	};
}
