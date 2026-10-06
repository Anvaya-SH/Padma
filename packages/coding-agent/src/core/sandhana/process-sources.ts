import { Type } from "typebox";
import { Value } from "typebox/value";
import { digest, type RecordOf } from "./records.ts";
import type { MissionStore } from "./store.ts";

export const PROCESS_SOURCE_LIMITATION =
	"Only declared and previously observed local source files were captured; transitive dependency closure is not established.";
export const ProcessSourceSnapshotSchema = Type.Object(
	{
		version: Type.Union([Type.Literal("LOCAL_PROCESS_SOURCES/1"), Type.Literal("LOCAL_PROCESS_SOURCES/2")]),
		before: Type.Array(Type.String({ minLength: 1 })),
		after: Type.Array(Type.String({ minLength: 1 })),
		complete: Type.Boolean(),
		limitation: Type.Literal(PROCESS_SOURCE_LIMITATION),
	},
	{ additionalProperties: false },
);

/** Null means native absence in version 2, never an inferred absence from a non-file digest. */
export function processSourceStates(
	store: MissionStore,
	mission: string,
	refs: string[],
	operationId: string,
	sourceVersion?: 1 | 2,
): Record<string, string | null> | null {
	const result: Record<string, string | null> = {};
	const paths = new Set<string>();
	try {
		for (const ref of refs) {
			const binding = store.get(mission, ref, "TargetBinding");
			const source =
				binding.establishment_evidence.length === 1
					? store.get(mission, binding.establishment_evidence[0], "EvidenceRecord")
					: null;
			const base = {
				canonical_path: binding.canonical_path,
				generation: binding.generation,
				preimage_digest: binding.preimage_digest,
			};
			const kind =
				source?.payload && typeof source.payload === "object" && "target_kind" in source.payload
					? source.payload.target_kind
					: null;
			const expected = source?.source === "local-process-source/2" ? { ...base, target_kind: kind } : base;
			if (
				!source ||
				source.kind !== "OBSERVATION" ||
				source.provenance !== "ADAPTER" ||
				source.stage !== "adana" ||
				!["local-process-source/1", "local-process-source/2"].includes(source.source) ||
				(sourceVersion !== undefined && source.source !== `local-process-source/${sourceVersion}`) ||
				source.operation_id !== operationId ||
				source.target_generation !== binding.generation ||
				digest(source.payload) !== digest(expected) ||
				source.digest !== digest(source.payload)
			)
				return null;
			const path = process.platform === "win32" ? binding.canonical_path.toLowerCase() : binding.canonical_path;
			if (paths.has(path)) return null;
			paths.add(path);
			if (source.source === "local-process-source/1") {
				// Durable older records remain readable, but their nullable digest never established absence.
				if (binding.preimage_digest === null) continue;
			} else {
				if (
					(kind !== "FILE" && kind !== "ABSENT" && kind !== "DIRECTORY" && kind !== "OTHER") ||
					(kind === "FILE" ? binding.preimage_digest === null : binding.preimage_digest !== null)
				)
					return null;
				if (kind === "ABSENT") {
					if (
						binding.generation !==
						digest({
							workspace: binding.workspace_id,
							path: binding.canonical_path,
							identity: "MISSING",
							preimage: null,
						})
					)
						return null;
				} else if (kind !== "FILE") continue;
			}
			result[path] = binding.preimage_digest;
		}
	} catch {
		return null;
	}
	return result;
}

export function observedProcessStates(
	store: MissionStore,
	observation: RecordOf<"EvidenceRecord">,
): Record<string, string | null> | null {
	const payload = observation.payload;
	if (
		observation.kind !== "OBSERVATION" ||
		observation.provenance !== "ADAPTER" ||
		observation.stage !== "phala" ||
		!observation.operation_id ||
		!payload ||
		typeof payload !== "object" ||
		!("process_sources" in payload) ||
		!Value.Check(ProcessSourceSnapshotSchema, payload.process_sources) ||
		!payload.process_sources.complete ||
		!("dependencies_unchanged" in payload) ||
		payload.dependencies_unchanged !== true
	)
		return null;
	const before = processSourceStates(
		store,
		observation.mission_id,
		payload.process_sources.before,
		observation.operation_id,
		payload.process_sources.version === "LOCAL_PROCESS_SOURCES/1" ? 1 : 2,
	);
	const after = processSourceStates(
		store,
		observation.mission_id,
		payload.process_sources.after,
		observation.operation_id,
		payload.process_sources.version === "LOCAL_PROCESS_SOURCES/1" ? 1 : 2,
	);
	return before && after && digest(before) === digest(after) ? after : null;
}

function fileDigests(states: Record<string, string | null> | null): Record<string, string> | null {
	if (!states) return null;
	const files: Record<string, string> = {};
	for (const [path, value] of Object.entries(states)) if (value !== null) files[path] = value;
	return files;
}

/** Binding digests are applicability facts, never task-completion proof. */
export function processSourceDigests(
	store: MissionStore,
	mission: string,
	refs: string[],
	operationId: string,
): Record<string, string> | null {
	return fileDigests(processSourceStates(store, mission, refs, operationId));
}

export function observedProcessSources(
	store: MissionStore,
	observation: RecordOf<"EvidenceRecord">,
): Record<string, string> | null {
	return fileDigests(observedProcessStates(store, observation));
}
