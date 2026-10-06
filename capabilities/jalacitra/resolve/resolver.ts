// Jālacitra Graph Resolver (Part J, J5-RES-001 through J5-RES-005, J5-TSE-013)

import type { ExtractResult, FileInfo } from "../adapters/adapter.ts";
import type { EdgeRecord } from "../model/edges.ts";
import { canonicalEdgeId, canonicalFileId, canonicalSymbolId, deriveId } from "../model/ids.ts";
import type { NodeRecord } from "../model/nodes.ts";
import { resolveModuleSpecifier } from "./module-resolver.ts";

export interface FileExtractionBatch {
	file: FileInfo;
	result: ExtractResult;
}

export interface ResolvedGraph {
	nodes: NodeRecord[];
	edges: EdgeRecord[];
	rowDependencies: Array<{
		rowKind: "node" | "edge";
		rowId: string;
		dependsOnFile?: string;
		dependsOnConfig?: string;
	}>;
}

export function resolveGraph(repoId: string, generation: number, extractions: FileExtractionBatch[]): ResolvedGraph {
	const nodes: NodeRecord[] = [];
	const edges: EdgeRecord[] = [];
	const rowDependencies: ResolvedGraph["rowDependencies"] = [];

	const knownFiles = new Set<string>(extractions.map((e) => e.file.path));
	const fileNodeMap = new Map<string, string>(); // path -> fileNodeId
	const symbolsByFile = new Map<string, Map<string, string>>(); // fileNodeId -> (symbolName -> symbolNodeId)
	const exportedSymbolsByFile = new Map<string, Map<string, string>>(); // fileNodeId -> (exportedName -> symbolNodeId)
	const _reexportsByFile = new Map<string, Array<{ targetSpecifier: string; exportedName?: string }>>();

	// Step 1: Create File and Symbol nodes
	for (const { file, result } of extractions) {
		const canonicalFile = canonicalFileId(repoId, file.path);
		const fileId = deriveId(canonicalFile);
		fileNodeMap.set(file.path, fileId);

		nodes.push({
			id: fileId,
			kind: "file",
			canonical: canonicalFile,
			name: file.path.split("/").pop() ?? file.path,
			parent_id: null,
			valid_from: generation,
			valid_to: null,
			attrs: {
				path: file.path,
				language: file.language,
				class: file.class,
				size_bytes: file.sizeBytes,
				content_digest: file.contentDigest,
				is_binary: file.isBinary,
			},
		});

		const fileSymbols = new Map<string, string>();
		const fileExported = new Map<string, string>();

		for (const decl of result.declarations) {
			const canonicalSym = canonicalSymbolId(fileId, decl.kind, decl.qualifiedName);
			const symId = deriveId(canonicalSym);

			fileSymbols.set(decl.name, symId);
			if (decl.exported) {
				fileExported.set(decl.name, symId);
			}

			nodes.push({
				id: symId,
				kind: "symbol",
				canonical: canonicalSym,
				name: decl.name,
				parent_id: fileId,
				valid_from: generation,
				valid_to: null,
				attrs: {
					symbol_kind: decl.kind,
					qualified_name: decl.qualifiedName,
					visibility: decl.visibility,
					exported: decl.exported,
					signature_digest: decl.signatureDigest,
					start_line: decl.range.startLine,
					end_line: decl.range.endLine,
					start_byte: decl.range.startByte,
					end_byte: decl.range.endByte,
				},
			});

			// File contains / declares symbol
			const edgeId = deriveId(canonicalEdgeId("declares", fileId, symId, "PARSED", "ast"));
			edges.push({
				id: edgeId,
				kind: "declares",
				src: fileId,
				dst: symId,
				class: "PARSED",
				method: "ast",
				ambiguity: "UNIQUE",
				weight: 1,
				valid_from: generation,
				valid_to: null,
				src_file: fileId,
				src_start: decl.range.startByte,
				src_end: decl.range.endByte,
				src_digest: decl.range.contentDigest,
			});
			rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: fileId });
		}

		// Create config_key nodes from declared configKeys (e.g. dotenv, json, yaml)
		for (const ck of result.configKeys) {
			const cfgCanonical = `repo:${repoId}:config_key:${ck.name}`;
			const cfgId = deriveId(cfgCanonical);
			nodes.push({
				id: cfgId,
				kind: "config_key",
				canonical: cfgCanonical,
				name: ck.name,
				parent_id: fileId,
				valid_from: generation,
				valid_to: null,
				attrs: {
					scope: ck.scope,
					key_path: ck.name,
					declared: true,
				},
			});
			const edgeId = deriveId(canonicalEdgeId("declares", fileId, cfgId, "PARSED", "config_adapter"));
			edges.push({
				id: edgeId,
				kind: "declares",
				src: fileId,
				dst: cfgId,
				class: "PARSED",
				method: "config_adapter",
				ambiguity: "UNIQUE",
				weight: 1,
				valid_from: generation,
				valid_to: null,
			});
			rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: fileId });
		}

		symbolsByFile.set(fileId, fileSymbols);
		exportedSymbolsByFile.set(fileId, fileExported);
	}

	// Step 2: Resolve References and Create Edges
	for (const { file, result } of extractions) {
		const srcFileId = fileNodeMap.get(file.path)!;
		const localSymbols = symbolsByFile.get(srcFileId) ?? new Map<string, string>();

		// Track imports from other files: importedName -> targetSymbolId
		const importedSymbols = new Map<string, string[]>();

		for (const ref of result.references) {
			// 1. Imports / Re-exports
			if (ref.referenceKind === "imports" && ref.targetSpecifier) {
				const resolved = resolveModuleSpecifier(file.path, ref.targetSpecifier, knownFiles);

				if (resolved.status === "RESOLVED_FILE" && resolved.targetPath) {
					const targetFileId = fileNodeMap.get(resolved.targetPath);
					if (targetFileId) {
						const edgeId = deriveId(
							canonicalEdgeId("imports", srcFileId, targetFileId, "PARSED", "specifier_resolver"),
						);
						edges.push({
							id: edgeId,
							kind: "imports",
							src: srcFileId,
							dst: targetFileId,
							class: "PARSED",
							method: "specifier_resolver",
							ambiguity: "UNIQUE",
							weight: 1,
							valid_from: generation,
							valid_to: null,
							src_file: srcFileId,
							src_start: ref.range.startByte,
							src_end: ref.range.endByte,
							src_digest: ref.range.contentDigest,
							attrs: ref.attrs,
						});
						rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: srcFileId });
						rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: targetFileId });

						// Add exported symbols of target file to imported symbols
						const targetExports = exportedSymbolsByFile.get(targetFileId);
						if (targetExports) {
							for (const [expName, symId] of targetExports.entries()) {
								const existing = importedSymbols.get(expName) ?? [];
								existing.push(symId);
								importedSymbols.set(expName, existing);
							}
						}
					}
				} else if (resolved.status === "RESOLVED_DEPENDENCY" && resolved.targetPackageName) {
					// External dependency
					const depCanonical = `repo:${repoId}:dependency:${resolved.targetPackageName}`;
					const depId = deriveId(depCanonical);
					nodes.push({
						id: depId,
						kind: "dependency",
						canonical: depCanonical,
						name: resolved.targetPackageName,
						parent_id: null,
						valid_from: generation,
						valid_to: null,
						attrs: { name: resolved.targetPackageName, ecosystem: "npm" },
					});

					const edgeId = deriveId(canonicalEdgeId("depends_on", srcFileId, depId, "PARSED", "specifier_resolver"));
					edges.push({
						id: edgeId,
						kind: "depends_on",
						src: srcFileId,
						dst: depId,
						class: "PARSED",
						method: "specifier_resolver",
						ambiguity: "UNIQUE",
						weight: 1,
						valid_from: generation,
						valid_to: null,
						src_file: srcFileId,
						src_start: ref.range.startByte,
						src_end: ref.range.endByte,
						src_digest: ref.range.contentDigest,
					});
					rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: srcFileId });
				} else {
					// Unresolved module import
					const unresCanonical = `repo:${repoId}:unresolved_ref:${ref.targetSpecifier}`;
					const unresId = deriveId(unresCanonical);
					nodes.push({
						id: unresId,
						kind: "unresolved_ref",
						canonical: unresCanonical,
						name: ref.targetSpecifier,
						parent_id: null,
						valid_from: generation,
						valid_to: null,
						attrs: {
							raw_text_digest: ref.range.contentDigest,
							reference_kind: "imports",
							reason_code: resolved.reasonCode ?? "NO_SUCH_MODULE",
						},
					});

					const edgeId = deriveId(
						canonicalEdgeId("unresolved_to", srcFileId, unresId, "PARSED", "specifier_resolver"),
					);
					edges.push({
						id: edgeId,
						kind: "unresolved_to",
						src: srcFileId,
						dst: unresId,
						class: "PARSED",
						method: "specifier_resolver",
						ambiguity: "UNRESOLVED",
						weight: 1,
						valid_from: generation,
						valid_to: null,
						src_file: srcFileId,
						src_start: ref.range.startByte,
						src_end: ref.range.endByte,
						src_digest: ref.range.contentDigest,
					});
					rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: srcFileId });
				}
			}

			// 2. Calls
			else if (ref.referenceKind === "calls" && ref.targetSpecifier) {
				const calleeName = ref.targetSpecifier.split(".")[0];
				let targetSymIds: string[] = [];

				// Check local scope first
				const localSym = localSymbols.get(calleeName);
				if (localSym) {
					targetSymIds = [localSym];
				} else {
					// Check imported symbols
					const imported = importedSymbols.get(calleeName);
					if (imported && imported.length > 0) {
						targetSymIds = imported;
					}
				}

				// Find enclosing caller symbol if call occurs inside a function/method
				let callerId = srcFileId;
				let bestSpan = Infinity;
				for (const decl of result.declarations) {
					if (decl.range.startByte <= ref.range.startByte && decl.range.endByte >= ref.range.endByte) {
						const span = decl.range.endByte - decl.range.startByte;
						if (span < bestSpan) {
							const symId = localSymbols.get(decl.name);
							if (symId) {
								callerId = symId;
								bestSpan = span;
							}
						}
					}
				}

				if (targetSymIds.length === 1) {
					const targetSymId = targetSymIds[0];
					const edgeId = deriveId(canonicalEdgeId("calls", callerId, targetSymId, "PARSED", "ast"));
					edges.push({
						id: edgeId,
						kind: "calls",
						src: callerId,
						dst: targetSymId,
						class: "PARSED",
						method: "ast",
						ambiguity: "UNIQUE",
						weight: 1,
						valid_from: generation,
						valid_to: null,
						src_file: srcFileId,
						src_start: ref.range.startByte,
						src_end: ref.range.endByte,
						src_digest: ref.range.contentDigest,
						attrs: ref.attrs ?? {},
					});
					rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: srcFileId });
				} else if (targetSymIds.length > 1) {
					// MULTI ambiguity candidate group
					const candidateGroupId = deriveId(`candidate_group:${ref.targetSpecifier}:${ref.range.startByte}`);
					for (const targetSymId of targetSymIds) {
						const edgeId = deriveId(canonicalEdgeId("calls", callerId, targetSymId, "PARSED", "ast"));
						edges.push({
							id: edgeId,
							kind: "calls",
							src: callerId,
							dst: targetSymId,
							class: "PARSED",
							method: "ast",
							ambiguity: "MULTI",
							candidate_group: candidateGroupId,
							candidate_reason: "EXPORTED_MATCH",
							weight: 1,
							valid_from: generation,
							valid_to: null,
							src_file: srcFileId,
							src_start: ref.range.startByte,
							src_end: ref.range.endByte,
							src_digest: ref.range.contentDigest,
							attrs: ref.attrs ?? {},
						});
						rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: srcFileId });
					}
				} else {
					// Unresolved call
					const unresCanonical = `repo:${repoId}:unresolved_call:${ref.targetSpecifier}`;
					const unresId = deriveId(unresCanonical);
					nodes.push({
						id: unresId,
						kind: "unresolved_ref",
						canonical: unresCanonical,
						name: ref.targetSpecifier,
						parent_id: null,
						valid_from: generation,
						valid_to: null,
						attrs: {
							raw_text_digest: ref.range.contentDigest,
							reference_kind: "calls",
							reason_code: "NO_SUCH_EXPORT",
						},
					});

					const edgeId = deriveId(canonicalEdgeId("unresolved_to", srcFileId, unresId, "PARSED", "ast"));
					edges.push({
						id: edgeId,
						kind: "unresolved_to",
						src: srcFileId,
						dst: unresId,
						class: "PARSED",
						method: "ast",
						ambiguity: "UNRESOLVED",
						weight: 1,
						valid_from: generation,
						valid_to: null,
						src_file: srcFileId,
						src_start: ref.range.startByte,
						src_end: ref.range.endByte,
						src_digest: ref.range.contentDigest,
					});
					rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: srcFileId });
				}
			}

			// 3. Config reads
			else if (ref.referenceKind === "reads_config" && ref.targetSpecifier) {
				const configKeyName = ref.targetSpecifier;
				const cfgCanonical = `repo:${repoId}:config_key:${configKeyName}`;
				const cfgId = deriveId(cfgCanonical);

				const existingNode = nodes.find((n) => n.id === cfgId);
				if (!existingNode) {
					nodes.push({
						id: cfgId,
						kind: "config_key",
						canonical: cfgCanonical,
						name: configKeyName,
						parent_id: null,
						valid_from: generation,
						valid_to: null,
						attrs: { scope: "env_var", key_path: configKeyName, declared: false },
					});
				}

				const edgeId = deriveId(canonicalEdgeId("reads_config", srcFileId, cfgId, "PARSED", "ast"));
				edges.push({
					id: edgeId,
					kind: "reads_config",
					src: srcFileId,
					dst: cfgId,
					class: "PARSED",
					method: "ast",
					ambiguity: "UNIQUE",
					weight: 1,
					valid_from: generation,
					valid_to: null,
					src_file: srcFileId,
					src_start: ref.range.startByte,
					src_end: ref.range.endByte,
					src_digest: ref.range.contentDigest,
				});
				rowDependencies.push({ rowKind: "edge", rowId: edgeId, dependsOnFile: srcFileId });
			}
		}
	}

	return { nodes, edges, rowDependencies };
}
