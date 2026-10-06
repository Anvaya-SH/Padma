// Jālacitra Cross-File Linkers (Part J2, J5-LINK-001, J5-LINK-002)

import type { EdgeRecord } from "../model/edges.ts";
import { canonicalEdgeId, deriveId } from "../model/ids.ts";
import type { NodeRecord } from "../model/nodes.ts";

export interface LinkerContext {
	repoId: string;
	generation: number;
	nodes: NodeRecord[];
	edges: EdgeRecord[];
}

export function linkTestsToCode(ctx: LinkerContext): EdgeRecord[] {
	const newEdges: EdgeRecord[] = [];
	const testFiles = ctx.nodes.filter((n) => n.kind === "file" && n.attrs?.class === "test");
	const sourceFiles = ctx.nodes.filter((n) => n.kind === "file" && n.attrs?.class === "source");
	const sourceFileByPath = new Map<string, NodeRecord>();
	for (const sf of sourceFiles) {
		sourceFileByPath.set(String(sf.attrs?.path ?? sf.name ?? sf.id), sf);
	}

	for (const tf of testFiles) {
		const testPath = String(tf.attrs?.path ?? tf.name ?? tf.id);

		// 1. Name convention link: foo.test.ts -> foo.ts, foo.spec.tsx -> foo.tsx
		const stripped = testPath
			.replace(/\.(test|spec)\./, ".")
			.replace(/__tests__\//, "")
			.replace(/^test\//, "src/")
			.replace(/^tests\//, "src/");

		const matchedSource = sourceFileByPath.get(stripped);
		if (matchedSource) {
			const edgeId = deriveId(canonicalEdgeId("tests", tf.id, matchedSource.id, "INFERRED", "name_convention"));
			newEdges.push({
				id: edgeId,
				kind: "tests",
				src: tf.id,
				dst: matchedSource.id,
				class: "INFERRED",
				method: "name_convention",
				ambiguity: "UNIQUE",
				weight: 1,
				valid_from: ctx.generation,
				valid_to: null,
				attrs: { reason: "NAME_CONVENTION" },
			});
		}

		// 2. Import-based test links
		const imports = ctx.edges.filter((e) => e.kind === "imports" && e.src === tf.id);
		for (const imp of imports) {
			const targetFile = ctx.nodes.find((n) => n.id === imp.dst);
			if (targetFile && targetFile.attrs?.class === "source") {
				const edgeId = deriveId(canonicalEdgeId("tests", tf.id, targetFile.id, "PARSED", "imports_only"));
				newEdges.push({
					id: edgeId,
					kind: "tests",
					src: tf.id,
					dst: targetFile.id,
					class: "PARSED",
					method: "imports_only",
					ambiguity: "UNIQUE",
					weight: 1,
					valid_from: ctx.generation,
					valid_to: null,
					attrs: { reason: "IMPORTS_ONLY" },
				});
			}
		}

		// 3. Import + Calls-based test links (J5-LINK-001)
		const callsFromTest = ctx.edges.filter((e) => e.kind === "calls" && (e.src === tf.id || e.src_file === tf.id));
		const calledSymbolIds = new Set(callsFromTest.map((c) => c.dst));
		for (const symId of calledSymbolIds) {
			const symNode = ctx.nodes.find((n) => n.id === symId);
			if (symNode && symNode.kind === "symbol") {
				const edgeId = deriveId(canonicalEdgeId("tests", tf.id, symNode.id, "PARSED", "imports_and_calls"));
				newEdges.push({
					id: edgeId,
					kind: "tests",
					src: tf.id,
					dst: symNode.id,
					class: "PARSED",
					method: "imports_and_calls",
					ambiguity: "UNIQUE",
					weight: 1,
					valid_from: ctx.generation,
					valid_to: null,
					attrs: { reason: "IMPORTS_AND_CALLS" },
				});
			}
		}
	}

	return newEdges;
}

export function linkConfigToCode(ctx: LinkerContext): { newNodes: NodeRecord[]; newEdges: EdgeRecord[] } {
	const newNodes: NodeRecord[] = [];
	const newEdges: EdgeRecord[] = [];

	const readsConfigEdges = ctx.edges.filter((e) => e.kind === "reads_config");
	const configNodes = new Map<string, NodeRecord>();
	for (const n of ctx.nodes) {
		if (n.kind === "config_key") {
			configNodes.set(n.name ?? "", n);
		}
	}

	for (const edge of readsConfigEdges) {
		const targetConfigNode = configNodes.get(edge.dst);
		if (!targetConfigNode) {
			// If target config_key node didn't exist from a declaration, mark declared=false
			const cfgCanonical = `repo:${ctx.repoId}:config_key:${edge.dst}`;
			const cfgId = deriveId(cfgCanonical);
			if (!configNodes.has(edge.dst)) {
				const newNode: NodeRecord = {
					id: cfgId,
					kind: "config_key",
					canonical: cfgCanonical,
					name: edge.dst,
					parent_id: null,
					valid_from: ctx.generation,
					valid_to: null,
					attrs: { scope: "env_var", key_path: edge.dst, declared: false },
				};
				newNodes.push(newNode);
				configNodes.set(edge.dst, newNode);
			}
		}
	}

	return { newNodes, newEdges };
}
