import { AsyncLocalStorage } from "node:async_hooks";

export interface ShellDispatch {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}
export interface ShellOutputReceipt {
	output_bytes: number;
	spool_bytes: number | null;
	spool_path: string | null;
	limitation: string | null;
	source: {
		path: string;
		bytes: number;
		digest: string;
		dev: number;
		ino: number;
		birthtime_ms: number;
	} | null;
}
export interface ShellExecutionObservation {
	phase: "STARTED" | "EXITED";
	token: string;
	pid: number | null;
	host: string;
	runtime_pid: number;
	started_at: number;
	observed_at: number;
	exit_code: number | null;
	signal: string | null;
	cancellation_requested: boolean;
	cancellation_dispatched: boolean;
	output_complete: boolean;
	supervisor: "NODE_CHILD_PROCESS";
}
const dispatchGuard = new AsyncLocalStorage<{
	authorize: (dispatch: ShellDispatch) => void;
	output?: (receipt: ShellOutputReceipt) => void;
	outputLimit?: number;
	execution?: (observation: ShellExecutionObservation) => void;
}>();
const fileReadGuard = new AsyncLocalStorage<(path: string) => Buffer>();
export function withFileReadGuard<T>(source: (path: string) => Buffer, execute: () => Promise<T>): Promise<T> {
	return fileReadGuard.run(source, execute);
}
export function boundFileSource(path: string): Buffer | undefined {
	return fileReadGuard.getStore()?.(path);
}
/** The host's final guard travels into the actual process-spawn operation, not an earlier read. */
export function withShellDispatchGuard<T>(
	guard: (dispatch: ShellDispatch) => void,
	execute: () => Promise<T>,
	output?: (receipt: ShellOutputReceipt) => void,
	outputLimit?: number,
	execution?: (observation: ShellExecutionObservation) => void,
): Promise<T> {
	return dispatchGuard.run({ authorize: guard, output, outputLimit, execution }, execute);
}
export function assertShellDispatchReady(dispatch: ShellDispatch): void {
	dispatchGuard.getStore()?.authorize(dispatch);
}
export function registerShellExecution(observation: ShellExecutionObservation): void {
	dispatchGuard.getStore()?.execution?.(observation);
}
export function shellOutputLimit(): number | undefined {
	return dispatchGuard.getStore()?.outputLimit;
}
/** Private native measurements, delivered after the accumulator's stream has closed. */
export function registerShellOutput(receipt: ShellOutputReceipt): void {
	dispatchGuard.getStore()?.output?.(receipt);
}
