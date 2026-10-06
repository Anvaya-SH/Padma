// Jālacitra Regions & Community Detection (Part M5, J5-REG-001 through J5-REG-005)
// Deterministic modularity-based community clustering over file dependency graphs.
// Includes heuristic labeling, cohesion metrics, bridge tracking, and directory fallback.

import { dirname } from "node:path";
import { deriveId } from "../model/ids.ts";
import type { JalacitraStore } from "../store/store.ts";

export interface RegionMember {
	nodeId: string;
	filePath: string;
	language?: string;
	symbolNames: string[];
}

export interface RegionBridge {
	targetRegionId: string;
	edgeCount: number;
	weight: number;
}

export interface RegionData {
	regionId: string;
	label: string;
	label_is_heuristic: true;
	algorithm: "MODULARITY_DETERMINISTIC" | "DIRECTORY_FALLBACK";
	seed: number;
	membersCount: number;
	memberFiles: string[];
	dominantLanguage: string;
	centralSymbols: string[];
	cohesion: number; // ratio of internal edge weight to total
	bridges: RegionBridge[];
	provenance: "INFERRED";
}

export interface RegionComputeOptions {
	seed?: number;
	timeoutMs?: number;
	hubDegreeThreshold?: number;
	maxFilesForModularity?: number;
}

const DEFAULT_SEED = 42;
const DEFAULT_HUB_DEGREE_THRESHOLD = 100;
const DEFAULT_MAX_FILES = 2000;

class PseudoRandom {
	private s: number;

	constructor(seed: number) {
		this.s = seed % 2147483647;
		if (this.s <= 0) this.s += 2147483646;
	}

	next(): number {
		this.s = (this.s * 16807) % 2147483647;
		return (this.s - 1) / 2147483646;
	}
}

export class RegionDetector {
	computeRegions(store: JalacitraStore, options?: RegionComputeOptions): RegionData[] {
		const seed = options?.seed ?? DEFAULT_SEED;
		const hubThreshold = options?.hubDegreeThreshold ?? DEFAULT_HUB_DEGREE_THRESHOLD;
		const maxFiles = options?.maxFilesForModularity ?? DEFAULT_MAX_FILES;

		const rawDb = store.rawDb;
		const currentGen = store.getCurrentGeneration()?.index_generation ?? 1;

		// 1. Fetch file nodes
		const files = rawDb
			.prepare(
				`SELECT n.id, n.canonical, f.path, f.language 
				 FROM nodes n
				 JOIN files f ON n.id = f.node_id
				 WHERE n.valid_from <= ? AND (n.valid_to IS NULL OR n.valid_to > ?)`,
			)
			.all(currentGen, currentGen) as Array<{ id: string; canonical: string; path: string; language: string }>;

		if (files.length === 0) return [];

		// Directory fallback if file count exceeds complexity bound (J5-REG-005)
		if (files.length > maxFiles) {
			return this.computeDirectoryFallback(files, seed);
		}

		// 2. Fetch edges between files
		const edges = rawDb
			.prepare(
				`SELECT e.src, e.dst, e.kind, e.weight
				 FROM edges e
				 WHERE e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
				   AND e.kind IN ('imports', 'calls', 'references', 'tests')`,
			)
			.all(currentGen, currentGen) as Array<{ src: string; dst: string; kind: string; weight: number }>;

		// 3. Build adjacency list with hub guard and edge down-weighting (J5-REG-001)
		const degreeMap = new Map<string, number>();
		for (const e of edges) {
			degreeMap.set(e.src, (degreeMap.get(e.src) ?? 0) + 1);
			degreeMap.set(e.dst, (degreeMap.get(e.dst) ?? 0) + 1);
		}

		const fileMap = new Map<string, { path: string; language: string }>();
		for (const f of files) {
			fileMap.set(f.id, { path: f.path, language: f.language });
		}

		const neighbors = new Map<string, Map<string, number>>();
		for (const f of files) {
			neighbors.set(f.id, new Map());
		}

		for (const e of edges) {
			if (!fileMap.has(e.src) || !fileMap.has(e.dst)) continue;
			if (e.src === e.dst) continue;

			// Hub guard: ignore edges to nodes with degree above threshold
			if ((degreeMap.get(e.src) ?? 0) > hubThreshold || (degreeMap.get(e.dst) ?? 0) > hubThreshold) {
				continue;
			}

			// Down-weight test edges (0.25 vs 1.0)
			const edgeWeight = e.kind === "tests" ? 0.25 : (e.weight ?? 1);

			const srcAdj = neighbors.get(e.src);
			const dstAdj = neighbors.get(e.dst);
			if (srcAdj && dstAdj) {
				srcAdj.set(e.dst, (srcAdj.get(e.dst) ?? 0) + edgeWeight);
				dstAdj.set(e.src, (dstAdj.get(e.src) ?? 0) + edgeWeight);
			}
		}

		// 4. Deterministic community detection using seeded label propagation (J5-REG-002)
		const community = new Map<string, string>();
		for (const f of files) {
			community.set(f.id, f.id);
		}

		const prng = new PseudoRandom(seed);
		const nodeOrder = [...files.map((f) => f.id)].sort(); // sorted for determinism

		const MAX_ITERATIONS = 15;
		for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
			let changed = false;

			// Deterministic shuffle with seeded PRNG
			const shuffled = [...nodeOrder];
			for (let i = shuffled.length - 1; i > 0; i--) {
				const j = Math.floor(prng.next() * (i + 1));
				const tmp = shuffled[i];
				shuffled[i] = shuffled[j];
				shuffled[j] = tmp;
			}

			for (const nodeId of shuffled) {
				const adj = neighbors.get(nodeId);
				if (!adj || adj.size === 0) continue;

				// Tally community weights
				const labelWeights = new Map<string, number>();
				for (const [nbr, w] of adj.entries()) {
					const comm = community.get(nbr) ?? nbr;
					labelWeights.set(comm, (labelWeights.get(comm) ?? 0) + w);
				}

				// Pick dominant community, tie-breaking lexicographically
				let bestLabel = community.get(nodeId) ?? nodeId;
				let maxWeight = -1;

				for (const [label, w] of labelWeights.entries()) {
					if (w > maxWeight || (w === maxWeight && label.localeCompare(bestLabel) < 0)) {
						maxWeight = w;
						bestLabel = label;
					}
				}

				if (bestLabel !== community.get(nodeId)) {
					community.set(nodeId, bestLabel);
					changed = true;
				}
			}

			if (!changed) break;
		}

