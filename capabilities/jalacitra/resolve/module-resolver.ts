// Jālacitra Module Specifier Resolver (Part I4, J1, J5-RES-001 through J5-RES-004)

import { dirname, join } from "node:path";
import { normalizeRepoPath } from "../model/ids.ts";

export interface ResolvedModule {
	status: "RESOLVED_FILE" | "RESOLVED_DEPENDENCY" | "UNRESOLVED";
	targetPath?: string; // normalized repo-relative path if resolved to file
	targetPackageName?: string; // package name if bare specifier
	reasonCode?: string; // reason if unresolved
}

const TS_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".d.ts", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

export function resolveModuleSpecifier(
	fromFilePath: string,
	specifier: string,
	knownFiles: Set<string>,
): ResolvedModule {
	const trimmed = specifier.trim();

	// 1. Relative import (starts with . or ..)
	if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed === "." || trimmed === "..") {
		const fromDir = dirname(fromFilePath);
		const basePath = normalizeRepoPath(join(fromDir, trimmed));

		for (const ext of TS_EXTENSIONS) {
			const candidate = normalizeRepoPath(basePath + ext);
			if (knownFiles.has(candidate)) {
				return {
					status: "RESOLVED_FILE",
					targetPath: candidate,
				};
			}
		}

		return {
			status: "UNRESOLVED",
			reasonCode: "NO_SUCH_MODULE",
		};
	}

	// 2. Node.js built-in or bare specifier
	if (trimmed.startsWith("node:") || !trimmed.startsWith("/")) {
		return {
			status: "RESOLVED_DEPENDENCY",
			targetPackageName: trimmed,
		};
	}

	return {
		status: "UNRESOLVED",
		reasonCode: "NO_SUCH_MODULE",
	};
}
