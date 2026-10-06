// Jālacitra Shrink Guard (Part K3, J5-TXN-003)

export interface ShrinkGuardLimits {
	maxNodeShrinkFraction: number; // default 0.30
	maxEdgeShrinkFraction: number; // default 0.40
}

export const DEFAULT_SHRINK_LIMITS: ShrinkGuardLimits = {
	maxNodeShrinkFraction: 0.3,
	maxEdgeShrinkFraction: 0.4,
};

export interface ShrinkGuardAssessment {
	allowed: boolean;
	nodeShrinkFraction: number;
	edgeShrinkFraction: number;
	reason?: string;
	details?: {
		prevNodes: number;
		proposedNodes: number;
		prevEdges: number;
		proposedEdges: number;
		filesRemovedFraction: number;
	};
}

export function evaluateShrinkGuard(
	prevNodes: number,
	proposedNodes: number,
	prevEdges: number,
	proposedEdges: number,
	totalPrevFiles: number,
	removedFiles: number,
	limits: ShrinkGuardLimits = DEFAULT_SHRINK_LIMITS,
	overrideReason?: string,
): ShrinkGuardAssessment {
	if (overrideReason && overrideReason.trim().length > 0) {
		return {
			allowed: true,
			nodeShrinkFraction: 0,
			edgeShrinkFraction: 0,
			reason: `Override accepted: ${overrideReason}`,
		};
	}

	// First build or empty graph allows any commit
	if (prevNodes === 0 && prevEdges === 0) {
		return {
			allowed: true,
			nodeShrinkFraction: 0,
			edgeShrinkFraction: 0,
		};
	}

	const nodeShrink = prevNodes > 0 ? (prevNodes - proposedNodes) / prevNodes : 0;
	const edgeShrink = prevEdges > 0 ? (prevEdges - proposedEdges) / prevEdges : 0;
	const filesRemovedFraction = totalPrevFiles > 0 ? removedFiles / totalPrevFiles : 0;

	// If shrink exceeds threshold and isn't explained by removed files
	const nodeExcessive = nodeShrink > limits.maxNodeShrinkFraction;
	const edgeExcessive = edgeShrink > limits.maxEdgeShrinkFraction;

	if ((nodeExcessive || edgeExcessive) && filesRemovedFraction < Math.min(nodeShrink, edgeShrink) * 0.75) {
		return {
			allowed: false,
			nodeShrinkFraction: nodeShrink,
			edgeShrinkFraction: edgeShrink,
			reason: `Shrink guard refused commit: nodes dropped by ${(nodeShrink * 100).toFixed(1)}% (limit ${(limits.maxNodeShrinkFraction * 100).toFixed(0)}%), edges dropped by ${(edgeShrink * 100).toFixed(1)}% (limit ${(limits.maxEdgeShrinkFraction * 100).toFixed(0)}%), while only ${(filesRemovedFraction * 100).toFixed(1)}% of files were removed.`,
			details: {
				prevNodes,
				proposedNodes,
				prevEdges,
				proposedEdges,
				filesRemovedFraction,
			},
		};
	}

	return {
		allowed: true,
		nodeShrinkFraction: nodeShrink,
		edgeShrinkFraction: edgeShrink,
		details: {
			prevNodes,
			proposedNodes,
			prevEdges,
			proposedEdges,
			filesRemovedFraction,
		},
	};
}
