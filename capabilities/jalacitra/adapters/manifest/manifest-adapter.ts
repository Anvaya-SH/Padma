// Jālacitra Manifest Adapter (Part I6, J5-MAN-001, J5-TSE-005)

import type { ProvenanceClass } from "../../model/provenance.ts";
import type { BlindSpotCode } from "../../model/reason-codes.ts";
import type {
	ConfigInput,
	ExtractContext,
	ExtractResult,
	FileInfo,
	LanguageAdapter,
	RawContract,
	RawDeclaration,
	RawReference,
} from "../adapter.ts";
import { computeSignatureDigest } from "../typescript/signature.ts";

export class ManifestAdapter implements LanguageAdapter {
	readonly id = "manifest";
	readonly version = "1.0.0";
	readonly languages = ["json", "yaml", "toml"];
	readonly provenanceClasses: ProvenanceClass[] = ["PARSED"];
	readonly blindSpotKinds: BlindSpotCode[] = [];

	grammarVersions(): Record<string, string> {
		return { manifest: "1.0.0" };
	}

	configFingerprintInputs(_repo: { repoRoot: string }): ConfigInput[] {
		return [];
	}

	supports(file: FileInfo): boolean {
		const name = file.path.split("/").pop() ?? "";
		return (
			name === "package.json" ||
			name.startsWith("tsconfig") ||
			name === "pnpm-workspace.yaml" ||
			name === "turbo.json" ||
			name === "Cargo.toml"
		);
	}

	extract(_ctx: ExtractContext, file: FileInfo, bytes: Uint8Array): ExtractResult {
		const name = file.path.split("/").pop() ?? "";
		const text = new TextDecoder().decode(bytes);

		const declarations: RawDeclaration[] = [];
		const references: RawReference[] = [];
		const contracts: RawContract[] = [];

		if (name === "package.json") {
			try {
				const pkg = JSON.parse(text);

				// Package declaration
				if (pkg.name) {
					declarations.push({
						name: pkg.name,
						qualifiedName: pkg.name,
						kind: "other",
						attrs: { is_package: true },
						visibility: "public",
						exported: true,
						range: {
							startByte: 0,
							endByte: 0,
							startLine: 1,
							endLine: 1,
							contentDigest: file.contentDigest,
						},
						signatureDigest: computeSignatureDigest(pkg.version ?? "1.0.0"),
					});
				}

				// Dependencies
				const allDeps = {
					...(pkg.dependencies ?? {}),
					...(pkg.devDependencies ?? {}),
					...(pkg.peerDependencies ?? {}),
				};

				for (const depName of Object.keys(allDeps)) {
					references.push({
						referenceKind: "imports",
						rawText: depName,
						targetSpecifier: depName,
						range: {
							startByte: 0,
							endByte: 0,
							startLine: 1,
							endLine: 1,
							contentDigest: file.contentDigest,
						},
						attrs: { dependency: true },
					});
				}

				// Scripts as build targets
				if (pkg.scripts && typeof pkg.scripts === "object") {
					for (const [scriptName, scriptCmd] of Object.entries(pkg.scripts)) {
						contracts.push({
							contractKind: "cli_command",
							descriptor: `npm run ${scriptName}`,
							attrs: {
								target_name: scriptName,
								command_digest: computeSignatureDigest(String(scriptCmd)),
								is_build_target: true,
							},
						});
					}
				}

				// Entry points and bin
				if (pkg.main) {
					contracts.push({
						contractKind: "public_export",
						descriptor: `main: ${pkg.main}`,
						attrs: { entry: pkg.main },
					});
				}
				if (pkg.bin) {
					contracts.push({
						contractKind: "package_bin",
						descriptor: typeof pkg.bin === "string" ? pkg.bin : JSON.stringify(pkg.bin),
					});
				}
			} catch {
				// unparseable manifest
			}
		}

		return {
			status: "OK",
			declarations,
			references,
			configKeys: [],
			testCases: [],
			contracts,
			blindSpots: {},
			diagnostics: [],
		};
	}
}
