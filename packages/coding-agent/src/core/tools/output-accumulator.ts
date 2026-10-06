import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, fstatSync, type Stats, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { privateOutputDirectory } from "../../utils/private-storage.ts";
import { registerShellOutput } from "./dispatch-guard.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	maxTotalBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	outputLimitExceeded: boolean;
	captureLimitation?: string;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function defaultTempFilePath(prefix: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error("Invalid private output file prefix");
	const id = randomBytes(8).toString("hex");
	return join(privateOutputDirectory(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly maxTotalBytes: number | undefined;
	private readonly rawDigest = createHash("sha256");
	private readonly decoder = new TextDecoder();

	// Guarded operations project already received bytes; they must not introduce
	// an unreserved filesystem read after dispatch. Keep at most 1 MiB of raw edges.
	private structuredEdges: Buffer | undefined;
	private structuredHeadBytes = 0;
	private structuredTailPosition = 0;
	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;
	private completionLimitation: string | undefined;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private queuedSpoolBytes = 0;
	private tempFileIdentity: Stats | undefined;
	private tempFileError: Error | undefined;
	private outputReported = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "padma-output";
		this.maxTotalBytes = options.maxTotalBytes;
		if (this.maxTotalBytes !== undefined && (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 0))
			throw new Error("Invalid total output limit");
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		if (this.maxTotalBytes !== undefined && data.length > 0) {
			const capacity = Math.min(this.maxTotalBytes, 1024 * 1024);
			this.structuredEdges ??= Buffer.alloc(capacity);
			const headCapacity = Math.ceil(capacity / 2);
			const headBytes = Math.min(data.length, headCapacity - this.structuredHeadBytes);
			data.copy(this.structuredEdges, this.structuredHeadBytes, 0, headBytes);
			this.structuredHeadBytes += headBytes;
			const tailCapacity = capacity - headCapacity;
			if (tailCapacity > 0) {
				const tail = data.subarray(Math.max(0, data.length - tailCapacity));
				const first = Math.min(tail.length, tailCapacity - this.structuredTailPosition);
				tail.copy(this.structuredEdges, headCapacity + this.structuredTailPosition, 0, first);
				tail.copy(this.structuredEdges, headCapacity, first);
				this.structuredTailPosition = (this.structuredTailPosition + tail.length) % tailCapacity;
			}
		}
		this.rawDigest.update(data);
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.shouldUseTempFile() || this.outputLimitExceeded) {
			this.ensureTempFile();
			this.writeSpool(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(limitation?: string): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.completionLimitation = limitation;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath:
				this.outputLimitExceeded || this.tempFileError || this.completionLimitation ? undefined : this.tempFilePath,
			outputLimitExceeded: this.outputLimitExceeded,
			captureLimitation: this.completionLimitation,
		};
	}

	closeTempFile(): Promise<void> {
		this.closePromise ??= this.finalizeOutput();
		return this.closePromise;
	}

	private async finalizeOutput(): Promise<void> {
		if (this.outputReported) return;
		this.finish();
		const stream = this.tempFileStream;
		this.tempFileStream = undefined;
		if (stream && !stream.closed)
			await new Promise<void>((resolve) => {
				stream.once("close", resolve);
				stream.end();
			});
		const spoolBytes = this.tempFileError ? null : (stream?.bytesWritten ?? 0);
		const identity = this.tempFileIdentity;
		const limitation = this.tempFileError
			? `Output spool failed: ${this.tempFileError.message}; written volume is unknown`
			: this.outputLimitExceeded
				? `Output exceeded admitted limit of ${this.maxTotalBytes} bytes; complete output was not retained`
				: (this.completionLimitation ??
					(stream && (!identity || spoolBytes !== this.totalRawBytes)
						? "Output spool did not confirm complete native bytes"
						: null));
		this.outputReported = true;
		registerShellOutput({
			output_bytes: this.totalRawBytes,
			spool_bytes: spoolBytes,
			spool_path: this.tempFilePath ?? null,
			limitation,
			source:
				this.tempFilePath && identity && limitation === null
					? {
							path: this.tempFilePath,
							bytes: this.totalRawBytes,
							digest: this.rawDigest.digest("hex"),
							dev: identity.dev,
							ino: identity.ino,
							birthtime_ms: identity.birthtimeMs,
						}
					: null,
		});
		if (this.tempFileError) throw this.tempFileError;
	}

	get outputLimitExceeded(): boolean {
		return this.maxTotalBytes !== undefined && this.totalRawBytes > this.maxTotalBytes;
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid structured output limit");
		if (this.maxTotalBytes !== undefined) {
			const capacity = Math.min(this.maxTotalBytes, 1024 * 1024);
			const edges = this.structuredEdges ?? Buffer.alloc(0);
			const headCapacity = Math.ceil(capacity / 2);
			const tailCapacity = capacity - headCapacity;
			const tail =
				tailCapacity === 0
					? Buffer.alloc(0)
					: Buffer.concat([
							edges.subarray(headCapacity + this.structuredTailPosition),
							edges.subarray(headCapacity, headCapacity + this.structuredTailPosition),
						]);
			const limit = Math.min(maxBytes, capacity);
			if (this.totalRawBytes <= limit) {
				const remaining = this.totalRawBytes - this.structuredHeadBytes;
				return {
					content: new TextDecoder().decode(
						Buffer.concat([
							edges.subarray(0, this.structuredHeadBytes),
							remaining > 0 ? tail.subarray(tail.length - remaining) : Buffer.alloc(0),
						]),
					),
					truncated: false,
				};
			}
			const headBytes = Math.ceil(limit / 2);
			const tailBytes = limit - headBytes;
			const headText = new TextDecoder().decode(edges.subarray(0, headBytes), { stream: true });
			const ending = tailBytes > 0 ? tail.subarray(tail.length - tailBytes) : Buffer.alloc(0);
			let start = 0;
			while (start < ending.length && (ending[start] & 0xc0) === 0x80) start++;
			return {
				content: `${headText}\n\n[... ${this.totalRawBytes - headBytes - tailBytes} bytes omitted ...]\n\n${new TextDecoder().decode(ending.subarray(start))}`,
				truncated: true,
			};
		}
		if (!this.tempFilePath) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		const file = await open(this.tempFilePath, "r");
		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes) {
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}
			const headBytes = Math.floor(maxBytes / 2);
			const tailBytes = maxBytes - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = size - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath || this.tempFileError) {
			return;
		}
		try {
			this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		} catch (error) {
			this.tempFileError = error instanceof Error ? error : new Error("Private output storage unavailable");
			return;
		}
		const stream = createWriteStream(this.tempFilePath, { mode: 0o600, flags: "wx" });
		this.tempFileStream = stream;
		stream.once("open", (fd) => {
			try {
				this.tempFileIdentity = fstatSync(fd);
			} catch (error) {
				stream.destroy(error instanceof Error ? error : new Error(String(error)));
			}
		});
		stream.on("error", (error: Error) => {
			this.tempFileError = error;
		});
		for (const chunk of this.rawChunks) {
			this.writeSpool(chunk);
		}
		this.rawChunks = [];
	}

	private writeSpool(chunk: Buffer): void {
		const remaining = this.maxTotalBytes === undefined ? chunk.length : this.maxTotalBytes - this.queuedSpoolBytes;
		const retained = chunk.subarray(0, Math.max(0, Math.min(chunk.length, remaining)));
		if (retained.length && this.tempFileStream && !this.tempFileError) {
			this.queuedSpoolBytes += retained.length;
			this.tempFileStream.write(retained);
		}
	}
}
