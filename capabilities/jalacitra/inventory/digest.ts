// Jālacitra Digest Calculation (Part F, Part H2, J5-CACHE-001)

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function computeDigest(data: string | Uint8Array): string {
	const hash = createHash("sha256");
	hash.update(data);
	return `sha256:${hash.digest("hex")}`;
}

export async function computeFileDigest(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
		stream.on("error", (err) => reject(err));
	});
}
