#!/usr/bin/env node
import { createRequire, enableCompileCache } from "node:module";
import { clearStartupScreen, showStartupScreen } from "./cli/startup-screen.ts";

enableCompileCache();
showStartupScreen(process.argv.slice(2));
try {
	// A synchronous deferred load keeps static runtime imports out of the first-paint graph.
	createRequire(import.meta.url)(import.meta.url.endsWith(".ts") ? "./cli-runtime.ts" : "./cli-runtime.js");
} catch (error) {
	clearStartupScreen();
	throw error;
}
