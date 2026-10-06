// Sūkṣmaśastra Artifact Storage Port (S6-INV-001, S6-KER-005)
// Stores diffs, post-parse reports, and rollback preimages keyed by SHA-256 digest.

import { createHash } from "node:crypto";

export interface StoredArtifact {
	readonly digest: string;
	readonly size: number;
	readonly content: string;
}

export class InMemoryArtifactStore {
	private readonly artifacts = new Map<string, StoredArtifact>();

	async put(content: string): Promise<{ digest: string; size: number }> {
		const digest = createHash("sha256").update(content, "utf8").digest("hex");
		const size = Buffer.byteLength(content, "utf8");
		this.artifacts.set(digest, { digest, size, content });
		return { digest, size };
	}

	async get(digest: string): Promise<string | undefined> {
		return this.artifacts.get(digest)?.content;
	}

	has(digest: string): boolean {
		return this.artifacts.has(digest);
	}
}

export const defaultArtifactStore = new InMemoryArtifactStore();
