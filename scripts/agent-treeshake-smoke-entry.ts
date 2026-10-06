import { Agent } from "@anvaya.sh/padma-agent-core";
import { createModels } from "@anvaya.sh/padma-ai";
import { anthropicProvider } from "@anvaya.sh/padma-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
