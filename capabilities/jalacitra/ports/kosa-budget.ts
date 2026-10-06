// Jālacitra Koṣa Budget Accounting Port (Part N1, J5-KER-004, J5-INV-009)
// Reports usage metrics to Koṣa debit port or store's usage_log.

import type { UsageReport } from "../api/context.ts";
import type { JalacitraStore } from "../store/store.ts";

export interface KosaDebitRequest {
	missionId: string;
	operationName: string;
	usage: UsageReport;
	timestamp: string;
}

export interface KosaDebitPort {
	debit(request: KosaDebitRequest): Promise<{ debited: boolean; remainingBudget?: number }>;
}

export class JalacitraBudgetManager {
	private kosaPort?: KosaDebitPort;
	private store?: JalacitraStore;

	constructor(options?: { kosaPort?: KosaDebitPort; store?: JalacitraStore }) {
		this.kosaPort = options?.kosaPort;
		this.store = options?.store;
	}

	setKosaPort(port: KosaDebitPort): void {
		this.kosaPort = port;
	}

	setStore(store: JalacitraStore): void {
		this.store = store;
	}

	/**
	 * Records usage for an operation.
	 * If a missionId is provided and Koṣa debit port is available, debits from the mission budget.
	 * If no mission or outside mission, appends to the store's usage_log table.
	 */
	async reportUsage(operationName: string, usage: UsageReport, missionId?: string): Promise<void> {
		if (missionId && this.kosaPort) {
			try {
				await this.kosaPort.debit({
					missionId,
					operationName,
					usage,
					timestamp: new Date().toISOString(),
				});
				return;
			} catch {
				// Fall back to local store logging if debit fails or throws
			}
		}

		// Maintenance outside mission: append to store usage_log if available
		if (this.store) {
			try {
				this.store.logUsage({
					op_id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
					op_kind: operationName,
					started_at: new Date().toISOString(),
					wall_ms: usage.wall_ms ?? usage.wall_time_ms ?? 0,
					files_read: usage.files_read ?? 0,
					bytes_read: usage.bytes_read ?? 0,
					rows_written: 0,
					rows_returned: usage.rows_returned ?? 0,
					output_bytes: usage.output_bytes ?? 0,
					mission_id: missionId ?? null,
					outcome: "SUCCESS",
				});
			} catch {
				// Usage logging is non-fatal
			}
		}
	}
}

export const defaultBudgetManager = new JalacitraBudgetManager();
