import { Container, getKeybindings, Spacer, Text } from "@anvaya.sh/padma-tui";
import { APP_NAME } from "../../../config.ts";
import { SYSTEM_THEME_NAME } from "../theme/system-theme.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { padmaLogoLines } from "./padma-logo.ts";

export interface FirstTimeSetupResult {
	theme: string;
	shareAnalytics: boolean;
}

export interface FirstTimeSetupOptions {
	onThemePreview: (themeName: string) => void;
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

const THEME_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "padma", label: "Padma [linen · khaki · camel · cocoa · espresso]" },
	{ value: SYSTEM_THEME_NAME, label: "Svabhāva [system terminal colors]" },
	{ value: "dark", label: "Tamas [dark]" },
	{ value: "light", label: "Prakāśa [light]" },
];

const ANALYTICS_OPTIONS: Array<{ value: boolean; label: string }> = [
	{ value: true, label: "Samvibhāga [share anonymous usage data]" },
	{ value: false, label: "Asamvibhāga [do not share]" },
];

/** First-time setup dialog: theme choice and analytics opt-in. */
export class FirstTimeSetupComponent extends Container {
	private step: "theme" | "analytics" = "theme";
	private themeIndex: number;
	private analyticsIndex = 0;
	private readonly options: FirstTimeSetupOptions;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.themeIndex = 0;
		this.update();
	}

	/** Rebuild on theme changes, e.g. when the system theme receives the terminal's colors. */
	override invalidate(): void {
		this.update();
		super.invalidate();
	}

	// Rebuild the whole dialog on every change so theme previews recolor all text.
	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(padmaLogoLines().join("\n"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Svāgata [welcome] · ${APP_NAME}`)), 1, 0));
		this.addChild(new Spacer(1));

		if (this.step === "theme") {
			this.addChild(new Text(theme.fg("text", "Varṇayojanā [theme] · Choose your palette."), 1, 0));
			this.addChild(new Spacer(1));
			this.addOptionList(
				THEME_OPTIONS.map((option) => option.label),
				this.themeIndex,
			);
		} else {
			this.addChild(new Text(theme.fg("text", "Māpana [analytics] · Share anonymous usage data?"), 1, 0));
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						"Opting in stores a tracking identifier in settings.json and enables anonymous\nusage analytics. This helps us to better debug, reproduce, and resolve issues\nand bugs within Padma. You can observe what is shared using /privacy and make\nchanges anytime in settings.json.",
					),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));
			this.addOptionList(
				ANALYTICS_OPTIONS.map((option) => option.label),
				this.analyticsIndex,
			);
		}

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "gamana [navigate]") +
					"  " +
					keyHint("tui.select.confirm", this.step === "theme" ? "anugamana [continue]" : "samāpti [finish]") +
					"  " +
					keyHint("tui.select.cancel", "virāma [skip setup]"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private addOptionList(labels: string[], selectedIndex: number): void {
		for (let i = 0; i < labels.length; i++) {
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", labels[i]) : theme.fg("text", labels[i]);
			this.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	private moveSelection(delta: number): void {
		if (this.step === "theme") {
			const next = Math.max(0, Math.min(THEME_OPTIONS.length - 1, this.themeIndex + delta));
			if (next !== this.themeIndex) {
				this.themeIndex = next;
				this.options.onThemePreview(THEME_OPTIONS[this.themeIndex].value);
			}
		} else {
			this.analyticsIndex = Math.max(0, Math.min(ANALYTICS_OPTIONS.length - 1, this.analyticsIndex + delta));
		}
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (this.step === "theme") {
				this.step = "analytics";
				this.update();
			} else {
				this.options.onSubmit({
					theme: THEME_OPTIONS[this.themeIndex].value,
					shareAnalytics: ANALYTICS_OPTIONS[this.analyticsIndex].value,
				});
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}
