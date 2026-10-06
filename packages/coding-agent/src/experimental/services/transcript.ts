import { defineService, type ReplicatedState } from "@anvaya.sh/chord";
import type { ConversationView } from "@anvaya.sh/padma-durable";

/** The root conversation's durable view: active entries and its live, inbox, agent, and usage documents. */
export interface Transcript {
	readonly state: ReplicatedState<ConversationView>;
}

export const Transcript = defineService<Transcript>("padma.transcript");
