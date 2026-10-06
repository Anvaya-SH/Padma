// Jālacitra Identity Principles (Part F1, J5-ID-001 through J5-ID-007)

import { createHash } from "node:crypto";

export const SCHEMA_NAMESPACE = "jalacitra:v1";

export interface LocationHandle {
	file_id: string;
	start_byte: number;
	end_byte: number;
	start_line: number;
	end_line: number;
	content_digest_of_file: string;
	generation: number;
}

export function normalizeRepoPath(filePath: string): string {
	let normalized = filePath.replace(/\\/g, "/");
	while (normalized.startsWith("/")) {
		normalized = normalized.slice(1);
	}
	if (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	const parts = normalized.split("/");
	const clean: string[] = [];
	for (const p of parts) {
		if (p === "" || p === ".") continue;
		if (p === "..") {
			clean.pop();
		} else {
			clean.push(p);
		}
	}
	return clean.join("/");
}

export function hashString(value: string, length = 16): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function deriveId(canonical: string, namespace = SCHEMA_NAMESPACE): string {
	return hashString(`${namespace}:${canonical}`, 24);
}

export function deriveRepoIdentity(rootPath: string, initialCommitOrMarker: string, worktreeId = "default"): string {
	return hashString(`repo:${normalizeRepoPath(rootPath)}:${initialCommitOrMarker}:${worktreeId}`, 32);
}

export function canonicalRepositoryId(repoIdentity: string): string {
	return `repo:${repoIdentity}`;
}

export function canonicalCommitId(repoId: string, sha: string): string {
	return `commit:${repoId}:${sha}`;
}

export function canonicalWorkspaceGenerationId(repoId: string, indexGeneration: number): string {
	return `gen:${repoId}:${indexGeneration}`;
}

export function canonicalFileId(repoId: string, repoRelativePath: string): string {
	return `file:${repoId}:${normalizeRepoPath(repoRelativePath)}`;
}

export function canonicalModuleId(repoId: string, language: string, modulePath: string): string {
	return `mod:${repoId}:${language}:${normalizeRepoPath(modulePath)}`;
}

export function canonicalSymbolId(fileId: string, kind: string, qualifiedName: string, disambiguator?: string): string {
	const suffix = disambiguator ? `:${disambiguator}` : "";
	return `sym:${fileId}:${kind}:${qualifiedName}${suffix}`;
}

export function canonicalDependencyId(repoId: string, ecosystem: string, name: string): string {
	return `dep:${repoId}:${ecosystem}:${name}`;
}

export function canonicalPackageId(repoId: string, ecosystem: string, name: string): string {
	return `pkg:${repoId}:${ecosystem}:${name}`;
}

export function canonicalBuildTargetId(repoId: string, configFileId: string, targetName: string): string {
	return `target:${repoId}:${configFileId}:${targetName}`;
}

export function canonicalBuildArtifactId(repoId: string, producedByTargetId: string, pathPattern: string): string {
	return `artifact:${repoId}:${producedByTargetId}:${normalizeRepoPath(pathPattern)}`;
}

export function canonicalTestCaseId(fileId: string, qualifiedName: string): string {
	return `test:${fileId}:${qualifiedName}`;
}

export function canonicalConfigKeyId(repoId: string, scope: string, keyPath: string): string {
	return `cfg:${repoId}:${scope}:${keyPath}`;
}

export function canonicalExternalContractId(repoId: string, contractKind: string, descriptor: string): string {
	return `contract:${repoId}:${contractKind}:${descriptor}`;
}

export function canonicalUnresolvedRefId(fileId: string, referenceKind: string, rawTextDigest: string): string {
	return `unresolved:${fileId}:${referenceKind}:${rawTextDigest}`;
}

export function canonicalEdgeId(
	kind: string,
	srcId: string,
	dstId: string,
	provenanceClass: string,
	extractionMethod: string,
	sourceRefDigest = "",
): string {
	return `edge:${kind}:${srcId}->${dstId}:${provenanceClass}:${extractionMethod}:${sourceRefDigest}`;
}
