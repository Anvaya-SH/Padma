// Jālacitra Kernel Events (Part N1, J5-KER-007)
// Emits structured events using Padma's event convention.
// Event payloads reference IDs, hashes and counts, NEVER source text.

export type JalacitraEventType =
	| "jalacitra.index.planned"
	| "jalacitra.index.committed"
	| "jalacitra.index.aborted"
	| "jalacitra.query.answered"
	| "jalacitra.invalidation.applied"
	| "jalacitra.shrink_guard.refused"
	| "jalacitra.runtime.recorded"
	| "jalacitra.store.discarded";

export interface JalacitraKernelEvent<T = Record<string, unknown>> {
	eventId: string;
	eventType: JalacitraEventType;
	repoIdentity: string;
	generation?: number;
	timestamp: string;
	payload: T;
}

export type EventListener = (event: JalacitraKernelEvent) => void | Promise<void>;

export class KernelEventEmitter {
	private listeners: Map<string, Set<EventListener>>;

	constructor() {
		this.listeners = new Map();
	}

	on(eventType: JalacitraEventType | "*", listener: EventListener): () => void {
		let set = this.listeners.get(eventType);
		if (!set) {
			set = new Set();
			this.listeners.set(eventType, set);
		}
		set.add(listener);
		return () => {
			set?.delete(listener);
		};
	}

	emit<T extends Record<string, unknown>>(
		eventType: JalacitraEventType,
		repoIdentity: string,
		payload: T,
		generation?: number,
	): JalacitraKernelEvent<T> {
		const event: JalacitraKernelEvent<T> = {
			eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
			eventType,
			repoIdentity,
			generation,
			timestamp: new Date().toISOString(),
			payload,
		};

		// Notify specific listeners
		const specific = this.listeners.get(eventType);
		if (specific) {
			for (const listener of specific) {
				try {
					void listener(event as JalacitraKernelEvent);
				} catch {
					// Event listeners must not break execution
				}
			}
		}

		// Notify wildcard listeners
		const wildcard = this.listeners.get("*");
		if (wildcard) {
			for (const listener of wildcard) {
				try {
					void listener(event as JalacitraKernelEvent);
				} catch {
					// Event listeners must not break execution
				}
			}
		}

		return event;
	}
}

export const defaultKernelEventEmitter = new KernelEventEmitter();
