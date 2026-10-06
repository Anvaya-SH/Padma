// Jālacitra atlas.find_relevant_tests Operation (Part M2, J2, J5-LINK-001)

import type { NodeRecord } from "../model/nodes.ts";
import { compareProvenance, type ProvenanceClass } from "../model/provenance.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface FindRelevantTestsParams {
	changed_symbol_ids?: string[];
	changed_file_ids?: string[];
	include_inferred?: boolean;
	max_tests?: number;
}

export interface RelevantTestCandidate {
	test_node: NodeRecord;
	reason: string;
	class: ProvenanceClass;
	hop_distance: number;
	target_id: string;
}

export interface FindRelevantTestsData {
	candidates: RelevantTestCandidate[];
	total_found: number;
	coverage_limitations: string[];
}

export function findRelevantTests(
	ctx: QueryContext,
	store: JalacitraStore,
	params: FindRelevantTestsParams,
): QueryResult<FindRelevantTestsData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const targetIds = new Set<string>();
	if (params.changed_symbol_ids) {
		for (const id of params.changed_symbol_ids) {
			targetIds.add(id);
			const node = store.getNode(id, genNum);
			if (node?.parent_id) {
				targetIds.add(node.parent_id);
			}
		}
	}
	if (params.changed_file_ids) {
		for (const id of params.changed_file_ids) targetIds.add(id);
	}

	const includeInferred = params.include_inferred ?? false;
	const maxTests = Math.min(Math.max(1, params.max_tests ?? 50), 500);

	const db = store.rawDb;
	const candidatesMap = new Map<string, RelevantTestCandidate>();
	let truncated = false;

	// Check direct tests (hop 1)
	for (const targetId of targetIds) {
		const testEdges = store.getEdgesTo(targetId, "tests", genNum);
		tracker.recordRowsScanned(testEdges.length);

		for (const edge of testEdges) {
			if (edge.class === "INFERRED" && !includeInferred) {
				continue;
			}
			if (!ctx.allow_provenance.includes(edge.class)) {
				continue;
			}

			const testNode = store.getNode(edge.src, genNum);
			if (!testNode) continue;

			const reason = (edge.attrs?.reason as string) ?? "TESTS_CODE";
			const candidate: RelevantTestCandidate = {
				test_node: testNode,
				reason,
				class: edge.class,
				hop_distance: 1,
				target_id: targetId,
			};

			const existing = candidatesMap.get(testNode.id);
			if (!existing || compareProvenance(candidate.class, existing.class) < 0) {
				candidatesMap.set(testNode.id, candidate);
			}
		}

		// Also check hop 2: tests of callers of targetId
		const callerEdges = store.getEdgesTo(targetId, "calls", genNum);
		tracker.recordRowsScanned(callerEdges.length);

		for (const callEdge of callerEdges) {
			const callerId = callEdge.src;
			const indirectTestEdges = store.getEdgesTo(callerId, "tests", genNum);
			tracker.recordRowsScanned(indirectTestEdges.length);

			for (const edge of indirectTestEdges) {
				if (edge.class === "INFERRED" && !includeInferred) {
					continue;
				}
				if (!ctx.allow_provenance.includes(edge.class)) {
					continue;
				}

				const testNode = store.getNode(edge.src, genNum);
				if (!testNode) continue;

				const reason = (edge.attrs?.reason as string) ?? "IMPORTS_AND_CALLS";
				const candidate: RelevantTestCandidate = {
					test_node: testNode,
					reason: `${reason} (indirect via caller)`,
					class: edge.class,
					hop_distance: 2,
					target_id: targetId,
				};

				const existing = candidatesMap.get(testNode.id);
				if (!existing || (existing.hop_distance > 2 && compareProvenance(candidate.class, existing.class) <= 0)) {
					candidatesMap.set(testNode.id, candidate);
				}
			}
		}
	}

	// Ordering: stronger evidence first, then shorter distance, then canonical identity
	const sortedCandidates = Array.from(candidatesMap.values()).sort((a, b) => {
		const classCmp = compareProvenance(a.class, b.class);
		if (classCmp !== 0) return classCmp;
		if (a.hop_distance !== b.hop_distance) return a.hop_distance - b.hop_distance;
		return a.test_node.canonical.localeCompare(b.test_node.canonical);
	});

	let returned = sortedCandidates;
	if (sortedCandidates.length > maxTests) {
		returned = sortedCandidates.slice(0, maxTests);
		truncated = true;
	}

	tracker.recordRowsReturned(returned.length);

	const coverage = computeSnapshotCoverage(store, genNum, repoId);
	// Test discovery is always a lower bound (never claims "these are all tests")
	coverage.completeness = "LOWER_BOUND";

	const coverageLimitations: string[] = ["Candidate tests are potential matches; completeness is a lower bound"];
	const runtimeObservationCountRow = db
		.prepare("SELECT COUNT(*) as count FROM edges WHERE kind = 'observed_at_runtime' OR class = 'RUNTIME_CONFIRMED'")
		.get() as { count: number } | undefined;
	if ((runtimeObservationCountRow?.count ?? 0) === 0) {
		coverageLimitations.push("No runtime coverage artifacts currently imported");
	}
	if (coverage.known_blind_spots.length > 0) {
		coverageLimitations.push(
			`Dynamic constructs (${coverage.known_blind_spots.map((b) => b.code).join(", ")}) may hide additional test dependencies`,
		);
	}

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const data: FindRelevantTestsData = {
		candidates: returned,
		total_found: sortedCandidates.length,
		coverage_limitations: coverageLimitations,
	};

	return buildQueryResult<FindRelevantTestsData>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage,
		truncation: truncated
			? { truncated: true, reason: "MAX_ROWS", omitted_count_lower_bound: sortedCandidates.length - maxTests }
			: { truncated: false },
		usage: tracker.report(),
	});
}
