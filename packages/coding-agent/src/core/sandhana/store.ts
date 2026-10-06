import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { BEHAVIOR_PLAN_RULE, validateBehaviorPlan, validateBehaviorVerification } from "./acceptance.ts";
import { parseActionApproval, validateActionApproval, validateApprovedPreparation } from "./approval.ts";
import { ContextError } from "./avartana/contracts.ts";
import { type Capsule, validateCapsule } from "./avartana/position.ts";
import { validateCaptureReservation } from "./capture-reservation.ts";
import { localCheck } from "./checks.ts";
import { inside } from "./code.ts";
import { routeBudget, validateConfiguration } from "./configuration.ts";
import { isFailure, SandhanaError } from "./errors.ts";
import { validateCognitiveTickTransition } from "./governor.ts";
import { hypothesisPremiseMatches, validateHypothesis, validateHypothesisMerge } from "./hypotheses.ts";
import { configurationForMigration } from "./migration.ts";
import {
	activeModelOverrun,
	MODEL_OVERRUN_REASON,
	MODEL_OVERRUN_SOURCE,
	modelOverrun,
	validateInvalidModelUsage,
	validateModelOverrun,
	validateModelSettlement,
} from "./model-usage.ts";
import { independentPrepared, validateSchedules } from "./operations.ts";
import { openPrivateMissionStore } from "./private-store.ts";
import {
	type PublicAuthorizationView,
	type PublicMissionEventPage,
	type PublicMissionSnapshot,
	projectMissionSnapshot,
} from "./public-protocol.ts";
import { localReplacement, validateLocalReconciliation } from "./reconciliation.ts";
import {
	actionDigest,
	BudgetChangeInputSchema,
	CONFIGURATION_MIGRATION_LIMITATION,
	canonical,
	digest,
	legalTransition,
	type MissionRecord,
	type MissionState,
	makeRecord,
	ProposalFailureSchema,
	type RecordOf,
	resources,
	validateMissionState,
	validateRecord,
} from "./records.ts";
import { renderTerminal } from "./reporting.ts";
import { validateRoutingContract } from "./routing.ts";
import {
	activeToolOverrun,
	TOOL_OVERRUN_REASON,
	TOOL_OVERRUN_SOURCE,
	toolOverrun,
	validateToolOverrun,
} from "./tool-usage.ts";

