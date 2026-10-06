import { Text } from "@anvaya.sh/padma-tui";
import { theme } from "../theme/theme.ts";

/**
 * Text whose content applies theme colors. Plain `Text` keeps the colors its string was built with, so
 * a theme change, or the system theme receiving the terminal's colors, would leave it stale. This
 * rebuilds the string after invalidation and samples Padma's animated colours on each render.
 * Unchanged strings retain Text's layout cache.
 *
 * `build` must return the same content each time, apart from colors. Snapshot changing data before
 * creating the component, or call `invalidate()` after changing state that `build` reads.
 */
export class ThemedText extends Text {
	private readonly build: () => string;
	private stale = true;
	private lastBuiltText: string | undefined;

	constructor(build: () => string, paddingX = 1, paddingY = 1) {
		super("", paddingX, paddingY);
		this.build = build;
	}

	override invalidate(): void {
		super.invalidate();
		this.stale = true;
	}

	override render(width: number): string[] {
		if (this.stale || theme.name === "padma") {
			const text = this.build();
			if (this.stale || text !== this.lastBuiltText) this.setText(text);
			this.lastBuiltText = text;
			this.stale = false;
		}
		return super.render(width);
	}
}
