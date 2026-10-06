// Sūkṣmaśastra Selector Grammar (Part D, S6-ANC-003)
// A deterministic, unambiguous selector grammar for targeting structural AST elements.
// Examples:
//   "function:verifySession"
//   "class:Auth > method:login"
//   "class:Auth > constructor"
//   "class:Auth > property:token"
//   "interface:Session > property:expiresAt"
//   "type:UserId"
//   "enum:Status > member:ACTIVE"
//   "jsx_component:LoginForm"
//   "import:\"./a\""
//   "export:default"
//   "export:named:verifySession"
//   "variable:MAX_RETRIES"

export interface SelectorSegment {
	readonly kind:
		| "function"
		| "class"
		| "method"
		| "constructor"
		| "property"
		| "interface"
		| "type"
		| "enum"
		| "member"
		| "jsx_component"
		| "import"
		| "export"
		| "variable";
	readonly identifier: string;
}

export interface ParsedSelector {
	readonly raw: string;
	readonly chain: SelectorSegment[];
	readonly target: SelectorSegment;
}

const VALID_KINDS = new Set<string>([
	"function",
	"class",
	"method",
	"constructor",
	"property",
	"interface",
	"type",
	"enum",
	"member",
	"jsx_component",
	"import",
	"export",
	"variable",
]);

/**
 * Parses a structural selector string into a structured representation.
 * Throws an Error if the grammar is invalid or unsupported.
 */
export function parseSelector(rawSelector: string): ParsedSelector {
	const trimmed = rawSelector.trim();
	if (!trimmed) {
		throw new Error("Empty structural selector");
	}

	// Split by '>' hierarchy separator
	const parts = trimmed.split(">").map((p) => p.trim());
	const segments: SelectorSegment[] = [];

	for (const part of parts) {
		if (!part) {
			throw new Error(`Invalid empty selector segment in '${rawSelector}'`);
		}

		// Find the first ':'
		const colonIdx = part.indexOf(":");
		if (colonIdx === -1) {
			// Special case: constructor without identifier
			if (part === "constructor") {
				segments.push({ kind: "constructor", identifier: "constructor" });
				continue;
			}
			throw new Error(`Malformed selector segment '${part}' in '${rawSelector}': expected 'kind:identifier'`);
		}

		const kind = part.slice(0, colonIdx).trim().toLowerCase();
		let identifier = part.slice(colonIdx + 1).trim();

		if (!VALID_KINDS.has(kind)) {
			throw new Error(
				`Unsupported selector kind '${kind}' in '${rawSelector}'. Valid kinds: ${Array.from(VALID_KINDS).join(", ")}`,
			);
		}

		// Handle quoted import specifiers e.g. import:"./a" or import:'./a'
		if (
			(identifier.startsWith('"') && identifier.endsWith('"')) ||
			(identifier.startsWith("'") && identifier.endsWith("'"))
		) {
			identifier = identifier.slice(1, -1);
		}

		if (!identifier && kind !== "constructor") {
			throw new Error(`Missing identifier for selector kind '${kind}' in '${rawSelector}'`);
		}

		segments.push({
			kind: kind as SelectorSegment["kind"],
			identifier,
		});
	}

	if (segments.length === 0) {
		throw new Error(`No valid selector segments parsed from '${rawSelector}'`);
	}

	return {
		raw: trimmed,
		chain: segments,
		target: segments[segments.length - 1],
	};
}

/**
 * Serializes a parsed selector back into canonical grammar text.
 */
export function serializeSelector(selector: ParsedSelector): string {
	return selector.chain
		.map((s) => {
			if (s.kind === "import") {
				return `import:"${s.identifier}"`;
			}
			if (s.kind === "constructor" && s.identifier === "constructor") {
				return "constructor";
			}
			return `${s.kind}:${s.identifier}`;
		})
		.join(" > ");
}
