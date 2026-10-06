// Jālacitra Coverage Calculator for Graph Query Results (Part G4, J5-COMP-001 through J5-COMP-005)

import type { BlindSpotEntry, Coverage, LanguageCoverage, SkippedFileSummary } from "../model/coverage.ts";
import { type BlindSpotCode, REASON_CODES, type ReasonCode } from "../model/reason-codes.ts";
import type { JalacitraStore } from "../store/store.ts";

export function computeSnapshotCoverage(store: JalacitraStore, generation: number, repoId: string): Coverage {
	const db = store.rawDb;

	// Total files in the generation
	const totalFilesRow = db
		.prepare(
			`SELECT COUNT(*) as count FROM files f 
			 JOIN nodes n ON f.node_id = n.id 
			 WHERE n.valid_from <= ? AND (n.valid_to IS NULL OR n.valid_to > ?)`,
		)
		.get(generation, generation) as { count: number } | undefined;
	const filesConsidered = Number(totalFilesRow?.count ?? 0);

	// Extractions at or before this generation for valid files
	const extractionRows = db
		.prepare(
			`SELECT e.*, f.path, f.language FROM extractions e
			 JOIN files f ON e.file_node_id = f.node_id
			 JOIN nodes n ON f.node_id = n.id
			 WHERE n.valid_from <= ? AND (n.valid_to IS NULL OR n.valid_to > ?)`,
		)
		.all(generation, generation) as Array<{
		file_node_id: string;
		adapter_id: string;
		adapter_version: string;
		status: string;
		reason_code: string | null;
		blind_spots: string;
		path: string;
		language: string | null;
	}>;

	let filesIndexed = 0;
	const skippedByReason = new Map<ReasonCode, { count: number; sample_paths: string[] }>();
	const languagesMap = new Map<string, { adapter_version: string; hasPartial: boolean }>();
	const blindSpotsAggregated = new Map<BlindSpotCode, number>();

	for (const row of extractionRows) {
		if (row.status === "OK") {
			filesIndexed += 1;
		} else if (row.status === "SKIPPED") {
			const reason = (row.reason_code as ReasonCode) || "UNSUPPORTED_LANGUAGE";
			const cur = skippedByReason.get(reason) ?? { count: 0, sample_paths: [] };
			cur.count += 1;
			if (cur.sample_paths.length < 5) {
				cur.sample_paths.push(row.path);
			}
			skippedByReason.set(reason, cur);
		} else if (row.status === "PARTIAL" || row.status === "FAILED") {
			filesIndexed += 1; // partially indexed
			if (row.reason_code) {
				const reason = row.reason_code as ReasonCode;
				const cur = skippedByReason.get(reason) ?? { count: 0, sample_paths: [] };
				cur.count += 1;
				if (cur.sample_paths.length < 5) {
					cur.sample_paths.push(row.path);
				}
				skippedByReason.set(reason, cur);
			}
		}

		const lang = row.language ?? "unknown";
		const langEntry = languagesMap.get(lang) ?? {
			adapter_version: row.adapter_version,
			hasPartial: false,
		};
		if (row.status === "PARTIAL" || row.status === "FAILED") {
			langEntry.hasPartial = true;
		}
		languagesMap.set(lang, langEntry);

		// Aggregate blind spots
		try {
			const parsedSpots = JSON.parse(row.blind_spots || "{}") as Record<string, number>;
			for (const [code, count] of Object.entries(parsedSpots)) {
				if (typeof count === "number" && count > 0) {
					const spotCode = code as BlindSpotCode;
					blindSpotsAggregated.set(spotCode, (blindSpotsAggregated.get(spotCode) ?? 0) + count);
				}
			}
		} catch {
			// ignore JSON error
		}
	}

	const filesSkipped: SkippedFileSummary[] = [];
	for (const [reason, info] of skippedByReason.entries()) {
		filesSkipped.push({
			reason,
			count: info.count,
			sample_paths: info.sample_paths,
		});
	}

	const languages: LanguageCoverage[] = [];
	for (const [lang, info] of languagesMap.entries()) {
		let covLevel: LanguageCoverage["coverage"] = "FULL";
		if (lang === "typescript" || lang === "javascript") {
			covLevel = info.hasPartial ? "PARTIAL" : "FULL";
		} else {
			covLevel = "FILE_LEVEL_ONLY";
		}
		languages.push({
			language: lang,
			adapter_version: info.adapter_version,
			coverage: covLevel,
		});
	}

	const knownBlindSpots: BlindSpotEntry[] = [];
	for (const [code, count] of blindSpotsAggregated.entries()) {
		const entry = REASON_CODES[code];
		knownBlindSpots.push({
			code,
			count,
			description: entry ? entry.description : code,
		});
	}
	knownBlindSpots.sort((a, b) => a.code.localeCompare(b.code));

	const limitations: string[] = [];
	if (languages.some((l) => l.coverage === "FILE_LEVEL_ONLY")) {
		limitations.push("Non-primary languages receive file-level coverage only");
	}
	if (knownBlindSpots.length > 0) {
		limitations.push(`${knownBlindSpots.length} blind spot types encountered in index`);
	}

	let completeness: Coverage["completeness"] = "EXACT_WITHIN_INDEX";
	if (filesConsidered === 0) {
		completeness = "UNKNOWN";
	} else if (knownBlindSpots.length > 0 || filesSkipped.length > 0) {
		completeness = "LOWER_BOUND";
	}

	return {
		scope: {
			repo_id: repoId,
			snapshot_id: `snap:${repoId}:${generation}`,
			generation,
		},
		files_considered: filesConsidered,
		files_indexed: filesIndexed,
		files_skipped: filesSkipped,
		languages,
		known_blind_spots: knownBlindSpots,
		completeness,
		limitations,
	};
}
