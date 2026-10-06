// Jālacitra File Enumeration and Confinement (Part F, Part O1, J5-INV-001 through J5-INV-007, J5-SEC-001, J5-SEC-002)

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { normalizeRepoPath } from "../model/ids.ts";
import type { FileClass } from "../model/nodes.ts";
import { classifyFile } from "./classify.ts";
import { computeDigest } from "./digest.ts";
import { IgnoreEngine } from "./ignore.ts";

export interface InventoryOptions {
	maxFileSize?: number; // default 1 MiB (1048576)
	maxFiles?: number; // default 100,000
	scopePaths?: string[]; // optional sub-paths to limit enumeration
	padmaignoreContent?: string;
	gitignoreContent?: string;
	calculateDigests?: boolean; // default true
}

export interface InventoryEntry {
	path: string; // repo-relative with forward slashes
	absolutePath: string;
	language: string | null;
	class: FileClass;
	sizeBytes: number;
	contentDigest: string;
	mtimeNs: string | number | null;
	isBinary: boolean;
	skipReason?: string;
	declarationFile?: boolean;
}

export interface InventoryResult {
	repoRoot: string;
	files: InventoryEntry[];
	skippedFiles: Array<{ path: string; reasonCode: string }>;
	totalBytes: number;
	durationMs: number;
}

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_FILES = 100000;

export function enumerateRepository(repoRoot: string, options: InventoryOptions = {}): InventoryResult {
	const startTime = Date.now();
	const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const calculateDigests = options.calculateDigests ?? true;

	const canonicalRoot = realpathSync(repoRoot);

	// Load ignore files if not supplied
	let padmaignoreContent = options.padmaignoreContent;
	if (padmaignoreContent === undefined) {
		try {
			padmaignoreContent = readFileSync(join(canonicalRoot, ".padmaignore"), "utf8");
		} catch {
			padmaignoreContent = undefined;
		}
	}

	let gitignoreContent = options.gitignoreContent;
	if (gitignoreContent === undefined) {
		try {
			gitignoreContent = readFileSync(join(canonicalRoot, ".gitignore"), "utf8");
		} catch {
			gitignoreContent = undefined;
		}
	}

	const ignoreEngine = new IgnoreEngine(padmaignoreContent, gitignoreContent);

	const entries: InventoryEntry[] = [];
	const skipped: Array<{ path: string; reasonCode: string }> = [];
	let totalBytes = 0;

	// Recursive walk helper
	function walk(currentDir: string): void {
		if (entries.length >= maxFiles) {
			return;
		}

		let dirents: import("node:fs").Dirent[];
		try {
			dirents = readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const dirent of dirents) {
			const fullPath = join(currentDir, dirent.name);
			const relPath = normalizeRepoPath(relative(canonicalRoot, fullPath));

			// Check symlink escape
			const isSymlink = dirent.isSymbolicLink();
			let targetPath = fullPath;
			if (isSymlink) {
				try {
					targetPath = realpathSync(fullPath);
					const relTarget = relative(canonicalRoot, targetPath);
					if (relTarget.startsWith("..") || isAbsolute(relTarget)) {
						skipped.push({ path: relPath, reasonCode: "SYMLINK_OUTSIDE_ROOT" });
						continue;
					}
				} catch {
					skipped.push({ path: relPath, reasonCode: "SYMLINK_OUTSIDE_ROOT" });
					continue;
				}
			}

			let stats: import("node:fs").Stats;
			try {
				stats = statSync(targetPath);
			} catch {
				continue;
			}

			const isDirectory = stats.isDirectory();

			// Evaluate ignore engine
			const ignoreCheck = ignoreEngine.evaluate(relPath, isDirectory);
			if (ignoreCheck.ignored) {
				if (ignoreCheck.reasonCode) {
					skipped.push({ path: relPath, reasonCode: ignoreCheck.reasonCode });
				}
				continue;
			}

			if (isDirectory) {
				walk(fullPath);
			} else if (stats.isFile()) {
				const sizeBytes = stats.size;
				totalBytes += sizeBytes;

				let skipReason: string | undefined;
				if (sizeBytes > maxFileSize) {
					skipReason = "FILE_TOO_LARGE";
					skipped.push({ path: relPath, reasonCode: "FILE_TOO_LARGE" });
				}

				let snippet: Uint8Array | undefined;
				let digest = "sha256:empty";

				try {
					if (sizeBytes > 0 && sizeBytes <= maxFileSize) {
						const buf = readFileSync(fullPath);
						snippet = buf.subarray(0, 4096);
						if (calculateDigests) {
							digest = computeDigest(buf);
						}
					} else if (sizeBytes > maxFileSize) {
						// For large files, compute digest or skip loading
						digest = `sha256:oversized_${sizeBytes}`;
					}
				} catch {
					continue;
				}

				const classification = classifyFile(relPath, snippet);

				const mtimeNs = String(Math.floor(stats.mtimeMs * 1_000_000));

				entries.push({
					path: relPath,
					absolutePath: fullPath,
					language: classification.language,
					class: classification.class,
					sizeBytes,
					contentDigest: digest,
					mtimeNs,
					isBinary: classification.isBinary,
					skipReason,
					declarationFile: classification.declarationFile,
				});
			}
		}
	}

	walk(canonicalRoot);

	return {
		repoRoot: canonicalRoot,
		files: entries,
		skippedFiles: skipped,
		totalBytes,
		durationMs: Date.now() - startTime,
	};
}
