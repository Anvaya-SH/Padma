import * as bundledPadmaAgentCore from "@anvaya.sh/padma-agent-core";
import * as bundledPadmaAiCompat from "@anvaya.sh/padma-ai/compat";
import * as bundledPadmaAiOauth from "@anvaya.sh/padma-ai/oauth";
import * as bundledPadmaAiProviders from "@anvaya.sh/padma-ai/providers/all";
import * as bundledPadmaTui from "@anvaya.sh/padma-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @anvaya.sh/padma-coding-agent.
import * as bundledPadmaCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@anvaya.sh/padma-agent-core": bundledPadmaAgentCore,
	"@anvaya.sh/padma-tui": bundledPadmaTui,
	// Extensions resolve the padma-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@anvaya.sh/padma-ai": bundledPadmaAiCompat,
	"@anvaya.sh/padma-ai/compat": bundledPadmaAiCompat,
	"@anvaya.sh/padma-ai/oauth": bundledPadmaAiOauth,
	"@anvaya.sh/padma-ai/providers/all": bundledPadmaAiProviders,
	"@anvaya.sh/padma-coding-agent": bundledPadmaCodingAgent,
	"@mariozechner/padma-agent-core": bundledPadmaAgentCore,
	"@mariozechner/padma-tui": bundledPadmaTui,
	"@mariozechner/padma-ai": bundledPadmaAiCompat,
	"@mariozechner/padma-ai/compat": bundledPadmaAiCompat,
	"@mariozechner/padma-ai/oauth": bundledPadmaAiOauth,
	"@mariozechner/padma-ai/providers/all": bundledPadmaAiProviders,
	"@mariozechner/padma-coding-agent": bundledPadmaCodingAgent,
};
