import { TextDecoder } from "node:util";
import { canonical, digest, type RecordOf } from "../records.ts";
import { redact } from "../redaction.ts";
import type { MissionStore } from "../store.ts";
import {
	type Citation,
	ContextError,
	type Snippet,
	type SourceDescriptor,
	type SourceFamily,
	type SourceRange,
} from "./contracts.ts";

export const DECODE_VERSION = "UTF8_RAW_LINES/1";
/** UTF-8, BOM preserved, no normalization. LF terminates lines, CRLF bytes remain in that line. */
export function decodedView(bytes: Buffer) {
	let lossy = false;
	try {
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		lossy = true;
	}
	const offsets = [0];
	let index = 0;
	for (; index < bytes.length && offsets.length <= 1000000; index++)
		if (bytes[index] === 10 && index + 1 < bytes.length) offsets.push(index + 1);
	return {
		offsets,
		mappingComplete: index === bytes.length,
		lossy,
		id: digest({ bytes: digest(bytes), decoder: DECODE_VERSION }),
	};
}
export function extract(source: SourceDescriptor, bytes: Buffer, range: SourceRange, reason: string): Snippet {
	const view = decodedView(bytes);
	let begin: number;
	let end: number;
	let actual: SourceRange;
	if (range.kind === "bytes_half_open") {
		begin = Math.min(range.begin, bytes.length);
		end = Math.min(range.end, bytes.length);
		actual = { kind: "bytes_half_open", begin, end };
	} else {
		if (range.first > view.offsets.length)
			throw new ContextError("EXTRACTION_FAILURE", "Requested line begins beyond end of source");
		if (!view.mappingComplete && range.last >= view.offsets.length)
			throw new ContextError(
				"EXTRACTION_FAILURE",
				"Line mapping exceeds bounded index; request a raw byte interval instead of inventing an end line",
			);
		const last = Math.min(range.last, view.offsets.length);
		begin = view.offsets[range.first - 1];
		end = view.offsets[last] ?? bytes.length;
		actual = { kind: "lines_inclusive", first: range.first, last };
	}
	const raw = bytes.subarray(begin, end);
	let rangeLossy = view.lossy;
	try {
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
	} catch {
		rangeLossy = true;
	}
	const text = raw.toString("utf8");
	const rendered = redact(text);
	return {
		source,
		citation: {
			version: "AVARTANA_CITATION/1",
			source: source.ref,
			range: actual,
			rawRange: { kind: "bytes_half_open", begin, end },
			excerptDigest: digest(raw),
			decodedView: view.id,
			lossy: rangeLossy,
		},
		text: rendered,
		trust: "source_data",
		provenance: source.ref.authority ? "HISTORY" : "OBSERVATION",
		freshness: source.currentness === "immutable_historical" ? "satisfied" : "unverified",
		truncated: canonical(actual) !== canonical(range),
		redacted: rendered !== text,
		inclusionReason: reason,
	};
}
export function descriptor(
	store: MissionStore,
	mission: string,
	artifactId: string,
	observationId: string | null,
	family: SourceFamily,
	locator: string,
	logicalNamespace: string,
	authorityId?: string,
): SourceDescriptor {
	const artifact = store.get(mission, artifactId, "Artifact");
	const checkpoint = authorityId ? store.get(mission, authorityId, "CheckpointRecord") : null;
	if (checkpoint && (checkpoint.artifact_ref !== artifactId || checkpoint.preimage === "ABSENT"))
		throw new ContextError(
			"MISSING_SOURCE",
			"Absent preimage markers are not file contents, or checkpoint does not own this artifact",
		);
	const observed = observationId ? store.get(mission, observationId, "EvidenceRecord") : null;
	if (!observed && !checkpoint)
		throw new ContextError("MISSING_SOURCE", "Source has no original observation or authoritative checkpoint");
	const data = observed?.payload && typeof observed.payload === "object" ? observed.payload : {};
	const historical = family !== "filesystem_text" && family !== "git_worktree_diff" && family !== "live_tool_stream";
	const logicalId = digest({ namespace: logicalNamespace, family, locator });
	const generation =
		family === "git_object" && /^[0-9a-f]{40,64}:/.test(locator)
			? locator.slice(0, locator.indexOf(":"))
			: family === "git_worktree_diff"
				? artifact.digest
				: artifact.generation;
	const sourceBlob = !!checkpoint || ["filesystem_text", "git_object", "git_worktree_diff"].includes(family);
	const rawTool = !!observed && observationArtifact(observed) === artifactId && observed.artifact_ref !== artifactId;
	const progress = observed?.stage === "dirghakriya-progress";
	const originalBytes =
		"native_output_bytes" in data && typeof data.native_output_bytes === "number"
			? data.native_output_bytes
			: sourceBlob
				? artifact.bytes
				: null;
	const incomplete =
		progress ||
		("capture_limitations" in data && Array.isArray(data.capture_limitations) && data.capture_limitations.length > 0);
	return {
		ref: {
			version: "AVARTANA_SOURCE/1",
			namespace: `${mission}:${logicalNamespace}`,
			logicalId,
			observedVersion: digest({
				namespace: `${mission}:${logicalNamespace}`,
				logicalId,
				digest: artifact.digest,
				generation,
				adapter: "AVARTANA_ADAPTER/1",
			}),
			adapterVersion: "AVARTANA_ADAPTER/1",
			artifact: { kind: "artifact", mission, id: artifactId },
			observation: observationId ? { kind: "evidence", mission, id: observationId } : null,
			authority: authorityId ? { kind: "authority", mission, id: authorityId } : null,
		},
		family,
		locator,
		displayName: locator,
		securityScope: mission,
		originOperation: observed?.operation_id ?? null,
		observedAt: observed?.captured_at ?? null,
		acquisition:
			observed?.source ??
			"Immutable retained checkpoint bytes; historical candidate, not a grant, current preimage or operation result",
		byteSize: artifact.bytes,
		contentType: artifact.media_type,
		encoding: "utf8",
		generation,
		currentness: historical
			? "immutable_historical"
			: family === "live_tool_stream"
				? "committed_prefix"
				: "working_capture",
		retention: { expiresAt: artifact.expires_at ?? null, available: artifact.available },
		capabilities: ["read_range", "search_literal", "structured_text"],
		capture: {
			format: progress ? "redacted_progress_snapshot" : sourceBlob || rawTool ? "raw_blob" : "serialized_result",
			complete: sourceBlob
				? true
				: incomplete
					? false
					: originalBytes !== null && rawTool
						? originalBytes === artifact.bytes
						: null,
			originalBytes,
			stream: sourceBlob ? "source_blob" : "combined_order_unavailable",
			operationId: observed?.operation_id ?? null,
			chunks: [
				{
					begin: 0,
					end: artifact.bytes,
					digest: artifact.digest,
					artifact: { kind: "artifact", mission, id: artifactId },
					capturedAt: observed?.captured_at ?? null,
				},
			],
		},
		consistency:
			"context_consistency" in data && typeof data.context_consistency === "string"
				? data.context_consistency
				: historical
					? "Immutable retained historical bytes; not evidence of current target state"
					: "Per-file digest and pre/post descriptor checks; no cross-file snapshot or universal race guarantee",
	};
}
export function verifyCitation(
	store: MissionStore,
	mission: string,
	source: SourceDescriptor,
	citation: Citation,
	authorize: (source: SourceDescriptor) => void,
	captured?: Buffer,
): Buffer {
	authorize(source);
	if (
		source.securityScope !== mission ||
		source.ref.artifact.mission !== mission ||
		canonical(source.ref) !== canonical(citation.source)
	)
		throw new ContextError("DENIED_SOURCE", "Citation belongs to another namespace or version");
	const metadata = store.get(mission, source.ref.artifact.id, "Artifact");
	if (
		!metadata.available ||
		(metadata.expires_at !== undefined && metadata.expires_at !== null && metadata.expires_at <= Date.now())
	)
		throw new ContextError("MISSING_SOURCE", "Cited artifact unavailable or expired");
	const bytes = captured ?? store.artifact(mission, source.ref.artifact.id);
	if (digest(bytes) !== metadata.digest) throw new ContextError("CITATION_FAILURE", "Retained source digest mismatch");
	const reconstructed = descriptor(
		store,
		mission,
		source.ref.artifact.id,
		source.ref.observation?.id ?? null,
		source.family,
		source.locator,
		source.ref.namespace.slice(mission.length + 1),
		source.ref.authority?.id,
	);
	if (canonical(reconstructed.ref) !== canonical(source.ref))
		throw new ContextError("CITATION_FAILURE", "Source version identity does not resolve");
	const actual = extract(source, bytes, citation.range, "Citation integrity check");
	if (canonical(actual.citation) !== canonical(citation))
		throw new ContextError("CITATION_FAILURE", "Citation bounds, decoded view or digest mismatch");
	return bytes.subarray(citation.rawRange.begin, citation.rawRange.end);
}
export function observationArtifact(event: RecordOf<"EvidenceRecord">): string | null {
	return event.payload &&
		typeof event.payload === "object" &&
		"full_output_ref" in event.payload &&
		typeof event.payload.full_output_ref === "string"
		? event.payload.full_output_ref
		: event.artifact_ref;
}
