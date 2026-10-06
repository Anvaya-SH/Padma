import { randomUUID } from "node:crypto";
import { hostname, totalmem } from "node:os";
import type { AgentToolResult } from "@anvaya.sh/padma-agent-core";
import { inside, redact } from "./code.ts";
import type { SandhanaKernel } from "./kernel.ts";
import {
	canonical,
	type Draft,
	digest,
	type MissionRecord,
	type MissionState,
	makeRecord,
	type RecordOf,
} from "./records.ts";
import { boundedText } from "./reporting.ts";
import type { MissionStore } from "./store.ts";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const edges: Record<RecordOf<"OperationSchedule">["status"], string[]> = {
	QUEUED: ["QUEUED", "DISPATCHED", "FAILED", "CANCELLED"],
	DISPATCHED: ["DISPATCHED", "RUNNING", "FAILED", "CANCELLED", "CANCEL_REQUESTED", "UNCERTAIN"],
	RUNNING: ["RUNNING", "COMPLETED", "FAILED", "CANCEL_REQUESTED", "UNCERTAIN"],
	CANCEL_REQUESTED: ["CANCEL_REQUESTED", "COMPLETED", "FAILED", "CANCELLED", "UNCERTAIN"],
	UNCERTAIN: ["UNCERTAIN", "COMPLETED", "FAILED"],
	COMPLETED: [],
	FAILED: [],
	CANCELLED: [],
};
export type OperationDependency = RecordOf<"OperationSchedule">["dependencies"][number];
function schedules(store: MissionStore, state: MissionState) {
	return (state.schedules ?? []).map((ref) => store.get(state.mission_id, ref, "OperationSchedule"));
}
function effect(store: MissionStore, state: MissionState, id: string) {
	return state.operations
		.map((ref) => store.get(state.mission_id, ref, "OperationRecord"))
		.find((op) => op.operation_id === id);
}
/** Independence is a reviewed local read property, not a model assertion. Opaque processes conflict with everything. */
export function independentPrepared(
	store: MissionStore,
	ref: string,
	kind: string,
	target: string,
	mission: string,
	uncertain = false,
): boolean {
	const action = store.get(mission, ref, "PreparedAction");
	const schema = store.get(mission, action.schema_ref, "RegisteredActionSchema");
	const binding = store.get(mission, action.binding_ref, "TargetBinding");
	return (
		["read", "ls"].includes(kind) &&
		((/^(read|ls)\/1:/.test(schema.version) && !schema.side_effect) ||
			(uncertain && schema.conditional_commit && /^(write|edit|restore)\/2:/.test(schema.version))) &&
		!inside(binding.canonical_path, target) &&
		!inside(target, binding.canonical_path)
	);
}
function independent(
	store: MissionStore,
	mission: string,
	left: RecordOf<"OperationSchedule">,
	right: RecordOf<"OperationSchedule">,
) {
	const action = store.get(mission, right.prepared_ref, "PreparedAction");
	const schema = store.get(mission, action.schema_ref, "RegisteredActionSchema");
	const target = store.get(mission, action.binding_ref, "TargetBinding");
	return independentPrepared(
		store,
		left.prepared_ref,
		schema.version.split("/")[0],
		target.canonical_path,
		mission,
		left.status === "UNCERTAIN",
	);
}
function satisfied(store: MissionStore, state: MissionState, dependency: OperationDependency): boolean {
	const op = effect(store, state, dependency.operation_id);
	if (op?.status !== "CONFIRMED_COMPLETE") return false;
	const action = store.get(state.mission_id, op.prepared_ref, "PreparedAction");
	if (dependency.condition === "PROCESS_SUCCEEDED" && !action.operation_class.startsWith("SHELL:")) return false;
	const observation = op.result_refs
		.map((ref) => store.get(state.mission_id, ref, "EvidenceRecord"))
		.findLast((record) => record.kind === "OBSERVATION" && record.artifact_ref !== null);
	if (!observation?.artifact_ref) return false;
	try {
		const facts = observation.payload;
		if (!facts || typeof facts !== "object" || ("unknown" in facts && facts.unknown === true)) return false;
		if (action.operation_class === "EDIT") {
			const reconciled = op.reconciliation_refs.some(
				(ref) => store.get(state.mission_id, ref, "ReconciliationRecord").result === "POSTCONDITION_OBSERVED",
			);
			const delivered = store
				.records(state.mission_id)
				.some(
					(record) =>
						record.record_type === "Artifact" &&
						record.purpose === "DELIVERED" &&
						record.generation === observation.target_generation &&
						action.intended_effect === `Content SHA256 ${record.digest}` &&
						store.artifact(state.mission_id, record.record_id).length === record.bytes,
				);
			if (!reconciled && !delivered) return false;
		}
		const raw: unknown = JSON.parse(store.artifact(state.mission_id, observation.artifact_ref).toString());
		if (dependency.condition === "EFFECT_CONFIRMED")
			return !!raw && typeof raw === "object" && !("isError" in raw && raw.isError === true);
		return (
			!!raw &&
			typeof raw === "object" &&
			!("isError" in raw && raw.isError === true) &&
			"structuredContent" in raw &&
			!!raw.structuredContent &&
			typeof raw.structuredContent === "object" &&
			"exit_code" in raw.structuredContent &&
			raw.structuredContent.exit_code === 0
		);
	} catch {
		return false;
	}
}

