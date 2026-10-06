// Sūkṣmaśastra Change-Signature Transformation (Part E2, S6-TX-001..003)
// Changes function/method parameter signatures and updates call sites.
// Flags dynamic dispatch and spread arguments with MANUAL_REVIEW_REQUIRED.

import type { Anchor } from "../model/anchors.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";

export interface ParamAddition {
	readonly name: string;
	readonly type?: string;
	readonly defaultValue?: string;
	readonly position?: number;
}

export interface SignatureChangeSpec {
	readonly add?: readonly ParamAddition[];
	readonly remove?: readonly string[];
	readonly reorder?: readonly number[]; // e.g. [1, 0] means new order is old index 1, old index 0
	readonly rename?: Readonly<Record<string, string>>;
}

export interface CallSiteReference {
	readonly rawText: string;
	readonly startByte: number;
	readonly endByte: number;
}

export interface ChangeSignatureResult {
	readonly edits: ByteRangeEdit[];
	readonly flags: Array<{
		readonly code: "MANUAL_REVIEW_REQUIRED";
		readonly message: string;
		readonly location: string;
	}>;
	readonly affectedNodes: string[];
}

interface ParsedParam {
	readonly raw: string;
	readonly name: string;
}

/**
 * Splits parameter list respecting nested brackets/generics.
 */
function splitParamList(paramStr: string): string[] {
	const result: string[] = [];
	let depth = 0;
	let current = "";

	for (let i = 0; i < paramStr.length; i++) {
		const c = paramStr[i];
		if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
		else if (c === ")" || c === "}" || c === "]" || c === ">") depth--;

		if (c === "," && depth === 0) {
			result.push(current.trim());
			current = "";
		} else {
			current += c;
		}
	}
	if (current.trim()) {
		result.push(current.trim());
	}
	return result;
}

/**
 * Extracts parameter name from a parameter declaration (e.g., "readonly x: number = 0" -> "x").
 */
function extractParamName(raw: string): string {
	const cleaned = raw.replace(/^(public|private|protected|readonly)\s+/, "").trim();
	const match = /^([a-zA-Z0-9_$]+)/.exec(cleaned);
	return match ? match[1] : cleaned;
}

/**
 * Transforms function/method parameter signatures and updates call sites.
 */
export function changeSignature(
	source: string,
	anchor: Anchor,
	spec: SignatureChangeSpec,
	callSites: readonly CallSiteReference[] = [],
): ChangeSignatureResult {
	if (!anchor.range) {
		throw new SukshmashastraError(
			"NOT_FOUND",
			`Anchor '${anchor.id}' has no resolved byte range for change_signature`,
		);
	}

	const nodeText = source.slice(anchor.range.startByte, anchor.range.endByte);
	const openParenRel = nodeText.indexOf("(");
	if (openParenRel === -1) {
		throw new SukshmashastraError("NOT_FOUND", `Anchor '${anchor.id}' has no parameter list '('`);
	}

	// Find matching closing paren
	let parenDepth = 1;
	let idx = openParenRel + 1;
	while (parenDepth > 0 && idx < nodeText.length) {
		if (nodeText[idx] === "(") parenDepth++;
		else if (nodeText[idx] === ")") parenDepth--;
		idx++;
	}
	const closeParenRel = idx - 1;

	const rawParams = nodeText.slice(openParenRel + 1, closeParenRel);
	const paramTokens = splitParamList(rawParams);

	let params: ParsedParam[] = paramTokens.map((p) => ({
		raw: p,
		name: extractParamName(p),
	}));

	// 1. Rename parameters
	if (spec.rename) {
		params = params.map((p) => {
			const newName = spec.rename![p.name];
			if (newName) {
				const replaced = p.raw.replace(new RegExp(`\\b${p.name}\\b`), newName);
				return { raw: replaced, name: newName };
			}
			return p;
		});
	}

	// 2. Remove parameters
	if (spec.remove && spec.remove.length > 0) {
		params = params.filter((p) => !spec.remove!.includes(p.name));
	}

	// 3. Reorder parameters
	if (spec.reorder && spec.reorder.length > 0) {
		const reordered: ParsedParam[] = [];
		for (const newIdx of spec.reorder) {
			if (newIdx >= 0 && newIdx < params.length) {
				reordered.push(params[newIdx]);
			}
		}
		params = reordered;
	}

	// 4. Add parameters
	if (spec.add && spec.add.length > 0) {
		for (const addition of spec.add) {
			let paramStr = addition.name;
			if (addition.type) paramStr += `: ${addition.type}`;
			if (addition.defaultValue) paramStr += ` = ${addition.defaultValue}`;

			const pos = addition.position ?? params.length;
			params.splice(pos, 0, { raw: paramStr, name: addition.name });
		}
	}

	const newParamText = params.map((p) => p.raw).join(", ");
	const edits: ByteRangeEdit[] = [
		{
			start: anchor.range.startByte + openParenRel + 1,
			end: anchor.range.startByte + closeParenRel,
			newText: newParamText,
			description: `Change parameter signature of ${anchor.selector}`,
		},
	];

	// 5. Update call sites
	const flags: Array<{ code: "MANUAL_REVIEW_REQUIRED"; message: string; location: string }> = [];

	for (const callSite of callSites) {
		// Check for dynamic dispatch, spread arguments, or apply/call
		if (
			callSite.rawText.includes("...") ||
			callSite.rawText.includes(".apply(") ||
			callSite.rawText.includes(".call(") ||
			/\[[^\]]+\]\s*\(/.test(callSite.rawText)
		) {
			flags.push({
				code: "MANUAL_REVIEW_REQUIRED",
				message: `Call site has dynamic dispatch or spread arguments: '${callSite.rawText.trim()}'`,
				location: `bytes:${callSite.startByte}-${callSite.endByte}`,
			});
			continue;
		}

		// Find call site parameter arguments
		const callParenStart = callSite.rawText.indexOf("(");
		const callParenEnd = callSite.rawText.lastIndexOf(")");
		if (callParenStart !== -1 && callParenEnd !== -1 && callParenEnd > callParenStart) {
			const innerArgs = callSite.rawText.slice(callParenStart + 1, callParenEnd);
			let argList = splitParamList(innerArgs);

			// If reordered
			if (spec.reorder && spec.reorder.length > 0 && argList.length >= spec.reorder.length) {
				const reorderedArgs: string[] = [];
				for (const oIdx of spec.reorder) {
					if (oIdx < argList.length) reorderedArgs.push(argList[oIdx]);
				}
				argList = reorderedArgs;
			}

			// If added with default value
			if (spec.add) {
				for (const addition of spec.add) {
					if (addition.defaultValue) {
						argList.push(addition.defaultValue);
					}
				}
			}

			edits.push({
				start: callSite.startByte + callParenStart + 1,
				end: callSite.startByte + callParenEnd,
				newText: argList.join(", "),
				description: `Update call site arguments`,
			});
		}
	}

	return {
		edits,
		flags,
		affectedNodes: [anchor.anchor_id ?? anchor.id ?? ""],
	};
}
