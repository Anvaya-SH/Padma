import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { canonical } from "../records.ts";

const text = Type.String({ minLength: 1, maxLength: 4096 });
const id = Type.String({ minLength: 1, maxLength: 256 });
const count = (maximum: number) => Type.Integer({ minimum: 0, maximum });
const choices = <const T extends string[]>(...values: T) => Type.Enum<T>(values);
export type AuthorityRef = { kind: "authority"; mission: string; id: string };
export type EvidenceRef = { kind: "evidence"; mission: string; id: string };
export type ArtifactRef = { kind: "artifact"; mission: string; id: string };
export type DerivedRef = { kind: "derived"; mission: string; id: string };
/** Admission belongs to Phase 14, not conversational recall. */
export type ExperienceRef = { kind: "experience"; namespace: string; id: string; admission: AuthorityRef };
export const RangeSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("bytes_half_open"), begin: count(8 * 1024 ** 2), end: count(8 * 1024 ** 2) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("lines_inclusive"),
			first: Type.Integer({ minimum: 1, maximum: 1000000 }),
			last: Type.Integer({ minimum: 1, maximum: 1000000 }),
		},
		{ additionalProperties: false },
	),
]);
export type SourceRange = Static<typeof RangeSchema>;
export const SourceFamilySchema = choices(
	"filesystem_text",
	"git_object",
	"git_worktree_diff",
	"tool_artifact",
	"live_tool_stream",
	"mission_evidence",
	"mission_position",
	"prior_attempts",
	"structured_text",
	"session_archive",
	"project_graph_future",
	"experience_future",
);
export type SourceFamily = Static<typeof SourceFamilySchema>;
export interface SourceRef {
	version: "AVARTANA_SOURCE/1";
	namespace: string;
	logicalId: string;
	observedVersion: string;
	adapterVersion: string;
	artifact: ArtifactRef;
	observation: EvidenceRef | null;
	authority: AuthorityRef | null;
}
export interface SourceDescriptor {
	ref: SourceRef;
	family: SourceFamily;
	locator: string;
	displayName: string;
	securityScope: string;
	originOperation: string | null;
	observedAt: number | null;
	acquisition: string;
	byteSize: number;
	contentType: string;
	encoding: "utf8" | "binary";
	generation: string | null;
	currentness: "immutable_historical" | "working_capture" | "committed_prefix";
	retention: { expiresAt: number | null; available: boolean };
	capabilities: ("read_range" | "search_literal" | "enumerate_scope" | "structured_text")[];
	consistency: string;
	capture: {
		format: "raw_blob" | "serialized_result" | "redacted_progress_snapshot";
		complete: boolean | null;
		originalBytes: number | null;
		stream: "source_blob" | "combined_order_unavailable";
		operationId: string | null;
		chunks: { begin: number; end: number; digest: string; artifact: ArtifactRef; capturedAt: number | null }[];
	};
}
export interface Citation {
	version: "AVARTANA_CITATION/1";
	source: SourceRef;
	range: SourceRange;
	rawRange: { kind: "bytes_half_open"; begin: number; end: number };
	excerptDigest: string;
	decodedView: string;
	lossy: boolean;
}
export interface Snippet {
	source: SourceDescriptor;
	citation: Citation;
	text: string;
	trust: "source_data";
	provenance: "OBSERVATION" | "HISTORY" | "DETERMINISTIC_DERIVATION" | "MODEL_INTERPRETATION";
	freshness: "satisfied" | "stale" | "unverified";
	truncated: boolean;
	redacted: boolean;
	inclusionReason: string;
	selection?: {
		version: "AVARTANA_RANKING/1";
		features: Record<string, number>;
		order: string[];
	};
}
export type LimitationCode =
	| "MALFORMED_REQUEST"
	| "MISSING_SOURCE"
	| "INACCESSIBLE_SOURCE"
	| "DENIED_SOURCE"
	| "UNSUPPORTED_ADAPTER"
	| "STALE_VERSION"
	| "AMBIGUOUS_TARGET"
	| "PARTIAL_SCAN"
	| "EXTRACTION_FAILURE"
	| "CITATION_FAILURE"
	| "CAPACITY"
	| "PROVIDER_FAILURE"
	| "STORAGE_FAILURE"
	| "CANCELLED"
	| "BUDGET"
	| "REVISION_CONFLICT"
	| "STAGNATION";
