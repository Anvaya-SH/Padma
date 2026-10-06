// Jālacitra atlas.explain_build_path Operation (Part M2, J2, J5-CFG-001)

import type { NodeRecord } from "../model/nodes.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface ExplainBuildPathParams {
	file_id?: string;
	filePath?: string;
}

export interface BuildTargetExplanation {
	target: NodeRecord;
	command_digest?: string;
	command_excerpt?: string;
	expected_artifacts: NodeRecord[];
	observed_artifacts: NodeRecord[];
	source_maps: string[];
}

export interface ExplainBuildPathData {
	file_id: string;
	build_path_known: boolean;
	targets: BuildTargetExplanation[];
	config_fingerprints: Record<string, string>;
	generated_marker?: {
		is_generated: boolean;
		method?: string;
		source_file?: string;
	};
	reasons?: string[];
}

export function explainBuildPath(
	ctx: QueryContext,
	store: JalacitraStore,
	params: ExplainBuildPathParams,
): QueryResult<ExplainBuildPathData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const targetPath = params.file_id ?? params.filePath ?? "";
	if (!targetPath || targetPath.startsWith("..") || targetPath.includes("/../") || targetPath.includes("\\..\\")) {
		const snapshotMeta: SnapshotMeta = {
			snapshot_id: `snap:${repoId}:${genNum}`,
			index_generation: genNum,
			workspace_generation: currentGen?.workspace_generation ?? String(genNum),
			build_generation: currentGen?.build_generation ?? null,
		};
		return buildQueryResult<ExplainBuildPathData>({
			snapshot: snapshotMeta,
			freshness: {
				requested: ctx.freshness,
				delivered: "UNVERIFIED",
				downgrade_reason: "PATH_OUTSIDE_ROOT",
				last_verified_at: new Date().toISOString(),
			},
			data: null as unknown as ExplainBuildPathData,
			coverage: computeSnapshotCoverage(store, genNum, repoId),
			negative_evidence: [
				{ checked: `file_id:${targetPath}`, result: "PATH_OUTSIDE_ROOT", completeness: "EXACT_WITHIN_INDEX" },
			],
			usage: tracker.report(),
		});
	}

	const fileNode = store.getNode(targetPath, genNum);
	if (!fileNode) {
		const snapshotMeta: SnapshotMeta = {
			snapshot_id: `snap:${repoId}:${genNum}`,
			index_generation: genNum,
			workspace_generation: currentGen?.workspace_generation ?? String(genNum),
			build_generation: currentGen?.build_generation ?? null,
		};
		return buildQueryResult<ExplainBuildPathData>({
			snapshot: snapshotMeta,
			freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
			data: {
				file_id: targetPath,
				build_path_known: false,
				targets: [],
				config_fingerprints: {},
				reasons: ["FILE_NODE_NOT_FOUND"],
			},
			coverage: computeSnapshotCoverage(store, genNum, repoId),
			negative_evidence: [
				{ checked: `file_id:${targetPath}`, result: "FILE_NOT_FOUND", completeness: "EXACT_WITHIN_INDEX" },
			],
			usage: tracker.report(),
		});
	}

	// Find build targets that build this file (builds edge where dst = file_id)
	const buildsEdges = store.getEdgesTo(targetPath, "builds", genNum);
	tracker.recordRowsScanned(buildsEdges.length);

	const targets: BuildTargetExplanation[] = [];
	const configFingerprints: Record<string, string> = {};

	for (const edge of buildsEdges) {
		const targetNode = store.getNode(edge.src, genNum);
		if (!targetNode) continue;

		// Find generates edges from this target
		const generatesEdges = store.getEdgesFrom(targetNode.id, "generates", genNum);
		tracker.recordRowsScanned(generatesEdges.length);

		const expectedArtifacts: NodeRecord[] = [];
		const observedArtifacts: NodeRecord[] = [];

		for (const genEdge of generatesEdges) {
			const artNode = store.getNode(genEdge.dst, genNum);
			if (artNode) {
				if (genEdge.attrs?.expected === false) {
					observedArtifacts.push(artNode);
				} else {
					expectedArtifacts.push(artNode);
				}
			}
		}

		// Find source_of edges for this file or artifacts
		const sourceMapLinks: string[] = [];
		const sourceOfEdges = store.getEdgesFrom(targetPath, "source_of", genNum);
		for (const smEdge of sourceOfEdges) {
			if (smEdge.attrs?.source_map) {
				sourceMapLinks.push(String(smEdge.attrs.source_map));
			}
		}

		targets.push({
			target: targetNode,
			command_digest: targetNode.attrs?.command_digest as string | undefined,
			command_excerpt: targetNode.attrs?.command_excerpt as string | undefined,
			expected_artifacts: expectedArtifacts,
			observed_artifacts: observedArtifacts,
			source_maps: sourceMapLinks,
		});

		// Config fingerprint of the build target
		if (targetNode.parent_id) {
			const parentConfig = store.getFile(targetNode.parent_id);
			if (parentConfig) {
				configFingerprints[parentConfig.path] = parentConfig.content_digest;
			}
		}
	}

	const isGenerated = fileNode.attrs?.class === "generated" || fileNode.attrs?.generated === true;
	const generatedMarker = {
		is_generated: Boolean(isGenerated),
		method: fileNode.attrs?.class_method as string | undefined,
		source_file: fileNode.attrs?.generated_from as string | undefined,
	};

	const buildPathKnown = targets.length > 0;
	const reasons = buildPathKnown ? undefined : ["NO_BUILD_TARGET_COVERS_FILE"];

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	const data: ExplainBuildPathData = {
		file_id: targetPath,
		build_path_known: buildPathKnown,
		targets,
		config_fingerprints: configFingerprints,
		generated_marker: generatedMarker,
		reasons,
	};

	return buildQueryResult<ExplainBuildPathData>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage,
		usage: tracker.report(),
	});
}
