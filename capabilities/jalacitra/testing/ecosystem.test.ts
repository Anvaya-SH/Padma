import assert from "node:assert/strict";
import test from "node:test";
import type { FileInfo } from "../adapters/adapter.ts";
import { parseWorkspaceDefinitions } from "../adapters/typescript/ecosystem.ts";
import { TypeScriptAdapter } from "../adapters/typescript/ts-adapter.ts";

test("J5-TSE-007: React components and hooks detection", () => {
	const adapter = new TypeScriptAdapter();
	const file: FileInfo = {
		path: "src/components/UserProfile.tsx",
		language: "typescript",
		class: "source",
		sizeBytes: 300,
		contentDigest: "sha256:react_comp",
		isBinary: false,
	};
	const code = `
export function useUserData(userId: string) {
  return { id: userId };
}

export function UserProfile(props: { id: string }) {
  const data = useUserData(props.id);
  return <div className="user">{data.id}</div>;
}
`;
	const res = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_react", files: [] } },
		file,
		new TextEncoder().encode(code),
	);

	const hookDecl = res.declarations.find((d) => d.name === "useUserData");
	assert.notEqual(hookDecl, undefined);
	assert.equal(hookDecl?.attrs?.role, "hook");
	assert.equal(hookDecl?.attrs?.heuristic, "custom_hook");

	const compDecl = res.declarations.find((d) => d.name === "UserProfile");
	assert.notEqual(compDecl, undefined);
	assert.equal(compDecl?.kind, "jsx_component");
	assert.equal(compDecl?.attrs?.role, "component");
	assert.equal(compDecl?.attrs?.heuristic, "component_heuristic");
});

test("J5-TSE-008 / J5-TSE-009: File-system and server framework route extraction", () => {
	const adapter = new TypeScriptAdapter();

	// 1. Next.js App Router convention
	const appPageFile: FileInfo = {
		path: "app/dashboard/settings/page.tsx",
		language: "typescript",
		class: "source",
		sizeBytes: 150,
		contentDigest: "sha256:page_tsx",
		isBinary: false,
	};
	const appPageRes = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_route", files: [] } },
		appPageFile,
		new TextEncoder().encode("export default function Page() { return <h1>Settings</h1>; }"),
	);
	assert.equal(appPageRes.contracts.length, 1);
	assert.equal(appPageRes.contracts[0].contractKind, "http_route");
	assert.equal(appPageRes.contracts[0].descriptor, "GET /dashboard/settings");
	assert.equal(appPageRes.contracts[0].attrs?.reason, "FRAMEWORK_CONVENTION");

	// 2. Server route literal registration (Express/Fastify style)
	const serverFile: FileInfo = {
		path: "src/server.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 200,
		contentDigest: "sha256:server_ts",
		isBinary: false,
	};
	const serverCode = `
app.get("/api/v1/users", listUsers);
app.post("/api/v1/users", createUser);
`;
	const serverRes = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_route", files: [] } },
		serverFile,
		new TextEncoder().encode(serverCode),
	);
	assert.equal(serverRes.contracts.length, 2);
	assert.ok(serverRes.contracts.some((c) => c.descriptor === "GET /api/v1/users"));
	assert.ok(serverRes.contracts.some((c) => c.descriptor === "POST /api/v1/users"));
});

test("J5-TSE-011: Environment variable public exposure classification", () => {
	const adapter = new TypeScriptAdapter();
	const file: FileInfo = {
		path: "src/env-check.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 150,
		contentDigest: "sha256:env_check",
		isBinary: false,
	};
	const code = `
const pub = process.env.NEXT_PUBLIC_ANALYTICS_ID;
const priv = process.env.DATABASE_PASSWORD;
`;
	const res = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_env", files: [] } },
		file,
		new TextEncoder().encode(code),
	);

	const pubRef = res.references.find((r) => r.targetSpecifier === "NEXT_PUBLIC_ANALYTICS_ID");
	assert.notEqual(pubRef, undefined);
	assert.equal(pubRef?.attrs?.exposedToClient, true);

	const privRef = res.references.find((r) => r.targetSpecifier === "DATABASE_PASSWORD");
	assert.notEqual(privRef, undefined);
	assert.equal(privRef?.attrs?.exposedToClient, false);
	assert.equal(privRef?.attrs?.clientExposureUnknown, true);
});

test("J5-TSE-002: Declaration merging detection", () => {
	const adapter = new TypeScriptAdapter();
	const file: FileInfo = {
		path: "src/types.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 150,
		contentDigest: "sha256:merge_ts",
		isBinary: false,
	};
	const code = `
export interface User {
  id: string;
}

export interface User {
  name: string;
}
`;
	const res = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_merge", files: [] } },
		file,
		new TextEncoder().encode(code),
	);

	const userDecls = res.declarations.filter((d) => d.name === "User");
	assert.equal(userDecls.length, 2);
	assert.equal(userDecls[0].attrs?.declaration_group, "User_group");
	assert.equal(userDecls[1].attrs?.declaration_group, "User_group");
	assert.ok((res.blindSpots.DECLARATION_MERGING ?? 0) >= 2);
});

test("J5-TSE-005 / J5-TSE-014: Workspace packages parsing", () => {
	const manifests = [
		{
			path: "package.json",
			content: JSON.stringify({ workspaces: ["packages/*"] }),
		},
		{
			path: "packages/core/package.json",
			content: JSON.stringify({ name: "@my/core", dependencies: { lodash: "^4.0.0" } }),
		},
		{
			path: "packages/web/package.json",
			content: JSON.stringify({ name: "@my/web", dependencies: { "@my/core": "workspace:*" } }),
		},
	];

	const pkgs = parseWorkspaceDefinitions("/repo", { workspaces: ["packages/*"] }, manifests);
	assert.equal(pkgs.length, 2);
	assert.equal(pkgs[0].name, "@my/core");
	assert.equal(pkgs[0].path, "packages/core");
	assert.equal(pkgs[1].name, "@my/web");
	assert.ok(pkgs[1].dependencies.includes("@my/core"));
});
