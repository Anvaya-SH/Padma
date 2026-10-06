// Jālacitra atlas.locate Operation (Part M2, J5-NODE-001, J5-INC-001)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeDigest } from "../inventory/digest.ts";
import { type LocationHandle, normalizeRepoPath } from "../model/ids.ts";
import type { NodeRecord } from "../model/nodes.ts";
import type { JalacitraStore } from "../store/store.ts";
import {
	buildQueryResult,
	type FreshnessDelivered,
	type QueryContext,
	type QueryResult,
	type SnapshotMeta,
	UsageTracker,
} from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface LocateParams {
	file_path?: string;
	symbol_id?: string;
	verify_live?: boolean;
}

export interface LocateData {
	node: NodeRecord | null;
	location: LocationHandle | null;
	container_chain: NodeRecord[];
	content_digest: string | null;
	verified_live: boolean;
}

export function locate(ctx: QueryContext, store: JalacitraStore, params: LocateParams): QueryResult<LocateData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const repoRoot = ctx.repository.canonical_path;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const db = store.rawDb;
	let targetNode: NodeRecord | null = null;
	let fileNodeId: string | null = null;
	let filePath: string | null = null;
	let storedDigest: string | null = null;

	if (params.symbol_id) {
		const row = db
			.prepare("SELECT * FROM nodes WHERE id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)")
			.get(params.symbol_id, genNum, genNum) as Record<string, unknown> | undefined;
		if (row) {
			targetNode = {
				id: String(row.id),
				kind: row.kind as NodeRecord["kind"],
				canonical: String(row.canonical),
				name: row.name ? String(row.name) : null,
				parent_id: row.parent_id ? String(row.parent_id) : null,
				valid_from: Number(row.valid_from),
				valid_to: row.valid_to !== null ? Number(row.valid_to) : null,
				attrs: typeof row.attrs === "string" ? JSON.parse(row.attrs) : (row.attrs ?? {}),
			};
			fileNodeId = targetNode.parent_id ?? targetNode.id;
			const fileRow = db.prepare("SELECT path, content_digest FROM files WHERE node_id = ?").get(fileNodeId) as
				| { path: string; content_digest: string }
				| undefined;
			if (fileRow) {
				filePath = fileRow.path;
				storedDigest = fileRow.content_digest;
			}
		}
	} else if (params.file_path) {
		const normalized = normalizeRepoPath(params.file_path);
		const fileRow = store.getFileByPath(normalized, genNum);
		if (fileRow) {
			fileNodeId = fileRow.node_id;
			filePath = fileRow.path;
			storedDigest = fileRow.content_digest;
			targetNode = store.getNode(fileNodeId, genNum);
		}
	}

	const containerChain: NodeRecord[] = [];
	if (targetNode) {
		let curParentId = targetNode.parent_id;
		while (curParentId) {
			const parentNode = store.getNode(curParentId, genNum);
			if (!parentNode) break;
			containerChain.push(parentNode);
			curParentId = parentNode.parent_id;
		}
	}

	let location: LocationHandle | null = null;
	if (targetNode && fileNodeId && storedDigest) {
		const attrs = targetNode.attrs ?? {};
		location = {
			file_id: fileNodeId,
			start_byte: Number(attrs.start_byte ?? 0),
			end_byte: Number(attrs.end_byte ?? 0),
			start_line: Number(attrs.start_line ?? 1),
			end_line: Number(attrs.end_line ?? 1),
			content_digest_of_file: storedDigest,
			generation: genNum,
		};
	}

	// Live verification if requested
	let verifiedLive = false;
	const freshnessDelivered: FreshnessDelivered = {
		requested: ctx.freshness,
		delivered: "FRESH",
		last_verified_at: new Date().toISOString(),
	};

	if ((ctx.freshness === "live" || params.verify_live === true) && filePath) {
		const absPath = join(repoRoot, filePath);
		if (!existsSync(absPath)) {
			freshnessDelivered.delivered = "STALE";
			freshnessDelivered.downgrade_reason = "SOURCE_REMOVED";
		} else {
			try {
				const buf = readFileSync(absPath);
				const liveDigest = computeDigest(buf);
				tracker.recordFileRead(buf.byteLength);
				if (liveDigest === storedDigest) {
					verifiedLive = true;
					freshnessDelivered.delivered = "live";
				} else {
					freshnessDelivered.delivered = "STALE";
					freshnessDelivered.downgrade_reason = "SOURCE_CHANGED";
				}
			} catch {
				freshnessDelivered.delivered = "STALE";
				freshnessDelivered.downgrade_reason = "SOURCE_CHANGED";
			}
		}
	}

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	const data: LocateData = {
		node: targetNode,
		location,
		container_chain: containerChain,
		content_digest: storedDigest,
		verified_live: verifiedLive,
	};

	return buildQueryResult<LocateData>({
		snapshot: snapshotMeta,
		freshness: freshnessDelivered,
		data,
		coverage,
		usage: tracker.report(),
	});
}
