// Jālacitra Kernel Registration (Part N1, J5-KER-001)
// Registers the Jalacitra capability and operations into Padma's capability registry.
// Includes schema versions, input/output schemas, side-effect classes, risk tiers, and negative examples.

export type SideEffectClass = "READ_ONLY" | "LOCAL_STATE_MUTATION" | "DESTRUCTIVE_LOCAL_MUTATION";

export type RiskTier = "LOW" | "MEDIUM" | "HIGH";

export interface NegativeExample {
	scenario: string;
	input: Record<string, unknown>;
	expectedErrorCode: string;
	explanation: string;
}

export interface OperationSchemaDefinition {
	operationName: string;
	schemaVersion: string;
	description: string;
	sideEffectClass: SideEffectClass;
	riskTier: RiskTier;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	negativeExamples: NegativeExample[];
}

export interface CapabilityRegistrationManifest {
	capabilityId: string;
	version: string;
	displayName: string;
	description: string;
	operations: OperationSchemaDefinition[];
}

export const JALACITRA_OPERATIONS: OperationSchemaDefinition[] = [
	{
		operationName: "atlas.status",
		schemaVersion: "1.0.0",
		description: "Reports the current store and indexing status for a bound repository",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
			},
			required: ["repoRoot"],
		},
		outputSchema: {
			type: "object",
			properties: {
				exists: { type: "boolean" },
				generation: { type: ["number", "null"] },
				freshness: { type: "string" },
				counts: { type: "object" },
			},
			required: ["exists", "freshness"],
		},
		negativeExamples: [
			{
				scenario: "Missing repository path",
				input: {},
				expectedErrorCode: "NO_REPOSITORY_BINDING",
				explanation: "Operation requires an explicit repository root",
			},
		],
	},
	{
		operationName: "atlas.ensure_index",
		schemaVersion: "1.0.0",
		description: "Ensures repository index is built up to the requested freshness",
		sideEffectClass: "LOCAL_STATE_MUTATION",
		riskTier: "MEDIUM",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				freshness: { type: "string", enum: ["current_generation", "live"] },
				forceRebuild: { type: "boolean" },
			},
			required: ["repoRoot"],
		},
		outputSchema: {
			type: "object",
			properties: {
				generation: { type: "number" },
				nodesCount: { type: "number" },
				edgesCount: { type: "number" },
				coverage: { type: "object" },
			},
			required: ["generation", "nodesCount", "edgesCount", "coverage"],
		},
		negativeExamples: [
			{
				scenario: "Non-existent repository path",
				input: { repoRoot: "/non/existent/path/here" },
				expectedErrorCode: "NO_REPOSITORY_BINDING",
				explanation: "Cannot index an unreachable directory",
			},
		],
	},
	{
		operationName: "atlas.resolve_symbol",
		schemaVersion: "1.0.0",
		description: "Resolves a symbol name across the index with exact matching and ambiguity policy",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				name: { type: "string" },
				filePath: { type: "string" },
				ambiguityPolicy: { type: "string", enum: ["REPORT", "STRICT", "BEST_EFFORT"] },
			},
			required: ["repoRoot", "name"],
		},
		outputSchema: {
			type: "object",
			properties: {
				matches: { type: "array" },
				isAmbiguous: { type: "boolean" },
				negative_evidence: { type: "array" },
			},
			required: ["matches", "isAmbiguous"],
		},
		negativeExamples: [
			{
				scenario: "Strict ambiguity policy on multi-match symbol",
				input: { repoRoot: ".", name: "Config", ambiguityPolicy: "STRICT" },
				expectedErrorCode: "AMBIGUOUS_SYMBOL",
				explanation: "STRICT policy rejects ambiguous symbols with error",
			},
		],
	},
	{
		operationName: "atlas.locate",
		schemaVersion: "1.0.0",
		description: "Locates a node and verifies current freshness against live file digest",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				nodeId: { type: "string" },
				verifyLive: { type: "boolean" },
			},
			required: ["repoRoot", "nodeId"],
		},
		outputSchema: {
			type: "object",
			properties: {
				node: { type: "object" },
				freshness: { type: "string" },
			},
			required: ["node", "freshness"],
		},
		negativeExamples: [
			{
				scenario: "Node ID not found",
				input: { repoRoot: ".", nodeId: "node:nonexistent" },
				expectedErrorCode: "NOT_FOUND",
				explanation: "Target node ID does not exist in store",
			},
		],
	},
	{
		operationName: "atlas.neighbors",
		schemaVersion: "1.0.0",
		description: "Traverses graph neighbors up to depth bound with hub node guards",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				nodeId: { type: "string" },
				depth: { type: "number" },
				direction: { type: "string", enum: ["outgoing", "incoming", "both"] },
			},
			required: ["repoRoot", "nodeId"],
		},
		outputSchema: {
			type: "object",
			properties: {
				nodes: { type: "array" },
				edges: { type: "array" },
				truncation: { type: "object" },
			},
			required: ["nodes", "edges"],
		},
		negativeExamples: [
			{
				scenario: "Negative depth",
				input: { repoRoot: ".", nodeId: "node:1", depth: -1 },
				expectedErrorCode: "INVALID_ARGUMENT",
				explanation: "Depth must be greater than or equal to 0",
			},
		],
	},
	{
		operationName: "atlas.expand_impact",
		schemaVersion: "1.0.0",
		description: "Expands potential impact graph of changes to target nodes",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				nodeIds: { type: "array", items: { type: "string" } },
				depth: { type: "number" },
				includeTypeOnly: { type: "boolean" },
			},
			required: ["repoRoot", "nodeIds"],
		},
		outputSchema: {
			type: "object",
			properties: {
				hops: { type: "array" },
				affectedFiles: { type: "array" },
				impact_is_potential_not_proven: { type: "boolean" },
			},
			required: ["hops", "affectedFiles", "impact_is_potential_not_proven"],
		},
		negativeExamples: [
			{
				scenario: "Empty nodeIds list",
				input: { repoRoot: ".", nodeIds: [] },
				expectedErrorCode: "INVALID_ARGUMENT",
				explanation: "At least one target node must be supplied for impact analysis",
			},
		],
	},
	{
		operationName: "atlas.find_relevant_tests",
		schemaVersion: "1.0.0",
		description: "Finds relevant test cases for a file or symbol with completeness bounds",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				nodeId: { type: "string" },
				filePath: { type: "string" },
			},
			required: ["repoRoot"],
		},
		outputSchema: {
			type: "object",
			properties: {
				tests: { type: "array" },
				coverage: { type: "object" },
			},
			required: ["tests", "coverage"],
		},
		negativeExamples: [
			{
				scenario: "No target specified",
				input: { repoRoot: "." },
				expectedErrorCode: "INVALID_ARGUMENT",
				explanation: "Either nodeId or filePath must be provided",
			},
		],
	},
	{
		operationName: "atlas.explain_build_path",
		schemaVersion: "1.0.0",
		description: "Explains build artifacts, target paths, and source map relationships",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				filePath: { type: "string" },
			},
			required: ["repoRoot", "filePath"],
		},
		outputSchema: {
			type: "object",
			properties: {
				targets: { type: "array" },
				artifacts: { type: "array" },
			},
			required: ["targets", "artifacts"],
		},
		negativeExamples: [
			{
				scenario: "Unindexed external path",
				input: { repoRoot: ".", filePath: "../outside/file.ts" },
				expectedErrorCode: "PATH_OUTSIDE_ROOT",
				explanation: "Target file is outside repository boundary",
			},
		],
	},
	{
		operationName: "atlas.path",
		schemaVersion: "1.0.0",
		description: "Finds shortest path between two nodes with deterministic tie-breaking",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				sourceNodeId: { type: "string" },
				targetNodeId: { type: "string" },
			},
			required: ["repoRoot", "sourceNodeId", "targetNodeId"],
		},
		outputSchema: {
			type: "object",
			properties: {
				found: { type: "boolean" },
				path: { type: "array" },
			},
			required: ["found"],
		},
		negativeExamples: [
			{
				scenario: "Identical source and target",
				input: { repoRoot: ".", sourceNodeId: "node:1", targetNodeId: "node:1" },
				expectedErrorCode: "NO_OP",
				explanation: "Path from node to itself is trivial length 0",
			},
		],
	},
	{
		operationName: "atlas.explain",
		schemaVersion: "1.0.0",
		description: "Provides full provenance, syntax range, and confidence audit for a node or edge",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				entityId: { type: "string" },
			},
			required: ["repoRoot", "entityId"],
		},
		outputSchema: {
			type: "object",
			properties: {
				entity: { type: "object" },
				provenanceDetails: { type: "object" },
			},
			required: ["entity", "provenanceDetails"],
		},
		negativeExamples: [
			{
				scenario: "Invalid entity ID format",
				input: { repoRoot: ".", entityId: "" },
				expectedErrorCode: "INVALID_ARGUMENT",
				explanation: "Entity ID cannot be empty",
			},
		],
	},
	{
		operationName: "atlas.dependencies",
		schemaVersion: "1.0.0",
		description: "Lists manifest dependencies and build target requirements",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				targetName: { type: "string" },
			},
			required: ["repoRoot"],
		},
		outputSchema: {
			type: "object",
			properties: {
				dependencies: { type: "array" },
			},
			required: ["dependencies"],
		},
		negativeExamples: [
			{
				scenario: "Target name not found in package manifests",
				input: { repoRoot: ".", targetName: "phantom-target-99" },
				expectedErrorCode: "NOT_FOUND",
				explanation: "Requested build target is not declared in any manifest",
			},
		],
	},
	{
		operationName: "atlas.config_usage",
		schemaVersion: "1.0.0",
		description: "Reports declared vs read config keys and client exposures",
		sideEffectClass: "READ_ONLY",
		riskTier: "LOW",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				configKey: { type: "string" },
			},
			required: ["repoRoot"],
		},
		outputSchema: {
			type: "object",
			properties: {
				keys: { type: "array" },
			},
			required: ["keys"],
		},
		negativeExamples: [
			{
				scenario: "Store absent",
				input: { repoRoot: "./unindexed-repo", configKey: "PORT" },
				expectedErrorCode: "INDEX_ABSENT",
				explanation: "Read requested before index was built",
			},
		],
	},
	{
		operationName: "atlas.discard",
		schemaVersion: "1.0.0",
		description: "Deletes store and all cached index state; requires explicit confirm=true",
		sideEffectClass: "DESTRUCTIVE_LOCAL_MUTATION",
		riskTier: "HIGH",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				confirm: { type: "boolean" },
			},
			required: ["repoRoot", "confirm"],
		},
		outputSchema: {
			type: "object",
			properties: {
				discarded: { type: "boolean" },
				bytesFreed: { type: "number" },
			},
			required: ["discarded"],
		},
		negativeExamples: [
			{
				scenario: "Missing explicit confirm",
				input: { repoRoot: ".", confirm: false },
				expectedErrorCode: "CONFIRMATION_REQUIRED",
				explanation: "atlas.discard requires explicit confirm: true",
			},
		],
	},
	{
		operationName: "atlas.record_runtime_observation",
		schemaVersion: "1.0.0",
		description: "Records dynamic runtime observation (call or test execution) as RUNTIME_CONFIRMED edge",
		sideEffectClass: "LOCAL_STATE_MUTATION",
		riskTier: "MEDIUM",
		inputSchema: {
			type: "object",
			properties: {
				repoRoot: { type: "string" },
				sourceNodeId: { type: "string" },
				targetNodeId: { type: "string" },
				evidenceRef: { type: "string" },
				generation: { type: "number" },
			},
			required: ["repoRoot", "sourceNodeId", "targetNodeId", "evidenceRef", "generation"],
		},
		outputSchema: {
			type: "object",
			properties: {
				recorded: { type: "boolean" },
				edgeId: { type: "string" },
			},
			required: ["recorded", "edgeId"],
		},
		negativeExamples: [
			{
				scenario: "Missing evidence reference",
				input: { repoRoot: ".", sourceNodeId: "a", targetNodeId: "b", generation: 1 },
				expectedErrorCode: "EVIDENCE_REQUIRED",
				explanation: "Runtime observations require an evidence reference token",
			},
		],
	},
];

export const JALACITRA_CAPABILITY_MANIFEST: CapabilityRegistrationManifest = {
	capabilityId: "jalacitra",
	version: "1.0.0",
	displayName: "Jālacitra Project Intelligence",
	description: "Version-aware, incremental code graph intelligence and atlas",
	operations: JALACITRA_OPERATIONS,
};

export const JalacitraKernelRegistration = {
	getManifest(): CapabilityRegistrationManifest {
		return JALACITRA_CAPABILITY_MANIFEST;
	},

	getOperation(name: string): OperationSchemaDefinition | undefined {
		return JALACITRA_OPERATIONS.find((op) => op.operationName === name);
	},
};