export class ContextError extends Error {
	readonly code: LimitationCode;
	constructor(code: LimitationCode, message: string) {
		super(message);
		this.name = "ContextError";
		this.code = code;
	}
}
export interface Coverage {
	manifest: DerivedRef | null;
	manifests?: DerivedRef[];
	mode: "targeted" | "bounded_candidates" | "complete_scope";
	eligible: number | null;
	enumerated: number;
	examined: number;
	completed: number;
	inaccessible: string[];
	excluded: string[];
	complete: boolean;
	omittedKnownHits: number;
	unexamined: number | null;
	stopReason: string | null;
	semantics: string;
}
const sourceSelector = Type.Object(
	{
		family: SourceFamilySchema,
		locator: text,
		range: Type.Optional(RangeSchema),
		view: Type.Optional(choices("blob", "tree", "diff")),
		staged: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export const ExpansionSchema = Type.Object(
	{
		version: Type.Literal("AVARTANA_EXPANSION/1"),
		minimumHits: Type.Integer({ minimum: 1, maximum: 64 }),
		steps: Type.Array(
			Type.Object(
				{
					sourceIndex: Type.Integer({ minimum: 1, maximum: 11 }),
					reason: Type.String({ minLength: 1, maxLength: 1000 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 3 },
		),
	},
	{ additionalProperties: false },
);
const nodeSchema = Type.Object(
	{
		id,
		op: choices(
			"resolve",
			"read_range",
			"search_literal",
			"enumerate_scope",
			"select",
			"partition",
			"compare",
			"aggregate",
			"map_extract",
			"compose",
			"analyse",
			"return",
		),
		inputs: Type.Array(id, { maxItems: 12, uniqueItems: true }),
		source: Type.Optional(sourceSelector),
		literal: Type.Optional(text),
		question: Type.Optional(text),
		key: Type.Optional(Type.String({ maxLength: 256 })),
	},
	{ additionalProperties: false },
);
export const PlanSchema = Type.Object(
	{ version: Type.Literal("AVARTANA_PLAN/1"), nodes: Type.Array(nodeSchema, { minItems: 1, maxItems: 32 }) },
	{ additionalProperties: false },
);
export type ContextPlan = Static<typeof PlanSchema>;
export const LimitsSchema = Type.Object(
	{
		scanBytes: count(64 * 1024 ** 2),
		returnBytes: count(256 * 1024),
		contextTokens: count(64000),
		hits: count(64),
		ranges: count(12),
		elapsedMs: Type.Integer({ minimum: 1, maximum: 120000 }),
		leafCalls: count(6),
		recursionDepth: count(2),
	},
	{ additionalProperties: false },
);
export type ContextLimits = Static<typeof LimitsSchema>;
export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
	scanBytes: 16 * 1024 ** 2,
	returnBytes: 32000,
	contextTokens: 8000,
	hits: 64,
	ranges: 12,
	elapsedMs: 30000,
	leafCalls: 6,
	recursionDepth: 1,
};
export const RequestSchema = Type.Object(
	{
		version: Type.Literal("AVARTANA_REQUEST/1"),
		id,
		missionId: id,
		missionRevision: Type.Integer({ minimum: 1 }),
		targetBinding: Type.Union([id, Type.Null()]),
		intent: choices(
			"resolve_target",
			"choose_next_move",
			"prepare_action",
			"diagnose",
			"verify",
			"review_quality",
			"recover",
			"explain",
		),
		question: text,
		sources: Type.Array(sourceSelector, { minItems: 1, maxItems: 12 }),
		requiredEvidence: Type.Array(choices("specification", "observation", "interpretation", "authority"), {
			maxItems: 4,
			uniqueItems: true,
		}),
		freshness: choices("historical_allowed", "current_generation", "live"),
		coverageMode: choices("targeted", "bounded_candidates", "complete_scope"),
		limits: LimitsSchema,
		cancellationId: id,
		literal: Type.Optional(text),
		continuation: Type.Optional(id),
		expansion: Type.Optional(ExpansionSchema),
		plan: Type.Optional(PlanSchema),
	},
	{ additionalProperties: false },
);
export type ContextRequest = Static<typeof RequestSchema>;
const requestValidator = Compile(RequestSchema);
export function validateRequest(input: unknown): asserts input is ContextRequest {
	canonical(input);
	if (!requestValidator.Check(input)) throw new ContextError("MALFORMED_REQUEST", "Invalid bounded context request");
	if (input.literal && /[\r\n]/.test(input.literal))
		throw new ContextError(
			"MALFORMED_REQUEST",
			"Literal search uses single-line matching; multiline patterns are unsupported",
		);
	for (const source of input.sources) {
		if (source.locator.includes("\0")) throw new ContextError("MALFORMED_REQUEST", "NUL in locator");
		if ((source.view || source.staged !== undefined) && !["git_object", "git_worktree_diff"].includes(source.family))
			throw new ContextError("MALFORMED_REQUEST", "Git view options require a Git source");
		if (
			(source.family === "git_object" && (source.view === "diff" || source.staged !== undefined)) ||
			(source.family === "git_worktree_diff" && source.view && source.view !== "diff")
		)
			throw new ContextError("MALFORMED_REQUEST", "Git family and requested view disagree");
		const range = source.range;
		if (range && (range.kind === "bytes_half_open" ? range.begin > range.end : range.first > range.last))
			throw new ContextError("MALFORMED_REQUEST", "Reversed range");
	}
}
export interface ContextAnswer {
	version: "AVARTANA_ANSWER/1";
	requestId: string;
	requestHash: string;
	basisRevision: number;
	eventWatermark: string | null;
	status:
		| "ANSWERED"
		| "PARTIAL"
		| "NOT_FOUND_IN_COMPLETE_SCOPE"
		| "NO_MATCH_IN_PARTIAL_SCOPE"
		| "STALE"
		| "UNAVAILABLE"
		| "DENIED"
		| "CANCELLED"
		| "FAILED";
	snapshots: SourceDescriptor[];
	snippets: Snippet[];
	coverage: Coverage;
	omitted: string[];
	unresolved: string[];
	contradictions: DerivedRef[];
	derivations: DerivedRef[];
	values: unknown[];
	limitations: { code: LimitationCode; reason: string }[];
	usageRefs: AuthorityRef[];
	continuation: DerivedRef | null;
	retained: DerivedRef | null;
}
export const LeafResultSchema = Type.Object(
	{
		claims: Type.Array(
			Type.Object(
				{
					text: Type.String({ maxLength: 2000 }),
					citations: Type.Array(count(11), { minItems: 1, maxItems: 12 }),
					support: Type.Literal("MODEL_INTERPRETATION"),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 12 },
		),
		unresolved: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 12 }),
		coverage: Type.String({ maxLength: 1000 }),
	},
	{ additionalProperties: false },
);
export type LeafResult = Static<typeof LeafResultSchema>;
export const leafValidator = Compile(LeafResultSchema);
export interface AnalysisFrame {
	version: "AVARTANA_FRAME/1";
	parentRequest: string;
	missionRevision: number;
	question: string;
	sources: Snippet[];
	tokenCeiling: number;
	depth: number;
	deadline: number;
}
export type LeafCall = (
	frame: AnalysisFrame,
	signal: AbortSignal,
) => Promise<{ result: unknown; usageRef: string; model: string; finishReason: string }>;
/** Later plugins mount an actual approved adapter; capability declarations are not implementations. */
export interface ContextSourceAdapter {
	family: SourceFamily;
	version: string;
	capabilities: SourceDescriptor["capabilities"];
	resolve(request: ContextRequest, locator: string, signal: AbortSignal): Promise<SourceDescriptor[]>;
	read(request: ContextRequest, source: SourceDescriptor, range: SourceRange, signal: AbortSignal): Promise<Snippet>;
}
