// Sūkṣmaśastra Koṣa Budget Tracking Port (Part I, S6-KER-004)
// Tracks resource consumption (AST parsing, compiler queries, diff generation)
// and handles SEMANTIC_DEFERRED / DIAGNOSTICS_DEFERRED decisions.

import { SukshmashastraError } from "../model/reason-codes.ts";

export interface KosaUsageMetrics {
	readonly astParseMs: number;
	readonly compilerQueryMs: number;
	readonly diffGenerationMs: number;
	readonly memoryBytes: number;
}

export interface KosaBudgetPort {
	debit(operation: string, metrics: KosaUsageMetrics, missionId?: string): Promise<void>;
	getRemainingBudget(missionId?: string): Promise<number>;
}

export class SukshmashastraBudgetManager {
	private port?: KosaBudgetPort;

	constructor(port?: KosaBudgetPort) {
		this.port = port;
	}

	setPort(port: KosaBudgetPort): void {
		this.port = port;
	}

	/**
	 * Checks if an estimated semantic compiler query exceeds 10% of remaining Koṣa budget.
	 */
	async checkSemanticBudgetCeiling(estimatedCostMs: number, missionId?: string): Promise<boolean> {
		if (!this.port) return true; // Allowed by default if unconstrained

		const remaining = await this.port.getRemainingBudget(missionId);
		const tenPercentLimit = remaining * 0.1;

		if (estimatedCostMs > tenPercentLimit) {
			throw new SukshmashastraError(
				"SEMANTIC_DEFERRED",
				`Estimated compiler query cost (${estimatedCostMs}ms) exceeds 10% of remaining budget (${tenPercentLimit.toFixed(0)}ms)`,
			);
		}

		return true;
	}

	/**
	 * Records actual usage metrics with Koṣa.
	 */
	async recordUsage(operation: string, metrics: KosaUsageMetrics, missionId?: string): Promise<void> {
		if (this.port) {
			try {
				await this.port.debit(operation, metrics, missionId);
			} catch {
				// Non-fatal
			}
		}
	}
}

export const defaultBudgetManager = new SukshmashastraBudgetManager();