/** This validator runs inside the mission's revision transaction, including the final Kshepana start. */
export function validateSchedules(
	store: MissionStore,
	state: MissionState,
	previous: MissionState | undefined,
	additions: MissionRecord[],
): void {
	const jobs = schedules(store, state);
	const old = previous ? schedules(store, previous) : [];
	if (new Set(jobs.map((job) => job.operation_id)).size !== jobs.length)
		throw new Error("Duplicate scheduling identity");
	if (jobs.filter((job) => !terminal.has(job.status)).length > 64)
		throw new Error("Operation queue capacity exceeded");
	for (const prior of old) {
		const current = jobs.find((job) => job.operation_id === prior.operation_id);
		if (
			!current ||
			(current.record_id !== prior.record_id && !additions.some((record) => record.record_id === current.record_id))
		)
			throw new Error("Scheduling history cannot disappear or rewind");
	}
	for (const job of jobs) {
		if (
			!old.some((prior) => prior.record_id === job.record_id) &&
			!additions.some((record) => record.record_id === job.record_id)
		)
			throw new Error("Uncommitted schedule projection");
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string) => {
			if (visited.has(id)) return;
			if (visiting.has(id)) throw new Error("Operation dependency cycle");
			visiting.add(id);
			const current = jobs.find((item) => item.operation_id === id);
			if (!current) throw new Error("Missing or cross-mission dependency");
			for (const dependency of current.dependencies) visit(dependency.operation_id);
			visiting.delete(id);
			visited.add(id);
		};
		visit(job.operation_id);
	}
	const owners = jobs.filter((job) => ["DISPATCHED", "RUNNING", "CANCEL_REQUESTED"].includes(job.status));
	if (
		owners.length > (state.operation_concurrency ?? 1) &&
		additions.some((record) => record.record_type === "OperationSchedule" && record.status === "DISPATCHED")
	)
		throw new Error("Scheduling concurrency ceiling exceeded");
	for (const [index, owner] of owners.entries())
		for (const other of owners.slice(index + 1))
			if (!independent(store, state.mission_id, owner, other)) throw new Error("Unproven operation independence");
	for (const record of additions) {
		if (record.record_type === "OperationSchedule") {
			const prior = old.find((job) => job.operation_id === record.operation_id);
			const op = effect(store, state, record.operation_id);
			if (!op || op.prepared_ref !== record.prepared_ref || !jobs.some((job) => job.record_id === record.record_id))
				throw new Error("Schedule must retain its prepared operation");
			const event = store.get(state.mission_id, record.control_ref, "EvidenceRecord");
			if (
				event.revision !== record.revision ||
				event.kind !== "CONTROL" ||
				event.provenance !== "KERNEL" ||
				event.source !== "DIRGHAKRIYA/1" ||
				event.operation_id !== record.operation_id ||
				canonical(event.payload) !==
					canonical({ status: record.status, reason: record.reason, source_revision: record.source_revision })
			)
				throw new Error("Schedule needs its current control evidence");
			if (record.source_revision !== previous?.revision) throw new Error("Schedule source revision changed");
			if (prior) {
				if (!edges[prior.status].includes(record.status)) throw new Error("Illegal scheduling transition");
				for (const key of ["prepared_ref", "dependencies", "queued_at"] as const)
					if (canonical(prior[key]) !== canonical(record[key]))
						throw new Error("Scheduling identity or dependencies rewritten");
				if (prior.claim && (prior.claim !== record.claim || canonical(prior.handle) !== canonical(record.handle)))
					throw new Error("Execution ownership rewritten");
			} else if (
				state.terminal ||
				record.status !== "QUEUED" ||
				op.status !== "NOT_STARTED" ||
				record.claim ||
				record.handle
			)
				throw new Error("Only prepared unstarted operations can be submitted");
			if (record.status === "DISPATCHED") {
				if (
					(prior?.status !== "QUEUED" && prior?.status !== "DISPATCHED") ||
					state.terminal ||
					state.owner_pid !== process.pid ||
					!record.claim ||
					!record.handle ||
					op.status !== "NOT_STARTED" ||
					record.dependencies.some((dep) => !satisfied(store, state, dep))
				)
					throw new Error("Dispatch needs exclusive current claim and observed dependencies");
			}
			if (
				record.reconciliation &&
				canonical(record.reconciliation) !== canonical(prior?.reconciliation ?? null) &&
				(!record.reconciliation.operation_ref ||
					store.get(state.mission_id, record.reconciliation.operation_ref, "OperationRecord").operation_id !==
						record.operation_id ||
					record.status !== "UNCERTAIN")
			)
				throw new Error("Unresolved reconciliation must retain the original operation and uncertainty");
			if (record.status === "CANCELLED" && op.status !== "NOT_STARTED")
				throw new Error("Stopping a process does not undo its effects");
			if (record.status === "COMPLETED" && op.status !== "CONFIRMED_COMPLETE")
				throw new Error("Completion needs observed effect");
			if (record.status === "FAILED" && !["NOT_STARTED", "FAILED"].includes(op.status))
				throw new Error("Failure needs known outcome");
			if (terminal.has(record.status) && record.status !== "CANCELLED" && op.status === "NOT_STARTED") {
				const reservation = state.reservations
					.map((ref) => store.get(state.mission_id, ref, "BudgetReservation"))
					.find((item) => item.owner_operation_id === op.operation_id);
				if (reservation?.state !== "RELEASED")
					throw new Error("Never-started work must release its reservation before settling");
			}
			for (const ref of [...record.progress_refs, ...(record.execution_refs ?? [])]) {
				const observation = store.get(state.mission_id, ref, "EvidenceRecord");
				if (
					observation.operation_id !== record.operation_id ||
					observation.kind !== "OBSERVATION" ||
					observation.provenance !== "ADAPTER"
				)
					throw new Error("Progress must be an adapter observation");
			}
		}
		if (record.record_type === "OperationRecord" && record.status === "IN_PROGRESS") {
			const job = jobs.find((item) => item.operation_id === record.operation_id);
			if (
				job &&
				(!["DISPATCHED", "RUNNING"].includes(job.status) ||
					job.dependencies.some((dependency) => !satisfied(store, state, dependency)))
			)
				throw new Error("Unclaimed or cancelled work cannot cross Kshepana");
			const current = store.get(state.mission_id, record.prepared_ref, "PreparedAction");
			const binding = store.get(state.mission_id, current.binding_ref, "TargetBinding");
			const schema = store.get(state.mission_id, current.schema_ref, "RegisteredActionSchema");
			for (const ref of previous?.operations ?? []) {
				const other = store.get(state.mission_id, ref, "OperationRecord");
				if (
					other.operation_id !== record.operation_id &&
					["IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(other.status) &&
					!independentPrepared(
						store,
						other.prepared_ref,
						schema.version.split("/")[0],
						binding.canonical_path,
						state.mission_id,
						other.status === "OUTCOME_UNKNOWN",
					)
				) {
					if (
						other.operation_id !==
						store.get(state.mission_id, state.contract, "MissionContract").reconcile_operation_id
					)
						throw new Error("Unresolved conflicting effect fences dispatch");
				}
			}
		}
	}
	if (
		additions.some(
			(record) =>
				record.record_type === "TerminalReport" &&
				["VERIFIED_COMPLETE", "DELIVERED_UNVERIFIED"].includes(record.status),
		) &&
		jobs.some((job) => !terminal.has(job.status))
	)
		throw new Error("Unsettled operations cannot establish mission completion");
}

