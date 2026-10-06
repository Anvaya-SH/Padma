// Jālacitra ScopePolicy Port (Part N1, J5-KER-002, J5-KER-003, J5-SEC-002)
// Enforces repository scope policy during indexing and at query time for product modes (Code vs Cyber).

export type ProductMode = "padma_code" | "padma_cyber";

export interface ScopeEvaluationResult {
	allowed: boolean;
	reasonCode?: "SCOPE_DENIED" | "NEEDS_CURRENT_AUTHORIZATION";
	message?: string;
}

export interface ScopePolicyContext {
	productMode: ProductMode;
	policyVersion: string;
	boundRepoRoot: string;
	excludedPatterns?: string[];
	engagementScope?: {
		includedPaths?: string[];
		excludedPaths?: string[];
	};
}

export class JalacitraScopeGuard {
	readonly productMode: ProductMode;
	readonly policyVersion: string;
	readonly boundRepoRoot: string;
	private excludedPatterns: string[];
	private engagementExcludedPaths: string[];

	constructor(context: ScopePolicyContext) {
		this.productMode = context.productMode;
		this.policyVersion = context.policyVersion;
		this.boundRepoRoot = context.boundRepoRoot;
		this.excludedPatterns = context.excludedPatterns ?? [];
		this.engagementExcludedPaths = context.engagementScope?.excludedPaths ?? [];
	}

	/**
	 * Evaluates whether a file path within the repository is permitted to be indexed or read.
	 * Returns allowed: false with SCOPE_DENIED if restricted by scope or cyber engagement rules.
	 */
	evaluatePath(relativePath: string): ScopeEvaluationResult {
		const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");

		// 1. Check general excluded patterns
		for (const pattern of this.excludedPatterns) {
			if (this.matchesPattern(normalized, pattern)) {
				return {
					allowed: false,
					reasonCode: "SCOPE_DENIED",
					message: `Path '${normalized}' is denied by mission scope pattern '${pattern}'`,
				};
			}
		}

		// 2. In Padma Cyber mode, check intersection with engagement scope (J5-KER-003)
		if (this.productMode === "padma_cyber") {
			for (const excluded of this.engagementExcludedPaths) {
				const normExcluded = excluded.replace(/\\/g, "/").replace(/^\/+/, "");
				if (
					normalized === normExcluded ||
					normalized.startsWith(normExcluded.endsWith("/") ? normExcluded : `${normExcluded}/`)
				) {
					return {
						allowed: false,
						reasonCode: "SCOPE_DENIED",
						message: `Path '${normalized}' is outside authorized engagement scope for Cyber mission`,
					};
				}
			}
		}

		return { allowed: true };
	}

	/**
	 * Filters query result items (nodes or references) at query time (J5-KER-003).
	 * Ensures mode switch immediately hides any rows belonging to newly restricted paths.
	 */
	filterQueryNodes<T extends { file_path?: string; path?: string }>(
		items: T[],
	): { allowed: T[]; deniedCount: number } {
		const allowed: T[] = [];
		let deniedCount = 0;

		for (const item of items) {
			const targetPath = item.file_path ?? item.path;
			if (!targetPath) {
				allowed.push(item);
				continue;
			}

			const evalResult = this.evaluatePath(targetPath);
			if (evalResult.allowed) {
				allowed.push(item);
			} else {
				deniedCount++;
			}
		}

		return { allowed, deniedCount };
	}

	private matchesPattern(path: string, pattern: string): boolean {
		const cleanPattern = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
		if (path === cleanPattern) return true;
		if (cleanPattern.endsWith("/*")) {
			const prefix = cleanPattern.slice(0, -2);
			return path.startsWith(prefix);
		}
		if (cleanPattern.endsWith("/")) {
			return path.startsWith(cleanPattern);
		}
		if (path.startsWith(`${cleanPattern}/`)) {
			return true;
		}
		return false;
	}
}