		// 5. Group into regions and compute cohesion, central symbols, and bridges (J5-REG-003, J5-REG-004)
		const regionGroups = new Map<string, string[]>();
		for (const [nodeId, comm] of community.entries()) {
			let group = regionGroups.get(comm);
			if (!group) {
				group = [];
				regionGroups.set(comm, group);
			}
			group.push(nodeId);
		}

		// Fetch symbol nodes per file to compute top 3 central symbols
		const symbols = rawDb
			.prepare(
				`SELECT s.id, s.name, s.parent_id
				 FROM nodes s
				 WHERE s.kind = 'symbol' AND s.valid_from <= ? AND (s.valid_to IS NULL OR s.valid_to > ?)`,
			)
			.all(currentGen, currentGen) as Array<{ id: string; name: string; parent_id: string }>;

		const fileSymbols = new Map<string, string[]>();
		for (const s of symbols) {
			if (s.name && s.parent_id) {
				let list = fileSymbols.get(s.parent_id);
				if (!list) {
					list = [];
					fileSymbols.set(s.parent_id, list);
				}
				list.push(s.name);
			}
		}

		const results: RegionData[] = [];

		for (const [, memberNodeIds] of regionGroups.entries()) {
			memberNodeIds.sort();
			const memberFiles = memberNodeIds
				.map((id) => fileMap.get(id)?.path ?? "")
				.filter(Boolean)
				.sort();
			if (memberFiles.length === 0) continue;

			// Region ID from hash of sorted member identities (J5-REG-002)
			const regionId = deriveId(`region:${memberNodeIds.join(",")}`);

			// Label: longest common directory prefix (J5-REG-003)
			const commonPrefix = this.longestCommonDirectoryPrefix(memberFiles);

			// Dominant language
			const langCounts = new Map<string, number>();
			for (const id of memberNodeIds) {
				const l = fileMap.get(id)?.language ?? "typescript";
				langCounts.set(l, (langCounts.get(l) ?? 0) + 1);
			}
			let dominantLang = "typescript";
			let maxLangCount = 0;
			for (const [l, count] of langCounts.entries()) {
				if (count > maxLangCount) {
					maxLangCount = count;
					dominantLang = l;
				}
			}

			// Central symbols (up to 3)
			const symSet: string[] = [];
			for (const id of memberNodeIds) {
				const syms = fileSymbols.get(id) ?? [];
				for (const s of syms) {
					if (!symSet.includes(s)) symSet.push(s);
				}
			}
			const centralSymbols = symSet.slice(0, 3);
			const centralSuffix = centralSymbols.length > 0 ? ` (${centralSymbols.join(", ")})` : "";
			const label = `${commonPrefix || "root"}${centralSuffix}`;

			// Cohesion: internal edge weight / total incident weight (J5-REG-004)
			const memberSet = new Set(memberNodeIds);
			let internalWeight = 0;
			let totalWeight = 0;
			const bridgeMap = new Map<string, { count: number; weight: number }>();

			for (const id of memberNodeIds) {
				const adj = neighbors.get(id);
				if (!adj) continue;
				for (const [nbr, w] of adj.entries()) {
					totalWeight += w;
					if (memberSet.has(nbr)) {
						internalWeight += w;
					} else {
						const nbrComm = community.get(nbr) ?? "other";
						const nbrRegionId = deriveId(`region:${(regionGroups.get(nbrComm) ?? [nbr]).sort().join(",")}`);
						const br = bridgeMap.get(nbrRegionId) ?? { count: 0, weight: 0 };
						br.count++;
						br.weight += w;
						bridgeMap.set(nbrRegionId, br);
					}
				}
			}

			const cohesion = totalWeight > 0 ? Number((internalWeight / totalWeight).toFixed(3)) : 1.0;
			const bridges: RegionBridge[] = [];
			for (const [targetRegionId, br] of bridgeMap.entries()) {
				bridges.push({ targetRegionId, edgeCount: br.count, weight: br.weight });
			}
			bridges.sort((a, b) => b.weight - a.weight);

			results.push({
				regionId,
				label,
				label_is_heuristic: true,
				algorithm: "MODULARITY_DETERMINISTIC",
				seed,
				membersCount: memberFiles.length,
				memberFiles,
				dominantLanguage: dominantLang,
				centralSymbols,
				cohesion,
				bridges: bridges.slice(0, 5),
				provenance: "INFERRED",
			});
		}

