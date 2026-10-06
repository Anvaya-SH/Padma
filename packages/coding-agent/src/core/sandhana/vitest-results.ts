import { resolve } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

const count = Type.Integer({ minimum: 0, maximum: 10000 });
const reportSchema = Compile(
	Type.Object({
		numTotalTests: count,
		numPassedTests: count,
		numFailedTests: count,
		numPendingTests: count,
		numTodoTests: count,
		numTotalTestSuites: count,
		numPassedTestSuites: count,
		numFailedTestSuites: count,
		numPendingTestSuites: count,
		success: Type.Boolean(),
		testResults: Type.Array(
			Type.Object({
				name: Type.String({ minLength: 1 }),
				status: Type.Enum(["passed", "failed"]),
				message: Type.String(),
				assertionResults: Type.Array(
					Type.Object({
						title: Type.String({ minLength: 1, maxLength: 300 }),
						fullName: Type.String({ minLength: 1 }),
						ancestorTitles: Type.Array(Type.String()),
						status: Type.Enum(["passed", "failed", "pending", "skipped", "todo", "disabled"]),
						failureMessages: Type.Union([Type.Array(Type.String()), Type.Null()]),
					}),
					{ maxItems: 1000 },
				),
			}),
			{ minItems: 1, maxItems: 8 },
		),
	}),
);

/** Native JSON reporter only: exact executed files, complete counts and unique assertion identities are required. */
export function vitestCases(output: string, targets: string[]): Map<string, "PASSED" | "FAILED" | "SKIPPED"> {
	if (Buffer.byteLength(output) > 128000) throw new Error("Vitest report exceeds bounded coverage input");
	const report: unknown = JSON.parse(output);
	if (!reportSchema.Check(report)) throw new Error("Missing complete native Vitest JSON report");
	const pathKey = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
	const expected = new Set(targets.map(pathKey));
	const observed = new Set<string>();
	const cases = new Map<string, "PASSED" | "FAILED" | "SKIPPED">();
	let pending = 0;
	let todo = 0;
	for (const file of report.testResults) {
		const path = pathKey(file.name);
		if (!expected.has(path) || observed.has(path) || file.message || !file.assertionResults.length)
			throw new Error("Vitest result has unexecuted, duplicate, empty or failed-collection files");
		observed.add(path);
		let failed = false;
		for (const assertion of file.assertionResults) {
			if (
				cases.has(assertion.title) ||
				assertion.fullName !== [...assertion.ancestorTitles, assertion.title].join(" ")
			)
				throw new Error("Ambiguous Vitest assertion identity");
			const status = assertion.status === "passed" ? "PASSED" : assertion.status === "failed" ? "FAILED" : "SKIPPED";
			if (status === "PASSED" && assertion.failureMessages?.length)
				throw new Error("Contradictory passing assertion");
			if (assertion.status === "todo") todo++;
			else if (status === "SKIPPED") pending++;
			failed ||= status === "FAILED";
			cases.set(assertion.title, status);
		}
		if ((file.status === "failed") !== failed) throw new Error("Vitest file verdict does not match its assertions");
	}
	const passed = [...cases.values()].filter((status) => status === "PASSED").length;
	const failed = [...cases.values()].filter((status) => status === "FAILED").length;
	if (
		observed.size !== expected.size ||
		cases.size !== report.numTotalTests ||
		passed !== report.numPassedTests ||
		failed !== report.numFailedTests ||
		pending !== report.numPendingTests ||
		todo !== report.numTodoTests ||
		report.numTotalTestSuites !==
			report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites ||
		report.numTotalTestSuites < observed.size ||
		report.success !== (report.numFailedTestSuites === 0 && failed === 0)
	)
		throw new Error("Incomplete or contradictory Vitest summary");
	return cases;
}
