export function getPadmaUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `padma/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
