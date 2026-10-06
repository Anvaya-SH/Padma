// Jālacitra atlas.config_usage Operation (Part M2, J5-CFG-001)

import type { NodeRecord } from "../model/nodes.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface ConfigUsageParams {
	key?: string;
	configKey?: string;
}

export interface ConfigReader {
	reader_node: NodeRecord;
	file_path: string;
	is_client_exposed: boolean;
	provenance_class: string;
}

export interface ConfigUsageData {
	key: string;
	readers: ConfigReader[];
	declaring_files: string[];
	read_but_not_declared: boolean;
	declared_but_not_read: boolean;
}

export function configUsage(
	ctx: QueryContext,
	store: JalacitraStore,
	params: ConfigUsageParams,
): QueryResult<ConfigUsageData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const db = store.rawDb;

	const keyName = params.key ?? params.configKey ?? "";

	// Find config_key nodes matching key name
	const configNodes = db
		.prepare(
			`SELECT * FROM nodes 
			 WHERE kind = 'config_key' 
			   AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
			   AND (name = ? OR canonical LIKE ?)`,
		)
		.all(genNum, genNum, keyName, `%:${keyName}`) as Array<Record<string, unknown>>;
	tracker.recordRowsScanned(configNodes.length);

	const declaringFiles = new Set<string>();
	const readersMap = new Map<string, ConfigReader>();

	for (const row of configNodes) {
		const attrs = typeof row.attrs === "string" ? JSON.parse(row.attrs) : (row.attrs ?? {});
		const isDeclared = attrs.declared !== false;
		if (isDeclared && row.parent_id) {
			const declaringFile = store.getFile(String(row.parent_id));
			if (declaringFile) {
				declaringFiles.add(declaringFile.path);
			}
		}

		// Find edges where dst = row.id and kind = 'reads_config'
		const readsEdges = store.getEdgesTo(String(row.id), "reads_config", genNum);
		tracker.recordRowsScanned(readsEdges.length);

		for (const edge of readsEdges) {
			const readerNode = store.getNode(edge.src, genNum);
			if (!readerNode) continue;

			const fileId = readerNode.parent_id ?? readerNode.id;
			const fileRec = store.getFile(fileId);
			const filePath = fileRec?.path ?? "unknown";
			const isClientExposed = Boolean(edge.attrs?.exposed_to_client || readerNode.attrs?.exposed_to_client);

			readersMap.set(readerNode.id, {
				reader_node: readerNode,
				file_path: filePath,
				is_client_exposed: isClientExposed,
				provenance_class: edge.class,
			});
		}
	}

	const sortedDeclaringFiles = Array.from(declaringFiles).sort();
	const sortedReaders = Array.from(readersMap.values()).sort(
		(a, b) =>
			a.file_path.localeCompare(b.file_path) || a.reader_node.canonical.localeCompare(b.reader_node.canonical),
	);

	tracker.recordRowsReturned(sortedReaders.length);

	const readButNotDeclared = sortedReaders.length > 0 && sortedDeclaringFiles.length === 0;
	const declaredButNotRead = sortedDeclaringFiles.length > 0 && sortedReaders.length === 0;

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	const data: ConfigUsageData = {
		key: keyName,
		readers: sortedReaders,
		declaring_files: sortedDeclaringFiles,
		read_but_not_declared: readButNotDeclared,
		declared_but_not_read: declaredButNotRead,
	};

	return buildQueryResult<ConfigUsageData>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage,
		usage: tracker.report(),
	});
}
