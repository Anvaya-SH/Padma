import { lstat, opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import { inside, secretPath } from "../code.ts";
import { observedFile, type RetrievalMeter } from "../io.ts";
import { digest } from "../records.ts";
import { ContextError, type SourceDescriptor } from "./contracts.ts";

export interface TraversalManifest {
	version: "AVARTANA_TRAVERSAL/1";
	root: string;
	namespace: string;
	rules: string;
	entries: {
		locator: string;
		status: "PENDING" | "COMPLETE" | "EXCLUDED" | "FAILED";
		source: SourceDescriptor | null;
		reason: string | null;
	}[];
	excluded: string[];
	enumerationComplete: boolean;
	scannedBytes: number;
	matches: { source: SourceDescriptor; first: number; last: number }[];
	omittedKnownHits: number;
	stopReason: string | null;
	basis: string;
	consistency: string;
}
/** Incremental directory enumeration, bounded metadata, one capture at a time. Never executes source code or regex. */
export async function scanScope(
	root: string,
	namespace: string,
	literal: string | null,
	scanBytes: number,
	hits: number,
	timeout: number,
	meter: RetrievalMeter,
	retain: (path: string, bytes: Buffer) => SourceDescriptor,
	signal?: AbortSignal,
	previous?: TraversalManifest,
): Promise<TraversalManifest> {
	const deadline = performance.now() + timeout;
	const result: TraversalManifest = {
		version: "AVARTANA_TRAVERSAL/1",
		root,
		namespace,
		rules: "case-sensitive literal matching lines; regular UTF-8 files, includes untracked/ignored; excludes node_modules, protected paths, symlinks, binary and files above 8 MiB; no .gitignore semantics",
		entries: [],
		excluded: [],
		enumerationComplete: true,
		scannedBytes: 0,
		matches: [],
		omittedKnownHits: 0,
		stopReason: null,
		basis: "",
		consistency:
			"Per-file captures at different times; no corpus-wide current snapshot. Negative conclusions apply only to captured decoded corpus and literal semantics.",
	};
	const boundedMeter: RetrievalMeter = {
		...meter,
		reserve: (expectedBytes) => {
			if (expectedBytes > scanBytes - result.scannedBytes)
				throw new ContextError("BUDGET", "Source grew beyond the remaining traversal byte allowance before read");
			const settle = meter.reserve(expectedBytes);
			return (actualBytes) => {
				result.scannedBytes += actualBytes;
				settle(actualBytes);
			};
		},
	};
	const pending = [root];
	const stopped = () => {
		if (signal?.aborted) {
			result.stopReason = "CANCELLED";
			return true;
		}
		if (performance.now() >= deadline) {
			result.stopReason = "TIMEOUT";
			return true;
		}
		return false;
	};
	let discovered = 0;
	let enumeratedEntries = 0;
	while (pending.length && !stopped()) {
		const path = pending.pop()!;
		if (++discovered > 1000) {
			result.stopReason = "ENUMERATION_LIMIT";
			break;
		}
		const locator = relative(root, path).replaceAll("\\", "/") || ".";
		if (!inside(root, path) || secretPath(path)) {
			result.excluded.push(locator);
			continue;
		}
		try {
			const stat = await lstat(path);
			if (stat.isSymbolicLink()) {
				result.excluded.push(`${locator}: symlink`);
				continue;
			}
			if (stat.isDirectory()) {
				const directory = await opendir(path);
				for await (const entry of directory) {
					if (stopped() || ++enumeratedEntries > 1000 || pending.length + discovered >= 1000) {
						result.stopReason ??= "ENUMERATION_LIMIT";
						break;
					}
					if (entry.name === "node_modules" || entry.isSymbolicLink() || secretPath(join(path, entry.name))) {
						result.excluded.push(relative(root, join(path, entry.name)));
						continue;
					}
					pending.push(join(path, entry.name));
				}
			} else if (stat.isFile())
				result.entries.push({ locator: path, status: "PENDING", source: null, reason: null });
			else result.excluded.push(`${locator}: not regular`);
		} catch (error) {
			result.entries.push({
				locator: path,
				status: "FAILED",
				source: null,
				reason: error instanceof Error ? error.message : "Inaccessible",
			});
		}
	}
	result.enumerationComplete = pending.length === 0 && result.stopReason === null;
	result.entries.sort((a, b) => (a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : 0));
	result.basis = digest({ root, entries: result.entries.map((entry) => entry.locator), rules: result.rules });
	if (
		previous &&
		(previous.version !== result.version ||
			previous.root !== root ||
			previous.namespace !== namespace ||
			previous.basis !== result.basis ||
			!previous.enumerationComplete ||
			!result.enumerationComplete)
	)
		throw new ContextError(
			"STALE_VERSION",
			"Traversal scope changed or was not fully enumerated; rebuild rather than mixing corpora",
		);
	for (const entry of result.entries) {
		if (entry.status !== "PENDING") continue;
		if (stopped()) break;
		try {
			const stat = await lstat(entry.locator);
			if (stat.size > 8 * 1024 ** 2) {
				entry.status = "EXCLUDED";
				entry.reason = "OVERSIZED";
				result.excluded.push(entry.locator);
				continue;
			}
			if (stat.size + result.scannedBytes > scanBytes) {
				result.stopReason = "SCAN_BYTE_LIMIT";
				break;
			}
			const bytes = observedFile(entry.locator, boundedMeter);
			if (bytes.includes(0)) {
				entry.status = "EXCLUDED";
				entry.reason = "BINARY";
				result.excluded.push(entry.locator);
				continue;
			}
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				entry.status = "EXCLUDED";
				entry.reason = "LOSSY_UTF8";
				result.excluded.push(entry.locator);
				continue;
			}
			const prior = previous?.entries.find((item) => item.locator === entry.locator && item.status === "COMPLETE");
			if (prior?.source && digest(bytes) !== prior.source.generation)
				throw new ContextError(
					"STALE_VERSION",
					"Previously completed source changed; continuation cannot claim current completeness",
				);
			entry.source = prior?.source ?? retain(entry.locator, bytes);
			entry.status = "COMPLETE";
			if (literal !== null) {
				let begin = 0;
				let line = 0;
				while (begin < bytes.length) {
					if (stopped() || ++line > 1000000) {
						entry.status = "FAILED";
						entry.reason = result.stopReason ?? "LINE_INDEX_LIMIT";
						result.stopReason ??= "LINE_INDEX_LIMIT";
						break;
					}
					const newline = bytes.indexOf(10, begin);
					const end = newline < 0 ? bytes.length : newline + 1;
					if (bytes.subarray(begin, end).toString("utf8").includes(literal)) {
						if (result.matches.length < hits)
							result.matches.push({ source: entry.source, first: line, last: line });
						else result.omittedKnownHits++;
					}
					begin = end;
				}
			}
		} catch (error) {
			if (error instanceof ContextError || (error instanceof Error && "status" in error)) throw error;
			entry.status = "FAILED";
			entry.reason = error instanceof Error ? error.message : "Capture failed";
		}
	}
	return result;
}
