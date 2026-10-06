import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { AgentToolResult } from "@anvaya.sh/padma-agent-core";
import { secretPath } from "./code.ts";
import { observedFile, type RetrievalMeter } from "./io.ts";

function globExpression(pattern: string): RegExp {
	if (/[[\]{}()]/.test(pattern)) throw new Error("Bounded search supports *, ** and ? globs only; narrow the pattern");
	let expression = "";
	for (let i = 0; i < pattern.length; i++) {
		if (pattern.slice(i, i + 3) === "**/") {
			expression += "(?:.*/)?";
			i += 2;
		} else if (pattern.slice(i, i + 2) === "**") {
			expression += ".*";
			i++;
		} else if (pattern[i] === "*") expression += "[^/]*";
		else if (pattern[i] === "?") expression += "[^/]";
		else expression += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${expression}$`);
}
/** Bounded, on-demand traversal; no index, helper download, repository instructions, or subprocess authority. */
export async function boundedSearch(
	root: string,
	kind: "find" | "grep",
	args: Record<string, unknown>,
	signal?: AbortSignal,
	meter?: RetrievalMeter,
): Promise<AgentToolResult<unknown>> {
	const pattern = String(args.pattern);
	const limit = typeof args.limit === "number" ? args.limit : kind === "find" ? 1000 : 100;
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Search limit must be 1..1000");
	if (kind === "grep" && !args.literal && (pattern.length > 128 || /[()*+?{}\\]/.test(pattern)))
		throw new Error("Complex regex requires a reviewed bounded adapter; use literal=true or a simple regex");
	const regex = kind === "grep" && !args.literal ? new RegExp(pattern, args.ignoreCase ? "i" : "") : null;
	const glob =
		kind === "find" ? globExpression(pattern) : typeof args.glob === "string" ? globExpression(args.glob) : null;
	const pending = [root];
	const output: string[] = [];
	let files = 0;
	let volume = 0;
	let visited = 0;
	const omitted: string[] = [];
	while (pending.length && output.length < limit) {
		signal?.throwIfAborted();
		if (++visited > 1000) {
			omitted.push("1000 entry traversal cap");
			break;
		}
		const path = pending.pop()!;
		if (secretPath(path)) continue;
		const identity = await stat(path);
		if (identity.isDirectory()) {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (entry.isSymbolicLink() || entry.name === "node_modules" || secretPath(join(path, entry.name))) continue;
				if (pending.length >= 1000) {
					omitted.push("1000 pending entry cap");
					break;
				}
				pending.push(join(path, entry.name));
			}
			continue;
		}
		if (!identity.isFile()) continue;
		files++;
		const label = relative(root, path).replaceAll("\\", "/") || basename(path);
		if (glob && !glob.test(String(args.glob ?? pattern).includes("/") ? label : basename(path))) continue;
		if (kind === "find") {
			output.push(label);
			continue;
		}
		if (identity.size > 256 * 1024 || volume + identity.size > 8 * 1024 * 1024) {
			omitted.push(`File omitted at byte cap: ${label}`);
			continue;
		}
		const bytes = observedFile(path, meter);
		volume += bytes.length;
		if (bytes.includes(0)) {
			omitted.push(`Binary file omitted: ${label}`);
			continue;
		}
		const lines = bytes.toString("utf8").split("\n");
		for (let i = 0; i < lines.length && output.length < limit; i++) {
			if (lines[i].length > 20000) {
				omitted.push(`Long line omitted: ${label}:${i + 1}`);
				continue;
			}
			const haystack = args.ignoreCase ? lines[i].toLowerCase() : lines[i];
			const needle = args.ignoreCase ? pattern.toLowerCase() : pattern;
			if (regex ? regex.test(lines[i]) : haystack.includes(needle)) {
				const context = Math.min(typeof args.context === "number" ? args.context : 0, 5);
				for (let line = Math.max(0, i - context); line <= Math.min(lines.length - 1, i + context); line++)
					output.push(`${label}:${line + 1}: ${lines[line].slice(0, 2000)}`);
			}
		}
	}
	if (pending.length || output.length >= limit)
		omitted.push("Result limit reached; narrow path/pattern or make a separately charged invocation");
	return {
		content: [
			{
				type: "text",
				text:
					(output.join("\n") || "No matches found within bounded scan") +
					(omitted.length ? `\n[Partial scan: ${omitted.slice(0, 10).join("; ")}]` : ""),
			},
		],
		details: {
			complete: omitted.length === 0,
			omitted: omitted.slice(0, 10),
			inspected_files: files,
			retrieval_bytes: volume,
		},
	};
}
