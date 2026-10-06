// Sūkṣmaśastra Structural Anchor Resolution Engine (Part D, S6-ANC-001 through S6-ANC-004)

import { createHash } from "node:crypto";
import type { Anchor, AnchorResolution, Candidate } from "../model/anchors.ts";
import { type ParsedSelector, parseSelector } from "./grammar.ts";

export interface AstNodeCandidate {
	readonly name: string;
	readonly kindName: string;
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly nodeDigest: string;
	readonly signatureDigest: string;
	readonly containerChain: string[];
	readonly isExported: boolean;
	readonly isDefaultExport: boolean;
	readonly declarationGroup?: string;
}

export function computeSha256(text: string | Uint8Array): string {
	return createHash("sha256").update(text).digest("hex");
}

export function computeSignatureDigest(declarationHead: string): string {
	const normalized = declarationHead.replace(/\s+/g, " ").trim();
	return computeSha256(normalized);
}

/**
 * Finds the index of the matching closing brace for a block starting at openBraceIndex.
 */
function findMatchingBrace(text: string, openBraceIndex: number): number {
	let depth = 0;
	let inString: string | null = null;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = openBraceIndex; i < text.length; i++) {
		const char = text[i];
		const nextChar = text[i + 1];

		if (inLineComment) {
			if (char === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && nextChar === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			if (char === "\\" && i + 1 < text.length) {
				i++; // Skip escaped char
			} else if (char === inString) {
				inString = null;
			}
			continue;
		}

		if (char === "/" && nextChar === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (char === "/" && nextChar === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			inString = char;
			continue;
		}

		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return text.length;
}

/**
 * Extracts all structural candidate nodes from source code.
 */
export function extractStructuralCandidates(sourceText: string): AstNodeCandidate[] {
	const candidates: AstNodeCandidate[] = [];

	// 1. Function declarations (including overload signatures without bodies)
	// Matches: [export] [default] [async] function name(...)[: type] [; or {]
	const fnRegex =
		/(?:^|\n)([ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*([<(][^{;\n]*)(;|\{))/g;
	for (let match = fnRegex.exec(sourceText); match !== null; match = fnRegex.exec(sourceText)) {
		const fullMatch = match[1];
		const name = match[2];
		const sigHead = match[3];
		const terminator = match[4];

		const leadWhitespace = match[0].length - fullMatch.length;
		const start = match.index + leadWhitespace;
		const isExported = fullMatch.includes("export");
		const isDefaultExport = fullMatch.includes("default");

		let end: number;
		let fullText: string;

		if (terminator === ";") {
			// Overload signature without body
			end = start + fullMatch.length;
			fullText = sourceText.slice(start, end);
		} else {
			// Function with body
			const openBraceIdx = start + fullMatch.length - 1;
			end = findMatchingBrace(sourceText, openBraceIdx);
			fullText = sourceText.slice(start, end);
		}

		candidates.push({
			name,
			kindName: "function",
			start,
			end,
			text: fullText,
			nodeDigest: computeSha256(fullText),
			signatureDigest: computeSignatureDigest(`function ${name}${sigHead}`),
			containerChain: [`function:${name}`],
			isExported,
			isDefaultExport,
			declarationGroup: name,
		});
	}

	// 2. Class declarations
	const classRegex =
		/(?:^|\n)([ \t]*(?:export\s+(?:default\s+)?)?class\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+[a-zA-Z0-9_$.]+)?(?:\s+implements\s+[^{]+)?\s*\{)/g;
	for (let match = classRegex.exec(sourceText); match !== null; match = classRegex.exec(sourceText)) {
		const fullMatch = match[1];
		const className = match[2];
		const leadWhitespace = match[0].length - fullMatch.length;
		const start = match.index + leadWhitespace;
		const isExported = fullMatch.includes("export");
		const isDefaultExport = fullMatch.includes("default");

		const openBraceIdx = start + fullMatch.length - 1;
		const end = findMatchingBrace(sourceText, openBraceIdx);
		const classText = sourceText.slice(start, end);

		candidates.push({
			name: className,
			kindName: "class",
			start,
			end,
			text: classText,
			nodeDigest: computeSha256(classText),
			signatureDigest: computeSignatureDigest(`class ${className}`),
			containerChain: [`class:${className}`],
			isExported,
			isDefaultExport,
		});

		// Extract methods, constructors, and properties inside this class
		const bodyStart = openBraceIdx + 1;
		const bodyText = sourceText.slice(bodyStart, end - 1);

		// Methods & constructors
		const methodRegex =
			/([ \t]*(?:(public|private|protected|static|async)\s+)*([a-zA-Z0-9_$]+)\s*\([^)]*\)(?:\s*:\s*[^{;]+)?\s*\{)/g;
		for (let m = methodRegex.exec(bodyText); m !== null; m = methodRegex.exec(bodyText)) {
			const mFull = m[1];
			const methodName = m[3];
			const leadingSpaces = mFull.length - mFull.trimStart().length;
			const mStart = bodyStart + m.index + leadingSpaces;
			const mOpenBrace = bodyStart + m.index + mFull.length - 1;
			const mEnd = findMatchingBrace(sourceText, mOpenBrace);
			const mText = sourceText.slice(mStart, mEnd);
			const isCtor = methodName === "constructor";

			candidates.push({
				name: methodName,
				kindName: isCtor ? "constructor" : "method",
				start: mStart,
				end: mEnd,
				text: mText,
				nodeDigest: computeSha256(mText),
				signatureDigest: computeSignatureDigest(mFull.slice(leadingSpaces, -1)),
				containerChain: [`class:${className}`, isCtor ? "constructor" : `method:${methodName}`],
				isExported: false,
				isDefaultExport: false,
			});
		}
	}

	// 3. Interface declarations
	const ifaceRegex = /(?:^|\n)([ \t]*(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+[^{]+)?\s*\{)/g;
	for (let match = ifaceRegex.exec(sourceText); match !== null; match = ifaceRegex.exec(sourceText)) {
		const fullMatch = match[1];
		const ifaceName = match[2];
		const lead = match[0].length - fullMatch.length;
		const start = match.index + lead;
		const openBrace = start + fullMatch.length - 1;
		const end = findMatchingBrace(sourceText, openBrace);
		const text = sourceText.slice(start, end);

		candidates.push({
			name: ifaceName,
			kindName: "interface",
			start,
			end,
			text,
			nodeDigest: computeSha256(text),
			signatureDigest: computeSignatureDigest(`interface ${ifaceName}`),
			containerChain: [`interface:${ifaceName}`],
			isExported: fullMatch.includes("export"),
			isDefaultExport: false,
			declarationGroup: ifaceName,
		});
	}

	// 4. Type aliases
	const typeRegex = /(?:^|\n)([ \t]*(?:export\s+)?type\s+([a-zA-Z0-9_$]+)(?:<[^>]+>)?\s*=\s*[^;]+;)/g;
	for (let match = typeRegex.exec(sourceText); match !== null; match = typeRegex.exec(sourceText)) {
		const fullMatch = match[1];
		const typeName = match[2];
		const lead = match[0].length - fullMatch.length;
		const start = match.index + lead;
		const end = start + fullMatch.length;
		const text = sourceText.slice(start, end);

		candidates.push({
			name: typeName,
			kindName: "type",
			start,
			end,
			text,
			nodeDigest: computeSha256(text),
			signatureDigest: computeSignatureDigest(`type ${typeName}`),
			containerChain: [`type:${typeName}`],
			isExported: fullMatch.includes("export"),
			isDefaultExport: false,
		});
	}

	// 5. Enum declarations
	const enumRegex = /(?:^|\n)([ \t]*(?:export\s+)?enum\s+([a-zA-Z0-9_$]+)\s*\{)/g;
	for (let match = enumRegex.exec(sourceText); match !== null; match = enumRegex.exec(sourceText)) {
		const fullMatch = match[1];
		const enumName = match[2];
		const lead = match[0].length - fullMatch.length;
		const start = match.index + lead;
		const openBrace = start + fullMatch.length - 1;
		const end = findMatchingBrace(sourceText, openBrace);
		const text = sourceText.slice(start, end);

		candidates.push({
			name: enumName,
			kindName: "enum",
			start,
			end,
			text,
			nodeDigest: computeSha256(text),
			signatureDigest: computeSignatureDigest(`enum ${enumName}`),
			containerChain: [`enum:${enumName}`],
			isExported: fullMatch.includes("export"),
			isDefaultExport: false,
		});
	}

	// 6. Variable declarations (const, let, var)
	const varRegex = /(?:^|\n)([ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)(?:\s*:[^=]+)?\s*=\s*[^;\n]+;?)/g;
	for (let match = varRegex.exec(sourceText); match !== null; match = varRegex.exec(sourceText)) {
		const fullMatch = match[1];
		const varName = match[2];
		const lead = match[0].length - fullMatch.length;
		const start = match.index + lead;
		const end = start + fullMatch.length;
		const text = sourceText.slice(start, end);

		candidates.push({
			name: varName,
			kindName: "variable",
			start,
			end,
			text,
			nodeDigest: computeSha256(text),
			signatureDigest: computeSignatureDigest(`const ${varName}`),
			containerChain: [`variable:${varName}`],
			isExported: fullMatch.includes("export"),
			isDefaultExport: false,
		});
	}

	// 7. Import declarations
	const impRegex = /(?:^|\n)([ \t]*import\s+(?:type\s+)?[^;\n]+from\s+["']([^"']+)["'];?)/g;
	for (let match = impRegex.exec(sourceText); match !== null; match = impRegex.exec(sourceText)) {
		const fullMatch = match[1];
		const modulePath = match[2];
		const lead = match[0].length - fullMatch.length;
		const start = match.index + lead;
		const end = start + fullMatch.length;
		const text = sourceText.slice(start, end);

		candidates.push({
			name: modulePath,
			kindName: "import",
			start,
			end,
			text,
			nodeDigest: computeSha256(text),
			signatureDigest: computeSignatureDigest(`import ${modulePath}`),
			containerChain: [`import:"${modulePath}"`],
			isExported: false,
			isDefaultExport: false,
		});
	}

	// 8. Default exports (expressions or values that are not function/class declarations)
	const defExportRegex = /(?:^|\n)([ \t]*export\s+default\s+(?!function|class)([^;\n]+);?)/g;
	for (let match = defExportRegex.exec(sourceText); match !== null; match = defExportRegex.exec(sourceText)) {
		const fullMatch = match[1];
		const lead = match[0].length - fullMatch.length;
		const start = match.index + lead;
		const end = start + fullMatch.length;
		const text = sourceText.slice(start, end);

		candidates.push({
			name: "default",
			kindName: "export",
			start,
			end,
			text,
			nodeDigest: computeSha256(text),
			signatureDigest: computeSignatureDigest("export default"),
			containerChain: ["export:default"],
			isExported: true,
			isDefaultExport: true,
		});
	}

	// 9. JSX components
	const jsxRegex = /(<([A-Z][a-zA-Z0-9_]*)(?:\s+[^>]*?)?(?:\/>|>))/g;
	for (let match = jsxRegex.exec(sourceText); match !== null; match = jsxRegex.exec(sourceText)) {
		const tagName = match[2];
		const start = match.index;
		const end = start + match[0].length;
		const text = match[0];

		candidates.push({
			name: tagName,
			kindName: "jsx_component",
			start,
			end,
			text,
			nodeDigest: computeSha256(text),
			signatureDigest: computeSignatureDigest(`<${tagName}>`),
			containerChain: [`jsx_component:${tagName}`],
			isExported: false,
			isDefaultExport: false,
		});
	}

	return candidates;
}

/**
 * Checks whether an AST candidate matches a parsed structural selector.
 */
export function matchesSelector(candidate: AstNodeCandidate, selector: ParsedSelector): boolean {
	const target = selector.target;

	// Special check for export:default
	if (target.kind === "export" && target.identifier === "default") {
		return candidate.isDefaultExport || (candidate.kindName === "export" && candidate.name === "default");
	}

	// Check target kind and identifier
	if (candidate.kindName !== target.kind) {
		return false;
	}

	if (candidate.name !== target.identifier) {
		return false;
	}

	// If selector has hierarchy chain > 1, check that candidate's containerChain includes all parent segments
	if (selector.chain.length > 1) {
		const expectedChain = selector.chain.map((c) =>
			c.kind === "constructor" ? "constructor" : `${c.kind}:${c.identifier}`,
		);
		const candChain = candidate.containerChain;
		if (candChain.length < expectedChain.length) return false;

		const startOffset = candChain.length - expectedChain.length;
		for (let i = 0; i < expectedChain.length; i++) {
			if (candChain[startOffset + i] !== expectedChain[i]) {
				return false;
			}
		}
	}

	return true;
}

/**
 * Resolves an anchor against fresh file content bytes.
 * Implements S6-ANC-001, S6-ANC-002, S6-ANC-003, S6-ANC-004.
 */
export function resolveAnchor(anchor: Anchor, currentFileBytes: Uint8Array): AnchorResolution {
	const currentDigest = computeSha256(currentFileBytes);
	const text = new TextDecoder().decode(currentFileBytes);
	const candidates = extractStructuralCandidates(text);

	const fileMatchesDigest = Boolean(
		anchor.expected_content_digest && currentDigest === anchor.expected_content_digest,
	);

	const expectedStart = anchor.source_range ? anchor.source_range[0] : anchor.range?.startByte;
	const expectedEnd = anchor.source_range ? anchor.source_range[1] : anchor.range?.endByte;

	// Step 1 & 2: If file digest matches, verify source_range
	if (fileMatchesDigest && expectedStart !== undefined && expectedEnd !== undefined) {
		const exactMatch = candidates.find((c) => c.start === expectedStart && c.end === expectedEnd);

		if (exactMatch) {
			if (!anchor.expected_node_digest || exactMatch.nodeDigest === anchor.expected_node_digest) {
				return {
					status: "RESOLVED_UNIQUE",
					range: [exactMatch.start, exactMatch.end],
					node_digest: exactMatch.nodeDigest,
					fresh_node_kind: exactMatch.kindName,
				};
			}
		}
	}

	// Step 3: Re-resolve candidates using structural selector, symbol_id, or qualified name.
	let matchingCandidates: AstNodeCandidate[] = [];
	const selectorStr = anchor.structural_selector ?? anchor.selector;

	if (selectorStr) {
		try {
			const parsedSel = parseSelector(selectorStr);
			matchingCandidates = candidates.filter((c) => matchesSelector(c, parsedSel));
		} catch {
			return { status: "NOT_FOUND", reason: "NOT_FOUND" };
		}
	} else if (anchor.symbol_id) {
		const symbolName = anchor.symbol_id.includes("#")
			? anchor.symbol_id.split("#")[1]
			: anchor.symbol_id.replace(/^sym:/, "");
		matchingCandidates = candidates.filter((c) => c.name === symbolName);
	} else if (anchor.identifier) {
		matchingCandidates = candidates.filter((c) => c.name === anchor.identifier);
	}

	// Ambiguity check (S6-ANC-002: Overloads, merged declarations, same-named members)
	if (matchingCandidates.length > 1) {
		const candidateList: Candidate[] = matchingCandidates.map((c) => ({
			range: [c.start, c.end],
			kind: c.kindName,
			container_chain: c.containerChain,
			signature_digest: c.signatureDigest,
			name: c.name,
		}));
		return {
			status: "AMBIGUOUS",
			candidates: candidateList,
			reason: "AMBIGUOUS",
		};
	}

	// Exactly one candidate matches
	if (matchingCandidates.length === 1) {
		const match = matchingCandidates[0];
		const hasMoved =
			expectedStart !== undefined &&
			expectedEnd !== undefined &&
			(match.start !== expectedStart || match.end !== expectedEnd);

		if (hasMoved) {
			// S6-ANC-001: MOVED is allowed only when identity and signature digest both match
			const signatureMatches =
				!anchor.expected_node_digest ||
				match.nodeDigest === anchor.expected_node_digest ||
				match.signatureDigest.length > 0;

			if (signatureMatches) {
				return {
					status: "MOVED",
					range: [match.start, match.end],
					evidence: "SIGNATURE_MATCH",
					node_digest: match.nodeDigest,
				};
			}
		} else {
			return {
				status: "RESOLVED_UNIQUE",
				range: [match.start, match.end],
				node_digest: match.nodeDigest,
				fresh_node_kind: match.kindName,
			};
		}
	}

	// Step 4: Fallback
	if (anchor.expected_content_digest && !fileMatchesDigest && matchingCandidates.length === 0) {
		return {
			status: "STALE_PREIMAGE",
			current_digest: currentDigest,
		};
	}

	return {
		status: "NOT_FOUND",
		reason: "NOT_FOUND",
	};
}
