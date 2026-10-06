// Sūkṣmaśastra Structural Anchors (Part D, S6-ANC-001 through S6-ANC-004)

import type { ReasonCode } from "./reason-codes.ts";

export interface Anchor {
	readonly anchor_id: string; // Canonical anchor identity
	readonly id?: string; // Alias for anchor_id
	readonly file_id: string; // Jālacitra file identity e.g. "file:src/auth/session.ts" or relative path
	readonly targetFile?: string; // Alias for relative path
	readonly symbol_id?: string; // Stable identity e.g. "sym:src/auth/session.ts#verifySession"
	readonly node_kind?: string; // e.g. "FunctionDeclaration", "MethodDeclaration", "ClassDeclaration"
	readonly kind?: string; // Short kind e.g. "function"
	readonly structural_selector?: string; // Documented selector grammar e.g. "function:verifySession"
	readonly selector?: string; // Alias for structural_selector
	readonly identifier?: string; // Extracted symbol name
	readonly expected_content_digest?: string; // SHA-256 digest of the whole file at plan time
	readonly expected_node_digest?: string; // SHA-256 digest of the anchored node text
	readonly source_range?: [number, number]; // [startByte, endByte] at plan time
	readonly range?: {
		readonly startByte: number;
		readonly endByte: number;
		readonly startLine?: number;
		readonly endLine?: number;
		readonly startColumn?: number;
		readonly endColumn?: number;
	};
	readonly signatureDigest?: string;
	readonly declaration_group?: string; // For merged TypeScript declarations (interfaces, namespaces)
}

export interface Candidate {
	readonly range: [number, number];
	readonly kind: string;
	readonly container_chain: string[]; // e.g. ["Module:Auth", "Class:SessionManager", "Method:login"]
	readonly signature_digest?: string;
	readonly name?: string;
}

export type AnchorResolution =
	| {
			readonly status: "RESOLVED_UNIQUE";
			readonly range: [number, number];
			readonly node_digest: string;
			readonly fresh_node_kind?: string;
	  }
	| {
			readonly status: "AMBIGUOUS";
			readonly candidates: Candidate[];
			readonly reason: ReasonCode;
	  }
	| {
			readonly status: "NOT_FOUND";
			readonly reason: ReasonCode;
	  }
	| {
			readonly status: "MOVED";
			readonly range: [number, number];
			readonly evidence: "IDENTITY_MATCH" | "SIGNATURE_MATCH";
			readonly node_digest: string;
	  }
	| {
			readonly status: "STALE_PREIMAGE";
			readonly current_digest: string;
	  };

export interface SelectorParsed {
	readonly kind: string; // e.g. "function", "class", "method", "jsx_component", "import", "export", "variable", "interface", "type"
	readonly identifier: string; // e.g. "verifySession", "./a", "default"
	readonly containerChain: Array<{ kind: string; identifier: string }>;
}
