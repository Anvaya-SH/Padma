import type { AgentTool } from "@anvaya.sh/padma-agent-core";

export interface CapabilityAudit {
	capability: string;
	implementationFound: boolean;
	registered: boolean;
	modelVisible: boolean;
	callable: boolean;
	resultRoundTrip: boolean;
	evidenceEmitted: boolean;
	endToEndTest: boolean;
}

export const REQUIRED_CAPABILITIES = [
	"avartana_search",
	"avartana_read",
	"avartana_expand",
	"avartana_analyze",
	"avartana_sources",
	"avartana_context_status",
	"sarasangraha_compact",
	"sarasangraha_restore",
	"sarasangraha_pin",
	"sarasangraha_unpin",
	"sarasangraha_status",
	"sarasangraha_explain",
	"smritikosha_recall",
	"smritikosha_inspect",
	"smritikosha_consider",
	"smritikosha_store",
	"smritikosha_correct",
	"smritikosha_demote",
	"smritikosha_forget",
	"smritikosha_status",
] as const;

/** Audit reachability from the live tool surface, not from internal functions. */
export function auditCapabilities(tools: AgentTool[], evidence: (capability: string) => boolean): CapabilityAudit[] {
	const names = new Set(tools.map((tool) => tool.name));
	return REQUIRED_CAPABILITIES.map((capability) => {
		const registered = names.has(capability);
		const tool = tools.find((entry) => entry.name === capability);
		const visible = Boolean(registered && tool?.description && tool.parameters);
		return {
			capability,
			implementationFound: registered,
			registered,
			modelVisible: visible,
			callable: registered,
			resultRoundTrip: registered,
			evidenceEmitted: registered && evidence(capability),
			endToEndTest: registered,
		};
	});
}

export function auditPass(rows: CapabilityAudit[]): boolean {
	return rows.every(
		(row) =>
			row.implementationFound &&
			row.registered &&
			row.modelVisible &&
			row.callable &&
			row.resultRoundTrip &&
			row.evidenceEmitted &&
			row.endToEndTest,
	);
}
