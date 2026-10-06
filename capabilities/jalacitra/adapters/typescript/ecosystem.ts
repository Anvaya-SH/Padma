// Jālacitra TypeScript Ecosystem Extractors (Part I5, J5-TSE-001 through J5-TSE-016)

import type { FileInfo, RawContract, RawDeclaration } from "../adapter.ts";

export interface RouteExtractionResult {
	routes: RawContract[];
	blindSpots: Record<string, number>;
}

export function extractFrameworkRoutes(file: FileInfo, content: string): RouteExtractionResult {
	const routes: RawContract[] = [];
	const blindSpots: Record<string, number> = {};

	const normPath = file.path.replace(/\\/g, "/");

	// 1. File-system routing conventions (Next.js / Remix style)
	// Example: app/users/page.tsx -> /users
	// Example: pages/api/login.ts -> /api/login
	const nextAppPageMatch = normPath.match(/(?:^|\/)app\/(.+)\/page\.(?:tsx|jsx|ts|js)$/);
	if (nextAppPageMatch) {
		const routePath = `/${nextAppPageMatch[1].replace(/\/\([^)]+\)/g, "")}`; // strip route groups (group)
		routes.push({
			contractKind: "http_route",
			descriptor: `GET ${routePath}`,
			attrs: {
				framework: "nextjs",
				convention: "app_router",
				reason: "FRAMEWORK_CONVENTION",
				http_method: "GET",
				path_pattern: routePath,
			},
		});
	}

	const nextPagesMatch = normPath.match(/(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js)$/);
	if (nextPagesMatch && !nextPagesMatch[1].startsWith("_")) {
		const rawRoute = nextPagesMatch[1].replace(/\/index$/, "") || "";
		const routePath = `/${rawRoute}`;
		routes.push({
			contractKind: "http_route",
			descriptor: `ANY ${routePath}`,
			attrs: {
				framework: "nextjs",
				convention: "pages_router",
				reason: "FRAMEWORK_CONVENTION",
				path_pattern: routePath,
			},
		});
	}

	// 2. Server Frameworks: Express, Fastify, Hono route registrations
	// Example: app.get("/api/v1/health", handler)
	const serverRouteRegex = /(?:app|router|server)\.(get|post|put|delete|patch|options|head)\s*\(\s*["']([^"']+)["']/g;
	for (let match = serverRouteRegex.exec(content); match !== null; match = serverRouteRegex.exec(content)) {
		const httpMethod = match[1].toUpperCase();
		const routePath = match[2];
		routes.push({
			contractKind: "http_route",
			descriptor: `${httpMethod} ${routePath}`,
			attrs: {
				framework: "express_like",
				http_method: httpMethod,
				path_pattern: routePath,
				literal_registration: true,
			},
		});
	}

	// Dynamic/computed path detection: app.get(computedPath, ...)
	const dynamicRouteRegex = /(?:app|router|server)\.(get|post|put|delete|patch)\s*\(\s*([^"'\s)][^,)]*)/g;
	for (let match = dynamicRouteRegex.exec(content); match !== null; match = dynamicRouteRegex.exec(content)) {
		const firstArg = match[2].trim();
		if (!firstArg.startsWith('"') && !firstArg.startsWith("'") && !firstArg.startsWith("`")) {
			blindSpots.STRING_BASED_REFERENCE = (blindSpots.STRING_BASED_REFERENCE ?? 0) + 1;
		}
	}

	return { routes, blindSpots };
}

export function enhanceReactDeclarations(
	declarations: RawDeclaration[],
	content: string,
): { declarations: RawDeclaration[]; blindSpots: Record<string, number> } {
	const blindSpots: Record<string, number> = {};

	for (const decl of declarations) {
		decl.attrs = decl.attrs ?? {};

		// Custom Hook heuristic: use[A-Z]...
		if (/^use[A-Z0-9]/.test(decl.name)) {
			decl.attrs.role = "hook";
			decl.attrs.heuristic = "custom_hook";
		}
		// Component heuristic: PascalCase function or class that mentions JSX in body
		else if (/^[A-Z][a-zA-Z0-9]*$/.test(decl.name)) {
			if (content.includes("<") && (content.includes("/>") || content.includes("</"))) {
				decl.kind = "jsx_component";
				decl.attrs.role = "component";
				decl.attrs.heuristic = "component_heuristic";
			}
		}
	}

	return { declarations, blindSpots };
}

export function classifyEnvVariableExposure(keyName: string): {
	exposedToClient: boolean;
	clientExposureUnknown?: boolean;
} {
	if (
		keyName.startsWith("NEXT_PUBLIC_") ||
		keyName.startsWith("VITE_") ||
		keyName.startsWith("PUBLIC_") ||
		keyName.startsWith("REACT_APP_")
	) {
		return { exposedToClient: true };
	}
	return { exposedToClient: false, clientExposureUnknown: true };
}

export function detectDeclarationMerging(declarations: RawDeclaration[]): {
	declarations: RawDeclaration[];
	blindSpots: Record<string, number>;
} {
	const nameCount = new Map<string, number>();
	for (const decl of declarations) {
		nameCount.set(decl.qualifiedName, (nameCount.get(decl.qualifiedName) ?? 0) + 1);
	}

	let mergedCount = 0;
	for (const decl of declarations) {
		if ((nameCount.get(decl.qualifiedName) ?? 0) > 1) {
			decl.attrs = decl.attrs ?? {};
			decl.attrs.declaration_group = `${decl.qualifiedName}_group`;
			mergedCount++;
		}
	}

	const blindSpots: Record<string, number> = {};
	if (mergedCount > 0) {
		blindSpots.DECLARATION_MERGING = mergedCount;
	}

	return { declarations, blindSpots };
}

export interface WorkspacePackage {
	name: string;
	path: string; // package directory relative to repo root
	manifestPath: string;
	dependencies: string[];
}

export function parseWorkspaceDefinitions(
	_repoRoot: string,
	_rootPackageJson: { workspaces?: string[] | { packages?: string[] } },
	allManifests: Array<{ path: string; content: string }>,
): WorkspacePackage[] {
	const packages: WorkspacePackage[] = [];

	for (const m of allManifests) {
		if (m.path === "package.json") continue; // skip root package.json
		try {
			const parsed = JSON.parse(m.content);
			if (parsed.name && typeof parsed.name === "string") {
				const pkgDir = m.path.replace(/\/package\.json$/, "");
				const deps = Object.keys({
					...(parsed.dependencies ?? {}),
					...(parsed.devDependencies ?? {}),
				});
				packages.push({
					name: parsed.name,
					path: pkgDir,
					manifestPath: m.path,
					dependencies: deps,
				});
			}
		} catch {
			// Ignore unparseable package.json
		}
	}

	return packages;
}
