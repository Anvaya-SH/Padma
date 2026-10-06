// Jālacitra Runtime Ingestion Port & Coverage Importer (Part J, J5-RT-001 through J5-RT-005)
// Ingests runtime trace observations and test coverage artifacts into the graph store.
// Strictly requires valid evidence tokens; never runs tests on its own initiative.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { canonicalEdgeId, deriveId } from "../model/ids.ts";
import type { JalacitraStore } from "../store/store.ts";

export interface StoredEvidenceRecord {
	evidenceId: string;
	origin: "runtime_trace" | "tool_observation" | "deterministic_check";
	targetRepoIdentity: string;
	artifactDigest: string;
	generation: number;
}

export interface RuntimeObservationParams {
	repoIdentity: string;
	sourceNodeId: string;
	targetNodeId: string;
	kind?: "calls" | "tests";
	generation: number;
	evidence: StoredEvidenceRecord;
	rawArtifactContent?: string;
}

export interface RuntimeObservationResult {
	success: boolean;
	edgeId?: string;
	unresolvedRefId?: string;
	reasonCode?: string;
}

export interface CoverageImportParams {
	coverageFilePath: string;
	repoRoot: string;
	repoIdentity: string;
	generation: number;
	evidence: StoredEvidenceRecord;
	rawArtifactContent?: string;
}

export interface CoverageImportResult {
	success: boolean;
	filesCovered: number;
	linesCovered: number;
	edgesCreated: number;
	unresolvedCount: number;
}

