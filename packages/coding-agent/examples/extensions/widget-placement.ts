import type { ExtensionAPI } from "@anvaya.sh/padma-coding-agent";

export default function widgetPlacementExtension(padma: ExtensionAPI) {
	padma.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
