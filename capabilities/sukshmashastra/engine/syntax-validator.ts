// Sūkṣmaśastra Syntax Validator & Structural Invariant Checker (S6-INV-005, S6-PIPE-001 Step 6)

import { extname, resolve } from "node:path";
import { type Message, transformSync } from "esbuild";
import { isRegularExpressionLiteral, type Node } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { extractStructuralCandidates } from "../anchors/resolver.ts";

export interface SyntaxCheckResult {
	readonly valid: boolean;
	readonly errors: string[];
	readonly diagnostics: Array<{ readonly message: string }>;
	readonly declarationsCount: number;
	readonly topLevelNames: string[];
}

function describeParserMessage(message: Message): string {
	return message.location
		? `${message.text} at ${message.location.file}:${message.location.line}:${message.location.column + 1} (byte column)`
		: message.text;
}

/**
 * Parse with pinned esbuild and TypeScript 7 native APIs; never execute source or load imports.
 * Parser-derived regex literals are compiled (never matched) by the runtime's regex parser.
 * Source-only calls default to TypeScript (.ts), NOT a permissive TSX/JSX grammar fallback.
 * Callers with a filename must forward it to enforce that grammar, especially JS versus TS
 * and TS versus TSX (angle-bracket assertions and generic arrows are ambiguous otherwise).
 * Parser failure, unsupported extensions/declaration-file grammar and warnings reject proof.
 * This is syntax validation, not TypeScript type checking or target-runtime compatibility.
 */
