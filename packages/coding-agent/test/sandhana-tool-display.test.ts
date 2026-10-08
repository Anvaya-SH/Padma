import type { TUI } from "@anvaya.sh/padma-tui";
import { beforeAll, expect, test } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

test.each(["avartana_read", "sarasangraha_restore", "smritikosha_recall"])(
	"%s shows useful excerpts while retaining optional diagnostic expansion",
	(name) => {
		const component = new ToolExecutionComponent(
			name,
			"context-call",
			{ locator: "private-evidence-id" },
			{},
			undefined,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({
			content: [
				{
					type: "text",
					text: JSON.stringify({ snippets: [{ text: "Useful excerpt", observation_id: "private-evidence-id" }] }),
				},
			],
			isError: false,
		});
		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Useful excerpt");
		expect(collapsed).not.toContain(name);
		expect(collapsed).not.toContain("private-evidence-id");
		expect(collapsed).not.toContain("observation_id");
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("private-evidence-id");
	},
);

test("memory control records stay collapsed until explicitly expanded", () => {
	const component = new ToolExecutionComponent(
		"smritikosha_store",
		"memory-call",
		{},
		{},
		undefined,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
	component.updateResult({
		content: [{ type: "text", text: '{"memoryId":"private-memory-id","lifecycle":"CANDIDATE"}' }],
		isError: false,
	});
	const collapsed = stripAnsi(component.render(120).join("\n"));
	expect(collapsed).toContain("Save memory");
	expect(collapsed).not.toContain("CANDIDATE");
	expect(collapsed).not.toContain("private-memory-id");
	component.setExpanded(true);
	expect(stripAnsi(component.render(120).join("\n"))).toContain("private-memory-id");
});

test.each([
	["QUEUED", "Waiting to run."],
	["DISPATCHED", "Starting."],
	["RUNNING", "Running."],
	["COMPLETED", "Command completed."],
	["FAILED", "Command failed."],
	["CANCELLED", "Cancelled."],
	["CANCEL_REQUESTED", "Cancellation requested"],
	["UNCERTAIN", "could not confirm"],
])("background status %s hides scheduler metadata and keeps a useful outcome", (status, expected) => {
	const component = new ToolExecutionComponent(
		"sandhana_operation",
		"background-call",
		{ action: "inspect", id: "private-operation-id" },
		{},
		undefined,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
	component.updateResult({
		content: [
			{
				type: "text",
				text: JSON.stringify({
					schedule: { status, reason: "Durable Kshepana start observed", operation_id: "private-operation-id" },
				}),
			},
		],
		isError: status === "FAILED",
	});
	const collapsed = stripAnsi(component.render(160).join("\n"));
	expect(collapsed).toContain(expected);
	expect(collapsed).not.toContain(status);
	expect(collapsed).not.toContain("Kshepana");
	expect(collapsed).not.toContain("private-operation-id");
	if (status === "UNCERTAIN") expect(collapsed).toContain("before running it again");
	component.setExpanded(true);
	expect(stripAnsi(component.render(160).join("\n"))).toContain("Durable Kshepana start observed");
});