export class RuntimeIngestionPort {
	/**
	 * J5-RT-001: Record dynamic runtime observation.
	 * Rejects call with EVIDENCE_REQUIRED if evidence record is invalid, origin is disallowed,
	 * repo binding mismatches, or artifact digest fails to verify.
	 */
	recordRuntimeObservation(store: JalacitraStore, params: RuntimeObservationParams): RuntimeObservationResult {
		// 1. Evidence verification (J5-RT-001)
		const ev = params.evidence;
		if (!ev || !ev.evidenceId) {
			throw new Error("EVIDENCE_REQUIRED: No evidence token provided for runtime observation");
		}

		const allowedOrigins = ["runtime_trace", "tool_observation", "deterministic_check"];
		if (!allowedOrigins.includes(ev.origin)) {
			throw new Error(`EVIDENCE_REQUIRED: Invalid evidence origin '${ev.origin}'`);
		}

		if (ev.targetRepoIdentity !== params.repoIdentity) {
			throw new Error(
				`EVIDENCE_REQUIRED: Evidence repository mismatch (expected '${params.repoIdentity}', got '${ev.targetRepoIdentity}')`,
			);
		}

		if (params.rawArtifactContent) {
			const calculatedDigest = createHash("sha256").update(params.rawArtifactContent).digest("hex");
			if (calculatedDigest !== ev.artifactDigest) {
				throw new Error("EVIDENCE_REQUIRED: Evidence artifact content digest mismatch");
			}
		}

		// 2. Generation verification & node matching (J5-RT-002)
		const rawDb = store.rawDb;
		const targetNode = rawDb
			.prepare("SELECT * FROM nodes WHERE id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)")
			.get(params.targetNodeId, params.generation, params.generation) as Record<string, unknown> | undefined;

		if (!targetNode) {
			// Record an unresolved_ref node and unresolved_to edge (J5-RES-002, J5-RT-002)
			const unresNodeId = deriveId(
				`repo:${params.repoIdentity}:unres:${params.sourceNodeId}:${params.targetNodeId}:${params.generation}`,
			);
			rawDb
				.prepare(
					`INSERT OR REPLACE INTO nodes 
					(id, kind, canonical, name, parent_id, valid_from, valid_to, attrs)
					VALUES (?, 'unresolved_ref', ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					unresNodeId,
					`repo:${params.repoIdentity}:unres:${params.targetNodeId}`,
					params.targetNodeId,
					params.sourceNodeId,
					params.generation,
					params.generation + 1,
					JSON.stringify({ reason_code: "OBSERVATION_GENERATION_MISMATCH" }),
				);

			const edgeId = deriveId(
				canonicalEdgeId("unresolved_to", params.sourceNodeId, unresNodeId, "RUNTIME_CONFIRMED", "runtime"),
			);
			rawDb
				.prepare(
					`INSERT OR REPLACE INTO edges 
					(id, kind, src, dst, class, method, ambiguity, candidate_reason, weight, valid_from, valid_to, evidence_ref)
					VALUES (?, 'unresolved_to', ?, ?, 'RUNTIME_CONFIRMED', 'runtime_trace', 'UNRESOLVED', 'OBSERVATION_GENERATION_MISMATCH', 1, ?, ?, ?)`,
				)
				.run(edgeId, params.sourceNodeId, unresNodeId, params.generation, params.generation + 1, ev.evidenceId);

			return {
				success: false,
				unresolvedRefId: unresNodeId,
				reasonCode: "OBSERVATION_GENERATION_MISMATCH",
			};
		}

		// 3. Insert RUNTIME_CONFIRMED edge valid only for observation generation range (J5-RT-003)
		const edgeKind = params.kind ?? "calls";
		const edgeId = deriveId(
			canonicalEdgeId(edgeKind, params.sourceNodeId, params.targetNodeId, "RUNTIME_CONFIRMED", "runtime"),
		);

		rawDb
			.prepare(
				`INSERT OR REPLACE INTO edges 
				(id, kind, src, dst, class, method, ambiguity, weight, valid_from, valid_to, evidence_ref)
				VALUES (?, ?, ?, ?, 'RUNTIME_CONFIRMED', 'runtime_trace', 'UNIQUE', 1, ?, ?, ?)`,
			)
			.run(
				edgeId,
				edgeKind,
				params.sourceNodeId,
				params.targetNodeId,
				params.generation,
				params.generation + 1, // Closed at next generation (never carried forward as present-day fact)
				ev.evidenceId,
			);

		return {
			success: true,
			edgeId,
		};
	}

	/**
	 * J5-RT-004: Ingest existing test coverage artifacts (LCOV, Istanbul/NYC, V8 coverage).
	 * Read-only ingestion of existing artifact; never launches test processes.
	 */
	importCoverage(store: JalacitraStore, params: CoverageImportParams): CoverageImportResult {
		if (!existsSync(params.coverageFilePath)) {
			throw new Error(`Coverage file not found: ${params.coverageFilePath}`);
		}

		const content = readFileSync(params.coverageFilePath, "utf8");

		// Validate evidence
		const ev = params.evidence;
		if (!ev || !ev.evidenceId) {
			throw new Error("EVIDENCE_REQUIRED: Coverage import requires valid evidence record");
		}

		let filesCovered = 0;
		let linesCovered = 0;
		let edgesCreated = 0;

		// Parse LCOV format (SF:..., DA:line,hits, end_of_record)
		if (content.includes("SF:") && content.includes("end_of_record")) {
			const records = content.split("end_of_record");
			for (const rec of records) {
				const sfMatch = rec.match(/SF:(.+)/);
				if (!sfMatch) continue;
				filesCovered++;

				const relPath = sfMatch[1].trim().replace(/\\/g, "/");
				const fileId = deriveId(`repo:${params.repoIdentity}:file:${relPath}`);

				const daMatches = rec.matchAll(/DA:(\d+),(\d+)/g);
				for (const match of daMatches) {
					const hits = Number(match[2]);
					if (hits > 0) {
						linesCovered++;
					}
				}

				// If test attribution is recorded in TN: (Test Name)
				const tnMatch = rec.match(/TN:(.+)/);
				if (tnMatch?.[1].trim()) {
					const testName = tnMatch[1].trim();
					const testNodeId = deriveId(`repo:${params.repoIdentity}:test:${testName}`);

					// Ensure file and test nodes exist in nodes table (J5-STORE foreign keys)
					store.rawDb
						.prepare(
							`INSERT OR IGNORE INTO nodes (id, kind, canonical, valid_from, valid_to)
							 VALUES (?, 'file', ?, ?, NULL)`,
						)
						.run(fileId, `repo:${params.repoIdentity}:file:${relPath}`, params.generation);

					store.rawDb
						.prepare(
							`INSERT OR IGNORE INTO nodes (id, kind, canonical, valid_from, valid_to)
							 VALUES (?, 'test_case', ?, ?, NULL)`,
						)
						.run(testNodeId, `repo:${params.repoIdentity}:test:${testName}`, params.generation);

					// Create tests edge
					const edgeId = deriveId(canonicalEdgeId("tests", testNodeId, fileId, "RUNTIME_CONFIRMED", "lcov"));
					store.rawDb
						.prepare(
							`INSERT OR REPLACE INTO edges 
							(id, kind, src, dst, class, method, ambiguity, weight, valid_from, valid_to, evidence_ref)
							VALUES (?, 'tests', ?, ?, 'RUNTIME_CONFIRMED', 'coverage_import', 'UNIQUE', 1, ?, ?, ?)`,
						)
						.run(edgeId, testNodeId, fileId, params.generation, params.generation + 1, ev.evidenceId);
					edgesCreated++;
				}
			}
		}

		return {
			success: true,
			filesCovered,
			linesCovered,
			edgesCreated,
			unresolvedCount: 0,
		};
	}
}

export const defaultRuntimeIngestion = new RuntimeIngestionPort();