/** Subordinate to Sandhana. No model, mission loop, verdict, independent account, lease expiry or automatic replay. */
export class OperationManager {
	private kernel: SandhanaKernel;
	private runtime = randomUUID();
	private running = new Map<
		string,
		{ token: string; abort: AbortController; promise: Promise<void>; deadline?: NodeJS.Timeout }
	>();
	private listeners = new Set<() => void>();
	private observers = new Set<(schedule: RecordOf<"OperationSchedule">) => void>();
	private pumping = false;
	private sequence = 0;
	private decisionSequence = 0;
	private lastProgress = new Map<string, { at: number; digest: string }>();
	constructor(kernel: SandhanaKernel) {
		this.kernel = kernel;
	}
	list() {
		const state = this.kernel.state;
		return state
			? schedules(this.kernel.store, state).map((schedule) => ({
					schedule,
					effect: effect(this.kernel.store, state, schedule.operation_id)!,
				}))
			: [];
	}
	inspect(id: string) {
		const found = this.list().find((item) => item.schedule.operation_id === id);
		if (!found) throw new Error("Unknown operation in this mission");
		return {
			...found,
			execution: (found.schedule.execution_refs ?? []).map(
				(ref) => this.kernel.store.get(found.effect.mission_id, ref, "EvidenceRecord").payload,
			),
		};
	}
	hasPending() {
		return this.list().some(({ schedule }) => !terminal.has(schedule.status) && schedule.status !== "UNCERTAIN");
	}
	subscribe(observer: (schedule: RecordOf<"OperationSchedule">) => void) {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}
	get eventSequence() {
		return this.sequence;
	}
	get controllerSequence() {
		return this.decisionSequence;
	}
	async wait(after: number, signal: AbortSignal): Promise<void> {
		if (after !== this.sequence) return;
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const wake = () => {
				cleanup();
				resolve();
			};
			const abort = () => {
				cleanup();
				reject(signal.reason);
			};
			const cleanup = () => {
				this.listeners.delete(wake);
				signal.removeEventListener("abort", abort);
			};
			this.listeners.add(wake);
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	wake(relevant = true) {
		this.sequence++;
		if (relevant) this.decisionSequence++;
		for (const listener of [...this.listeners]) listener();
	}
	submit(id: string, dependencies: OperationDependency[] = [], priority = 0) {
		const existing = this.list().find(({ schedule }) => schedule.operation_id === id);
		if (existing) {
			if (canonical(existing.schedule.dependencies) !== canonical(dependencies))
				throw new Error("Stable ID dependency conflict");
			return existing.schedule;
		}
		const state = this.kernel.state!;
		const operation = effect(this.kernel.store, state, id);
		if (!operation) throw new Error("Submission requires an already prepared operation");
		const schedule = this.append({
			version: "DIRGHAKRIYA/1",
			operation_id: id,
			prepared_ref: operation.prepared_ref,
			dependencies,
			priority,
			status: "QUEUED",
			claim: null,
			handle: null,
			queued_at: Date.now(),
			observed_at: Date.now(),
			progress_refs: [],
			progress_omitted: 0,
			reason: "Awaiting dependencies and final policy guard",
		});
		return schedule;
	}
	async prepare(name: string, args: unknown, dependencies: OperationDependency[] = [], priority = 0) {
		const id = await this.kernel.prepareOperation(name, `background:${randomUUID()}`, args);
		try {
			return this.submit(id, dependencies, priority);
		} catch (error) {
			this.kernel.discardPrepared(id);
			throw error;
		}
	}
	assertClaim(id: string) {
		const job = this.list().find(({ schedule }) => schedule.operation_id === id)?.schedule;
		if (job) {
			const state = this.kernel.state!;
			if (job.dependencies.some((dependency) => !satisfied(this.kernel.store, state, dependency)))
				throw new Error("Operation prerequisite no longer has the required observed outcome");
			this.kernel.assertOperationDependencies(job.dependencies);
		}
		if (
			job &&
			(job.handle?.runtime !== this.runtime ||
				this.running.get(id)?.token !== job.handle.token ||
				!["DISPATCHED", "RUNNING"].includes(job.status))
		)
			throw new Error("Execution does not own the durable scheduler claim");
	}
	executionObserved(id: string, ref: string) {
		const job = this.list().find(({ schedule }) => schedule.operation_id === id)?.schedule;
		if (job)
			this.append({
				...job,
				execution_refs: [...(job.execution_refs ?? []), ref],
				reason: "Native execution handle/state observed; process exit is not effect reversal",
			});
	}
	started(id: string) {
		const item = this.list().find(({ schedule }) => schedule.operation_id === id);
		if (item?.schedule.status === "DISPATCHED")
			this.append({ ...item.schedule, status: "RUNNING", reason: "Durable Kshepana start observed" });
	}
	async pump(): Promise<void> {
		if (this.pumping || !this.kernel.active) return;
		this.refreshDeadlines();
		this.pumping = true;
		try {
			for (const { schedule } of this.list().sort(
				(left, right) =>
					right.schedule.priority - left.schedule.priority || left.schedule.queued_at - right.schedule.queued_at,
			)) {
				if (schedule.status !== "QUEUED") continue;
				const state = this.kernel.state!;
				const action = this.kernel.store.get(state.mission_id, schedule.prepared_ref, "PreparedAction");
				const dependencies = schedule.dependencies.map((dep) => this.inspect(dep.operation_id));
				if (
					action.intent_epoch !== (state.intent_epoch ?? 1) ||
					dependencies.some(({ schedule: dep }) => ["FAILED", "CANCELLED", "UNCERTAIN"].includes(dep.status)) ||
					schedule.dependencies.some(
						(dep) =>
							terminal.has(this.inspect(dep.operation_id).schedule.status) &&
							!satisfied(this.kernel.store, state, dep),
					)
				) {
					this.kernel.discardPrepared(schedule.operation_id);
					this.append({
						...schedule,
						status: "CANCELLED",
						reason: "Preparation invalidated by steering or failed/uncertain prerequisite",
					});
					continue;
				}
				const eligibility = this.kernel.operationEligibility(schedule.operation_id);
				if (eligibility.outcome !== "ALLOW") {
					this.kernel.discardPrepared(schedule.operation_id);
					this.append({
						...schedule,
						status: "CANCELLED",
						reason:
							`Current policy or user constraint invalidated preparation: ${eligibility.reasons.join("; ")}`.slice(
								0,
								500,
							),
					});
					continue;
				}
				if (schedule.dependencies.some((dep) => !satisfied(this.kernel.store, state, dep))) continue;
				const active = this.list().filter(({ schedule: job }) =>
					["DISPATCHED", "RUNNING", "CANCEL_REQUESTED", "UNCERTAIN"].includes(job.status),
				);
				const uncertainConflict = active.find(
					({ schedule: job }) =>
						job.status === "UNCERTAIN" && !independent(this.kernel.store, state.mission_id, job, schedule),
				);
				if (uncertainConflict) {
					this.kernel.discardPrepared(schedule.operation_id);
					this.append({
						...schedule,
						status: "CANCELLED",
						reason: `Conflicts with uncertain operation ${uncertainConflict.schedule.operation_id}; reconcile before fresh preparation`,
					});
					continue;
				}
				if (
					active.filter(({ schedule: job }) => job.status !== "UNCERTAIN").length >=
						(state.operation_concurrency ??
							this.kernel.configuration.operations?.concurrency ??
							(totalmem() < 8 * 1024 ** 3 ? 1 : 2)) ||
					active.some(({ schedule: job }) => !independent(this.kernel.store, state.mission_id, job, schedule))
				)
					continue;
				// CAS ownership commits before invoking any adapter. Losing schedulers reload; they never dispatch the stale claim.
				const token = randomUUID();
				const abort = new AbortController();
				const binding = this.kernel.store.get(state.mission_id, action.binding_ref, "TargetBinding");
				this.append({
					...schedule,
					status: "DISPATCHED",
					claim: randomUUID(),
					handle: {
						token,
						runtime: this.runtime,
						host: hostname(),
						environment: binding.environment,
						backend: "RUNTIME_CALLBACK/1",
						reattach: false,
					},
					reason: "Claimed; current policy and reservation still checked at Kshepana",
				});
				const promise = this.execute(schedule.operation_id, abort.signal).catch(() => {
					this.wake();
				});
				this.running.set(schedule.operation_id, { token, abort, promise });
				this.refreshDeadlines();
			}
		} finally {
			this.pumping = false;
		}
	}
	private refreshDeadlines() {
		const state = this.kernel.state;
		if (!state) return;
		for (const [id, execution] of this.running) {
			if (execution.deadline) clearTimeout(execution.deadline);
			const remaining = Math.max(0, state.ceilings.elapsed_ms - (Date.now() - state.started_at));
			execution.deadline = setTimeout(
				() => {
					try {
						const requested = this.cancel(id);
						if (requested.status === "CANCEL_REQUESTED")
							this.append({
								...requested,
								reason:
									"Parent mission deadline exhausted; backend cancellation requested, earlier effects retained",
							});
					} catch {
						/* Only validated runtime handles can be stopped. */
					}
				},
				Math.min(remaining, 2_147_483_647),
			);
			execution.deadline.unref();
		}
	}
	private async execute(id: string, signal: AbortSignal) {
		try {
			await this.kernel.dispatchPrepared(id, signal, (partial) => this.progress(id, partial));
		} catch (error) {
			const current = this.inspect(id);
			if (current.effect.status === "NOT_STARTED") {
				this.kernel.discardPrepared(id);
				this.append({
					...current.schedule,
					status: signal.aborted ? "CANCELLED" : "FAILED",
					reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
				});
			}
		} finally {
			const execution = this.running.get(id);
			if (execution?.deadline) clearTimeout(execution.deadline);
			this.running.delete(id);
			const current = this.inspect(id);
			if (!terminal.has(current.schedule.status)) this.settle(id);
			queueMicrotask(() => {
				void this.pump().catch(() => this.wake());
			});
		}
	}
	settle(id: string) {
		const current = this.inspect(id);
		if (terminal.has(current.schedule.status)) return current.schedule;
		const status =
			current.effect.status === "CONFIRMED_COMPLETE"
				? "COMPLETED"
				: current.effect.status === "FAILED"
					? "FAILED"
					: "UNCERTAIN";
		return this.append({
			...current.schedule,
			status,
			reason:
				status === "UNCERTAIN"
					? "Execution or remaining effects unresolved; no retry"
					: "Original governed outcome retained; cancellation cannot rewrite completion",
		});
	}
	reprioritize(id: string, priority: number) {
		const { schedule } = this.inspect(id);
		if (schedule.status !== "QUEUED") throw new Error("Only queued priorities may change");
		return this.append({
			...schedule,
			priority,
			reason: "Current user changed queued priority; target and payload unchanged",
		});
	}
	cancel(id: string, token?: string) {
		const { schedule, effect: op } = this.inspect(id);
		if (terminal.has(schedule.status)) return schedule;
		if (schedule.status === "QUEUED") {
			this.kernel.discardPrepared(id);
			return this.append({
				...schedule,
				status: "CANCELLED",
				reason: "Cancelled before dispatch; no target invocation",
			});
		}
		const execution = this.running.get(id);
		if (
			!execution ||
			schedule.handle?.runtime !== this.runtime ||
			schedule.handle.host !== hostname() ||
			schedule.handle.token !== execution.token ||
			(token !== undefined && token !== execution.token)
		)
			throw new Error("Handle is not a validated live runtime execution; no PID signal sent");
		if (["CONFIRMED_COMPLETE", "FAILED"].includes(op.status)) return this.settle(id);
		if (schedule.status !== "CANCEL_REQUESTED") this.kernel.operationControlUsage(true, id);
		const requested =
			schedule.status === "CANCEL_REQUESTED"
				? schedule
				: this.append({
						...schedule,
						status: "CANCEL_REQUESTED",
						reason: "Backend cancellation requested; previous effects are not reversed",
					});
		execution.abort.abort();
		return requested;
	}
	reconnect(id: string) {
		const current = this.inspect(id);
		return {
			...current,
			attached:
				current.schedule.handle?.runtime === this.runtime &&
				this.running.get(id)?.token === current.schedule.handle?.token,
			limitation: "Runtime-owned callbacks survive client disconnect only; no PID or runtime-restart reattachment",
		};
	}
	async recover() {
		for (const { schedule, effect: op } of this.list()) {
			if (terminal.has(schedule.status) || this.reconnect(schedule.operation_id).attached) continue;
			if (["CONFIRMED_COMPLETE", "FAILED"].includes(op.status)) this.settle(schedule.operation_id);
			else if (schedule.status !== "QUEUED") {
				if (op.status === "NOT_STARTED") {
					this.kernel.discardPrepared(op.operation_id);
					this.append({
						...schedule,
						status: "FAILED",
						reason: "Recovered claim before durable start; no automatic relaunch",
					});
				} else this.settle(schedule.operation_id);
			}
		}
		await this.pump();
	}
	async reconcile(id: string) {
		const current = this.inspect(id);
		if (["CONFIRMED_COMPLETE", "FAILED"].includes(current.effect.status)) return this.settle(id);
		if (this.reconnect(id).attached) return this.reconnect(id);
		if (!["IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(current.effect.status)) return current;
		// File postconditions use the existing explicit resume/inspection path and original Kośa reservation.
		const limitation =
			"Use explicit resume for reviewed local file postcondition inspection. Opaque shell has no authoritative completion endpoint; conflicting retries remain fenced.";
		const schedule = this.append({
			...current.schedule,
			status: "UNCERTAIN",
			reason: `Reconciliation remains unresolved: ${limitation}`,
			reconciliation: {
				rule: "NO_AUTHORITATIVE_ENDPOINT/1",
				operation_ref: current.effect.record_id,
				conclusion: "STILL_UNRESOLVED",
				attempted_at: Date.now(),
				limitation,
			},
		});
		return { ...current, schedule, conclusion: "STILL_UNRESOLVED", limitation };
	}
	readOutput(id: string, ref: string, offset = 0, limit = 8192) {
		const { schedule, effect: op } = this.inspect(id);
		const observations = [...schedule.progress_refs, ...op.result_refs].map((item) =>
			this.kernel.store.get(op.mission_id, item, "EvidenceRecord"),
		);
		const observation = observations.find(
			(item) =>
				item.record_id === ref ||
				item.artifact_ref === ref ||
				(item.payload &&
					typeof item.payload === "object" &&
					"full_output_ref" in item.payload &&
					item.payload.full_output_ref === ref),
		);
		if (!observation) throw new Error("Output reference is not associated with this operation");
		const full =
			observation.payload &&
			typeof observation.payload === "object" &&
			"full_output_ref" in observation.payload &&
			observation.payload.full_output_ref === ref;
		const artifact = full
			? ref
			: (observation.artifact_ref ??
				(observation.payload &&
				typeof observation.payload === "object" &&
				"full_output_ref" in observation.payload &&
				typeof observation.payload.full_output_ref === "string"
					? observation.payload.full_output_ref
					: null));
		if (!artifact) throw new Error("Output was omitted; no retained artifact is available");
		return this.kernel.readOperationArtifact(artifact, offset, limit);
	}
	private progress(id: string, partial: AgentToolResult<unknown>) {
		const { schedule } = this.inspect(id);
		const view = this.kernel.modelView(partial);
		const text = boundedText(redact(JSON.stringify(view)), 8192).text;
		const hash = digest(text);
		const prior = this.lastProgress.get(id);
		if (prior && (prior.digest === hash || Date.now() - prior.at < 1000)) return;
		this.lastProgress.set(id, { at: Date.now(), digest: hash });
		if (schedule.progress_refs.length >= 16) {
			if (schedule.progress_omitted === 0)
				this.append({
					...schedule,
					progress_omitted: 1,
					reason: "Progress snapshot retention limit reached; later range omitted until final capture",
				});
			return;
		}
		const observation = this.kernel.captureOperationProgress(id, text);
		if (observation)
			this.append({
				...this.inspect(id).schedule,
				progress_refs: [...schedule.progress_refs, observation.record_id],
				reason: "Adapter output snapshot observed; not a completion verdict",
			});
		else if (schedule.progress_omitted === 0)
			this.append({
				...this.inspect(id).schedule,
				progress_omitted: 1,
				reason: "Progress not retained: parent output or artifact capacity unavailable",
			});
	}
	private append(fields: Omit<Draft<"OperationSchedule">, "source_revision" | "control_ref">) {
		const state = this.kernel.state!;
		const expected = state.revision;
		state.revision++;
		state.operation_concurrency ??=
			this.kernel.configuration.operations?.concurrency ?? (totalmem() < 8 * 1024 ** 3 ? 1 : 2);
		const payload = { status: fields.status, reason: fields.reason, source_revision: expected };
		const control = makeRecord(state.mission_id, state.revision, "EvidenceRecord", {
			event_id: randomUUID(),
			stage: "dirghakriya",
			kind: "CONTROL",
			provenance: "KERNEL",
			operation_id: fields.operation_id,
			target_generation: null,
			captured_at: Date.now(),
			source: "DIRGHAKRIYA/1",
			payload,
			artifact_ref: null,
			digest: digest(payload),
			sensitivity: "PRIVATE",
			sources: [],
			requirement_ids: [],
			correction_of: null,
			previous: state.last_event,
		});
		const record = makeRecord(state.mission_id, state.revision, "OperationSchedule", {
			...fields,
			source_revision: expected,
			control_ref: control.record_id,
			observed_at: Date.now(),
		});
		state.schedules = [
			...(state.schedules ?? []).filter(
				(ref) =>
					this.kernel.store.get(state.mission_id, ref, "OperationSchedule").operation_id !== fields.operation_id,
			),
			record.record_id,
		];
		state.last_event = control.record_id;
		this.kernel.store.commit(expected, state, [control, record]);
		for (const observer of this.observers) {
			try {
				observer(record);
			} catch {
				/* A disconnected client cannot change backend truth. */
			}
		}
		this.wake(terminal.has(record.status) || ["CANCEL_REQUESTED", "UNCERTAIN"].includes(record.status));
		return record;
	}
}
