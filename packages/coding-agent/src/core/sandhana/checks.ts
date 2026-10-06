import { isAbsolute, resolve } from "node:path";
import { inside, secretPath } from "./code.ts";

/** Literal local source arguments only; this does not establish dependency closure or authorize execution. */
export function processCommandPaths(command: string): string[] {
	return [
		...command.matchAll(
			/(?:^|\s)(?:"([^"\n]+\.(?:[cm]?js|tsx?|json))"|'([^'\n]+\.(?:[cm]?js|tsx?|json))'|([^\s'";|&]+\.(?:[cm]?js|tsx?|json)))(?=\s|$)/g,
		),
	].map((match) => match[1] ?? match[2] ?? match[3]);
}

/** Recognized foreground checks. Project tests remain effectful code; this is application policy, not a sandbox. */
export function localCheck(command: string, cwd: string): { runner: "NODE_TEST" | "VITEST"; targets: string[] } | null {
	if (/[\r\n;&|`$()<>{}*?%]/.test(command)) return null;
	const tokens = [...command.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+)/g)];
	if (tokens.map((token) => token[0]).join(" ") !== command.trim().replace(/\s+/g, " ")) return null;
	const args = tokens.map((token) => token[1] ?? token[2] ?? token[3]);
	if (args.shift() !== "node") return null;
	let runner: "NODE_TEST" | "VITEST";
	let targets: string[];
	if (args[0] === "--test") {
		runner = "NODE_TEST";
		targets = args.slice(1);
	} else if (args[0] === "node_modules/vitest/dist/cli.js" && args[1] === "--run") {
		runner = "VITEST";
		targets = args
			.slice(2)
			.filter((argument) => argument !== "--no-file-parallelism" && argument !== "--reporter=json");
		if (args.filter((argument) => argument === "--reporter=json").length > 1) return null;
	} else return null;
	if (!targets.length || targets.length > 8) return null;
	if (
		targets.some(
			(target) => isAbsolute(target) || target.startsWith("-") || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(target),
		)
	)
		return null;
	const paths = targets.map((target) => resolve(cwd, target));
	if (paths.some((path) => !inside(cwd, path) || secretPath(path))) return null;
	return { runner, targets: paths };
}
