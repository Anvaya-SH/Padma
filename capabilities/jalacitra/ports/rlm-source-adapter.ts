import type { Atlas } from "../api/atlas.ts";
import type { NegativeEvidence } from "../model/coverage.ts";
import type { FreshnessState } from "../model/freshness.ts";
import type { ProvenanceClass } from "../model/provenance.ts";

export interface RlmRetrievalRequest {
	intent: "investigate_symbol" | "find_callers" | "find_tests" | "impact_analysis" | "locate_target";
	target: string; // symbol name, file path, or node ID
	repoRoot: string;
	filePath?: string;
	question?: string;
	sources_allowed?: string[];
	max_context_tokens?: number;
	freshness_requirement?: "current_generation" | "live";
	required_evidence_types?: ProvenanceClass[];
}

export interface LocationHandleReference {
	handleId: string;
	filePath: string;
	range?: {
		startLine: number;
		startCol: number;
		endLine: number;
		endCol: number;
	};
	provenance: ProvenanceClass;
	sourceGeneration: number;
	freshness: FreshnessState;
	selectionReason: string;
	isInferred: boolean;
	isAmbiguous: boolean;
}

export interface RlmRetrievalAnswer {
	version: "RLM_GRAPH_ANSWER/1";
	snapshotId: string;
	generation: number;
	references: LocationHandleReference[];
	omitted_relevant_count: number;
	unresolved_questions: string[];
	negative_evidence: NegativeEvidence[];
	compaction_key: {
		snapshotId: string;
		queryDigest: string;
		generation: number;
	};
}

export class JalacitraRlmSourceAdapter {
	private atlas: Atlas;

	constructor(atlas: Atlas) {
		this.atlas = atlas;
	}