export class RevisionConflict extends SandhanaError {
	constructor(reason: string) {
		super("REVISION_CONFLICT", reason);
	}
}
export class RecordConflict extends SandhanaError {
	constructor(reason: string) {
		super("ID_PAYLOAD_CONFLICT", reason);
	}
}
export class MissionStore {
	private db: DatabaseSync;
	readonly databasePath: string;
	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const opened = openPrivateMissionStore(path, (database) => {
			if (path !== ":memory:" && process.platform !== "win32") chmodSync(path, 0o600);
			database.exec(
				"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;",
			);
			const version = database.prepare("PRAGMA user_version").get()?.user_version;
			if (version !== 0 && version !== 1) throw new Error(`Unsupported Sandhana store version ${version}`);
			if (version === 0 && database.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get())
				throw new Error("Unversioned mission storage contains foreign records; retained data must not be reset");
			if (version === 0)
				database.exec(`BEGIN IMMEDIATE;
		CREATE TABLE missions (id TEXT PRIMARY KEY, session TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL);
		CREATE TABLE records (mission TEXT NOT NULL REFERENCES missions(id), id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(mission,id));
		CREATE TABLE artifacts (mission TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(mission,id), FOREIGN KEY(mission,id) REFERENCES records(mission,id));
		PRAGMA user_version=1; COMMIT;`);
		});
		this.db = opened.database;
		this.databasePath = opened.path;
	}
	close(): void {
		this.db.close();
	}
	load(id: string): MissionState {
		const row = this.db.prepare("SELECT state FROM missions WHERE id=?").get(id);
		if (!row) throw new Error(`Mission ${id} not found`);
		const state: unknown = JSON.parse(String(row.state));
		validateMissionState(state);
		return state;
	}
	list(session: string): MissionState[] {
		return this.db
			.prepare("SELECT state FROM missions WHERE session=? ORDER BY rowid")
			.all(session)
			.map((row) => {
				const state: unknown = JSON.parse(String(row.state));
				validateMissionState(state);
				return state;
			});
	}
	/** Append a supported compatible projection; original records and target effects are untouched. */
	migrateConfiguration(mission: string): MissionState {
		const previous = this.load(mission);
		const prior = this.get(mission, previous.contract, "MissionContract");
		if (prior.configuration_ref) {
			validateConfiguration(this.get(mission, prior.configuration_ref, "KernelConfiguration").value);
			return previous;
		}
		const revision = previous.revision + 1;
		const configuration = makeRecord(mission, revision, "KernelConfiguration", {
			source: "MIGRATION",
			value: configurationForMigration(previous, prior),
			resource_overrides: {},
		});
		const contract = makeRecord(mission, revision, "MissionContract", {
			...prior,
			configuration_ref: configuration.record_id,
		});
		const migration = makeRecord(mission, revision, "ConfigurationMigration", {
			version: "CONFIGURATION_CAPTURE/1",
			previous_contract_ref: prior.record_id,
			contract_ref: contract.record_id,
			configuration_ref: configuration.record_id,
			limitation: CONFIGURATION_MIGRATION_LIMITATION,
		});
		const state = { ...previous, revision, contract: contract.record_id };
		this.commit(previous.revision, state, [configuration, contract, migration]);
		return state;
	}
	get<T extends MissionRecord["record_type"]>(mission: string, id: string, type: T): RecordOf<T> {
		const row = this.db.prepare("SELECT payload FROM records WHERE mission=? AND id=?").get(mission, id);
		if (!row) throw new Error(`Unresolved ${type} reference ${id}`);
		const value: unknown = JSON.parse(String(row.payload));
		validateRecord(value);
		if (value.record_type !== type) throw new Error(`Reference ${id} is not ${type}`);
		return value as RecordOf<T>;
	}
	records(mission: string): MissionRecord[] {
		return this.db
			.prepare("SELECT payload FROM records WHERE mission=? ORDER BY revision,rowid")
			.all(mission)
			.map((row) => {
				const value: unknown = JSON.parse(String(row.payload));
				validateRecord(value);
				return value;
			});
	}
	/** Reconstruct a client view from records only; never inspect targets or dispatch tools. */
	publicSnapshot(mission: string): PublicMissionSnapshot {
		return projectMissionSnapshot(this, this.load(mission));
	}
	/** A denial can precede an operation marker. Inspect its retained preparation without granting or dispatching it. */
	publicAuthorization(mission: string): PublicAuthorizationView {
		const state = this.load(mission);
		const base = { version: "SANDHANA_AUTHORIZATION/1" as const, mission_id: mission, revision: state.revision };
		const row = this.db
			.prepare(`SELECT d.id AS decision_ref,d.digest AS decision_digest,a.id AS prepared_ref,a.digest AS prepared_digest
			FROM records d JOIN records a ON a.mission=d.mission AND a.type='PreparedAction'
			AND json_extract(a.payload,'$.operation_id')=json_extract(d.payload,'$.operation_id')
			WHERE d.mission=? AND d.type='ScopeDecision' AND d.revision<=? AND a.revision<=?
			AND json_extract(d.payload,'$.outcome')='NEEDS_CURRENT_AUTHORIZATION'
			AND json_extract(a.payload,'$.intent_epoch')=?
			AND NOT EXISTS(SELECT 1 FROM records newer WHERE newer.mission=d.mission AND newer.type='ScopeDecision'
			AND newer.revision>d.revision AND newer.revision<=?
			AND json_extract(newer.payload,'$.operation_id')=json_extract(d.payload,'$.operation_id'))
			ORDER BY d.revision DESC,d.rowid DESC LIMIT 1`)
			.get(mission, state.revision, state.revision, state.intent_epoch ?? 1, state.revision);
		if (!row) return { ...base, request: null };
		const decision = this.get(mission, String(row.decision_ref), "ScopeDecision");
		const action = this.get(mission, String(row.prepared_ref), "PreparedAction");
		const binding = this.get(mission, action.binding_ref, "TargetBinding");
		const schema = this.get(mission, action.schema_ref, "RegisteredActionSchema");
		if (
			decision.record_id !== row.decision_ref ||
			action.record_id !== row.prepared_ref ||
			digest(decision) !== row.decision_digest ||
			digest(action) !== row.prepared_digest ||
			decision.mission_id !== mission ||
			action.mission_id !== mission ||
			decision.operation_id !== action.operation_id ||
			decision.action_digest !== action.action_digest ||
			action.action_digest !== actionDigest(action) ||
			decision.target_generation !== binding.generation ||
			action.target_generation !== binding.generation ||
			action.intent_epoch !== (state.intent_epoch ?? 1)
		)
			throw new SandhanaError("STATE_CONFLICT", "Authorization request differs from its retained action or target", {
				operation_id: action.operation_id,
				target_binding_ref: action.binding_ref,
			});
		if (
			state.operations.some((ref) => {
				const operation = this.get(mission, ref, "OperationRecord");
				return operation.operation_id === action.operation_id && operation.status !== "NOT_STARTED";
			})
		)
			return { ...base, request: null };
		const kind = action.operation_class.startsWith("SHELL:")
			? "PROCESS"
			: action.operation_class === "READ"
				? "READ"
				: action.operation_class === "LIST"
					? "LIST"
					: action.operation_class === "STATUS"
						? "STATUS"
						: action.operation_class === "SEARCH"
							? "SEARCH"
							: action.operation_class === "EDIT"
								? "EDIT"
								: "OTHER";
		const postimage = /^Content SHA256 ([a-f0-9]{64})$/.exec(action.intended_effect)?.[1] ?? null;
		return {
			...base,
			request: {
				decision_ref: decision.record_id,
				prepared_ref: action.record_id,
				operation_id: action.operation_id,
				action_digest: action.action_digest,
				prepared_revision: action.revision,
				evaluated_revision: decision.evaluated_revision,
				intent_epoch: action.intent_epoch,
				expires_at: decision.valid_until,
				action: { tool_id: action.tool_id, kind },
				target: {
					binding_ref: binding.record_id,
					workspace_id: binding.workspace_id,
					generation: binding.generation,
				},
				effect: {
					kind:
						kind === "PROCESS"
							? "OPAQUE_PROCESS"
							: kind === "EDIT"
								? action.intended_effect === "Restore absent target"
									? "TARGET_REMOVAL"
									: "FILE_REPLACEMENT"
								: "OBSERVATION",
					side_effect: schema.side_effect,
					postimage_digest: postimage,
				},
				arguments_omitted: true,
				requires_repreparation: true,
				response: "EXACT_USER_INSTRUCTION",
			},
		};
	}
	/** A sourced approval can bind one new preparation; reconstruction never grants or replays it. */
	pendingApproval(mission: string, intentEpoch: number): RecordOf<"ActionApproval"> | null {
		const row = this.db
			.prepare(`SELECT a.id FROM records a WHERE a.mission=? AND a.type='ActionApproval'
			AND json_extract(a.payload,'$.intent_epoch')=?
			AND NOT EXISTS(SELECT 1 FROM records p WHERE p.mission=a.mission AND p.type='PreparedAction'
			AND json_extract(p.payload,'$.approval_ref')=a.id) ORDER BY a.revision DESC LIMIT 1`)
			.get(mission, intentEpoch);
		return row ? this.get(mission, String(row.id), "ActionApproval") : null;
	}
	publicEvents(mission: string, afterRevision = 0, limit = 32): PublicMissionEventPage {
		const state = this.load(mission);
		if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || afterRevision > state.revision)
			throw new RevisionConflict("Public event cursor is outside the committed mission history");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
			throw new Error("Public event pages are bounded to 64 committed revisions");
		const rows = this.db
			.prepare(
				"SELECT id,revision,payload,digest FROM records WHERE mission=? AND type='PublicMissionEvent' AND revision>? AND revision<=? ORDER BY revision,rowid LIMIT ?",
			)
			.all(mission, afterRevision, state.revision, limit + 1);
		let previousRevision = afterRevision;
		const validated = rows.map((row) => {
			const value: unknown = JSON.parse(String(row.payload));
			validateRecord(value);
			if (
				value.record_type !== "PublicMissionEvent" ||
				value.record_id !== row.id ||
				value.revision !== row.revision ||
				value.revision <= previousRevision ||
				value.mission_id !== mission ||
				value.payload.mission_id !== mission ||
				value.payload.revision !== value.revision ||
				value.event_id !== `${mission}:${value.revision}` ||
				digest(value) !== row.digest
			)
				throw new Error("Committed public event identity or payload differs");
			previousRevision = value.revision;
			return value;
		});
		const events = validated.slice(0, limit);
		const hasMore = validated.length > limit;
		const floor = this.db
			.prepare(
				"SELECT MIN(revision) AS revision FROM records WHERE mission=? AND type='PublicMissionEvent' AND revision<=?",
			)
			.get(mission, state.revision)?.revision;
		const historyFrom = typeof floor === "number" ? floor : null;
		let cursor = afterRevision;
		let historyGap = false;
		for (const event of events) {
			if (event.revision !== cursor + 1) historyGap = true;
			cursor = event.revision;
		}
		// A complete page advances past missing history to its authoritative snapshot, never fabricated events.
		if (!hasMore && cursor < state.revision) historyGap = true;
		return {
			snapshot: projectMissionSnapshot(this, state),
			events,
			next_revision: hasMore ? cursor : state.revision,
			has_more: hasMore,
			history_from_revision: historyFrom,
			history_gap: historyGap,
		};
	}
	/** Narrow metadata queries do not deserialize old source bodies on reconstruction. */
	contextReferences(mission: string, source: string, revision: number, latest = false): string[] {
		const rows = this.db
			.prepare(
				`SELECT id FROM records WHERE mission=? AND type='EvidenceRecord' AND revision<=? AND json_extract(payload,'$.source')=? ORDER BY revision ${latest ? "DESC" : "ASC"}, rowid ${latest ? "DESC" : "ASC"} LIMIT ?`,
			)
			.all(mission, revision, source, latest ? 1 : 1001);
		if (rows.length > 1000)
			throw new ContextError(
				"CAPACITY",
				"Context reference set exceeds bounded reconstruction metadata; do not silently hide unresolved conflicts",
			);
		return rows.map((row) => String(row.id));
	}
	contextCheckpoint(mission: string, artifact: string): RecordOf<"CheckpointRecord"> | null {
		const row = this.db
			.prepare(
				"SELECT id FROM records WHERE mission=? AND type='CheckpointRecord' AND json_extract(payload,'$.artifact_ref')=? ORDER BY revision DESC,rowid DESC LIMIT 1",
			)
			.get(mission, artifact);
		return row ? this.get(mission, String(row.id), "CheckpointRecord") : null;
	}
	contextObservation(mission: string, locator: string): RecordOf<"EvidenceRecord"> | null {
		const row = this.db
			.prepare(
				"SELECT id FROM records WHERE mission=? AND type='EvidenceRecord' AND json_extract(payload,'$.kind')='OBSERVATION' AND (id=? OR json_extract(payload,'$.artifact_ref')=? OR json_extract(payload,'$.payload.full_output_ref')=?) ORDER BY revision DESC,rowid DESC LIMIT 1",
			)
			.get(mission, locator, locator, locator);
		return row ? this.get(mission, String(row.id), "EvidenceRecord") : null;
	}
	artifact(mission: string, id: string): Buffer {
		const metadata = this.get(mission, id, "Artifact");
		if (metadata.expires_at !== undefined && metadata.expires_at !== null && metadata.expires_at <= Date.now())
			throw new SandhanaError("ARTIFACT_UNAVAILABLE", "Artifact expired; digest cannot prove its claim");
		return this.artifactBytes(mission, id);
	}
	private artifactBytes(mission: string, id: string): Buffer {
		const metadata = this.get(mission, id, "Artifact");
		const row = this.db.prepare("SELECT bytes FROM artifacts WHERE mission=? AND id=?").get(mission, id);
		if (!metadata.available || !row || !(row.bytes instanceof Uint8Array))
			throw new SandhanaError("ARTIFACT_UNAVAILABLE", "Artifact unavailable; evidence cannot prove its claim");
		const bytes = Buffer.from(row.bytes);
		if (digest(bytes) !== metadata.digest)
			throw new SandhanaError("ARTIFACT_UNAVAILABLE", "Artifact digest mismatch");
		return bytes;
	}
	/** State, immutable records, and retained bytes are one compare-on-revision transaction. */
	commit(
		expected: number,
		state: MissionState,
		records: MissionRecord[],
		artifacts: Map<string, Buffer> = new Map(),
	): void {
		validateMissionState(state);
		if (records.some((record) => record.record_type === "PublicMissionEvent"))
			throw new Error("Public events are derived only from a validated store commit");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT revision,state FROM missions WHERE id=?").get(state.mission_id);
			const previous = row ? (JSON.parse(String(row.state)) as MissionState) : undefined;
			if (previous) validateMissionState(previous);
			// Stable IDs with identical payloads are safe acknowledgements of an already committed transition.
			if (Number(row?.revision ?? 0) !== expected) {
				if (
					records.length > 0 &&
					records.every(
						(record) =>
							this.db
								.prepare("SELECT digest FROM records WHERE mission=? AND id=?")
								.get(state.mission_id, record.record_id)?.digest === digest(record),
					) &&
					canonical(previous) === canonical(state)
				) {
					this.db.exec("COMMIT");
					return;
				}
				throw new RevisionConflict("Stale mission revision: reload and revalidate");
			}
			if (state.schema_version !== 1 || state.record_type !== "MissionState" || state.revision !== expected + 1)
				throw new Error("Invalid mission state revision/version");
			const resumes = records.filter((record) => record.record_type === "ResumeRecord");
			const migratesStoppedRun = records.some((record) => record.record_type === "ConfigurationMigration");
			if (migratesStoppedRun && artifacts.size) throw new Error("Configuration migration cannot publish artifacts");
			const resumesStoppedRun =
				previous?.terminal !== null &&
				previous?.terminal !== undefined &&
				resumes.length === 1 &&
				resumes[0].previous_terminal_ref === previous.terminal &&
				state.phase === "COMPILING" &&
				state.terminal === null;
			const scheduleMaintenance =
				previous?.terminal &&
				records.length > 0 &&
				records.every(
					(record) =>
						record.record_type === "OperationSchedule" ||
						(record.record_type === "EvidenceRecord" &&
							record.source === "DIRGHAKRIYA/1" &&
							record.kind === "CONTROL" &&
							record.provenance === "KERNEL"),
				) &&
				canonical(state) ===
					canonical({
						...previous,
						revision: state.revision,
						schedules: state.schedules,
						operation_concurrency: state.operation_concurrency,
						last_event: state.last_event,
					});
			const lateSettlement =
				previous?.terminal &&
				records.some(
					(record) =>
						record.record_type === "OperationRecord" &&
						["CONFIRMED_COMPLETE", "FAILED", "OUTCOME_UNKNOWN"].includes(record.status) &&
						previous.operations.some((ref) => {
							const op = this.get(state.mission_id, ref, "OperationRecord");
							return op.operation_id === record.operation_id && op.status === "IN_PROGRESS";
						}),
				) &&
				records.every((record) =>
					[
						"OperationRecord",
						"BudgetReservation",
						"Artifact",
						"CheckpointRecord",
						"EvidenceRecord",
						"TargetBinding",
					].includes(record.record_type),
				) &&
				!records.some(
					(record) =>
						record.record_type === "BudgetReservation" && !["RECONCILED", "RETAINED"].includes(record.state),
				) &&
				canonical(state) ===
					canonical({
						...previous,
						revision: state.revision,
						operations: state.operations,
						reservations: state.reservations,
						used: state.used,
						checkpoints: state.checkpoints,
						last_event: state.last_event,
					});
			const soleRecord = records.length === 1 ? records[0] : null;
			const lateCapture =
				previous?.terminal &&
				soleRecord?.record_type === "BudgetReservation" &&
				soleRecord.capture_operation_ref !== undefined;
			if (lateCapture) validateCaptureReservation(this, soleRecord, state, previous, records);
			const lateExecutionObservation =
				previous?.terminal &&
				soleRecord?.record_type === "EvidenceRecord" &&
				soleRecord.stage === "execution-handle" &&
				soleRecord.kind === "OBSERVATION" &&
				soleRecord.provenance === "ADAPTER" &&
				previous.operations.some((ref) => {
					const operation = this.get(state.mission_id, ref, "OperationRecord");
					return operation.operation_id === soleRecord.operation_id && operation.status === "IN_PROGRESS";
				}) &&
				canonical(state) === canonical({ ...previous, revision: state.revision, last_event: state.last_event });
			const outputSlice = records.length === 1 && records[0].record_type === "BudgetReservation" ? records[0] : null;
			const sliceParts = outputSlice?.owner_operation_id.split(":");
			const sliceBytes = Number(sliceParts?.[3]);
			const terminalCancellation =
				previous?.terminal &&
				outputSlice?.state === "RECONCILED" &&
				sliceParts?.[0] === "cancellation" &&
				previous.operations.some((ref) => {
					const operation = this.get(state.mission_id, ref, "OperationRecord");
					return (
						operation.operation_id === sliceParts[1] &&
						["IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(operation.status)
					);
				}) &&
				canonical(outputSlice.actual) === canonical({ ...resources(), execution: 1 }) &&
				canonical(outputSlice.amounts) === canonical(outputSlice.actual) &&
				canonical(state) ===
					canonical({
						...previous,
						revision: state.revision,
						reservations: [...previous.reservations, outputSlice.record_id],
						used: { ...previous.used, execution: previous.used.execution + 1 },
					});
			const terminalRetrieval =
				previous?.terminal &&
				outputSlice?.state === "RECONCILED" &&
				sliceParts?.[0] === "output-slice" &&
				Number.isSafeInteger(sliceBytes) &&
				sliceBytes >= 0 &&
				sliceBytes <= 8192 &&
				canonical(outputSlice.actual) ===
					canonical({ ...resources(), output_bytes: sliceBytes, retrieval_bytes: sliceBytes }) &&
				canonical(outputSlice.amounts) === canonical(outputSlice.actual) &&
				state.used.output_bytes <= state.ceilings.output_bytes &&
				state.used.retrieval_bytes <= state.ceilings.retrieval_bytes &&
				canonical(state) ===
					canonical({
						...previous,
						revision: state.revision,
						reservations: [...previous.reservations, outputSlice.record_id],
						used: {
							...previous.used,
							output_bytes: previous.used.output_bytes + sliceBytes,
							retrieval_bytes: previous.used.retrieval_bytes + sliceBytes,
						},
					});
			if (
				previous &&
				((!legalTransition(previous.phase, state.phase) &&
					!resumesStoppedRun &&
					!migratesStoppedRun &&
					!scheduleMaintenance &&
					!lateSettlement &&
					!lateCapture &&
					!terminalRetrieval &&
					!lateExecutionObservation &&
					!terminalCancellation) ||
					previous.session_id !== state.session_id ||
					previous.command !== state.command)
			)
				throw new Error("Illegal mission transition or rewritten instruction");
			if (!row)
				this.db
					.prepare("INSERT INTO missions VALUES (?,?,?,?)")
					.run(state.mission_id, state.session_id, state.revision, canonical(state));
			for (const record of records) {
				validateRecord(record);
				if (record.mission_id !== state.mission_id || record.revision !== state.revision)
					throw new Error("Cross-mission or uncommitted record");
				const existing = this.db
					.prepare("SELECT digest FROM records WHERE mission=? AND id=?")
					.get(state.mission_id, record.record_id);
				if (existing && existing.digest !== digest(record))
					throw new RecordConflict("Different payload under stable record ID");
				if (!existing)
					this.db
						.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)")
						.run(
							state.mission_id,
							record.record_id,
							record.revision,
							record.record_type,
							digest(record),
							canonical(record),
						);
			}
			for (const [id, bytes] of artifacts) {
				const metadata = this.get(state.mission_id, id, "Artifact");
				const contract = this.get(state.mission_id, state.contract, "MissionContract");
				if (contract.configuration_ref) {
					const policy = this.get(state.mission_id, contract.configuration_ref, "KernelConfiguration").value
						.artifact;
					if (
						bytes.length > policy.max_bytes ||
						(policy.retention_ms !== null &&
							(metadata.expires_at === undefined ||
								metadata.expires_at === null ||
								metadata.expires_at > Date.now() + policy.retention_ms))
					)
						throw new Error("Artifact publication violates captured retention policy");
				}
				if (metadata.digest !== digest(bytes) || metadata.bytes !== bytes.length || bytes.length > 8 * 1024 * 1024)
					throw new Error("Artifact size/digest contract violated");
				this.db
					.prepare("INSERT OR IGNORE INTO artifacts VALUES (?,?,?,?)")
					.run(state.mission_id, id, metadata.digest, bytes);
			}
			this.validate(state, previous, records);
			const changedOperations = new Set(
				records.filter((record) => record.record_type === "OperationRecord").map((record) => record.operation_id),
			);
			const publicEvent = makeRecord(state.mission_id, state.revision, "PublicMissionEvent", {
				event_id: `${state.mission_id}:${state.revision}`,
				event_type: "MISSION_STATE",
				operation_id: changedOperations.size === 1 ? [...changedOperations][0] : null,
				payload: projectMissionSnapshot(this, state),
			});
			this.db
				.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)")
				.run(
					state.mission_id,
					publicEvent.record_id,
					state.revision,
					publicEvent.record_type,
					digest(publicEvent),
					canonical(publicEvent),
				);
			this.db
				.prepare("UPDATE missions SET revision=?,state=? WHERE id=?")
				.run(state.revision, canonical(state), state.mission_id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private validate(state: MissionState, previous: MissionState | undefined, additions: MissionRecord[]): void {
		const mission = state.mission_id;
		const spec = this.get(mission, state.command, "CommandSpecification");
		const contract = this.get(mission, state.contract, "MissionContract");
		if (
			previous &&
			previous.contract !== state.contract &&
			!additions.some((record) => record.record_id === state.contract)
		)
			throw new Error("Changing the active routing contract requires a current contract mutation");
		const configuration = contract.configuration_ref
			? this.get(mission, contract.configuration_ref, "KernelConfiguration")
			: null;
		if (configuration) validateConfiguration(configuration.value);
		validateCognitiveTickTransition(this, state, previous, additions);
		validateSchedules(this, state, previous, additions);
		const priorConstraints = previous?.operation_constraints ?? [];
		if (
			canonical((state.operation_constraints ?? []).slice(0, priorConstraints.length)) !==
			canonical(priorConstraints)
		)
			throw new Error("Current user constraints cannot disappear or be rewritten");
		for (const constraint of (state.operation_constraints ?? []).slice(priorConstraints.length)) {
			const source = this.get(mission, constraint.source_ref, "Amendment");
			const root = state.authorizations
				.map((ref) => this.get(mission, ref, "Authorization").environment)
				.find((environment) => environment.startsWith("local:"))
				?.slice(6);
			if (
				!root ||
				source.revision !== state.revision ||
				!additions.some((record) => record.record_id === source.record_id) ||
				!source.instruction.startsWith("operations: ")
			)
				throw new Error("Constraint requires a current sourced user operation event");
			const request: unknown = JSON.parse(source.instruction.slice(12));
			if (
				!request ||
				typeof request !== "object" ||
				!("deny_targets" in request) ||
				!Array.isArray(request.deny_targets) ||
				!request.deny_targets.some(
					(label: unknown) => typeof label === "string" && resolve(root, label) === constraint.target,
				) ||
				!inside(root, constraint.target)
			)
				throw new Error("Constraint target differs from the current user instruction");
		}
		const migrations = additions.filter((record) => record.record_type === "ConfigurationMigration");
		if (migrations.length) {
			const migration = migrations[0];
			if (
				!previous ||
				migrations.length !== 1 ||
				additions.length !== 3 ||
				!configuration ||
				configuration.source !== "MIGRATION" ||
				migration.previous_contract_ref !== previous.contract ||
				migration.contract_ref !== state.contract ||
				migration.configuration_ref !== configuration.record_id ||
				!additions.some((record) => record.record_id === configuration.record_id) ||
				!additions.some((record) => record.record_id === contract.record_id)
			)
				throw new Error("Configuration migration requires exactly its new configuration and contract");
			const prior = this.get(mission, previous.contract, "MissionContract");
			if (
				canonical(configuration.value) !== canonical(configurationForMigration(previous, prior)) ||
				canonical(configuration.resource_overrides) !== canonical({}) ||
				canonical(state) !== canonical({ ...previous, revision: state.revision, contract: contract.record_id }) ||
				canonical(contract) !==
					canonical({
						...prior,
						revision: state.revision,
						record_id: contract.record_id,
						configuration_ref: configuration.record_id,
					})
			)
				throw new Error("Configuration migration cannot change captured state, authority, budget or history");
		}
		if (
			previous &&
			this.get(mission, previous.contract, "MissionContract").configuration_ref !== contract.configuration_ref &&
			!migrations.length
		)
			throw new Error("Changing persisted configuration requires an explicit supported migration");
		if (
			previous &&
			(this.get(mission, previous.contract, "MissionContract").reconcile_operation_id ?? null) !==
				(contract.reconcile_operation_id ?? null) &&
			!additions.some(
				(record) => record.record_type === "ResumeRecord" && record.contract_ref === contract.record_id,
			)
		)
			throw new Error("Selecting reconciliation requires explicit stopped-run resume");
		if (
			contract.command_spec_ref !== spec.record_id ||
			contract.route !== state.route ||
			contract.product_mode !== "padma_code"
		)
			throw new Error("Contract identity mismatch or unavailable product profile");
		const requirements = state.requirements.map((id) => this.get(mission, id, "Requirement"));
		for (const [refs, type] of [
			[state.authorizations, "Authorization"],
			[state.operations, "OperationRecord"],
			[state.reservations, "BudgetReservation"],
			[state.checkpoints, "CheckpointRecord"],
			[state.best, "CheckpointRecord"],
			[state.hypotheses, "Hypothesis"],
		] as const) {
			if (new Set(refs).size !== refs.length) throw new Error("Duplicate mission projection reference");
			for (const ref of refs) this.get(mission, ref, type);
		}
		for (const ref of state.best) {
			if (!state.checkpoints.includes(ref))
				throw new Error("Best checkpoint must remain in the active checkpoint projection");
			const point = this.get(mission, ref, "CheckpointRecord");
			const artifact = this.get(mission, point.artifact_ref, "Artifact");
			if (point.level === "EXPERIMENTAL" || artifact.purpose !== "DELIVERED" || artifact.target !== point.target)
				throw new Error("Best checkpoint requires validated delivered bytes for its target");
			if (
				point.preimage !== artifact.digest ||
				point.preimage !== digest(this.artifact(mission, point.artifact_ref))
			)
				throw new Error("Best checkpoint bytes do not match their delivered artifact");
			for (const requirementId of point.coverage) {
				const requirement = requirements.find((candidate) => candidate.requirement_id === requirementId);
				if (
					!requirement ||
					requirement.status !== "VERIFIED" ||
					requirement.target !== point.target ||
					requirement.generation !== artifact.generation ||
					!point.verification_refs.some((verification) => requirement.evidence.includes(verification))
				)
					throw new Error("Best checkpoint coverage lacks current target-specific verification");
			}
		}
		if (new Set(requirements.map((req) => req.requirement_id)).size !== requirements.length)
			throw new Error("Duplicate active requirement identity");
		const contractRequirements = contract.requirements.map(
			(id) => this.get(mission, id, "Requirement").requirement_id,
		);
		if (
			contractRequirements.length !== requirements.length ||
			requirements.some((req) => !contractRequirements.includes(req.requirement_id))
		)
			throw new Error("Contract omitted an active mission requirement");
		if (state.last_event) this.get(mission, state.last_event, "EvidenceRecord");
		if (state.terminal && this.get(mission, state.terminal, "TerminalReport").status !== state.phase)
			throw new Error("Terminal projection status mismatch");
		const reservations = state.reservations.map((id) => this.get(mission, id, "BudgetReservation"));
		if (new Set(reservations.map((item) => item.owner_operation_id)).size !== reservations.length)
			throw new Error("Duplicate reservation owner would double reserve or settle usage");
		const hypotheses = state.hypotheses.map((id) => this.get(mission, id, "Hypothesis"));
		if (new Set(hypotheses.map((hypothesis) => hypothesis.hypothesis_id)).size !== hypotheses.length)
			throw new Error("Duplicate hypothesis identity in the current projection");
		for (const ref of previous?.hypotheses ?? []) {
			const prior = this.get(mission, ref, "Hypothesis");
			const current = hypotheses.find((hypothesis) => hypothesis.hypothesis_id === prior.hypothesis_id);
			if (
				!current ||
				(current.record_id !== ref && !additions.some((record) => record.record_id === current.record_id))
			)
				throw new Error("Hypothesis history cannot be dropped or replaced by a stale revision");
		}
		if (
			hypotheses.filter((hypothesis) => hypothesis.status === "ACTIVE").length >
			(state.route === "GAMBHIRA"
				? (configuration?.value.branches.active ?? 3)
				: Math.min(1, configuration?.value.branches.active ?? 1))
		)
			throw new Error("Active hypothesis branch ceiling exceeded");
		if (state.leading_hypothesis && !state.hypotheses.includes(state.leading_hypothesis))
			throw new Error("Selected hypothesis is outside the current branch projection");
		if (
			!Number.isSafeInteger(state.verification_reserve) ||
			state.verification_reserve < 0 ||
			state.verification_reserve > state.ceilings.execution
		)
			throw new Error("Invalid protected verification reserve");
		for (const dimension of Object.keys(state.used) as (keyof MissionState["used"])[]) {
			if (state.used[dimension] !== null && (!Number.isFinite(state.used[dimension]) || state.used[dimension]! < 0))
				throw new Error("Invalid resource measurement");
			if (
				state.ceilings[dimension] !== null &&
				(!Number.isFinite(state.ceilings[dimension]) || state.ceilings[dimension]! < 0)
			)
				throw new Error("Invalid resource ceiling");
		}
		if (previous) {
			for (const id of previous.requirements) {
				const old = this.get(mission, id, "Requirement");
				const current = requirements.find((req) => req.requirement_id === old.requirement_id);
				if (!current) throw new Error("Recompilation discarded original requirement");
				const changed = ["text", "source_ref", "mandatory", "rule", "target", "expected", "dependencies"] as const;
				if (
					changed.some((key) => canonical(current[key] ?? null) !== canonical(old[key] ?? null)) &&
					!additions.some(
						(record) =>
							record.record_type === "Amendment" &&
							record.requirement_changes.includes(old.requirement_id) &&
							record.record_id === current.source_ref,
					)
				)
					throw new Error("Only an explicit user amendment can change an existing obligation");
			}
			for (const oldRef of previous.operations) {
				const oldOperation = this.get(mission, oldRef, "OperationRecord");
				if (
					oldOperation.status !== "NOT_STARTED" &&
					!state.operations.some(
						(ref) => this.get(mission, ref, "OperationRecord").operation_id === oldOperation.operation_id,
					)
				)
					throw new Error("Started operation cannot disappear from authoritative state");
			}
			for (const key of Object.keys(state.used) as (keyof MissionState["used"])[]) {
				if (previous.used[key] !== null && state.used[key] !== null && state.used[key]! < previous.used[key]!)
					throw new Error("Budget usage cannot decrease");
			}
		}
		for (const req of requirements) {
			if (req.source_ref !== spec.record_id) this.get(mission, req.source_ref, "Amendment");
			if (req.status === "SUPERSEDED") {
				if (!req.superseded_by) throw new Error("Supersession requires a user amendment");
				this.get(mission, req.superseded_by, "Amendment");
			}
			if (
				req.status === "VERIFIED" &&
				(!req.evidence.length ||
					req.evidence.some((id) => {
						const event = this.get(mission, id, "EvidenceRecord");
						return (
							event.kind !== "VERIFICATION" ||
							event.payload === null ||
							typeof event.payload !== "object" ||
							!("result" in event.payload) ||
							event.payload.result !== "PASSED" ||
							event.target_generation !== req.generation ||
							!event.requirement_ids.includes(req.requirement_id)
						);
					}))
			)
				throw new Error("Requirement lacks current verification");
		}
		for (const record of additions) {
			switch (record.record_type) {
				case "KernelConfiguration":
					validateConfiguration(record.value);
					if (previous ? !migrations.length : record.source !== "APPLICATION")
						throw new Error(
							"Application configuration must be captured at mission creation or supported migration",
						);
					break;
				case "BudgetChange": {
					if (!previous || spec.source !== "USER")
						throw new Error("Budget adjustment needs an existing user mission");
					const source = this.get(mission, record.source_ref, "Amendment");
					const prefix = source.instruction.startsWith(`resume ${mission} budget: `)
						? `resume ${mission} budget: `
						: "budget: ";
					if (
						!source.instruction.startsWith(prefix) ||
						source.revision !== state.revision ||
						source.revokes ||
						source.requirement_changes.length ||
						!(contract.amendment_refs ?? []).includes(source.record_id) ||
						contract.budget_ref !== record.record_id
					)
						throw new Error("Budget change lacks current scoped user amendment");
					const request: unknown = JSON.parse(source.instruction.slice(prefix.length));
					if (!Value.Check(BudgetChangeInputSchema, request) || canonical(request) !== canonical(record.request))
						throw new Error("Budget change differs from the actual user request");
					const priorContract = this.get(mission, previous.contract, "MissionContract");
					for (const key of [
						"command_spec_ref",
						"product_mode",
						"route",
						"signals",
						"bindings",
						"allowed_classes",
						"quality_obligations",
						"policy_version",
						"configuration_ref",
						"strategy",
					] as const)
						if (canonical(contract[key] ?? null) !== canonical(priorContract[key] ?? null))
							throw new Error("Budget adjustment cannot change compiled scope or obligations");
					if (
						canonical(
							contract.requirements.map((ref) => this.get(mission, ref, "Requirement").requirement_id),
						) !==
						canonical(
							priorContract.requirements.map((ref) => this.get(mission, ref, "Requirement").requirement_id),
						)
					)
						throw new Error("Budget adjustment cannot replace original requirements");
					if (contract.recompile_source !== source.record_id)
						throw new Error("Budget contract must cite its current user source");
					const prior = priorContract.budget_ref
						? this.get(mission, priorContract.budget_ref, "BudgetChange")
						: null;
					if (
						record.previous_ref !== (prior?.record_id ?? null) ||
						canonical(record.overrides) !== canonical({ ...prior?.overrides, ...request.ceilings }) ||
						record.verification_reserve !== (request.verification_reserve ?? prior?.verification_reserve ?? null)
					)
						throw new Error("Budget adjustment discarded or fabricated prior overrides");
					for (const key of [
						"used",
						"started_at",
						"authorizations",
						"requirements",
						"operations",
						"reservations",
						"checkpoints",
						"best",
						"hypotheses",
						"route",
					] as const)
						if (canonical(state[key]) !== canonical(previous[key]))
							throw new Error("Budget change cannot reset spending, deadline or authority");
					if (state.intent_epoch !== (previous.intent_epoch ?? 1) + 1)
						throw new Error("Budget change must invalidate queued preparation");
					break;
				}
				case "ResumeRecord": {
					const source = this.get(mission, record.source_ref, "Amendment");
					const resumedContract = this.get(mission, record.contract_ref, "MissionContract");
					const budgetChange = additions.find(
						(item) => item.record_type === "BudgetChange" && item.source_ref === source.record_id,
					);
					const approval = record.approval_ref ? this.get(mission, record.approval_ref, "ActionApproval") : null;
					if (
						approval &&
						(approval.source_ref !== source.record_id ||
							approval.revision !== state.revision ||
							budgetChange ||
							record.reconcile_operation_id)
					)
						throw new Error(
							"Exact-action approval requires its own sourced resume without budget or reconciliation changes",
						);
					const pending = state.operations
						.map((ref) => this.get(mission, ref, "OperationRecord"))
						.filter((operation) => ["IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(operation.status));
					const selected = pending.find((operation) => operation.operation_id === record.reconcile_operation_id);
					if (record.reconcile_operation_id) {
						if (
							pending.length !== 1 ||
							selected?.status !== "OUTCOME_UNKNOWN" ||
							resumedContract.reconcile_operation_id !== selected.operation_id
						)
							throw new Error("Resume may inspect only one selected uncertain local replacement");
						localReplacement(this, selected);
					} else if (pending.length || resumedContract.reconcile_operation_id)
						throw new Error("Resume requires settled operations or an explicit reconciliation selection");
					if (
						!previous?.terminal ||
						record.previous_terminal_ref !== previous.terminal ||
						record.previous_contract_ref !== previous.contract ||
						record.contract_ref !== state.contract ||
						state.phase !== "COMPILING" ||
						state.terminal !== null ||
						source.revision !== state.revision ||
						(source.instruction !== `resume ${mission}` &&
							!(budgetChange && source.instruction.startsWith(`resume ${mission} budget: `)) &&
							!(
								approval && canonical(parseActionApproval(source.instruction)) === canonical(approval.request)
							)) ||
						source.revokes ||
						source.requirement_changes.length ||
						resumedContract.recompile_source !== source.record_id
					)
						throw new Error("Resume requires explicit current user input, prior report and settled operations");
					const preserved = [
						"used",
						"started_at",
						"route",
						"requirements",
						"authorizations",
						"operations",
						"reservations",
						"checkpoints",
						"best",
						"hypotheses",
						"stagnation",
						"leading_hypothesis",
						"cognitive_tick",
					] as const;
					// validateCognitiveTickTransition already validates this exact prior OPEN tick and its durable progress.
					const settlesTick = additions.some(
						(item) =>
							item.record_type === "CognitiveTick" &&
							item.status === "SETTLED" &&
							item.record_id === state.cognitive_tick,
					);
					if (
						(!budgetChange &&
							(canonical(state.ceilings) !== canonical(previous?.ceilings) ||
								state.verification_reserve !== previous?.verification_reserve)) ||
						preserved.some(
							(key) =>
								!(settlesTick && (key === "stagnation" || key === "cognitive_tick")) &&
								canonical(state[key] ?? null) !== canonical(previous[key] ?? null),
						) ||
						state.intent_epoch !== (previous.intent_epoch ?? 1) + 1
					)
						throw new Error("Resume cannot reset spending, deadline, scope or governed history");
					const priorContract = this.get(mission, previous.contract, "MissionContract");
					const contractFields = [
						"product_mode",
						"route",
						"signals",
						"bindings",
						"allowed_classes",
						"quality_obligations",
						"policy_version",
						"configuration_ref",
						"strategy",
					] as const;
					if (
						contractFields.some(
							(key) => canonical(resumedContract[key] ?? null) !== canonical(priorContract[key] ?? null),
						) ||
						(!budgetChange &&
							(canonical(resumedContract.ceilings) !== canonical(priorContract.ceilings) ||
								resumedContract.verification_reserve !== priorContract.verification_reserve ||
								resumedContract.budget_ref !== priorContract.budget_ref)) ||
						canonical(resumedContract.requirements) !== canonical(state.requirements)
					)
						throw new Error("Resume cannot silently change the compiled contract");
					this.get(mission, record.previous_terminal_ref, "TerminalReport");
					break;
				}
				case "ActionApproval": {
					const source = this.get(mission, record.source_ref, "Amendment");
					const original = validateActionApproval(this, record.request, record.record_id);
					if (
						!previous?.terminal ||
						record.request.mission_id !== mission ||
						record.request.revision !== previous.revision ||
						source.revision !== state.revision ||
						source.revokes ||
						source.requirement_changes.length ||
						canonical(parseActionApproval(source.instruction)) !== canonical(record.request) ||
						record.intent_epoch !== state.intent_epoch ||
						record.intent_epoch !== (previous.intent_epoch ?? 1) + 1 ||
						record.expires_at !== source.captured_at + original.timeout_ms + 30000 ||
						record.expires_at <= Date.now() ||
						!additions.some(
							(item) =>
								item.record_type === "ResumeRecord" &&
								item.approval_ref === record.record_id &&
								item.source_ref === source.record_id,
						)
					)
						throw new Error("Approval requires current exact user input and preserved stopped-run history");
					break;
				}
				case "Hypothesis": {
					validateHypothesis(this, record, previous?.hypotheses ?? [], state);
					if (record.parent_ref) {
						const parent = this.get(mission, record.parent_ref, "Hypothesis");
						if (
							state.route !== "GAMBHIRA" ||
							record.depth !== (parent.depth ?? 0) + 1 ||
							record.depth > (configuration?.value.branches.depth ?? 2)
						)
							throw new Error("Invalid hypothesis parent/depth");
					} else if ((record.depth ?? 0) !== 0) throw new Error("Root hypothesis depth must be zero");
					for (const ref of [...record.supporting, ...record.contradicting, ...(record.branch_evidence ?? [])])
						if (this.get(mission, ref, "EvidenceRecord").kind !== "OBSERVATION")
							throw new Error("Hypothesis premises need actual observation evidence");
					break;
				}
				case "CandidateAction": {
					if (!record.hypothesis_ref) {
						if (record.hypothesis_binding_ref || record.hypothesis_selection_version || record.shared_experiment)
							throw new Error("A hypothesis selection requires its selected branch");
						break;
					}
					if (!record.hypothesis_binding_ref || record.hypothesis_selection_version !== "HYPOTHESIS_SELECTION/1")
						throw new Error("A selected hypothesis requires versioned premise validation");
					const hypothesis = this.get(mission, record.hypothesis_ref, "Hypothesis");
					const premise = this.get(mission, record.hypothesis_binding_ref, "TargetBinding");
					const action = additions.find(
						(item) => item.record_type === "PreparedAction" && item.operation_id === record.operation_id,
					);
					if (
						!previous?.hypotheses.includes(hypothesis.record_id) ||
						hypothesis.status !== "ACTIVE" ||
						premise.revision !== record.revision ||
						action?.record_type !== "PreparedAction" ||
						!hypothesisPremiseMatches(this, hypothesis, premise, previous.revision)
					)
						throw new Error("Hypothesis selection does not match the current eligible premise");
					const target = this.get(mission, action.binding_ref, "TargetBinding");
					if (record.shared_experiment) {
						const schema = this.get(mission, action.schema_ref, "RegisteredActionSchema");
						const args = action.arguments as Record<string, unknown>;
						const sharedRead =
							record.shared_experiment.version === "SHARED_OBSERVATION/1" &&
							schema.version.startsWith("read/1:") &&
							!schema.side_effect &&
							action.risk === 0 &&
							target.canonical_path === hypothesis.target;
						const sharedTest =
							record.shared_experiment.version === "SHARED_TEST/1" &&
							/^(?:bash|powershell)\/1:/.test(schema.version) &&
							action.operation_class === `SHELL:${String(args.command)}` &&
							typeof args.command === "string" &&
							localCheck(args.command, target.canonical_path) !== null;
						if (
							(!sharedRead && !sharedTest) ||
							premise.canonical_path !== hypothesis.target ||
							record.estimate.execution !== 1 ||
							canonical(record.estimate) !== canonical(action.limits) ||
							record.shared_experiment.hypothesis_refs.length + 1 > (configuration?.value.branches.active ?? 3)
						)
							throw new Error(
								"Shared hypotheses require one registered file observation or scoped foreground check and its exact cost",
							);
						for (const ref of record.shared_experiment.hypothesis_refs) {
							const shared = this.get(mission, ref, "Hypothesis");
							if (
								ref === hypothesis.record_id ||
								!previous.hypotheses.includes(ref) ||
								shared.status !== "ACTIVE" ||
								shared.target !== hypothesis.target ||
								!hypothesisPremiseMatches(this, shared, premise, previous.revision)
							)
								throw new Error(
									"Shared selection requires a distinct current hypothesis on the exact observed premise",
								);
						}
					}
					if (
						record.target !== target.canonical_path ||
						record.tool_id !== action.tool_id ||
						record.expected_effect !== action.intended_effect ||
						canonical(record.arguments) !== canonical(action.arguments) ||
						this.records(mission).some(
							(item) =>
								(item.record_type === "OperationRecord" ||
									(item.record_type === "CandidateAction" && item.record_id !== record.record_id)) &&
								item.operation_id === record.operation_id,
						)
					)
						throw new Error(
							"Hypothesis selection must accompany one exact preparation before its operation exists",
						);
					break;
				}
				case "MissionContract":
					validateRoutingContract(this, record, state, previous);
					this.get(mission, record.command_spec_ref, "CommandSpecification");
					for (const id of record.requirements) this.get(mission, id, "Requirement");
					for (const id of record.amendment_refs ?? []) this.get(mission, id, "Amendment");
					break;
				case "Authorization": {
					if (record.source_ref !== spec.record_id) this.get(mission, record.source_ref, "Amendment");
					if (spec.source !== "USER") throw new Error("Extension instruction cannot mint authorization");
					const source =
						record.source_ref === spec.record_id ? null : this.get(mission, record.source_ref, "Amendment");
					if (record.prepared_ref || source?.instruction.startsWith("authorize: ")) {
						if (!record.prepared_ref) throw new Error("An exact approval cannot mint general authority");
						const action = this.get(mission, record.prepared_ref, "PreparedAction");
						if (!action.approval_ref) throw new Error("Exact approval grant lacks its approved preparation");
						const approval = this.get(mission, action.approval_ref, "ActionApproval");
						const target = this.get(mission, action.binding_ref, "TargetBinding");
						if (record.revoked) {
							const prior = previous?.authorizations
								.map((ref) => this.get(mission, ref, "Authorization"))
								.find((grant) => grant.authorization_id === record.authorization_id);
							if (
								!prior ||
								!source?.revokes ||
								source.revision !== state.revision ||
								canonical(record) !==
									canonical({
										...prior,
										record_id: record.record_id,
										revision: record.revision,
										source_ref: source.record_id,
										revoked: true,
									})
							)
								throw new Error("Revocation must preserve the exact previously bound grant");
						}
						if (!record.revoked)
							validateApprovedPreparation(
								this,
								approval,
								action,
								target,
								this.get(mission, action.schema_ref, "RegisteredActionSchema"),
							);
						if (
							(!record.revoked && record.source_ref !== approval.source_ref) ||
							record.action_digest !== action.action_digest ||
							canonical(record.classes) !== canonical([action.operation_class]) ||
							record.target !== target.canonical_path ||
							record.environment !== target.environment ||
							record.policy_version !== contract.policy_version ||
							record.expires_at !== approval.expires_at ||
							(!record.revoked && action.intent_epoch !== state.intent_epoch)
						)
							throw new Error("Approval grant cannot widen its exact action, target, environment or validity");
					}
					break;
				}
				case "PreparedAction": {
					if (!configuration) throw new Error("Dispatch requires versioned mission configuration");
					const schema = this.get(mission, record.schema_ref, "RegisteredActionSchema");
					const binding = this.get(mission, record.binding_ref, "TargetBinding");
					if (record.operation_class.startsWith("SHELL:")) {
						const args = record.arguments as Record<string, unknown>;
						if (args.cwd !== binding.canonical_path || record.operation_class !== `SHELL:${args.command}`)
							throw new Error("Shell preparation must bind its exact command and native cwd");
					}
					if (record.approval_ref) {
						const approval = this.get(mission, record.approval_ref, "ActionApproval");
						validateApprovedPreparation(this, approval, record, binding, schema);
						if (
							record.intent_epoch !== state.intent_epoch ||
							this.records(mission).some(
								(item) =>
									item.record_type === "PreparedAction" &&
									item.record_id !== record.record_id &&
									item.approval_ref === record.approval_ref,
							)
						)
							throw new Error("Exact-action approval can bind only one current preparation");
					}
					const pending = state.operations
						.map((ref) => this.get(mission, ref, "OperationRecord"))
						.filter((operation) => ["IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(operation.status));
					if (
						pending.length &&
						!pending.every((op) =>
							independentPrepared(
								this,
								op.prepared_ref,
								schema.version.split("/")[0],
								binding.canonical_path,
								mission,
								op.status === "OUTCOME_UNKNOWN",
							),
						)
					) {
						const args = record.arguments as Record<string, unknown>;
						const selected = pending.find(
							(operation) => operation.operation_id === contract.reconcile_operation_id,
						);
						if (
							pending.length !== 1 ||
							selected?.status !== "OUTCOME_UNKNOWN" ||
							record.operation_class !== "READ" ||
							!schema.version.startsWith("read/1:") ||
							!schema.structural ||
							schema.side_effect ||
							args.offset !== undefined ||
							args.limit !== undefined
						)
							throw new Error("Unresolved operation permits only its governed reconciliation inspection");
						const original = localReplacement(this, selected).binding;
						if (
							binding.canonical_path !== original.canonical_path ||
							binding.workspace_id !== original.workspace_id ||
							binding.environment !== original.environment
						)
							throw new Error("Reconciliation inspection must bind the original target and workspace");
					}
					if (
						record.action_digest !== actionDigest(record) ||
						record.schema_version_ref !== schema.version ||
						record.tool_id !== schema.tool_id ||
						record.operation_class !== schema.operation_class ||
						record.risk < schema.risk_floor ||
						record.target_generation !== binding.generation ||
						!binding.valid
					)
						throw new Error("Invalid action schema/digest/binding");
					break;
				}
				case "ReconciliationRecord": {
					if (!previous?.operations.includes(record.operation_ref))
						throw new Error("Reconciliation must cite the current uncertain operation revision");
					validateLocalReconciliation(this, state, record);
					break;
				}
				case "OperationRecord": {
					const action = this.get(mission, record.prepared_ref, "PreparedAction");
					const prediction = this.get(mission, record.prediction_ref, "EvidenceRecord");
					if (
						record.operation_id !== action.operation_id ||
						prediction.kind !== "PREDICTION" ||
						prediction.operation_id !== action.operation_id
					)
						throw new Error("Operation lacks prior prediction");
					const priorRef = previous?.operations.find(
						(id) => this.get(mission, id, "OperationRecord").operation_id === record.operation_id,
					);
					const prior = priorRef ? this.get(mission, priorRef, "OperationRecord") : undefined;
					if (
						prior &&
						(prior.prepared_ref !== record.prepared_ref ||
							["CONFIRMED_COMPLETE", "FAILED"].includes(prior.status))
					)
						throw new Error(
							"Final operation cannot be dispatched/reconciled twice or change its prepared action",
						);
					if (
						["CONFIRMED_COMPLETE", "FAILED", "OUTCOME_UNKNOWN"].includes(record.status) &&
						(!prior || !["IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(prior.status))
					)
						throw new Error("Final operation requires a prior durable start");
					if (prior?.status === "OUTCOME_UNKNOWN") {
						const proof = additions.find(
							(value): value is RecordOf<"ReconciliationRecord"> =>
								value.record_type === "ReconciliationRecord" &&
								value.operation_ref === prior.record_id &&
								value.result === "POSTCONDITION_OBSERVED" &&
								record.reconciliation_refs.includes(value.record_id),
						);
						if (
							!proof ||
							record.status !== "CONFIRMED_COMPLETE" ||
							record.reservation_ref !== prior.reservation_ref ||
							record.prediction_ref !== prior.prediction_ref ||
							record.checkpoint_ref !== prior.checkpoint_ref ||
							record.invocation_charged !== prior.invocation_charged ||
							canonical(record.result_refs) !== canonical([...prior.result_refs, proof.observation_ref]) ||
							canonical(record.reconciliation_refs) !==
								canonical([...prior.reconciliation_refs, proof.record_id])
						)
							throw new Error(
								"Unknown outcome requires current authoritative reconciliation and preserved history",
							);
						validateLocalReconciliation(this, state, proof);
					}
					if (record.status !== "NOT_STARTED") {
						if (!record.decision_ref || !record.reservation_ref || !record.started_at)
							throw new Error("Operation missing durable authority/start/reservation");
						const decision = this.get(mission, record.decision_ref, "ScopeDecision");
						const reservation = this.get(mission, record.reservation_ref, "BudgetReservation");
						if (
							decision.outcome !== "ALLOW" ||
							decision.operation_id !== action.operation_id ||
							decision.action_digest !== action.action_digest ||
							decision.target_generation !== action.target_generation ||
							!decision.authorization_ref ||
							(record.status === "IN_PROGRESS" &&
								(decision.policy_version !== contract.policy_version ||
									!state.authorizations.includes(decision.authorization_ref)))
						)
							throw new Error("Dispatch lacks current matching ALLOW");
						const grant = this.get(mission, decision.authorization_ref, "Authorization");
						const binding = this.get(mission, action.binding_ref, "TargetBinding");
						if (
							record.status !== "IN_PROGRESS" &&
							prior &&
							(prior.decision_ref !== record.decision_ref || prior.started_at !== record.started_at)
						)
							throw new Error("Result rewrote historical dispatch authority/start");
						if (
							record.status === "IN_PROGRESS" &&
							((action.intent_epoch !== undefined && action.intent_epoch !== (state.intent_epoch ?? 1)) ||
								decision.evaluated_revision !== previous?.revision ||
								decision.valid_until < Date.now() ||
								grant.revoked ||
								grant.expires_at < Date.now() ||
								grant.policy_version !== contract.policy_version ||
								(!grant.classes.includes(action.operation_class) && !grant.classes.includes("*")) ||
								grant.environment !== binding.environment ||
								(action.operation_class.startsWith("SHELL:") && !grant.classes.includes("*")
									? grant.target !== binding.canonical_path
									: !inside(grant.target, binding.canonical_path)) ||
								(grant.prepared_ref !== undefined && grant.prepared_ref !== action.record_id) ||
								(grant.action_digest !== null && grant.action_digest !== action.action_digest))
						)
							throw new Error("Expired/revoked or mismatched dispatch authority");
						if (
							reservation.owner_operation_id !== record.operation_id ||
							(record.status === "IN_PROGRESS" &&
								(reservation.state !== "STARTED" ||
									reservation.revision !== record.revision ||
									decision.revision !== record.revision ||
									prediction.revision >= record.revision))
						)
							throw new Error("Start, current decision and reservation must commit together after prediction");
					}
					break;
				}
				case "BudgetReservation": {
					if (record.capture_operation_ref !== undefined || record.owner_operation_id.startsWith("capture:"))
						validateCaptureReservation(this, record, state, previous, additions);
					const previousRef = previous?.reservations.find(
						(ref) => this.get(mission, ref, "BudgetReservation").owner_operation_id === record.owner_operation_id,
					);
					if (previousRef) {
						const prior = this.get(mission, previousRef, "BudgetReservation");
						if (["RECONCILED", "RELEASED"].includes(prior.state))
							throw new Error("Reservation already reconciled/released");
						if (prior.owner_operation_id.startsWith("model:") && record.state === "RECONCILED") {
							validateModelSettlement(prior, record, state, previous!);
							if (
								modelOverrun(prior, record, state) &&
								!additions.some(
									(item) =>
										item.record_type === "EvidenceRecord" &&
										item.source === MODEL_OVERRUN_SOURCE &&
										item.payload &&
										typeof item.payload === "object" &&
										"settlement_ref" in item.payload &&
										item.payload.settlement_ref === record.record_id,
								)
							)
								throw new Error("Model settlement requires its exact overrun evidence in the same transaction");
						}
						if (["STARTED", "RETAINED"].includes(prior.state) && record.state === "RELEASED")
							throw new Error("Unknown effects cannot release capacity without reconciliation");
						if (
							["STARTED", "RETAINED"].includes(prior.state) &&
							["RECONCILED", "RETAINED"].includes(record.state)
						) {
							const outcome = additions.find(
								(item): item is RecordOf<"OperationRecord"> =>
									item.record_type === "OperationRecord" &&
									item.operation_id === record.owner_operation_id &&
									item.reservation_ref === record.record_id &&
									["CONFIRMED_COMPLETE", "FAILED", "OUTCOME_UNKNOWN"].includes(item.status),
							);
							if (
								!outcome ||
								!outcome.result_refs.some((ref) =>
									additions.some(
										(item) =>
											item.record_type === "EvidenceRecord" &&
											item.record_id === ref &&
											item.operation_id === record.owner_operation_id &&
											item.kind === "OBSERVATION" &&
											item.stage === "phala",
									),
								)
							)
								throw new Error(
									"Started usage settlement needs the operation's current raw result; unmeasured capacity stays reserved",
								);
							if (
								toolOverrun(
									prior,
									record,
									outcome,
									state,
									this.get(state.mission_id, outcome.result_refs[0], "EvidenceRecord").captured_at,
								) &&
								!additions.some(
									(item) =>
										item.record_type === "EvidenceRecord" &&
										item.source === TOOL_OVERRUN_SOURCE &&
										item.operation_id === outcome.operation_id,
								)
							)
								throw new Error("Tool settlement requires its exact overrun evidence in the same transaction");
						}
					}
					if (["RECONCILED", "RETAINED"].includes(record.state) && !record.actual)
						throw new Error("Settled reservation lacks actual usage measurements");
					break;
				}
				case "EvidenceRecord":
					if (
						record.source === TOOL_OVERRUN_SOURCE ||
						(record.payload &&
							typeof record.payload === "object" &&
							"version" in record.payload &&
							record.payload.version === "TOOL_USAGE_OVERRUN/1")
					)
						validateToolOverrun(this, record, state, previous, additions);
					if (
						record.source === "invalid-model-usage/1" ||
						(record.payload &&
							typeof record.payload === "object" &&
							"version" in record.payload &&
							record.payload.version === "MODEL_USAGE_INVALID/1")
					)
						validateInvalidModelUsage(this, record, state, previous, additions);
					if (
						record.source === MODEL_OVERRUN_SOURCE ||
						(record.payload &&
							typeof record.payload === "object" &&
							"version" in record.payload &&
							record.payload.version === "MODEL_USAGE_OVERRUN/1")
					)
						validateModelOverrun(this, record, state, previous, additions);
					if (
						record.source === "hypothesis-normalization/1" ||
						(record.payload &&
							typeof record.payload === "object" &&
							"version" in record.payload &&
							record.payload.version === "EQUIVALENT_HYPOTHESIS/1")
					)
						validateHypothesisMerge(this, record, state, previous, additions);
					if (record.source === "SARASANGRAHA_CAPSULE/1") {
						if (
							!previous ||
							record.kind !== "CONTROL" ||
							record.provenance !== "KERNEL" ||
							!record.payload ||
							typeof record.payload !== "object" ||
							!("version" in record.payload) ||
							record.payload.version !== "SARASANGRAHA_CAPSULE/1"
						)
							throw new Error("Invalid context capsule publication");
						validateCapsule(this, previous, record.payload as Capsule);
						if (
							canonical(state) !==
							canonical({
								...previous,
								revision: state.revision,
								last_event: record.record_id,
								used: { ...previous.used, artifact_bytes: state.used.artifact_bytes },
								reservations: state.reservations,
							})
						)
							throw new Error("Compaction cannot alter authoritative position or reset accounting");
					}
					if (record.stage === "proposal-failure") {
						const payload = record.payload;
						if (!Value.Check(ProposalFailureSchema, payload))
							throw new Error("Invalid proposal failure envelope");
						const history = this.records(mission);
						const prior = history
							.slice(
								0,
								history.findIndex((item) => item.record_id === record.record_id),
							)
							.filter((item) => item.record_type === "EvidenceRecord" && item.stage === "proposal-failure");
						if (
							record.provenance !== "KERNEL" ||
							record.kind !== "CONTROL" ||
							record.source !== "sandhana" ||
							record.operation_id !== null ||
							record.target_generation !== null ||
							record.artifact_ref !== null ||
							!record.failure ||
							record.failure.operation_id !== null ||
							record.failure.target_binding_ref !== null ||
							record.failure.code !== payload.diagnostic.code ||
							(payload.diagnostic.code === "UNREGISTERED_OPERATION") !==
								(payload.diagnostic.boundary === "TOOL_RESOLUTION") ||
							payload.tick_ref !== (state.cognitive_tick ?? null) ||
							payload.count !== prior.length + 1 ||
							payload.limit !== configuration?.value.stagnation.stop ||
							prior.some(
								(item) =>
									item.record_type === "EvidenceRecord" &&
									Value.Check(ProposalFailureSchema, item.payload) &&
									item.payload.diagnostic.id === payload.diagnostic.id,
							)
						)
							throw new Error(
								"Proposal failure must describe the current undispatched preparation and cumulative recovery bound",
							);
						if (payload.tick_ref && this.get(mission, payload.tick_ref, "CognitiveTick").status !== "OPEN")
							throw new Error("Proposal failure requires the current open decision");
					}
					if (
						record.stage !== "proposal-failure" &&
						record.payload &&
						typeof record.payload === "object" &&
						"version" in record.payload &&
						record.payload.version === "PROPOSAL_FAILURE/1"
					)
						throw new Error("Proposal failure envelope cannot use another evidence stage");
					if (record.failure) {
						if (!isFailure(record.failure))
							throw new Error("Failure recovery conditions do not match the boundary code");
						if (
							!["KERNEL", "ADAPTER"].includes(record.provenance) ||
							!["CONTROL", "OBSERVATION"].includes(record.kind) ||
							record.failure.operation_id !== record.operation_id
						)
							throw new Error(
								"Failure must come from an observed kernel/adapter boundary with matching operation identity",
							);
						const target = record.failure.target_binding_ref
							? this.get(mission, record.failure.target_binding_ref, "TargetBinding")
							: null;
						if (record.operation_id) {
							const action = this.records(mission).find(
								(entry) => entry.record_type === "PreparedAction" && entry.operation_id === record.operation_id,
							);
							if (
								!action ||
								action.record_type !== "PreparedAction" ||
								!target ||
								action.binding_ref !== target.record_id
							)
								throw new Error("Failure target must resolve to its actual prepared operation");
						}
					}
					if (record.artifact_ref) {
						if (digest(this.artifactBytes(mission, record.artifact_ref)) !== record.digest)
							throw new Error("Evidence artifact digest mismatch");
					} else if (digest(record.payload) !== record.digest) throw new Error("Inline evidence digest mismatch");
					if (record.kind === "OBSERVATION" && record.payload === null && !record.artifact_ref)
						throw new Error("Observation has no accessible bytes");
					if (
						record.source === "native-behavior-plan/1" ||
						(record.payload &&
							typeof record.payload === "object" &&
							"registered_rule" in record.payload &&
							record.payload.registered_rule === BEHAVIOR_PLAN_RULE)
					)
						validateBehaviorPlan(this, state, record);
					if (
						["INTERPRETATION", "VERIFICATION"].includes(record.kind) &&
						(!record.sources.length ||
							record.sources.some((id) => this.get(mission, id, "EvidenceRecord").kind !== "OBSERVATION"))
					)
						throw new Error("Derived evidence requires raw observations");
					if (record.kind === "VERIFICATION")
						if (record.stage === "pariskara" && record.requirement_ids.length === 0) {
							const payload = record.payload;
							const op = state.operations
								.map((id) => this.get(mission, id, "OperationRecord"))
								.find((value) => value.operation_id === record.operation_id);
							if (
								!op ||
								!payload ||
								typeof payload !== "object" ||
								!("rule" in payload) ||
								payload.rule !== "DECLARED_PROCESS_QUALITY" ||
								!("command" in payload) ||
								typeof payload.command !== "string" ||
								!contract.quality_obligations.includes(`PROCESS:${payload.command}`) ||
								this.get(mission, op.prepared_ref, "PreparedAction").operation_class !==
									`SHELL:${payload.command}`
							)
								throw new Error("Quality verification does not match a declared governed check");
							this.validateVerificationSources(mission, record, op);
						}
					if (record.kind === "VERIFICATION")
						for (const requirementId of record.requirement_ids) {
							const req = requirements.find((value) => value.requirement_id === requirementId);
							const operationRef = state.operations.find(
								(id) => this.get(mission, id, "OperationRecord").operation_id === record.operation_id,
							);
							if (!operationRef || !req) throw new Error("Verification lacks a governed operation/requirement");
							if (req.rule === "SEMANTIC") {
								validateBehaviorVerification(this, state, req, record);
								continue;
							}
							const op = this.get(mission, operationRef, "OperationRecord");
							const action = this.get(mission, op.prepared_ref, "PreparedAction");
							const target = this.get(mission, action.binding_ref, "TargetBinding");
							if (
								req.target !== target.canonical_path ||
								(req.rule === "PROCESS" && action.operation_class !== `SHELL:${req.expected}`)
							)
								throw new Error("Verification is for the wrong target/check");
							const observed = this.validateVerificationSources(mission, record, op);
							const payload = record.payload as Record<string, unknown>;
							const args = action.arguments as Record<string, unknown>;
							if (payload.rule !== req.rule) throw new Error("Verification rule does not match the requirement");
							if (payload.result === "PASSED") {
								const observation = this.get(mission, record.sources[0], "EvidenceRecord");
								const facts = observation.payload as Record<string, unknown>;
								if (
									!facts ||
									facts.dependencies_unchanged !== true ||
									!facts.dependencies ||
									typeof facts.dependencies !== "object" ||
									Array.isArray(facts.dependencies) ||
									canonical(payload.dependencies) !== canonical(facts.dependencies) ||
									(req.dependencies ?? []).some((path) => !(path in (facts.dependencies as object))) ||
									(["READ", "LIST", "STATUS"].includes(action.operation_class) &&
										facts.target_unchanged !== true)
								)
									throw new Error("Passing verification lacks the observation's current dependency vector");
								const source =
									typeof facts.full_output_ref === "string"
										? this.get(mission, facts.full_output_ref, "Artifact")
										: null;
								const supported =
									(req.rule === "READ" &&
										action.operation_class === "READ" &&
										args.offset === undefined &&
										args.limit === undefined) ||
									(req.rule === "LIST" && action.operation_class === "LIST" && args.limit === undefined) ||
									(req.rule === "STATUS" && action.operation_class === "STATUS") ||
									(req.rule === "PROCESS" && action.operation_class === `SHELL:${req.expected}`) ||
									(req.rule === "CONTENT" &&
										action.operation_class === "READ" &&
										args.offset === undefined &&
										args.limit === undefined &&
										req.expected !== null &&
										source?.target === req.target &&
										source.generation === record.target_generation &&
										digest(this.artifact(mission, source.record_id)) === digest(req.expected)) ||
									(req.rule === "CONTENT" &&
										action.operation_class === "EDIT" &&
										req.expected !== null &&
										action.intended_effect === `Content SHA256 ${digest(req.expected)}` &&
										this.records(mission).some(
											(value) =>
												value.record_type === "Artifact" &&
												value.purpose === "DELIVERED" &&
												value.target === req.target &&
												value.generation === record.target_generation &&
												value.digest === digest(req.expected),
										));
								if (!supported || observed.isError === true || op.status !== "CONFIRMED_COMPLETE")
									throw new Error("Passing verification lacks the registered rule's actual supported effect");
								if (req.rule === "PROCESS") {
									const process = observed.structuredContent;
									if (
										!process ||
										typeof process !== "object" ||
										!("exit_code" in process) ||
										process.exit_code !== 0
									)
										throw new Error("Passing process verification lacks an observed zero exit");
									if (payload.dependencies === null || typeof payload.dependencies !== "object")
										throw new Error("Process verification lacks source dependency generations");
								}
							}
						}
					if (
						record.kind === "VERIFICATION" &&
						((!(
							record.requirement_ids.length === 1 &&
							requirements.find((req) => req.requirement_id === record.requirement_ids[0])?.rule === "SEMANTIC"
						) &&
							record.sources.some(
								(id) => this.get(mission, id, "EvidenceRecord").target_generation !== record.target_generation,
							)) ||
							(!record.requirement_ids.length && record.stage !== "pariskara") ||
							record.requirement_ids.some((id) => !requirements.some((req) => req.requirement_id === id)))
					)
						throw new Error("Verification must cite active requirements");
					break;
				case "CheckpointRecord": {
					const metadata = this.get(mission, record.artifact_ref, "Artifact");
					const bytes =
						metadata.revision === state.revision
							? this.artifactBytes(mission, record.artifact_ref)
							: this.artifact(mission, record.artifact_ref);
					if (record.preimage !== "ABSENT" && record.preimage !== digest(bytes))
						throw new Error("Checkpoint does not contain its declared restorable bytes");
					if (!record.restore || (record.level !== "EXPERIMENTAL" && !record.verification_refs.length))
						throw new Error("Checkpoint needs real recovery and validation");
					for (const ref of record.verification_refs) {
						const source = this.records(mission).find((value) => value.record_id === ref);
						if (
							!source ||
							(source.record_type !== "EvidenceRecord" && source.record_type !== "VerificationReport")
						)
							throw new Error("Checkpoint validation reference is not evidence/report");
					}
					if (
						record.level === "MISSION_VERIFIED" &&
						!record.verification_refs.some((ref) => {
							const source = this.records(mission).find((value) => value.record_id === ref);
							return (
								source?.record_type === "VerificationReport" &&
								source.completion_status === "PASSED" &&
								["PASSED", "NOT_APPLICABLE"].includes(source.quality)
							);
						})
					)
						throw new Error("Mission checkpoint requires passing Pramana and quality report");
					break;
				}
				case "VerificationReport": {
					const active = requirements.filter((req) => req.mandatory && req.status !== "SUPERSEDED");
					if (
						active.length !== record.results.length ||
						active.some((req) => !record.results.some((result) => result.requirement_id === req.requirement_id))
					)
						throw new Error("Verification omitted mandatory requirements");
					for (const result of record.results)
						if (
							result.result === "PASSED" &&
							(!result.evidence.length ||
								result.evidence.some((id) => {
									const event = this.get(mission, id, "EvidenceRecord");
									return (
										event.kind !== "VERIFICATION" ||
										!event.requirement_ids.includes(result.requirement_id) ||
										!event.payload ||
										typeof event.payload !== "object" ||
										!("result" in event.payload) ||
										event.payload.result !== "PASSED" ||
										!active.some(
											(req) =>
												req.requirement_id === result.requirement_id &&
												req.status === "VERIFIED" &&
												req.generation === event.target_generation &&
												req.evidence.includes(id),
										)
									);
								}))
						)
							throw new Error("Passing report lacks requirement verification");
					if (record.completion_status === "PASSED" && record.results.some((result) => result.result !== "PASSED"))
						throw new Error("Inconclusive/failed report cannot pass");
					for (const ref of record.candidate_refs) this.artifact(mission, ref);
					break;
				}
				case "TerminalReport": {
					if (record.failure_refs) {
						if (new Set(record.failure_refs).size !== record.failure_refs.length)
							throw new Error("Duplicate failure reference");
						for (const ref of record.failure_refs) {
							const event = this.get(mission, ref, "EvidenceRecord");
							if (!event.failure || event.revision >= record.revision)
								throw new Error("Terminal failure reference requires a previously observed failure");
						}
					}
					if (record.output_limit_bytes !== undefined || configuration) {
						if (
							record.output_limit_bytes === undefined ||
							record.output_omitted === undefined ||
							!record.output_reservation_ref ||
							!previous
						)
							throw new Error("Terminal output requires bounded rendering and settled usage");
						const pending = state.reservations.reduce((bytes, ref) => {
							const reservation = this.get(mission, ref, "BudgetReservation");
							return (
								bytes +
								(["RESERVED", "STARTED", "RETAINED"].includes(reservation.state)
									? reservation.amounts.output_bytes
									: 0)
							);
						}, 0);
						const available = Math.max(0, state.ceilings.output_bytes - previous.used.output_bytes - pending);
						if (record.output_limit_bytes !== available)
							throw new Error("Terminal output allowance differs from remaining cumulative capacity");
						const view = renderTerminal(record, record.output_limit_bytes);
						const usage = this.get(mission, record.output_reservation_ref, "BudgetReservation");
						const actual = { ...resources(), output_bytes: Buffer.byteLength(view.text) };
						const report = record.verification_report_ref
							? this.get(mission, record.verification_report_ref, "VerificationReport")
							: null;
						if (
							record.output_omitted !== (view.omitted || report?.presentation_omitted === true) ||
							usage.state !== "RECONCILED" ||
							usage.owner_operation_id !== `terminal:${state.contract}` ||
							!usage.protected_for_verification ||
							usage.revision !== record.revision ||
							!state.reservations.includes(usage.record_id) ||
							!additions.some((item) => item.record_id === usage.record_id) ||
							canonical(usage.amounts) !== canonical(actual) ||
							canonical(usage.actual) !== canonical(actual) ||
							state.used.output_bytes !== previous.used.output_bytes + actual.output_bytes
						)
							throw new Error("Terminal output charge or omission differs from the persisted bounded view");
						if (record.output_omitted && ["VERIFIED_COMPLETE", "DELIVERED_UNVERIFIED"].includes(record.status))
							throw new Error("An omitted terminal report cannot claim successful delivery");
					}
					if (state.terminal !== record.record_id || state.phase !== record.status || previous?.terminal)
						throw new Error("Only one authoritative terminal");
					if (record.contract_ref !== undefined && record.contract_ref !== state.contract)
						throw new Error("Terminal report belongs to another contract revision");
					const unknown = state.operations
						.map((id) => this.get(mission, id, "OperationRecord"))
						.find((op) => op.status === "OUTCOME_UNKNOWN" || op.status === "IN_PROGRESS");
					if (
						unknown &&
						(record.status !== "OUTCOME_UNKNOWN" || record.unknown_operation !== unknown.operation_id)
					)
						throw new Error("Unknown effects take precedence");
					if (["VERIFIED_COMPLETE", "DELIVERED_UNVERIFIED"].includes(record.status)) {
						if (!record.verification_report_ref) throw new Error("Success requires verification report");
						const report = this.get(mission, record.verification_report_ref, "VerificationReport");
						const active = requirements.filter((req) => req.mandatory && req.status !== "SUPERSEDED");
						if (
							active.length !== report.results.length ||
							active.some(
								(req) => !report.results.some((result) => result.requirement_id === req.requirement_id),
							)
						)
							throw new Error("Terminal report no longer covers the current obligations");
						if (
							record.status === "VERIFIED_COMPLETE" &&
							(report.completion_status !== "PASSED" || !["PASSED", "NOT_APPLICABLE"].includes(report.quality))
						)
							throw new Error("Success without passing report");
						if (
							record.status === "DELIVERED_UNVERIFIED" &&
							(report.delivery_status !== "DELIVERED" ||
								report.results.some(
									(result) =>
										result.result === "FAILED" ||
										(result.result === "INCONCLUSIVE" &&
											requirements.find((req) => req.requirement_id === result.requirement_id)?.rule !==
												"SUBJECTIVE"),
								) ||
								report.quality === "FAILED" ||
								(report.quality === "INCONCLUSIVE" &&
									contract.quality_obligations.some((rule) => rule.startsWith("PROCESS:"))) ||
								!record.limitations.length ||
								!record.next_action)
						)
							throw new Error("Ineligible delivered-unverified claim");
					} else if (!record.evidence.length) throw new Error("Early stop requires causal evidence");
					break;
				}
				default:
					break;
			}
		}
		if (configuration) {
			const change = contract.budget_ref ? this.get(mission, contract.budget_ref, "BudgetChange") : undefined;
			const budget = routeBudget(configuration.value, state.route, configuration.resource_overrides, change);
			if (
				canonical(state.ceilings) !== canonical(budget.ceilings) ||
				state.verification_reserve !== budget.verification_reserve ||
				canonical(contract.ceilings) !== canonical(state.ceilings) ||
				contract.verification_reserve !== state.verification_reserve
			)
				throw new Error("Effective budget differs from captured configuration and user amendments");
			if (
				previous &&
				this.get(mission, previous.contract, "MissionContract").budget_ref !== contract.budget_ref &&
				!additions.some(
					(record) => record.record_type === "BudgetChange" && record.record_id === contract.budget_ref,
				)
			)
				throw new Error("Budget pointer changed without a current user amendment");
		}
		const reserved = state.reservations
			.map((id) => this.get(mission, id, "BudgetReservation"))
			.filter((r) => ["RESERVED", "STARTED", "RETAINED"].includes(r.state));
		for (const reservation of reserved)
			for (const amount of Object.values(reservation.amounts))
				if (amount !== null && (!Number.isFinite(amount) || amount < 0))
					throw new Error("Invalid reservation resource vector");
		// Capacity prevents new reservations/starts. Actual settlement and reporting must survive a measured overrun.
		const admitsWork = additions.some(
			(record) =>
				record.record_type === "BudgetReservation" &&
				record.capture_operation_ref === undefined &&
				["RESERVED", "STARTED"].includes(record.state),
		);
		if (!admitsWork) return;
		if (activeModelOverrun(this, state)) throw new SandhanaError("BUDGET_OVERRUN", MODEL_OVERRUN_REASON);
		if (activeToolOverrun(this, state)) throw new SandhanaError("BUDGET_OVERRUN", TOOL_OVERRUN_REASON);
		// Captured legacy unknown model spending cannot admit a model, but a zero-model-cost recovery read remains possible.
		const legacyModelUnknown =
			configuration?.source === "MIGRATION" &&
			!state.reservations.some((ref) =>
				this.get(mission, ref, "BudgetReservation").owner_operation_id.startsWith("model:"),
			);
		for (const dimension of Object.keys(state.used) as (keyof MissionState["used"])[]) {
			const pending = reserved.reduce((sum, reservation) => sum + (reservation.amounts[dimension] ?? 0), 0);
			if (
				reserved.some((reservation) => reservation.amounts[dimension] === null) ||
				(state.used[dimension] === null &&
					!(
						legacyModelUnknown &&
						pending === 0 &&
						["input_tokens", "output_tokens", "cost"].includes(dimension)
					)) ||
				(state.used[dimension] !== null && pending + state.used[dimension]! > (state.ceilings[dimension] ?? 0))
			)
				throw new SandhanaError(
					"BUDGET_REJECTED",
					`Resource reservation exceeds cumulative ${dimension} ceiling or measurement unknown`,
				);
		}
		const calls = reserved.reduce((sum, r) => sum + r.amounts.execution, 0);
		if (
			state.used.execution + calls > state.ceilings.execution ||
			state.used.preflight + reserved.reduce((sum, r) => sum + r.amounts.preflight, 0) > state.ceilings.preflight
		)
			throw new SandhanaError("BUDGET_REJECTED", "Budget reservation exceeds ceiling");
		if (
			reserved.some((r) => r.amounts.execution > 0 && !r.protected_for_verification) &&
			state.used.execution + calls > state.ceilings.execution - state.verification_reserve
		)
			throw new SandhanaError("BUDGET_REJECTED", "Exploration spent protected verification capacity");
	}
	private validateVerificationSources(
		mission: string,
		record: RecordOf<"EvidenceRecord">,
		operation: RecordOf<"OperationRecord">,
	): Record<string, unknown> {
		if (
			record.provenance !== "KERNEL" ||
			!record.payload ||
			typeof record.payload !== "object" ||
			!("result" in record.payload) ||
			!["PASSED", "FAILED", "INCONCLUSIVE"].includes(String(record.payload.result))
		)
			throw new Error("Verification must come from a registered kernel rule");
		if (record.sources.length !== 1 || !operation.result_refs.includes(record.sources[0]))
			throw new Error("Verification must cite the governed operation's actual result");
		const observation = this.get(mission, record.sources[0], "EvidenceRecord");
		if (
			observation.stage !== "phala" ||
			observation.provenance !== "ADAPTER" ||
			observation.operation_id !== operation.operation_id ||
			!observation.artifact_ref
		)
			throw new Error("Binding metadata and interpretations are not result proof");
		const result: unknown = JSON.parse(this.artifact(mission, observation.artifact_ref).toString());
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw new Error("Invalid retained adapter result");
		if (
			record.payload.result === "PASSED" &&
			(("isError" in result && result.isError === true) || operation.status !== "CONFIRMED_COMPLETE")
		)
			throw new Error("Failed/unknown operation cannot establish a passing rule");
		return result as Record<string, unknown>;
	}
}
