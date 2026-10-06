// Sūkṣmaśastra Rename Transformation (Part E2, S6-TX-001..003)
// Handles identifier renaming across declarations, call sites, JSX tags,
// shorthand properties ({ a } -> { a: b }), export aliases, default exports,
// and type-only imports. Leaves string/comment mentions unrenamed but lists them for review.

import type { ByteRangeEdit } from "../model/diff.ts";

export interface MentionUnmodified {
	readonly line: number;
	readonly column: number;
	readonly snippet: string;
	readonly kind: "string" | "comment";
}

export interface RenameResult {
	readonly edits: ByteRangeEdit[];
	readonly mentions_unmodified: MentionUnmodified[];
	readonly affectedNodes: string[];
	readonly deliberatelyUnchangedNodes: string[];
}

export interface RenameOptions {
	readonly scopeStart?: number;
	readonly scopeEnd?: number;
	readonly targetFile?: string;
	readonly isExported?: boolean;
	readonly isDefaultExport?: boolean;
}

interface Span {
	readonly start: number;
	readonly end: number;
	readonly kind: "string" | "comment";
}

/**
 * Extracts all string literal and comment byte ranges from source code.
 */
function findStringsAndComments(source: string): Span[] {
	const spans: Span[] = [];
	let i = 0;
	const len = source.length;

	while (i < len) {
		const c = source[i];
		const next = i + 1 < len ? source[i + 1] : "";

		// Single-line comment
		if (c === "/" && next === "/") {
			const start = i;
			let end = source.indexOf("\n", start);
			if (end === -1) end = len;
			spans.push({ start, end, kind: "comment" });
			i = end;
			continue;
		}

		// Multi-line comment
		if (c === "/" && next === "*") {
			const start = i;
			let end = source.indexOf("*/", start + 2);
			if (end === -1) end = len;
			else end += 2;
			spans.push({ start, end, kind: "comment" });
			i = end;
			continue;
		}

		// String literals: '...', "...", `...`
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			const start = i;
			i++;
			while (i < len) {
				if (source[i] === "\\") {
					i += 2; // skip escaped character
					continue;
				}
				if (source[i] === quote) {
					i++;
					break;
				}
				i++;
			}
			spans.push({ start, end: i, kind: "string" });
			continue;
		}

		i++;
	}

	return spans;
}

/**
 * Computes line and column (1-indexed) for an offset.
 */