	async retrieve(request: RlmRetrievalRequest): Promise<RlmRetrievalAnswer> {
		const freshnessReq = request.freshness_requirement ?? "current_generation";
		const verifyLive = freshnessReq === "live";

		const references: LocationHandleReference[] = [];
		let omittedCount = 0;
		const unresolvedQuestions: string[] = [];
		let negativeEvidence: NegativeEvidence[] = [];
		let snapshotId = "snap_unknown";
		let generation = 0;

		switch (request.intent) {
			case "investigate_symbol": {
				const res = this.atlas.resolveSymbol({
					name: request.target,
					ambiguity_policy: "REPORT",
				});
				snapshotId = res.snapshot.snapshot_id;
				generation = res.snapshot.index_generation;
				negativeEvidence = res.negative_evidence;

				if (res.coverage.known_blind_spots.length > 0) {
					for (const spot of res.coverage.known_blind_spots) {
						unresolvedQuestions.push(
							`Coverage limitation: ${spot.code} - ${spot.description} (${spot.count} occurrences)`,
						);
					}
				}

				if (res.data) {
					for (const match of res.data) {
						const node = match.node;
						const filePath =
							(node.attrs?.path as string) ?? (node.attrs?.file_path as string) ?? node.canonical.split(":")[0];
						const freshnessState: FreshnessState = res.freshness.downgrade_reason ? "STALE" : "FRESH";
						references.push({
							handleId: node.id,
							filePath,
							range: match.location
								? {
										startLine: match.location.start_line,
										startCol: 1,
										endLine: match.location.end_line,
										endCol: 1,
									}
								: undefined,
							provenance: match.class,
							sourceGeneration: generation,
							freshness: freshnessState,
							selectionReason: `Exact symbol match for '${request.target}'`,
							isInferred: match.class === "INFERRED",
							isAmbiguous: false,
						});
					}
				}
				break;
			}

			case "find_callers": {
				// Symbol resolution + neighbors backward
				const symRes = this.atlas.resolveSymbol({
					name: request.target,
					ambiguity_policy: "BEST_EFFORT",
				});
				snapshotId = symRes.snapshot.snapshot_id;
				generation = symRes.snapshot.index_generation;

				if (symRes.data && symRes.data.length > 0) {
					const primaryNodeId = symRes.data[0].node.id;
					const nRes = this.atlas.neighbors({
						node_id: primaryNodeId,
						direction: "backward",
						depth: 1,
					});

					if (nRes.data) {
						for (const node of nRes.data.nodes) {
							if (node.id === primaryNodeId) continue;
							const edge = nRes.data.edges.find((e) => e.src === node.id && e.dst === primaryNodeId);
							const filePath =
								(node.attrs?.path as string) ?? (node.attrs?.file_path as string) ?? node.canonical;
							const freshnessState: FreshnessState = nRes.freshness.downgrade_reason ? "STALE" : "FRESH";
							references.push({
								handleId: node.id,
								filePath,
								range: node.attrs?.start_line
									? {
											startLine: Number(node.attrs.start_line),
											startCol: 1,
											endLine: Number(node.attrs.end_line ?? node.attrs.start_line),
											endCol: 1,
										}
									: undefined,
								provenance: (edge?.class as ProvenanceClass) ?? "PARSED",
								sourceGeneration: generation,
								freshness: freshnessState,
								selectionReason: `Caller into '${request.target}' via ${edge?.kind ?? "references"}`,
								isInferred: edge?.class === "INFERRED",
								isAmbiguous: edge?.ambiguity !== "UNIQUE",
							});
						}
					}

					if (nRes.truncation.truncated) {
						omittedCount += nRes.truncation.omitted_count_lower_bound ?? 1;
						unresolvedQuestions.push(
							`Caller exploration truncated: ${nRes.truncation.reason ?? "FAN_OUT_TRUNCATED"}`,
						);
					}
				}
				break;
			}

			case "find_tests": {
				const testRes = this.atlas.findRelevantTests({
					changed_symbol_ids: request.target.startsWith("sym:") ? [request.target] : undefined,
					changed_file_ids: !request.target.startsWith("sym:") ? [request.target] : undefined,
				});
				snapshotId = testRes.snapshot.snapshot_id;
				generation = testRes.snapshot.index_generation;
				negativeEvidence = testRes.negative_evidence;

				if (testRes.data?.candidates) {
					for (const c of testRes.data.candidates) {
						const t = c.test_node;
						const filePath = (t.attrs?.path as string) ?? t.canonical;
						const freshnessState: FreshnessState = testRes.freshness.downgrade_reason ? "STALE" : "FRESH";
						references.push({
							handleId: t.id,
							filePath,
							provenance: c.class,
							sourceGeneration: generation,
							freshness: freshnessState,
							selectionReason: `Linked test (${c.reason}, distance ${c.hop_distance})`,
							isInferred: c.class === "INFERRED",
							isAmbiguous: false,
						});
					}
				}

				if (testRes.coverage.known_blind_spots.length > 0) {
					unresolvedQuestions.push(
						`Test linkage incomplete (${testRes.coverage.known_blind_spots.length} blind spots present in index)`,
					);
				}
				break;
			}

			default: {
				const locRes = this.atlas.locate({
					symbol_id: request.target.startsWith("sym:") ? request.target : undefined,
					file_path: !request.target.startsWith("sym:") ? request.target : undefined,
					verify_live: verifyLive,
				});
				snapshotId = locRes.snapshot.snapshot_id;
				generation = locRes.snapshot.index_generation;

				if (locRes.data?.node) {
					const node = locRes.data.node;
					const filePath = (node.attrs?.path as string) ?? node.canonical;
					const freshnessState: FreshnessState = locRes.freshness.downgrade_reason ? "STALE" : "FRESH";
					references.push({
						handleId: node.id,
						filePath,
						range: locRes.data.location
							? {
									startLine: locRes.data.location.start_line,
									startCol: 1,
									endLine: locRes.data.location.end_line,
									endCol: 1,
								}
							: undefined,
						provenance: "PARSED",
						sourceGeneration: generation,
						freshness: freshnessState,
						selectionReason: "Direct location lookup",
						isInferred: false,
						isAmbiguous: false,
					});
				}
				break;
			}
		}

		return {
			version: "RLM_GRAPH_ANSWER/1",
			snapshotId,
			generation,
			references,
			omitted_relevant_count: omittedCount,
			unresolved_questions: unresolvedQuestions,
			negative_evidence: negativeEvidence,
			compaction_key: {
				snapshotId,
				queryDigest: `${request.intent}:${request.target}:${request.freshness_requirement ?? "curr"}`,
				generation,
			},
		};
	}
}
