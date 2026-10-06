import { canonical } from "../records.ts";
import { ContextError, type ContextLimits, type SourceDescriptor } from "./contracts.ts";
import type { TraversalManifest } from "./scan.ts";

/** Request-local work limits, never a replacement for the parent's actual I/O/provider ledger. */
export class ContextWork {
	private limits: ContextLimits;
	private deadline: number;
	private scannedSources = new Set<string>();
	readonly logicalSources = new Set<string>();
	scannedBytes = 0;
	hits = 0;
	scanMeasurementKnown = true;

	constructor(limits: ContextLimits) {
		this.limits = limits;
		this.deadline = performance.now() + limits.elapsedMs;
	}
	get remainingBytes(): number {
		return Math.max(0, this.limits.scanBytes - this.scannedBytes);
	}
	get remainingHits(): number {
		return Math.max(0, this.limits.hits - this.hits);
	}
	get remainingMs(): number {
		return Math.max(0, Math.floor(this.deadline - performance.now()));
	}
	assertTime(): void {
		if (this.remainingMs <= 0) throw new ContextError("CANCELLED", "Context request deadline reached");
	}
	assertRead(source: SourceDescriptor): void {
		if (!this.scannedSources.has(source.ref.observedVersion) && source.byteSize > this.remainingBytes)
			throw new ContextError("BUDGET", "Context request-wide scanned-byte ceiling reached");
	}
	recordRead(source: SourceDescriptor, bytes: number): void {
		if (!this.scannedSources.has(source.ref.observedVersion)) {
			this.scannedBytes += bytes;
			if (this.scannedBytes > this.limits.scanBytes)
				throw new ContextError("BUDGET", "Context source exceeded its admitted scanned-byte bound");
		}
		this.scannedSources.add(source.ref.observedVersion);
		this.logicalSources.add(canonical({ namespace: source.ref.namespace, id: source.ref.logicalId }));
	}
	recordScan(manifest: TraversalManifest): void {
		if (
			!Number.isSafeInteger(manifest.scannedBytes) ||
			manifest.scannedBytes < 0 ||
			manifest.scannedBytes > this.remainingBytes ||
			manifest.matches.length > this.remainingHits
		) {
			this.scanMeasurementKnown = false;
			throw new ContextError("BUDGET", "Traversal exceeded its remaining request-wide work allowance");
		}
		// Traversals charge every actual scan, including overlap and continuation validation.
		this.scannedBytes += manifest.scannedBytes;
		this.hits += manifest.matches.length;
		this.scanMeasurementKnown = true;
		for (const entry of manifest.entries) {
			if (!entry.source) continue;
			this.scannedSources.add(entry.source.ref.observedVersion);
			this.logicalSources.add(canonical({ namespace: entry.source.ref.namespace, id: entry.source.ref.logicalId }));
		}
	}
	takeHit(): boolean {
		if (!this.remainingHits) return false;
		this.hits++;
		return true;
	}
}
