// Jālacitra Hypothesis Boundary Port (Part N1, J5-KER-006, J5-INV-013)
// When converting graph results into a candidate fix or cause, the hypothesis
// provenance class is strictly the weakest class among the supporting edges.

import type { EdgeRecord } from "../model/edges.ts";
import { type ProvenanceClass, weakestProvenance } from "../model/provenance.ts";

export interface HypothesisSupportItem {
	edgeId?: string;
	kind: string;
	source: string;
	target: string;
	provenance: ProvenanceClass;
	isAmbiguous?: boolean;
}

export interface GraphHypothesis {
	hypothesisId: string;
	claim: string;
	effectiveProvenance: ProvenanceClass;
	supportingEvidence: HypothesisSupportItem[];
	weakestSupportingEdge: HypothesisSupportItem;
	createdAt: string;
}

/**
 * Creates a hypothesis derived from graph edges, enforcing that the hypothesis's
 * effective provenance class is bounded by the weakest supporting edge (J5-KER-006).
 */
export function createHypothesisFromGraph(
	claim: string,
	supportingEdges: (EdgeRecord | HypothesisSupportItem)[],
): GraphHypothesis {
	if (supportingEdges.length === 0) {
		throw new Error("Cannot create hypothesis from graph without at least one supporting edge");
	}

	const supportItems: HypothesisSupportItem[] = supportingEdges.map((e) => ({
		edgeId: "id" in e ? e.id : e.edgeId,
		kind: e.kind,
		source: "src" in e ? e.src : e.source,
		target: "dst" in e ? e.dst : e.target,
		provenance: "class" in e ? e.class : e.provenance,
		isAmbiguous: "ambiguity" in e ? e.ambiguity !== "UNIQUE" : Boolean((e as HypothesisSupportItem).isAmbiguous),
	}));

	const provenances = supportItems.map((s) => s.provenance);
	const effectiveProvenance = weakestProvenance(provenances);

	// Find the edge that established the weakest level
	const weakestEdge = supportItems.find((s) => s.provenance === effectiveProvenance) ?? supportItems[0];

	return {
		hypothesisId: `hyp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
		claim,
		effectiveProvenance,
		supportingEvidence: supportItems,
		weakestSupportingEdge: weakestEdge,
		createdAt: new Date().toISOString(),
	};
}