export function checkSyntax(sourceText: string, filename = "source.ts"): SyntaxCheckResult {
	const errors: string[] = [];
	const extension = extname(filename).toLowerCase();
	let loader: "ts" | "tsx" | "js" | "jsx" | undefined;
	switch (extension) {
		case ".ts":
		case ".mts":
		case ".cts":
			loader = "ts";
			break;
		case ".tsx":
			loader = "tsx";
			break;
		case ".js":
		case ".mjs":
		case ".cjs":
			loader = "js";
			break;
		case ".jsx":
			loader = "jsx";
			break;
	}

	if (/\.d\.(?:ts|mts|cts)$/i.test(filename)) {
		// Ambient declaration restrictions are checked outside the native parser's
		// syntactic phase; do not silently parse declaration files as ordinary TS.
		errors.push(`Syntax validation is inconclusive: declaration-file grammar is unsupported for '${filename}'`);
	} else if (loader === undefined) {
		errors.push(`Syntax validation is inconclusive: unsupported filename '${filename}'`);
	} else {
		try {
			// transformSync parses one in-memory file. The generated code is deliberately discarded.
			// No build, plugins, tsconfig discovery, module loading, or user-code execution occurs.
			const result = transformSync(sourceText, {
				loader,
				sourcefile: filename,
				target: "esnext",
				jsx: "preserve",
				logLevel: "silent",
			});
			for (const warning of result.warnings) {
				errors.push(`Syntax validation is inconclusive: ${describeParserMessage(warning)}`);
			}
			if (extension === ".mts" || extension === ".cts") {
				// These extensions disallow JSX-ambiguous assertions/generic arrows. The
				// native API checks that restriction outside its syntactic phase, so
				// require BOTH TS and TSX parsing, never a permissive grammar fallback.
				const unambiguous = transformSync(sourceText, {
					loader: "tsx",
					sourcefile: filename,
					target: "esnext",
					jsx: "preserve",
					logLevel: "silent",
				});
				for (const warning of unambiguous.warnings) {
					errors.push(`Syntax validation is inconclusive: ${describeParserMessage(warning)}`);
				}
			}

			// esbuild enforces JS/JSX versus TS/TSX but does not parse regex bodies.
			// TypeScript 7's native parser supplies syntactic diagnostics and an AST in
			// an isolated virtual project; never interpret absent-file diagnostics as proof.
			const root = resolve("/__sukshmashastra_parser__").replace(/\\/g, "/");
			const virtualSource = `${root}/source${extension}`;
			const configPath = `${root}/tsconfig.json`;
			const config = JSON.stringify({
				compilerOptions: {
					target: "esnext",
					jsx: "preserve",
					allowJs: true,
					noEmit: true,
					noLib: true,
					noResolve: true,
					types: [],
				},
				files: [virtualSource],
			});
			const files = new Map([
				[virtualSource, sourceText],
				[configPath, config],
			]);
			const api = new API({
				cwd: root,
				fs: {
					readFile: (path) => files.get(path.replace(/\\/g, "/")) ?? null,
					fileExists: (path) => files.has(path.replace(/\\/g, "/")),
					directoryExists: (path) => path.replace(/\\/g, "/") === root,
					getAccessibleEntries: () => ({ files: [], directories: [] }),
					realpath: (path) => path,
				},
			});
			try {
				const snapshot = api.updateSnapshot({ openProjects: [configPath] });
				try {
					const project = snapshot.getProject(configPath);
					if (!project || !project.program.getSourceFileNames().includes(virtualSource)) {
						throw new Error("Native parser did not load the in-memory source file");
					}
					const parsedFile = project.program.getSourceFile(virtualSource);
					if (!parsedFile || parsedFile.text !== sourceText) {
						throw new Error("Native parser did not return the exact in-memory source");
					}
					for (const diagnostic of project.program.getSyntacticDiagnostics(virtualSource)) {
						errors.push(`${diagnostic.text} in ${filename} at offset ${diagnostic.pos} (TS${diagnostic.code})`);
					}
					// Neither parser checks regex-body grammar in its syntactic phase.
					// Compile only parser-identified regex literals with V8's regex parser:
					// no matching, evaluation, or user-source execution. Unsupported future
					// flags/features also fail closed against this runtime's capability.
					const nodes: Node[] = [parsedFile];
					while (nodes.length > 0) {
						const node = nodes.pop();
						if (!node) break;
						if (isRegularExpressionLiteral(node)) {
							const closingSlash = node.text.lastIndexOf("/");
							try {
								if (!node.text.startsWith("/") || closingSlash <= 0) {
									throw new Error("Unrecognized parser regex literal representation");
								}
								new RegExp(node.text.slice(1, closingSlash), node.text.slice(closingSlash + 1));
							} catch (error: unknown) {
								errors.push(
									`Invalid or unsupported regex in ${filename} at offset ${node.pos}: ${error instanceof Error ? error.message : "regex parser failed"}`,
								);
							}
						}
						node.forEachChild((child) => {
							nodes.push(child);
						});
					}
				} finally {
					snapshot.dispose();
				}
			} finally {
				api.close();
			}
		} catch (error: unknown) {
			if (error instanceof Error && "errors" in error && Array.isArray(error.errors) && error.errors.length > 0) {
				// esbuild's documented TransformFailure.errors contains parser diagnostics.
				for (const message of error.errors as Message[]) errors.push(describeParserMessage(message));
			} else {
				errors.push(
					`Syntax validation is inconclusive: ${error instanceof Error ? error.message : "parser failed"}`,
				);
			}
		}
	}

	// Keep structural declaration detection compatible with the anchor resolver; these
	// heuristic candidates are NOT parser evidence and never determine syntactic validity.
	const candidates = extractStructuralCandidates(sourceText);
	const topLevelCandidates = candidates.filter((c) => c.containerChain.length === 1);
	const topLevelNames = topLevelCandidates.map((c) => `${c.kindName}:${c.name}`);

	return {
		valid: errors.length === 0,
		errors,
		diagnostics: errors.map((msg) => ({ message: msg })),
		declarationsCount: topLevelCandidates.length,
		topLevelNames,
	};
}

/**
 * Validates that an edit does not introduce unexpected structural deletions (S6-INV-005, S6-PIPE-001).
 * If a top-level declaration disappeared without being declared in deletedNames, returns false.
 */
export function validateStructuralDeclarations(
	preEditContent: string,
	postEditContent: string,
	expectedDeletedNames: ReadonlySet<string> = new Set(),
): { valid: boolean; undeclaredDeletions: string[] } {
	const preCheck = checkSyntax(preEditContent);
	const postCheck = checkSyntax(postEditContent);

	const postNamesSet = new Set(postCheck.topLevelNames);
	const undeclaredDeletions: string[] = [];

	for (const preName of preCheck.topLevelNames) {
		if (!postNamesSet.has(preName) && !expectedDeletedNames.has(preName)) {
			undeclaredDeletions.push(preName);
		}
	}

	return {
		valid: undeclaredDeletions.length === 0,
		undeclaredDeletions,
	};
}
