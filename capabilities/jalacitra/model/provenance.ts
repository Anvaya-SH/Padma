// Jālacitra Provenance Classes (Part G1, J5-PROV-001 through J5-PROV-005)

export type ProvenanceClass = "PARSED" | "COMPILED" | "RUNTIME_CONFIRMED" | "INFERRED";

export const PROVENANCE_CLASSES: readonly ProvenanceClass[] = ["RUNTIME_CONFIRMED", "COMPILED", "PARSED", "INFERRED"];

export const PROVENANCE_RANK: Record<ProvenanceClass, number> = {
	RUNTIME_CONFIRMED: 4,
	COMPILED: 3,
	PARSED: 2,
	INFERRED: 1,
};

export function compareProvenance(a: ProvenanceClass, b: ProvenanceClass): number {
	return PROVENANCE_RANK[b] - PROVENANCE_RANK[a];
}

export function weakestProvenance(classes: Iterable<ProvenanceClass>): ProvenanceClass {
	let weakest: ProvenanceClass = "RUNTIME_CONFIRMED";
	for (const cls of classes) {
		if (PROVENANCE_RANK[cls] < PROVENANCE_RANK[weakest]) {
			weakest = cls;
		}
	}
	return weakest;
}