		// Deterministic sort by regionId
		results.sort((a, b) => a.regionId.localeCompare(b.regionId));
		return results;
	}

	private computeDirectoryFallback(
		files: Array<{ id: string; canonical: string; path: string; language: string }>,
		seed: number,
	): RegionData[] {
		const dirGroups = new Map<string, string[]>();
		for (const f of files) {
			const dir = dirname(f.path).replace(/\\/g, "/");
			let group = dirGroups.get(dir);
			if (!group) {
				group = [];
				dirGroups.set(dir, group);
			}
			group.push(f.path);
		}

		const results: RegionData[] = [];
		for (const [dir, memberFiles] of dirGroups.entries()) {
			memberFiles.sort();
			const regionId = deriveId(`region:dir:${dir}`);
			results.push({
				regionId,
				label: `${dir}/ (directory fallback)`,
				label_is_heuristic: true,
				algorithm: "DIRECTORY_FALLBACK",
				seed,
				membersCount: memberFiles.length,
				memberFiles,
				dominantLanguage: "typescript",
				centralSymbols: [],
				cohesion: 1.0,
				bridges: [],
				provenance: "INFERRED",
			});
		}

		results.sort((a, b) => a.regionId.localeCompare(b.regionId));
		return results;
	}

	private longestCommonDirectoryPrefix(paths: string[]): string {
		if (paths.length === 0) return "";
		const dirs = paths.map((p) => {
			const norm = p.replace(/\\/g, "/");
			const parts = norm.split("/");
			parts.pop(); // remove file name
			return parts;
		});
		const first = dirs[0];
		if (!first || first.length === 0) return "";
		let commonLen = 0;

		for (let i = 0; i < first.length; i++) {
			const segment = first[i];
			if (dirs.every((d) => d[i] === segment)) {
				commonLen = i + 1;
			} else {
				break;
			}
		}

		return first.slice(0, commonLen).join("/");
	}
}

export const defaultRegionDetector = new RegionDetector();
