// Jālacitra Ignore Engine & Precedence Rules (Part F, Part O1, J5-INV-001 through J5-INV-007, J5-SEC-005)

import { normalizeRepoPath } from "../model/ids.ts";

export interface IgnoreDecision {
	ignored: boolean;
	reasonCode?: string;
}

export interface IgnoreRule {
	pattern: string;
	isNegative: boolean;
	isDirectoryOnly: boolean;
	regex: RegExp;
	source: "hard" | "padmaignore" | "gitignore" | "default";
}

const HARD_EXCLUDED_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"vendor",
	"bower_components",
	".pnpm-store",
]);

const SECRET_PATTERNS = [
	/\.pem$/i,
	/\.key$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)/i,
	/\.p12$/i,
	/\.pkcs12$/i,
	/credentials(\..+)?$/i,
	/\.kdbx$/i,
	/service[-_]?account.*\.json$/i,
	/token(\..+)?$/i,
];

const DEFAULT_BUILD_DIRS = new Set([
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"coverage",
	".nyc_output",
]);

export class IgnoreEngine {
	private padmaRules: IgnoreRule[] = [];
	private gitRules: IgnoreRule[] = [];

	constructor(padmaignoreContent?: string, gitignoreContent?: string) {
		if (padmaignoreContent) {
			this.padmaRules = this.parseRules(padmaignoreContent, "padmaignore");
		}
		if (gitignoreContent) {
			this.gitRules = this.parseRules(gitignoreContent, "gitignore");
		}
	}

	evaluate(repoRelativePath: string, isDirectory: boolean): IgnoreDecision {
		const normalized = normalizeRepoPath(repoRelativePath);
		const segments = normalized.split("/");

		// 1. Hard Exclusions (Highest Precedence)
		for (const seg of segments) {
			if (seg === ".git" || seg === ".hg" || seg === ".svn") {
				return { ignored: true, reasonCode: "EXCLUDED_VCS_INTERNAL" };
			}
			if (HARD_EXCLUDED_DIRS.has(seg)) {
				return { ignored: true, reasonCode: "EXCLUDED_DEPENDENCY_DIR" };
			}
		}

		// Secret file check (only for files, or directory with secret name)
		const fileName = segments[segments.length - 1];
		for (const rx of SECRET_PATTERNS) {
			if (rx.test(fileName)) {
				return { ignored: true, reasonCode: "EXCLUDED_SECRET_PATTERN" };
			}
		}

		// 2. .padmaignore rules
		const padmaDecision = this.evaluateRuleList(this.padmaRules, normalized, isDirectory);
		if (padmaDecision !== null) {
			return padmaDecision ? { ignored: true, reasonCode: "IGNORED_BY_RULE" } : { ignored: false };
		}

		// 3. .gitignore rules
		const gitDecision = this.evaluateRuleList(this.gitRules, normalized, isDirectory);
		if (gitDecision !== null) {
			return gitDecision ? { ignored: true, reasonCode: "IGNORED_BY_RULE" } : { ignored: false };
		}

		// 4. Default build/cache directory rules
		for (const seg of segments) {
			if (DEFAULT_BUILD_DIRS.has(seg)) {
				return { ignored: true, reasonCode: "BUILD_OUTPUT_ARTIFACT_ONLY" };
			}
		}

		return { ignored: false };
	}

	private evaluateRuleList(rules: IgnoreRule[], path: string, isDirectory: boolean): boolean | null {
		let match: boolean | null = null;
		for (const rule of rules) {
			if (rule.isDirectoryOnly && !isDirectory) {
				continue;
			}
			if (rule.regex.test(path)) {
				match = !rule.isNegative;
			}
		}
		return match;
	}

	private parseRules(content: string, source: "padmaignore" | "gitignore"): IgnoreRule[] {
		const rules: IgnoreRule[] = [];
		const lines = content.split(/\r?\n/);
		for (const rawLine of lines) {
			const trimmed = rawLine.trim();
			if (!trimmed || trimmed.startsWith("#")) {
				continue;
			}

			let line = trimmed;
			let isNegative = false;
			if (line.startsWith("!")) {
				isNegative = true;
				line = line.slice(1).trim();
			}

			let isDirectoryOnly = false;
			if (line.endsWith("/")) {
				isDirectoryOnly = true;
				line = line.slice(0, -1);
			}

			const regex = this.globToRegex(line);
			rules.push({
				pattern: line,
				isNegative,
				isDirectoryOnly,
				regex,
				source,
			});
		}
		return rules;
	}

	private globToRegex(glob: string): RegExp {
		let p = glob;
		const startsWithSlash = p.startsWith("/");
		if (startsWithSlash) {
			p = p.slice(1);
		}

		let regexStr = "^";
		if (!startsWithSlash && !p.includes("/")) {
			// Matches anywhere in path hierarchy
			regexStr = "(^|.*/)";
		}

		let i = 0;
		while (i < p.length) {
			const c = p[i];
			if (c === "*") {
				if (p[i + 1] === "*") {
					if (p[i + 2] === "/") {
						regexStr += "(?:.*/)?";
						i += 3;
						continue;
					}
					regexStr += ".*";
					i += 2;
					continue;
				}
				regexStr += "[^/]*";
				i++;
			} else if (c === "?") {
				regexStr += "[^/]";
				i++;
			} else if (".+^$(){}|[]\\".includes(c)) {
				regexStr += `\\${c}`;
				i++;
			} else {
				regexStr += c;
				i++;
			}
		}

		regexStr += "(/.*)?$";
		return new RegExp(regexStr);
	}
}
