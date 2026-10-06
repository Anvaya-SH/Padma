import { resolve } from "node:path";
import { inside } from "../code.ts";
import { canonical } from "../records.ts";
import type { ContextRequest, Snippet } from "./contracts.ts";
import type { MissionPosition } from "./position.ts";

export function snippetKey(snippet: Snippet): string {
	return canonical({
		namespace: snippet.source.ref.namespace,
		logicalId: snippet.source.ref.logicalId,
		version: snippet.source.ref.observedVersion,
		range: snippet.citation.rawRange,
		view: snippet.citation.decodedView,
	});
}
const order = [
	"knownConflict",
	"exactTarget",
	"currentness",
	"exactQuery",
	"requirementRelevance",
	"operationCorrelation",
	"evidenceRole",
	"sourceDiversity",
	"roleDiversity",
	"queryTerms",
	"lossless",
];

/** Lexicographic, inspectable relevance features. They are neither confidence nor semantic proof. */
export function rankSnippets(
	snippets: Snippet[],
	request: ContextRequest,
	position: MissionPosition,
	root: string,
	exactTarget: string | null,
	conflicts: ReadonlySet<string>,
): Snippet[] {
	const terms = [...new Set(request.question.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])].slice(0, 16);
	const exactTargets = new Set(
		[...(exactTarget ? [exactTarget] : []), ...position.exactTargets].map((path) =>
			process.platform === "win32" ? resolve(root, path).toLowerCase() : resolve(root, path),
		),
	);
	const unique = new Map<string, Snippet>();
	for (const snippet of snippets) {
		const key = snippetKey(snippet);
		if (!unique.has(key)) unique.set(key, snippet);
	}
	const candidates = [...unique.values()].map((snippet) => {
		const file = ["filesystem_text", "structured_text"].includes(snippet.source.family);
		const path = file ? resolve(root, snippet.source.locator) : null;
		const role =
			snippet.source.family === "tool_artifact"
				? "operation_output"
				: /(?:^|[\\/])(?:test|tests)(?:[\\/])|\.(?:test|spec)\./i.test(snippet.source.locator)
					? "test"
					: "source";
		const features: Record<string, number> = {
			knownConflict: Number(conflicts.has(snippetKey(snippet))),
			exactTarget: Number(
				path !== null && exactTargets.has(process.platform === "win32" ? path.toLowerCase() : path),
			),
			currentness: snippet.freshness !== "satisfied" ? 0 : snippet.source.currentness === "working_capture" ? 2 : 1,
			exactQuery: Number(snippet.text.includes(request.literal ?? request.question)),
			requirementRelevance: Number(
				path !== null &&
					position.requirements.some(
						(requirement) =>
							requirement.status !== "SUPERSEDED" &&
							requirement.target !== null &&
							inside(requirement.target, path),
					),
			),
			operationCorrelation: Number(
				position.operations.some((entry) => entry.operation.operation_id === snippet.source.originOperation),
			),
			evidenceRole: snippet.provenance === "MODEL_INTERPRETATION" ? 0 : snippet.provenance === "HISTORY" ? 1 : 2,
			sourceDiversity: 1,
			roleDiversity: 1,
			queryTerms: terms.filter((term) => snippet.text.toLowerCase().includes(term)).length,
			lossless: Number(!snippet.redacted && !snippet.citation.lossy),
		};
		return { snippet, features, role, key: snippetKey(snippet) };
	});
	const ranked: Snippet[] = [];
	const sources = new Set<string>();
	const roles = new Set<string>();
	while (candidates.length) {
		for (const candidate of candidates) {
			candidate.features.sourceDiversity = Number(!sources.has(candidate.snippet.source.ref.logicalId));
			candidate.features.roleDiversity = Number(!roles.has(candidate.role));
		}
		candidates.sort((left, right) => {
			for (const feature of order) {
				const difference = right.features[feature] - left.features[feature];
				if (difference) return difference;
			}
			return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
		});
		const next = candidates.shift()!;
		ranked.push({
			...next.snippet,
			selection: { version: "AVARTANA_RANKING/1", features: { ...next.features }, order: [...order] },
		});
		sources.add(next.snippet.source.ref.logicalId);
		roles.add(next.role);
	}
	return ranked;
}
