// Jālacitra atlas.dependencies Operation (Part M2, I6)

import type { NodeRecord } from "../model/nodes.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface DependenciesParams {
	package_id?: string;
	file_id?: string;
	transitive?: boolean;
	max_depth?: number;
}

export interface DeclaredDependency {
	name: string;
	ecosystem: string;
	dependency_type: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies" | "unknown";
	version_spec: string;
	resolved_version: null; // explicitly null in Phase 5 per J5-DEP
	node: NodeRecord;
	depth: number;
}

export interface DependenciesData {
	target_id: string;
	package_node: NodeRecord | null;
	dependencies: DeclaredDependency[];
	transitive: boolean;
}

export function dependencies(
	ctx: QueryContext,
	store: JalacitraStore,
	params: DependenciesParams,
): QueryResult<DependenciesData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const targetId = params.package_id ?? params.file_id;
	if (!targetId) {
		throw new Error("dependencies operation requires package_id or file_id");
	}

	const targetName = targetId.split(":").pop() ?? targetId;

	let packageNode = store.getNode(targetId, genNum);
	if (!packageNode) {
		const row = store.rawDb
			.prepare(
				`SELECT * FROM nodes 
				 WHERE (id = ? OR canonical = ? OR name = ? OR name = ? OR canonical LIKE ?) 
				   AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
			)
			.get(targetId, targetId, targetId, targetName, `%:${targetName}`, genNum, genNum) as
			| Record<string, unknown>
			| undefined;
		if (row) {
			packageNode = {
				id: String(row.id),
				kind: row.kind as NodeRecord["kind"],
				canonical: String(row.canonical),
				name: row.name ? String(row.name) : null,
				parent_id: row.parent_id ? String(row.parent_id) : null,
				valid_from: Number(row.valid_from),
				valid_to: row.valid_to !== null ? Number(row.valid_to) : null,
				attrs: typeof row.attrs === "string" ? JSON.parse(row.attrs) : (row.attrs ?? {}),
			};
		}
	}
	if (packageNode && packageNode.kind !== "package") {
		// If targetId is a file (e.g. package.json), look for associated package node
		const pkgNodes = store.findNodesByKind("package", genNum);
		const matchingPkg = pkgNodes.find(
			(p) => p.parent_id === targetId || p.canonical.includes(packageNode?.canonical ?? ""),
		);
		if (matchingPkg) {
			packageNode = matchingPkg;
		}
	}

	const collectedDeps: DeclaredDependency[] = [];
	const maxDepth = params.transitive ? Math.min(Math.max(1, params.max_depth ?? 3), 5) : 1;

	if (packageNode) {
		const visitedPackages = new Set<string>([packageNode.id]);
		interface QueueItem {
			pkgId: string;
			depth: number;
		}
		const queue: QueueItem[] = [{ pkgId: packageNode.id, depth: 1 }];

		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) break;
			if (item.depth > maxDepth) continue;

			let depEdges = store.getEdgesFrom(item.pkgId, "depends_on", genNum);
			if (depEdges.length === 0 && packageNode.parent_id) {
				depEdges = store.getEdgesFrom(packageNode.parent_id, "depends_on", genNum);
			}
			tracker.recordRowsScanned(depEdges.length);

			for (const edge of depEdges) {
				const depNode = store.getNode(edge.dst, genNum);
				if (!depNode) continue;

				const depType = (edge.attrs?.dependency_type as DeclaredDependency["dependency_type"]) ?? "unknown";
				const versionSpec = String(edge.attrs?.version_spec ?? "*");

				collectedDeps.push({
					name: depNode.name ?? depNode.canonical.split(":").pop() ?? "",
					ecosystem: String(depNode.attrs?.ecosystem ?? "npm"),
					dependency_type: depType,
					version_spec: versionSpec,
					resolved_version: null, // J5 requirement: no resolved versions claimed in Phase 5
					node: depNode,
					depth: item.depth,
				});

				// If transitive, and this dep is also a workspace package
				if (params.transitive && depNode.kind === "package" && !visitedPackages.has(depNode.id)) {
					visitedPackages.add(depNode.id);
					queue.push({ pkgId: depNode.id, depth: item.depth + 1 });
				}
			}
		}
	}

	// Deterministic sorting: dependency_type, then name
	collectedDeps.sort((a, b) => {
		const typeCmp = a.dependency_type.localeCompare(b.dependency_type);
		if (typeCmp !== 0) return typeCmp;
		return a.name.localeCompare(b.name);
	});

	tracker.recordRowsReturned(collectedDeps.length);

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	const data: DependenciesData = {
		target_id: targetId,
		package_node: packageNode,
		dependencies: collectedDeps,
		transitive: Boolean(params.transitive),
	};

	return buildQueryResult<DependenciesData>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage,
		usage: tracker.report(),
	});
}