function getLineCol(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset && i < source.length; i++) {
		if (source[i] === "\n") {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return { line, column: col };
}

/**
 * Checks if an offset falls inside any of the provided spans.
 */
function findContainingSpan(offset: number, spans: readonly Span[]): Span | undefined {
	for (const span of spans) {
		if (offset >= span.start && offset < span.end) {
			return span;
		}
	}
	return undefined;
}

/**
 * Performs structural identifier rename on source text.
 */
export function renameIdentifier(
	source: string,
	oldName: string,
	newName: string,
	options: RenameOptions = {},
): RenameResult {
	if (oldName === newName) {
		return {
			edits: [],
			mentions_unmodified: [],
			affectedNodes: [],
			deliberatelyUnchangedNodes: [],
		};
	}

	const spans = findStringsAndComments(source);
	const edits: ByteRangeEdit[] = [];
	const mentions_unmodified: MentionUnmodified[] = [];
	const affectedNodes: string[] = [];
	const deliberatelyUnchangedNodes: string[] = [];

	const scopeStart = options.scopeStart ?? 0;
	const scopeEnd = options.scopeEnd ?? source.length;

	// Regex to find word boundaries for oldName
	const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const wordRegex = new RegExp(`\\b${escaped}\\b`, "g");

	for (let match = wordRegex.exec(source); match !== null; match = wordRegex.exec(source)) {
		const offset = match.index;
		const endOffset = offset + oldName.length;

		// 1. Check if match is inside a comment or string
		const span = findContainingSpan(offset, spans);
		if (span) {
			const pos = getLineCol(source, offset);
			const lineStart = source.lastIndexOf("\n", offset);
			const lineEnd = source.indexOf("\n", offset);
			const rawSnippet = source
				.slice(lineStart === -1 ? 0 : lineStart + 1, lineEnd === -1 ? source.length : lineEnd)
				.trim();
			const snippet = rawSnippet.length > 100 ? `${rawSnippet.slice(0, 97)}...` : rawSnippet;

			mentions_unmodified.push({
				line: pos.line,
				column: pos.column,
				snippet,
				kind: span.kind,
			});
			continue;
		}

		// 2. Check if outside specified scope
		if (offset < scopeStart || endOffset > scopeEnd) {
			deliberatelyUnchangedNodes.push(`offset:${offset}-${endOffset}`);
			continue;
		}

		// 3. Inspect syntactic context around the match

		// Look behind around offset
		const prevChar = offset > 0 ? source[offset - 1] : "";

		// JSX closing tag: </oldName>
		if (offset >= 2 && source.slice(offset - 2, offset) === "</") {
			edits.push({
				start: offset,
				end: endOffset,
				newText: newName,
				description: `JSX closing tag: </${oldName}> -> </${newName}>`,
			});
			affectedNodes.push(`jsx_closing:${offset}`);
			continue;
		}

		// JSX opening or self-closing tag: <oldName or <oldName ... />
		if (prevChar === "<") {
			edits.push({
				start: offset,
				end: endOffset,
				newText: newName,
				description: `JSX tag: <${oldName} -> <${newName}`,
			});
			affectedNodes.push(`jsx_tag:${offset}`);
			continue;
		}

		// Object literal shorthand property check: { a } or { a, ... } or { ..., a }
		// Look behind for '{' or ',' with optional whitespace, and ahead for '}' or ','
		const textBefore = source.slice(Math.max(0, offset - 20), offset);
		const textAfter = source.slice(endOffset, Math.min(source.length, endOffset + 20));

		const isPrecededByBraceOrComma = /[{,]\s*$/.test(textBefore);
		const isFollowedByBraceOrComma = /^\s*[,}]/.test(textAfter);
		const isFollowedByColon = /^\s*:/.test(textAfter);

		// If it's a shorthand object property: { oldName } -> expand to { oldName: newName }
		if (isPrecededByBraceOrComma && isFollowedByBraceOrComma && !isFollowedByColon) {
			// Check if this is within an import or export clause or object literal
			const lineStartIdx = source.lastIndexOf("\n", offset);
			const linePrefix = source.slice(lineStartIdx === -1 ? 0 : lineStartIdx + 1, offset);

			if (linePrefix.includes("import ") || linePrefix.includes("import{")) {
				// In named import: import { oldName } from '...'
				// Rewrite to: import { newName as oldName } or import { oldName as newName }
				edits.push({
					start: offset,
					end: endOffset,
					newText: `${oldName} as ${newName}`,
					description: `Import alias: ${oldName} as ${newName}`,
				});
				affectedNodes.push(`import_specifier:${offset}`);
				continue;
			}

			if (linePrefix.includes("export ") || linePrefix.includes("export{")) {
				// In export clause: export { oldName } -> export { newName as oldName } or export { oldName as newName }
				edits.push({
					start: offset,
					end: endOffset,
					newText: `${newName} as ${oldName}`,
					description: `Export alias: ${newName} as ${oldName}`,
				});
				affectedNodes.push(`export_specifier:${offset}`);
				continue;
			}

			// In object literal shorthand: { a } -> { a: b }
			edits.push({
				start: offset,
				end: endOffset,
				newText: `${oldName}: ${newName}`,
				description: `Expanded shorthand property: ${oldName}: ${newName}`,
			});
			affectedNodes.push(`shorthand_prop:${offset}`);
			continue;
		}

		// Default export check: export default function oldName(...)
		const precedingSnippet = source.slice(Math.max(0, offset - 40), offset);
		if (/export\s+default\s+function\s*$/.test(precedingSnippet)) {
			edits.push({
				start: offset,
				end: endOffset,
				newText: newName,
				description: `Default export function: ${oldName} -> ${newName}`,
			});
			affectedNodes.push(`default_export:${offset}`);
			continue;
		}

		// Standard identifier rename
		edits.push({
			start: offset,
			end: endOffset,
			newText: newName,
			description: `Rename identifier ${oldName} -> ${newName}`,
		});
		affectedNodes.push(`ident:${offset}`);
	}

	return {
		edits,
		mentions_unmodified,
		affectedNodes,
		deliberatelyUnchangedNodes,
	};
}
