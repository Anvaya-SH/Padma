// Jālacitra Invalidation Planner (Part K1, K2, J5-INC-001 through J5-INC-005)

import type { InventoryEntry, InventoryResult } from "../inventory/enumerate.ts";
import type { JalacitraStore } from "../store/store.ts";

export interface ChangeSet {
	added: InventoryEntry[];
	modified: InventoryEntry[];
	removed: string[]; // repo-relative paths of removed files
	unchanged: InventoryEntry[];
	configChanged: boolean;
	affectedFilePaths: Set<string>;
}

export function planChangeSet(
	prevInventory: Map<string, InventoryEntry>,
	currentInventory: InventoryResult,
	store: JalacitraStore,
): ChangeSet {
	const added: InventoryEntry[] = [];
	const modified: InventoryEntry[] = [];
	const unchanged: InventoryEntry[] = [];
	const removed: string[] = [];
	let configChanged = false;

	const currentPaths = new Set<string>();

	for (const entry of currentInventory.files) {
		currentPaths.add(entry.path);
		const prev = prevInventory.get(entry.path);

		if (!prev) {
			added.push(entry);
			if (entry.class === "config" || entry.class === "manifest") {
				configChanged = true;
			}
		} else if (prev.contentDigest !== entry.contentDigest) {
			modified.push(entry);
			if (entry.class === "config" || entry.class === "manifest") {
				configChanged = true;
			}
		} else {
			unchanged.push(entry);
		}
	}

	for (const prevPath of prevInventory.keys()) {
		if (!currentPaths.has(prevPath)) {
			removed.push(prevPath);
			const prevEntry = prevInventory.get(prevPath);
			if (prevEntry && (prevEntry.class === "config" || prevEntry.class === "manifest")) {
				configChanged = true;
			}
		}
	}

	// Compute affected files: added + modified + dependents of modified/removed
	const affectedFilePaths = new Set<string>();
	for (const a of added) affectedFilePaths.add(a.path);
	for (const m of modified) affectedFilePaths.add(m.path);

	// Query dependencies from store for modified & removed files
	for (const m of modified) {
		const prevRec = store.getFileByPath(m.path);
		if (prevRec) {
			const deps = store.getRowsDependingOnFile(prevRec.node_id);
			for (const dep of deps) {
				if (dep.rowKind === "node") {
					const node = store.getNode(dep.rowId);
					if (node && node.kind === "file") {
						affectedFilePaths.add(String(node.attrs?.path ?? node.name ?? node.id));
					}
				}
			}
		}
	}

	for (const r of removed) {
		const prevRec = store.getFileByPath(r);
		if (prevRec) {
			const deps = store.getRowsDependingOnFile(prevRec.node_id);
			for (const dep of deps) {
				if (dep.rowKind === "node") {
					const node = store.getNode(dep.rowId);
					if (node && node.kind === "file") {
						affectedFilePaths.add(String(node.attrs?.path ?? node.name ?? node.id));
					}
				}
			}
		}
	}

	return {
		added,
		modified,
		removed,
		unchanged,
		configChanged,
		affectedFilePaths,
	};
}
