// Jālacitra Pure TypeScript/JavaScript Syntactic Extractor (Part I4, I5, J5-TS-001, J5-TSE-001..016)

import type { BlindSpotCode } from "../../model/reason-codes.ts";
import type {
	BoundedDiagnostic,
	ExtractResult,
	FileInfo,
	RawConfigKey,
	RawDeclaration,
	RawRange,
	RawReference,
} from "../adapter.ts";
import {
	classifyEnvVariableExposure,
	detectDeclarationMerging,
	enhanceReactDeclarations,
	extractFrameworkRoutes,
} from "./ecosystem.ts";
import { computeSignatureDigest } from "./signature.ts";

export function walkTypeScriptAst(file: FileInfo, bytes: Uint8Array): ExtractResult {
	const sourceText = new TextDecoder().decode(bytes);

	let declarations: RawDeclaration[] = [];
	const references: RawReference[] = [];
	const configKeys: RawConfigKey[] = [];
	const blindSpots: Record<string, number> = {};
	const diagnostics: BoundedDiagnostic[] = [];

	function addBlindSpot(code: BlindSpotCode, count = 1) {
		blindSpots[code] = (blindSpots[code] ?? 0) + count;
	}

	// Line start offset mapping for byte -> (line, col)
	const lineStarts: number[] = [0];
	for (let i = 0; i < sourceText.length; i++) {
		if (sourceText[i] === "\n") {
			lineStarts.push(i + 1);
		}
	}

	function getLineAndCol(offset: number): { line: number; col: number } {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (lineStarts[mid] <= offset) {
				if (mid === lineStarts.length - 1 || lineStarts[mid + 1] > offset) {
					return { line: mid + 1, col: offset - lineStarts[mid] + 1 };
				}
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		return { line: 1, col: offset + 1 };
	}

	function makeRange(startByte: number, endByte: number): RawRange {
		const startPos = getLineAndCol(startByte);
		const endPos = getLineAndCol(endByte);
		return {
			startByte,
			endByte,
			startLine: startPos.line,
			endLine: endPos.line,
			startColumn: startPos.col,
			endColumn: endPos.col,
			contentDigest: file.contentDigest,
		};
	}

	// 1. Process environment variables
	const envRegex =
		/(?:process\.env|import\.meta\.env)(?:\.([a-zA-Z_][a-zA-Z0-9_]*)|\[["']([a-zA-Z_][a-zA-Z0-9_]*)["']\]|\[([^\]]+)\])/g;
	for (let envMatch = envRegex.exec(sourceText); envMatch !== null; envMatch = envRegex.exec(sourceText)) {
		const keyName = envMatch[1] || envMatch[2];
		const computedKey = envMatch[3];
		const start = envMatch.index;
		const end = start + envMatch[0].length;
		const range = makeRange(start, end);

		if (keyName) {
			const exposure = classifyEnvVariableExposure(keyName);
			configKeys.push({
				name: keyName,
				scope: "env_var",
				range,
			});
			references.push({
				referenceKind: "reads_config",
				rawText: envMatch[0],
				targetSpecifier: keyName,
				range,
				attrs: exposure,
			});
		} else if (computedKey) {
			addBlindSpot("STRING_BASED_REFERENCE");
		}
	}

	// 2. Process imports
	// Static import: import ... from "..." or import "..."
	const importRegex =
		/import\s+(?:type\s+)?(?:(?:([a-zA-Z0-9_$]+)|\*\s+as\s+([a-zA-Z0-9_$]+)|(?:\{[^}]*\}))(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[a-zA-Z0-9_$]+))?\s+from\s+)?["']([^"']+)["']/g;
	for (let impMatch = importRegex.exec(sourceText); impMatch !== null; impMatch = importRegex.exec(sourceText)) {
		const specifier = impMatch[3] || impMatch[0].match(/["']([^"']+)["']/)?.[1] || "";
		const start = impMatch.index;
		const end = start + impMatch[0].length;
		const isTypeOnly = impMatch[0].includes("import type");

		if (specifier.endsWith(".node") || specifier.endsWith(".wasm")) {
			addBlindSpot("CROSS_LANGUAGE_BOUNDARY");
		}

		references.push({
			referenceKind: "imports",
			rawText: impMatch[0],
			targetSpecifier: specifier,
			range: makeRange(start, end),
			attrs: { type_only: isTypeOnly },
		});
	}

	// Re-exports: export ... from "..."
	const reexportRegex = /export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
	for (
		let reexpMatch = reexportRegex.exec(sourceText);
		reexpMatch !== null;
		reexpMatch = reexportRegex.exec(sourceText)
	) {
		const specifier = reexpMatch[1];
		const start = reexpMatch.index;
		const end = start + reexpMatch[0].length;
		references.push({
			referenceKind: "imports",
			rawText: reexpMatch[0],
			targetSpecifier: specifier,
			range: makeRange(start, end),
			attrs: { is_reexport: true },
		});
	}

	// Dynamic import: import("...")
	const dynImportRegex = /import\s*\(\s*(?:["']([^"']+)["']|([^)]+))\s*\)/g;
	for (let dynMatch = dynImportRegex.exec(sourceText); dynMatch !== null; dynMatch = dynImportRegex.exec(sourceText)) {
		const specifier = dynMatch[1];
		const start = dynMatch.index;
		const end = start + dynMatch[0].length;
		if (specifier) {
			references.push({
				referenceKind: "imports",
				rawText: dynMatch[0],
				targetSpecifier: specifier,
				range: makeRange(start, end),
				attrs: { dynamic: true },
			});
		} else {
			addBlindSpot("DYNAMIC_IMPORT");
		}
	}

	// require("...")
	const reqRegex = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (let reqMatch = reqRegex.exec(sourceText); reqMatch !== null; reqMatch = reqRegex.exec(sourceText)) {
		const specifier = reqMatch[1];
		const start = reqMatch.index;
		const end = start + reqMatch[0].length;
		references.push({
			referenceKind: "imports",
			rawText: reqMatch[0],
			targetSpecifier: specifier,
			range: makeRange(start, end),
			attrs: { require: true },
		});
	}

	// 3. Declarations

	// Function declarations: [export] [default] [async] function name(...)
	const fnRegex = /(?:(export\s+(?:default\s+)?))?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*([<(][^{]*)\{/g;
	for (let fnMatch = fnRegex.exec(sourceText); fnMatch !== null; fnMatch = fnRegex.exec(sourceText)) {
		const isExported = Boolean(fnMatch[1]);
		const name = fnMatch[2];
		const head = fnMatch[0].slice(0, -1);
		const start = fnMatch.index;
		const end = start + fnMatch[0].length;

		// Find matching closing brace for function body
		let braceDepth = 1;
		let bodyIdx = end;
		while (braceDepth > 0 && bodyIdx < sourceText.length) {
			if (sourceText[bodyIdx] === "{") braceDepth++;
			else if (sourceText[bodyIdx] === "}") braceDepth--;
			bodyIdx++;
		}
		const fullEnd = bodyIdx;

		declarations.push({
			name,
			qualifiedName: name,
			kind: "function",
			visibility: "public",
			exported: isExported,
			range: makeRange(start, fullEnd),
			signatureDigest: computeSignatureDigest(head),
		});
	}

	// Class declarations: [export] [default] class Name [extends Base] [implements Iface] {
	const classRegex =
		/(?:(export\s+(?:default\s+)?))?class\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+([a-zA-Z0-9_$.]+))?(?:\s+implements\s+([^{]+))?\s*\{/g;
	for (let clsMatch = classRegex.exec(sourceText); clsMatch !== null; clsMatch = classRegex.exec(sourceText)) {
		const isExported = Boolean(clsMatch[1]);
		const className = clsMatch[2];
		const extendsName = clsMatch[3];
		const implementsList = clsMatch[4];
		const head = clsMatch[0].slice(0, -1);
		const start = clsMatch.index;
		const end = start + clsMatch[0].length;

		declarations.push({
			name: className,
			qualifiedName: className,
			kind: "class",
			visibility: "public",
			exported: isExported,
			range: makeRange(start, end),
			signatureDigest: computeSignatureDigest(head),
		});

		if (extendsName) {
			references.push({
				referenceKind: "extends",
				rawText: extendsName,
				targetSpecifier: extendsName,
				range: makeRange(start, start + clsMatch[0].indexOf("{")),
			});
		}

		if (implementsList) {
			const ifaces = implementsList.split(",").map((s) => s.trim());
			for (const iface of ifaces) {
				references.push({
					referenceKind: "references",
					rawText: iface,
					targetSpecifier: iface,
					range: makeRange(start, start + clsMatch[0].indexOf("{")),
				});
			}
		}

		// Find class methods and constructor
		// Find matching closing brace for class
		const classBodyStart = end - 1;
		let depth = 1;
		let classBodyEnd = classBodyStart + 1;
		while (depth > 0 && classBodyEnd < sourceText.length) {
			if (sourceText[classBodyEnd] === "{") depth++;
			else if (sourceText[classBodyEnd] === "}") depth--;
			classBodyEnd++;
		}
		const classBody = sourceText.slice(classBodyStart, classBodyEnd);

		// Constructor and parameter properties
		const ctorMatch = /constructor\s*\(([^)]*)\)\s*\{/.exec(classBody);
		if (ctorMatch) {
			const ctorStart = start + ctorMatch.index;
			const ctorEnd = ctorStart + ctorMatch[0].length;
			declarations.push({
				name: "constructor",
				qualifiedName: `${className}.constructor`,
				kind: "method",
				visibility: "public",
				exported: false,
				range: makeRange(ctorStart, ctorEnd),
				signatureDigest: computeSignatureDigest(ctorMatch[0].slice(0, -1)),
			});

			const paramStr = ctorMatch[1];
			const paramRegex = /(private|protected|public|readonly)\s+(?:readonly\s+)?([a-zA-Z0-9_$]+)/g;
			for (let pMatch = paramRegex.exec(paramStr); pMatch !== null; pMatch = paramRegex.exec(paramStr)) {
				const vis = pMatch[1] === "private" || pMatch[1] === "protected" ? pMatch[1] : "public";
				const propName = pMatch[2];
				declarations.push({
					name: propName,
					qualifiedName: `${className}.${propName}`,
					kind: "property",
					visibility: vis,
					exported: false,
					range: makeRange(ctorStart, ctorEnd),
					signatureDigest: computeSignatureDigest(`prop ${propName}`),
				});
			}
		}

		// Class methods
		const methodRegex =
			/(?:(public|private|protected)\s+)?(?:async\s+)?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g;
		for (let mMatch = methodRegex.exec(classBody); mMatch !== null; mMatch = methodRegex.exec(classBody)) {
			const mName = mMatch[2];
			if (mName === "constructor" || mName === "if" || mName === "for" || mName === "switch" || mName === "while") {
				continue;
			}
			const vis = mMatch[1] === "private" || mMatch[1] === "protected" ? mMatch[1] : "public";
			const mStart = start + mMatch.index;
			const mEnd = mStart + mMatch[0].length;
			declarations.push({
				name: mName,
				qualifiedName: `${className}.${mName}`,
				kind: "method",
				visibility: vis,
				exported: false,
				range: makeRange(mStart, mEnd),
				signatureDigest: computeSignatureDigest(mMatch[0].slice(0, -1)),
			});
		}
	}

	// Interfaces: [export] interface Name [extends ...] {
	const ifaceRegex = /(?:(export\s+))?interface\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+([^{]+))?\s*\{/g;
	for (let ifaceMatch = ifaceRegex.exec(sourceText); ifaceMatch !== null; ifaceMatch = ifaceRegex.exec(sourceText)) {
		const isExported = Boolean(ifaceMatch[1]);
		const ifaceName = ifaceMatch[2];
		const extendsList = ifaceMatch[3];
		const head = ifaceMatch[0].slice(0, -1);
		const start = ifaceMatch.index;
		const end = start + ifaceMatch[0].length;

		declarations.push({
			name: ifaceName,
			qualifiedName: ifaceName,
			kind: "interface",
			visibility: "public",
			exported: isExported,
			range: makeRange(start, end),
			signatureDigest: computeSignatureDigest(head),
		});

		if (extendsList) {
			const ifaces = extendsList.split(",").map((s) => s.trim());
			for (const iface of ifaces) {
				references.push({
					referenceKind: "extends",
					rawText: iface,
					targetSpecifier: iface,
					range: makeRange(start, end),
				});
			}
		}
	}

	// Type aliases: [export] type Name = ...
	const typeRegex = /(?:(export\s+))?type\s+([a-zA-Z0-9_$]+)\s*(?:<[^>]+>)?\s*=\s*([^;]+);/g;
	for (let typeMatch = typeRegex.exec(sourceText); typeMatch !== null; typeMatch = typeRegex.exec(sourceText)) {
		const isExported = Boolean(typeMatch[1]);
		const typeName = typeMatch[2];
		const start = typeMatch.index;
		const end = start + typeMatch[0].length;
		declarations.push({
			name: typeName,
			qualifiedName: typeName,
			kind: "type_alias",
			visibility: "public",
			exported: isExported,
			range: makeRange(start, end),
			signatureDigest: computeSignatureDigest(`type ${typeName}`),
		});
	}

	// Enums: [export] enum Name { ... }
	const enumRegex = /(?:(export\s+))?enum\s+([a-zA-Z0-9_$]+)\s*\{([^}]*)\}/g;
	for (let enumMatch = enumRegex.exec(sourceText); enumMatch !== null; enumMatch = enumRegex.exec(sourceText)) {
		const isExported = Boolean(enumMatch[1]);
		const enumName = enumMatch[2];
		const membersStr = enumMatch[3];
		const start = enumMatch.index;
		const end = start + enumMatch[0].length;

		declarations.push({
			name: enumName,
			qualifiedName: enumName,
			kind: "enum",
			visibility: "public",
			exported: isExported,
			range: makeRange(start, end),
			signatureDigest: computeSignatureDigest(`enum ${enumName}`),
		});

		const members = membersStr
			.split(",")
			.map((s) => s.trim().split("=")[0].trim())
			.filter(Boolean);
		for (const mem of members) {
			declarations.push({
				name: mem,
				qualifiedName: `${enumName}.${mem}`,
				kind: "enum_member",
				visibility: "public",
				exported: isExported,
				range: makeRange(start, end),
				signatureDigest: computeSignatureDigest(`${enumName}.${mem}`),
			});
		}
	}

	// Top-level const / let / var bindings (including arrow functions)
	const varRegex =
		/(?:(export\s+))?(const|let|var)\s+([a-zA-Z0-9_$]+)(?:\s*:\s*[^=]+)?\s*=\s*(?:(async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>|function)/g;
	for (let varMatch = varRegex.exec(sourceText); varMatch !== null; varMatch = varRegex.exec(sourceText)) {
		const isExported = Boolean(varMatch[1]);
		const varName = varMatch[3];
		const start = varMatch.index;
		const end = start + varMatch[0].length;

		declarations.push({
			name: varName,
			qualifiedName: varName,
			kind: "function", // arrow function assigned to variable
			visibility: "public",
			exported: isExported,
			range: makeRange(start, end),
			signatureDigest: computeSignatureDigest(varMatch[0]),
		});
	}

	// 4. Calls: callee(...) and new Cls(...)
	const callRegex = /(?:new\s+([a-zA-Z0-9_$.]+)|([a-zA-Z0-9_$.]+))\s*\(/g;
	for (let callMatch = callRegex.exec(sourceText); callMatch !== null; callMatch = callRegex.exec(sourceText)) {
		const isNew = Boolean(callMatch[1]);
		const callee = callMatch[1] || callMatch[2];
		const start = callMatch.index;

		// Skip keywords that look like function calls
		if (
			callee === "if" ||
			callee === "for" ||
			callee === "while" ||
			callee === "switch" ||
			callee === "catch" ||
			callee === "import" ||
			callee === "require" ||
			callee === "function" ||
			callee === "return" ||
			callee === "typeof"
		) {
			continue;
		}

		// Skip declarations that look like calls (e.g. function start())
		const precedingText = sourceText.slice(Math.max(0, start - 15), start);
		if (/\b(?:function|class|interface|type)\s*$/.test(precedingText)) {
			continue;
		}

		if (callee === "eval" || (isNew && callee === "Function")) {
			addBlindSpot("EVAL_OR_EXEC");
			continue;
		}

		// Find matching closing parenthesis
		let parenDepth = 1;
		let idx = start + callMatch[0].length;
		while (parenDepth > 0 && idx < sourceText.length) {
			if (sourceText[idx] === "(") parenDepth++;
			else if (sourceText[idx] === ")") parenDepth--;
			idx++;
		}
		const end = idx;
		const rawText = sourceText.slice(start, end);
		const innerArgs = sourceText.slice(start + callMatch[0].length, Math.max(start + callMatch[0].length, end - 1));
		const argCount = innerArgs.trim() ? innerArgs.split(",").length : 0;
		const shape = isNew ? "new" : callee.includes(".") ? "member_chain" : "identifier";

		references.push({
			referenceKind: "calls",
			calleeShape: shape,
			rawText,
			targetSpecifier: callee,
			range: makeRange(start, end),
			attrs: { argument_count: argCount },
		});
	}

	// 5. Dynamic property dispatch checks: obj[computed]()
	const dynamicAccessRegex = /(?:[a-zA-Z0-9_$)\]])\s*\[\s*([^"'\]\d]+)\s*\]\s*\(/g;
	if (dynamicAccessRegex.test(sourceText)) {
		addBlindSpot("STRING_BASED_REFERENCE");
		addBlindSpot("DYNAMIC_DISPATCH");
	}

	// 6. Ecosystem Enhancements: React components and hooks
	const reactRes = enhanceReactDeclarations(declarations, sourceText);
	declarations = reactRes.declarations;
	for (const [k, v] of Object.entries(reactRes.blindSpots)) {
		blindSpots[k] = (blindSpots[k] ?? 0) + v;
	}

	// 7. Declaration Merging
	const mergeRes = detectDeclarationMerging(declarations);
	declarations = mergeRes.declarations;
	for (const [k, v] of Object.entries(mergeRes.blindSpots)) {
		blindSpots[k] = (blindSpots[k] ?? 0) + v;
	}

	// 8. Framework Routes
	const routeRes = extractFrameworkRoutes(file, sourceText);
	for (const [k, v] of Object.entries(routeRes.blindSpots)) {
		blindSpots[k] = (blindSpots[k] ?? 0) + v;
	}

	return {
		status: "OK",
		declarations,
		references,
		configKeys,
		testCases: [],
		contracts: routeRes.routes,
		blindSpots,
		diagnostics,
	};
}
