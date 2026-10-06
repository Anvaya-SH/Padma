// Sūkṣmaśastra Kernel Registration (Part I, S6-KER-001..003)
// Registers the sukshmashastra capability, schema definitions, risk tiers, and negative examples.

export type SideEffectClass = "READ_ONLY" | "LOCAL_STATE_MUTATION" | "REPOSITORY_WRITE";

export type RiskTier = "LOW" | "MEDIUM" | "HIGH" | "TIER_0" | "TIER_1" | "TIER_2" | "TIER_3" | "TIER_4";

export interface NegativeExample {
	readonly scenario: string;
	readonly input: Record<string, unknown>;
	readonly expectedErrorCode: string;
	readonly explanation: string;
}

export interface OperationSchemaDefinition {
	readonly operationName: string;
	readonly schemaVersion: string;
	readonly description: string;
	readonly sideEffectClass: SideEffectClass;
	readonly riskTier: RiskTier;
	readonly inputSchema: Record<string, unknown>;
	readonly outputSchema: Record<string, unknown>;
	readonly negativeExamples: readonly NegativeExample[];
}

export interface CapabilityRegistrationManifest {
	readonly capabilityId: string;
	readonly version: string;
	readonly displayName: string;
	readonly description: string;
	readonly operations: readonly OperationSchemaDefinition[];
}

export const SUKSHMASHASTRA_OPERATIONS: readonly OperationSchemaDefinition[] = [
	{
		operationName: "plan.create",
		schemaVersion: "1.0.0",
		description: "Constructs a draft structural edit plan from proposed anchors and transformations",
		sideEffectClass: "READ_ONLY",
		riskTier: "TIER_0",
		inputSchema: {
			type: "object",
			properties: {
				repoBinding: { type: "object" },
				intent: { type: "string" },
				anchors: { type: "array" },
				transformations: { type: "array" },
			},
			required: ["repoBinding", "intent", "anchors", "transformations"],
		},
		outputSchema: {
			type: "object",
			properties: {
				plan_id: { type: "string" },
				status: { type: "string" },
			},
			required: ["plan_id", "status"],
		},
		negativeExamples: [
			{
				scenario: "Target file resolves outside workspace root",
				input: { transformations: [{ target_file: "../secret.txt" }] },
				expectedErrorCode: "PATH_OUTSIDE_ROOT",
				explanation: "Paths escaping workspace root are refused for security confinement",
			},
			{
				scenario: "Non-TypeScript or non-JavaScript file targeted",
				input: { transformations: [{ target_file: "src/main.rs" }] },
				expectedErrorCode: "UNSUPPORTED_LANGUAGE",
				explanation: "Phase 6 only supports TypeScript and JavaScript",
			},
		],
	},
	{
		operationName: "plan.validate",
		schemaVersion: "1.0.0",
		description: "Runs the 8-stage validation pipeline on a structural edit plan",
		sideEffectClass: "READ_ONLY",
		riskTier: "TIER_0",
		inputSchema: {
			type: "object",
			properties: {
				plan: { type: "object" },
			},
			required: ["plan"],
		},
		outputSchema: {
			type: "object",
			properties: {
				valid: { type: "boolean" },
				plan: { type: "object" },
			},
			required: ["valid"],
		},
		negativeExamples: [
			{
				scenario: "Transformation introduces a syntax error",
				input: { replacementText: "function foo() { unclosed" },
				expectedErrorCode: "REJECTED_SYNTAX_ERROR",
				explanation: "Parse before apply invariant blocks syntax breaking edits",
			},
			{
				scenario: "Secret detected in replacement code",
				input: { replacementText: "const key = '-----BEGIN RSA PRIVATE KEY-----';" },
				expectedErrorCode: "SECRET_IN_REPLACEMENT",
				explanation: "Secret scanning rejects private keys and API tokens in proposed edits",
			},
		],
	},
	{
		operationName: "plan.preview",
		schemaVersion: "1.0.0",
		description: "Generates unified diff preview and post-parse structural report for review",
		sideEffectClass: "READ_ONLY",
		riskTier: "TIER_0",
		inputSchema: {
			type: "object",
			properties: {
				plan_id: { type: "string" },
			},
			required: ["plan_id"],
		},
		outputSchema: {
			type: "object",
			properties: {
				unifiedDiff: { type: "string" },
				totalAddedLines: { type: "number" },
				totalRemovedLines: { type: "number" },
			},
			required: ["unifiedDiff"],
		},
		negativeExamples: [],
	},
	{
		operationName: "plan.rebase",
		schemaVersion: "1.0.0",
		description: "Rebases an existing edit plan against modified base files, updating anchor ranges",
		sideEffectClass: "READ_ONLY",
		riskTier: "TIER_1",
		inputSchema: {
			type: "object",
			properties: {
				plan: { type: "object" },
				newBaseCommit: { type: "string" },
			},
			required: ["plan"],
		},
		outputSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				newPlan: { type: "object" },
			},
			required: ["success"],
		},
		negativeExamples: [
			{
				scenario: "Target function deleted or signature modified concurrently",
				input: { plan_id: "plan_123" },
				expectedErrorCode: "CONFLICT",
				explanation: "Three-way analysis detects incompatible AST node modifications",
			},
		],
	},
	{
		operationName: "plan.explain",
		schemaVersion: "1.0.0",
		description: "Explains anchor selections, rationale, and reports uncovered blind spots",
		sideEffectClass: "READ_ONLY",
		riskTier: "TIER_0",
		inputSchema: {
			type: "object",
			properties: {
				plan_id: { type: "string" },
			},
			required: ["plan_id"],
		},
		outputSchema: {
			type: "object",
			properties: {
				coverage: { type: "object" },
				uncovered_surface: { type: "array" },
			},
			required: ["coverage"],
		},
		negativeExamples: [],
	},
	{
		operationName: "plan.apply",
		schemaVersion: "1.0.0",
		description: "Applies a validated plan to disk via atomic multi-file Kṣepaṇa coordinator",
		sideEffectClass: "REPOSITORY_WRITE",
		riskTier: "TIER_2",
		inputSchema: {
			type: "object",
			properties: {
				plan_id: { type: "string" },
			},
			required: ["plan_id"],
		},
		outputSchema: {
			type: "object",
			properties: {
				status: { type: "string" },
				appliedFiles: { type: "array" },
			},
			required: ["status", "appliedFiles"],
		},
		negativeExamples: [
			{
				scenario: "Target file modified on disk between validation and apply",
				input: { plan_id: "plan_123" },
				expectedErrorCode: "PREIMAGE_CHANGED",
				explanation: "Under write lock, unexpected file digest change aborts the entire apply",
			},
		],
	},
];

export const SUKSHMASHASTRA_MANIFEST: CapabilityRegistrationManifest = {
	capabilityId: "sukshmashastra",
	version: "1.0.0",
	displayName: "Sūkṣmaśastra Structural Code Editing",
	description: "Precision AST-anchored code transformation, multi-file atomic apply, and structural rebase engine",
	operations: SUKSHMASHASTRA_OPERATIONS,
};
