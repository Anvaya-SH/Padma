// Jālacitra Adapter Framework (Part I, J5-ADP-001 through J5-ADP-005, J5-PROV-002)

import type { FileClass, SymbolKind } from "../model/nodes.ts";
import type { ProvenanceClass } from "../model/provenance.ts";
import type { BlindSpotCode } from "../model/reason-codes.ts";

export interface RawRange {
	startByte: number;
	endByte: number;
	startLine: number;
	endLine: number;
	startColumn?: number;
	endColumn?: number;
	contentDigest: string;
}

export interface RawDeclaration {
	name: string;
	qualifiedName: string;
	kind: SymbolKind;
	visibility: "public" | "protected" | "private" | "internal";
	exported: boolean;
	range: RawRange;
	signatureDigest: string;
	attrs?: Record<string, unknown>;
}

export interface RawReference {
	referenceKind: "imports" | "calls" | "references" | "extends" | "overrides" | "reads_config";
	calleeShape?: "identifier" | "member_chain" | "new" | "tagged_template" | "optional_call";
	rawText: string;
	targetSpecifier?: string; // module specifier or symbol name
	range: RawRange;
	attrs?: Record<string, unknown>;
}

export interface RawConfigKey {
	name: string;
	scope: "file_key" | "env_var" | "cli_flag";
	range?: RawRange;
}

export interface RawTestCase {
	framework: string;
	qualifiedName: string;
	kind: "suite" | "case" | "param_family";
	range: RawRange;
	attrs?: Record<string, unknown>;
}

export interface RawContract {
	contractKind: "public_export" | "http_route" | "cli_command" | "package_bin" | "event_name";
	descriptor: string;
	range?: RawRange;
	attrs?: Record<string, unknown>;
}

export interface BoundedDiagnostic {
	code: string;
	message: string;
	range?: RawRange;
	excerpt?: string; // maximum 120 characters, secret-scrubbed
}

export interface ExtractResult {
	status: "OK" | "PARTIAL" | "FAILED";
	reasonCode?: string;
	declarations: RawDeclaration[];
	references: RawReference[];
	configKeys: RawConfigKey[];
	testCases: RawTestCase[];
	contracts: RawContract[];
	blindSpots: Record<string, number>;
	diagnostics: BoundedDiagnostic[];
}

export interface FileInfo {
	path: string;
	language: string | null;
	class: FileClass;
	sizeBytes: number;
	contentDigest: string;
	isBinary: boolean;
	declarationFile?: boolean;
	mtimeNs?: string | number | null;
}

export interface ConfigInput {
	path: string;
	digest: string;
}

export interface ExtractContext {
	repoView: {
		repoRoot: string;
		repoIdentity: string;
		files: string[];
	};
	timeoutMs?: number; // default 5000 ms
}

export interface LanguageAdapter {
	id: string;
	version: string;
	languages: string[];
	provenanceClasses: Array<ProvenanceClass>;
	grammarVersions(): Record<string, string>;
	configFingerprintInputs(repo: { repoRoot: string }): ConfigInput[];
	supports(file: FileInfo): boolean;
	extract(ctx: ExtractContext, file: FileInfo, bytes: Uint8Array): ExtractResult;
	blindSpotKinds: BlindSpotCode[];
}

export class AdapterRegistry {
	private adapters = new Map<string, LanguageAdapter>();

	register(adapter: LanguageAdapter): void {
		// Validation per J5-ADP-001..005 & J5-PROV-002
		if (!adapter.id || typeof adapter.id !== "string") {
			throw new Error("Adapter must declare a non-empty string id");
		}
		if (!adapter.version || typeof adapter.version !== "string") {
			throw new Error(`Adapter ${adapter.id} must declare a non-empty version`);
		}
		if (!Array.isArray(adapter.languages) || adapter.languages.length === 0) {
			throw new Error(`Adapter ${adapter.id} must declare supported languages`);
		}
		if (!Array.isArray(adapter.provenanceClasses) || adapter.provenanceClasses.length === 0) {
			throw new Error(`Adapter ${adapter.id} must declare at least one provenanceClass`);
		}
		if (typeof adapter.extract !== "function") {
			throw new Error(`Adapter ${adapter.id} must implement extract method`);
		}

		this.adapters.set(adapter.id, adapter);
	}

	get(id: string): LanguageAdapter | undefined {
		return this.adapters.get(id);
	}

	findForFile(file: FileInfo): LanguageAdapter | undefined {
		for (const adapter of this.adapters.values()) {
			if (adapter.supports(file)) {
				return adapter;
			}
		}
		return undefined;
	}

	list(): LanguageAdapter[] {
		return Array.from(this.adapters.values());
	}

	// Guarded extraction with timeout, bounds, and error recovery (J5-ADP-002, J5-ADP-003)
	safeExtract(adapter: LanguageAdapter, ctx: ExtractContext, file: FileInfo, bytes: Uint8Array): ExtractResult {
		const timeoutMs = ctx.timeoutMs ?? 5000;
		const start = Date.now();

		try {
			const result = adapter.extract(ctx, file, bytes);
			const elapsed = Date.now() - start;

			if (elapsed > timeoutMs) {
				return {
					status: "FAILED",
					reasonCode: "PARSE_TIMEOUT",
					declarations: [],
					references: [],
					configKeys: [],
					testCases: [],
					contracts: [],
					blindSpots: { PARSER_ERROR_RECOVERY: 1 },
					diagnostics: [
						{
							code: "PARSE_TIMEOUT",
							message: `Extraction took ${elapsed}ms, exceeding ceiling of ${timeoutMs}ms`,
						},
					],
				};
			}

			// Bound diagnostics to 20 items and excerpts to 120 chars
			const boundedDiags: BoundedDiagnostic[] = (result.diagnostics ?? []).slice(0, 20).map((d) => ({
				code: d.code,
				message: d.message.slice(0, 256),
				range: d.range,
				excerpt: d.excerpt ? d.excerpt.slice(0, 120) : undefined,
			}));

			return {
				status: result.status ?? "OK",
				reasonCode: result.reasonCode,
				declarations: result.declarations ?? [],
				references: result.references ?? [],
				configKeys: result.configKeys ?? [],
				testCases: result.testCases ?? [],
				contracts: result.contracts ?? [],
				blindSpots: result.blindSpots ?? {},
				diagnostics: boundedDiags,
			};
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				status: "FAILED",
				reasonCode: "PARSE_FAILED",
				declarations: [],
				references: [],
				configKeys: [],
				testCases: [],
				contracts: [],
				blindSpots: { PARSER_ERROR_RECOVERY: 1 },
				diagnostics: [
					{
						code: "PARSE_FAILED",
						message: msg.slice(0, 256),
					},
				],
			};
		}
	}
}
