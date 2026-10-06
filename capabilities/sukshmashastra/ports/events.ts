// Sūkṣmaśastra Kernel Lifecycle Events (Part I, S6-KER-006)
// Emits structured events for plan creation, validation, apply, rollback, and conflict.

export type SukshmashastraEventType =
	| "plan_created"
	| "plan_validated"
	| "plan_applied"
	| "plan_rolled_back"
	| "plan_conflict";

export interface SukshmashastraEvent {
	readonly type: SukshmashastraEventType;
	readonly planId: string;
	readonly timestamp: string;
	readonly payload: Record<string, unknown>;
}

export type EventListener = (event: SukshmashastraEvent) => void;

export class SukshmashastraEventEmitter {
	private readonly listeners = new Set<EventListener>();

	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(type: SukshmashastraEventType, planId: string, payload: Record<string, unknown> = {}): void {
		const event: SukshmashastraEvent = {
			type,
			planId,
			timestamp: new Date().toISOString(),
			payload,
		};

		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Prevent subscriber errors from disrupting pipeline
			}
		}
	}
}

export const defaultEventEmitter = new SukshmashastraEventEmitter();
