import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { SandhanaError } from "./errors.ts";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export type RetrievalSource = { kind: "TARGET" } | { kind: "WORKSPACE_IDENTITY" | "STATUS_METADATA"; root: string };
export interface RetrievalMeter {
	authorize: (path: string, source: RetrievalSource) => void;
	validate?: (path: string, descriptor: Stats) => void;
	reserve: (expectedBytes: number) => (actualBytes: number) => void;
}

/** Admit a bounded source read before allocating/reading it, then settle bytes even on failure. */
export function observedFile(
	path: string,
	meter?: RetrievalMeter,
	source: RetrievalSource = { kind: "TARGET" },
): Buffer {
	meter?.authorize(path, source);
	if (!lstatSync(path).isFile()) throw new SandhanaError("SCOPE_DENIED", "Source is not a regular file");
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	let consumed = 0;
	let settle: ((actualBytes: number) => void) | undefined;
	try {
		const descriptor = fstatSync(fd);
		if (!descriptor.isFile()) throw new SandhanaError("SCOPE_DENIED", "Opened source is not a regular file");
		meter?.validate?.(path, descriptor);
		const size = descriptor.size;
		if (size > MAX_FILE_BYTES)
			throw new SandhanaError("BUDGET_REJECTED", "File exceeds bounded adapter limit (8 MiB)");
		settle = meter?.reserve(size);
		const bytes = Buffer.alloc(size);
		while (consumed < size) {
			const count = readSync(fd, bytes, consumed, size - consumed, consumed);
			if (count === 0) break;
			consumed += count;
		}
		const after = fstatSync(fd);
		const pathAfter = lstatSync(path);
		if (
			after.size !== size ||
			consumed !== size ||
			after.mtimeMs !== descriptor.mtimeMs ||
			after.ctimeMs !== descriptor.ctimeMs ||
			pathAfter.dev !== descriptor.dev ||
			pathAfter.ino !== descriptor.ino ||
			pathAfter.birthtimeMs !== descriptor.birthtimeMs
		)
			throw new SandhanaError(
				"BINDING_STALE",
				"Source changed during bounded read (descriptor/path checks; not a universal snapshot guarantee)",
			);
		return bytes;
	} finally {
		closeSync(fd);
		settle?.(consumed);
	}
}
