// Jālacitra Declaration Signature Normalizer (Part F2, I4, J5-ID-005)

import { computeDigest } from "../../inventory/digest.ts";

export function computeSignatureDigest(declarationHead: string): string {
	// Normalize whitespace: collapse multiple spaces/newlines to single space
	const normalized = declarationHead.replace(/\s+/g, " ").trim();
	return computeDigest(normalized);
}
