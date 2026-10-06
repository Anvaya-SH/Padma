// Jālacitra Query Context and Result Envelopes (Part M1, J5-API-001 through J5-API-006)

import type { Coverage, NegativeEvidence } from "../model/coverage.ts";
import type { ProvenanceClass } from "../model/provenance.ts";
import type { ReasonCode } from "../model/reason-codes.ts";

export interface BoundTarget {
	canonical_path: string;
	workspace_id?: string;
	repository_identity: string;
	worktree_identity?: string;
	environment?: string;
	generation?: string;
	preimage_digest?: string;
	valid?: boolean;
}

export type FreshnessRequest = "live" | "current_generation" | "historical_allowed";

export interface QueryContext {
	repository: BoundTarget;
	mission_id?: string;
	freshness: FreshnessRequest;
	max_rows: number;
	max_output_bytes: number;
	timeout_ms: number;
	allow_provenance: ProvenanceClass[];
	ambiguity_policy: "REPORT" | "STRICT" | "BEST_EFFORT";
	include_rename_hints?: boolean;
	signal?: AbortSignal;
}

export interface UsageReport {
	wall_ms: number;
	wall_time_ms?: number;
	files_read: number;
	bytes_read: number;
	rows_scanned: number;
	rows_returned: number;
	output_bytes: number;
}

export interface TruncationInfo {
	truncated: boolean;
	reason?: "MAX_ROWS" | "MAX_BYTES" | "DEPTH" | "TIMEOUT";
	omitted_count_lower_bound?: number;
}

export interface SnapshotMeta {
	snapshot_id: string;
	index_generation: number;
	workspace_generation: string;
	build_generation: string | null;
}

export interface FreshnessDelivered {
	requested: string;
	delivered: string;
	downgrade_reason?: ReasonCode;
	index_building?: boolean;
	last_verified_at: string;
}

export interface QueryResult<T> {
	schema_version: string;
	snapshot: SnapshotMeta;
	freshness: FreshnessDelivered;
	data: T;
	coverage: Coverage;
	negative_evidence: NegativeEvidence[];
	truncation: TruncationInfo;
	usage: UsageReport;
	evidence_ref?: string;
}

export class UsageTracker {
	private startTime = performance.now();
	filesRead = 0;
	bytesRead = 0;
	rowsScanned = 0;
	rowsReturned = 0;
	outputBytes = 0;

	recordFileRead(bytes = 0): void {
		this.filesRead += 1;
		this.bytesRead += bytes;
	}

	recordRowsScanned(count = 1): void {
		this.rowsScanned += count;
	}

	recordRowsReturned(count = 1): void {
		this.rowsReturned += count;
	}

	recordOutputBytes(bytes: number): void {
		this.outputBytes += bytes;
	}

	report(): UsageReport {
		const elapsed = Math.round(performance.now() - this.startTime);
		return {
			wall_ms: Math.max(1, elapsed),
			files_read: this.filesRead,
			bytes_read: this.bytesRead,
			rows_scanned: this.rowsScanned,
			rows_returned: this.rowsReturned,
			output_bytes: this.outputBytes,
		};
	}
}

export function createDefaultContext(repository: BoundTarget, overrides?: Partial<QueryContext>): QueryContext {
	return {
		repository,
		freshness: overrides?.freshness ?? "current_generation",
		max_rows: overrides?.max_rows ?? 500,
		max_output_bytes: overrides?.max_output_bytes ?? 1_048_576, // 1 MiB
		timeout_ms: overrides?.timeout_ms ?? 10_000,
		// J5-API-003: default excludes INFERRED
		allow_provenance: overrides?.allow_provenance ?? ["PARSED", "COMPILED", "RUNTIME_CONFIRMED"],
		ambiguity_policy: overrides?.ambiguity_policy ?? "REPORT",
		include_rename_hints: overrides?.include_rename_hints ?? false,
		mission_id: overrides?.mission_id,
		signal: overrides?.signal,
	};
}

export function buildQueryResult<T>(params: {
	snapshot: SnapshotMeta;
	freshness: FreshnessDelivered;
	data: T;
	coverage: Coverage;
	negative_evidence?: NegativeEvidence[];
	truncation?: TruncationInfo;
	usage: UsageReport;
	evidence_ref?: string;
}): QueryResult<T> {
	const outputPayload = JSON.stringify(params.data ?? {});
	const calculatedOutputBytes = Buffer.byteLength(outputPayload, "utf8");
	const finalUsage: UsageReport = {
		...params.usage,
		output_bytes: params.usage.output_bytes > 0 ? params.usage.output_bytes : calculatedOutputBytes,
	};

	return {
		schema_version: "jalacitra:v1",
		snapshot: params.snapshot,
		freshness: params.freshness,
		data: params.data,
		coverage: params.coverage,
		negative_evidence: params.negative_evidence ?? [],
		truncation: params.truncation ?? { truncated: false },
		usage: finalUsage,
		evidence_ref: params.evidence_ref,
	};
}
