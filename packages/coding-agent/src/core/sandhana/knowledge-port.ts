import type { ContextAnswer, ContextRequest } from "./avartana/contracts.ts";
import type { Capsule } from "./avartana/position.ts";
import type { IntentContinuityPacket, MemoryRecord } from "./smritikosha/types.ts";

/** Single context port for Sandhana. Implementations must not create a second controller or budget. */
export interface KnowledgePort {
	retrieveContext(request: ContextRequest, signal?: AbortSignal): Promise<ContextAnswer>;
	buildContinuity(intentSignature: string, taskType?: string): Promise<IntentContinuityPacket>;
	compact(): Promise<{ capsuleId: string; revision: number; protectedDigest: string }>;
	restore(): Promise<{ revision: number; requirements: number; stale: string[]; pins: number }>;
	considerMemory(
		kind: MemoryRecord["kind"],
		subject: string,
		content: Record<string, unknown>,
	): Promise<{ id: string; lifecycle: string }>;
}

export interface RestoredContext {
	revision: number;
	requirements: number;
	stale: string[];
	pins: number;
	capsule: Capsule | null;
}
