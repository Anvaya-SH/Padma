// Sūkṣmaśastra Rewrite Imports Transformation (Part E2, S6-TX-001..003)
// Adds, removes, and rewrites import specifiers and module paths without churning unrelated imports.

import type { ByteRangeEdit } from "../model/diff.ts";

export interface AddImportSpec {
	readonly moduleSpecifier: string;
	readonly namedImports?: string[];
	readonly defaultImport?: string;
	readonly isTypeOnly?: boolean;
}

export interface RemoveImportSpec {
	readonly moduleSpecifier: string;
	readonly namedImports?: string[];
	readonly defaultImport?: string;
}

export interface RewriteSpecifierSpec {
	readonly moduleSpecifier?: string;
	readonly oldSpecifier: string;
	readonly newSpecifier: string;
}

/**
 * Rewrites module specifier from oldPath to newPath.
 */
export function rewriteModuleSpecifier(source: string, oldModule: string, newModule: string): ByteRangeEdit[] {
	const edits: ByteRangeEdit[] = [];
	const escaped = oldModule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`(from\\s+["'])(${escaped})(["'])`, "g");

	for (let match = regex.exec(source); match !== null; match = regex.exec(source)) {
		const start = match.index + match[1].length;
		const end = start + oldModule.length;
		edits.push({
			start,
			end,
			newText: newModule,
			description: `Rewrite module specifier: ${oldModule} -> ${newModule}`,
		});
	}

	return edits;
}

/**
 * Rewrites a specific imported identifier or specifier.
 */
export function rewriteImportSpecifier(source: string, spec: RewriteSpecifierSpec): ByteRangeEdit[] {
	const edits: ByteRangeEdit[] = [];
	const escaped = spec.oldSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`\\b(${escaped})\\b`, "g");

	// Find import statements
	const importRegex = /import\s+[^;]+;?/g;

	for (let impMatch = importRegex.exec(source); impMatch !== null; impMatch = importRegex.exec(source)) {
		const statement = impMatch[0];
		if (spec.moduleSpecifier && !statement.includes(spec.moduleSpecifier)) {
			continue;
		}

		// Search within this import statement
		for (let specMatch = regex.exec(statement); specMatch !== null; specMatch = regex.exec(statement)) {
			const start = impMatch.index + specMatch.index;
			const end = start + spec.oldSpecifier.length;
			edits.push({
				start,
				end,
				newText: spec.newSpecifier,
				description: `Rewrite import specifier: ${spec.oldSpecifier} -> ${spec.newSpecifier}`,
			});
		}
	}

	return edits;
}

/**
 * Adds an import to source code without churn.
 */
export function addImport(source: string, spec: AddImportSpec): ByteRangeEdit[] {
	const escaped = spec.moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Look for existing import statement for this module
	const existingRegex = new RegExp(`import\\s+([^{;]*)(?:\\{([^}]*)\\})?\\s*from\\s+["']${escaped}["'];?`);
	const match = existingRegex.exec(source);

	if (match && spec.namedImports && spec.namedImports.length > 0) {
		const namedClause = match[2];
		if (namedClause !== undefined) {
			// Existing named imports clause: add new specifiers
			const existingNames = namedClause
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const toAdd = spec.namedImports.filter((n) => !existingNames.includes(n));
			if (toAdd.length === 0) return []; // Already present

			const braceStart = match[0].indexOf("{") + match.index;
			const braceEnd = match[0].indexOf("}") + match.index;
			const inner = source.slice(braceStart + 1, braceEnd).trim();

			const newInner = inner ? `${inner}, ${toAdd.join(", ")}` : ` ${toAdd.join(", ")} `;
			return [
				{
					start: braceStart + 1,
					end: braceEnd,
					newText: ` ${newInner.trim()} `,
					description: `Add named import(s) ${toAdd.join(", ")} to ${spec.moduleSpecifier}`,
				},
			];
		}
	}

	// No existing import found: synthesize a new import line
	const typePrefix = spec.isTypeOnly ? "type " : "";
	let importLine = "";

	if (spec.defaultImport && spec.namedImports && spec.namedImports.length > 0) {
		importLine = `import ${typePrefix}${spec.defaultImport}, { ${spec.namedImports.join(", ")} } from "${spec.moduleSpecifier}";\n`;
	} else if (spec.defaultImport) {
		importLine = `import ${typePrefix}${spec.defaultImport} from "${spec.moduleSpecifier}";\n`;
	} else if (spec.namedImports && spec.namedImports.length > 0) {
		importLine = `import ${typePrefix}{ ${spec.namedImports.join(", ")} } from "${spec.moduleSpecifier}";\n`;
	} else {
		return [];
	}

	// Find insertion point: after the last existing import, or at the top of file
	const lastImportRegex = /^import\s+[^;]+;?\s*$/gm;
	let lastIndex = 0;
	for (let matchLast = lastImportRegex.exec(source); matchLast !== null; matchLast = lastImportRegex.exec(source)) {
		lastIndex = matchLast.index + matchLast[0].length;
		if (source[lastIndex] === "\n") lastIndex++;
	}

	return [
		{
			start: lastIndex,
			end: lastIndex,
			newText: lastIndex === 0 ? `${importLine}` : `${importLine}`,
			description: `Add import from "${spec.moduleSpecifier}"`,
		},
	];
}

/**
 * Removes import specifiers or entire import statements cleanly.
 */
export function removeImport(source: string, spec: RemoveImportSpec): ByteRangeEdit[] {
	const escaped = spec.moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`(^import\\s+[^;]+from\\s+["']${escaped}["'];?\\r?\\n?)`, "gm");

	const match = regex.exec(source);
	if (!match) return [];

	const fullStatement = match[1];
	const stmtStart = match.index;
	const stmtEnd = stmtStart + fullStatement.length;

	// If removing specific named imports
	if (spec.namedImports && spec.namedImports.length > 0) {
		const braceMatch = /\{([^}]*)\}/.exec(fullStatement);
		if (braceMatch) {
			const currentNames = braceMatch[1]
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const remainingNames = currentNames.filter((n) => !spec.namedImports!.includes(n));

			if (remainingNames.length === 0) {
				// No remaining named imports.
				// Check if there is a default import: e.g. import Foo, { bar } from "..."
				const defaultMatch = /import\s+([a-zA-Z0-9_$]+)\s*,/.exec(fullStatement);
				if (defaultMatch) {
					// Keep only the default import
					const lineEnding = fullStatement.endsWith("\r\n") ? "\r\n" : "\n";
					return [
						{
							start: stmtStart,
							end: stmtEnd,
							newText: `import ${defaultMatch[1]} from "${spec.moduleSpecifier}";${lineEnding}`,
							description: `Remove named imports, keep default import ${defaultMatch[1]}`,
						},
					];
				}
				// Remove the whole import statement
				return [
					{
						start: stmtStart,
						end: stmtEnd,
						newText: "",
						description: `Remove unused import from "${spec.moduleSpecifier}"`,
					},
				];
			}

			// Some named imports remain
			const braceStart = stmtStart + braceMatch.index;
			const braceEnd = braceStart + braceMatch[0].length;
			return [
				{
					start: braceStart,
					end: braceEnd,
					newText: `{ ${remainingNames.join(", ")} }`,
					description: `Remove [${spec.namedImports.join(", ")}] from ${spec.moduleSpecifier}`,
				},
			];
		}
	}

	// Remove whole statement
	return [
		{
			start: stmtStart,
			end: stmtEnd,
			newText: "",
			description: `Remove import statement from "${spec.moduleSpecifier}"`,
		},
	];
}
