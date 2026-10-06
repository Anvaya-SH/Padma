import { type KeyId, matchesKey } from "./keys.ts";

/**
 * Global keybinding registry.
 * Downstream packages can add keybindings via declaration merging.
 */
export interface Keybindings {
	// Editor navigation and editing
	"tui.editor.cursorUp": true;
	"tui.editor.cursorDown": true;
	"tui.editor.historyPrevious": true;
	"tui.editor.historyNext": true;
	"tui.editor.cursorLeft": true;
	"tui.editor.cursorRight": true;
	"tui.editor.cursorWordLeft": true;
	"tui.editor.cursorWordRight": true;
	"tui.editor.cursorLineStart": true;
	"tui.editor.cursorLineEnd": true;
	"tui.editor.jumpForward": true;
	"tui.editor.jumpBackward": true;
	"tui.editor.pageUp": true;
	"tui.editor.pageDown": true;
	"tui.editor.deleteCharBackward": true;
	"tui.editor.deleteCharForward": true;
	"tui.editor.deleteWordBackward": true;
	"tui.editor.deleteWordForward": true;
	"tui.editor.deleteToLineStart": true;
	"tui.editor.deleteToLineEnd": true;
	"tui.editor.yank": true;
	"tui.editor.yankPop": true;
	"tui.editor.undo": true;
	"tui.editor.killWholeLine": true;
	// Generic input actions
	"tui.input.newLine": true;
	"tui.input.submit": true;
	"tui.input.tab": true;
	"tui.input.copy": true;
	// Generic selection actions
	"tui.select.up": true;
	"tui.select.down": true;
	"tui.select.pageUp": true;
	"tui.select.pageDown": true;
	"tui.select.confirm": true;
	"tui.select.cancel": true;
	"tui.select.left": true;
	"tui.select.right": true;
	"tui.select.top": true;
	"tui.select.bottom": true;
	// Alternate-screen viewport navigation
	"tui.altScreen.pageUp": true;
	"tui.altScreen.pageDown": true;
	"tui.altScreen.halfPageUp": true;
	"tui.altScreen.halfPageDown": true;
	"tui.altScreen.lineUp": true;
	"tui.altScreen.lineDown": true;
	"tui.altScreen.previousPrompt": true;
	"tui.altScreen.nextPrompt": true;
	"tui.altScreen.search": true;
	"tui.altScreen.searchNext": true;
	"tui.altScreen.searchPrevious": true;
	"tui.altScreen.searchClose": true;
	"tui.altScreen.top": true;
	"tui.altScreen.bottom": true;
	"tui.altScreen.close": true;
	"tui.altScreen.closeTranscript": true;
	"tui.altScreen.find": true;
	"tui.vim.normal.enterInsert": true;
	"tui.vim.normal.appendAfterCursor": true;
	"tui.vim.normal.appendLineEnd": true;
	"tui.vim.normal.insertLineStart": true;
	"tui.vim.normal.openLineBelow": true;
	"tui.vim.normal.openLineAbove": true;
	"tui.vim.normal.enterReplaceMode": true;
	"tui.vim.normal.moveLeft": true;
	"tui.vim.normal.moveRight": true;
	"tui.vim.normal.moveUp": true;
	"tui.vim.normal.moveDown": true;
	"tui.vim.normal.moveWordForward": true;
	"tui.vim.normal.moveWordBackward": true;
	"tui.vim.normal.moveWordEnd": true;
	"tui.vim.normal.moveLineStart": true;
	"tui.vim.normal.moveLineEnd": true;
	"tui.vim.normal.findForward": true;
	"tui.vim.normal.findBackward": true;
	"tui.vim.normal.tillForward": true;
	"tui.vim.normal.tillBackward": true;
	"tui.vim.normal.jumpTop": true;
	"tui.vim.normal.jumpBottom": true;
	"tui.vim.normal.deleteChar": true;
	"tui.vim.normal.replaceChar": true;
	"tui.vim.normal.repeatLastChange": true;
	"tui.vim.normal.substituteChar": true;
	"tui.vim.normal.deleteToLineEnd": true;
	"tui.vim.normal.changeToLineEnd": true;
	"tui.vim.normal.yankLine": true;
	"tui.vim.normal.pasteAfter": true;
	"tui.vim.normal.startDeleteOperator": true;
	"tui.vim.normal.startYankOperator": true;
	"tui.vim.normal.startChangeOperator": true;
	"tui.vim.normal.undo": true;
	"tui.vim.normal.redo": true;
	"tui.vim.normal.cancelOperator": true;
	"tui.vim.search.forward": true;
	"tui.vim.search.backward": true;
	"tui.vim.search.next": true;
	"tui.vim.search.previous": true;
	"tui.vim.operator.deleteLine": true;
	"tui.vim.operator.yankLine": true;
	"tui.vim.operator.motionLeft": true;
	"tui.vim.operator.motionRight": true;
	"tui.vim.operator.motionUp": true;
	"tui.vim.operator.motionDown": true;
	"tui.vim.operator.motionWordForward": true;
	"tui.vim.operator.motionWordBackward": true;
	"tui.vim.operator.motionWordEnd": true;
	"tui.vim.operator.motionLineStart": true;
	"tui.vim.operator.motionLineEnd": true;
	"tui.vim.operator.motionFindForward": true;
	"tui.vim.operator.motionFindBackward": true;
	"tui.vim.operator.motionTillForward": true;
	"tui.vim.operator.motionTillBackward": true;
	"tui.vim.operator.motionJumpTop": true;
	"tui.vim.operator.motionJumpBottom": true;
	"tui.vim.operator.selectInner": true;
	"tui.vim.operator.selectAround": true;
	"tui.vim.operator.cancel": true;
	"tui.vim.textObject.word": true;
	"tui.vim.textObject.bigWord": true;
	"tui.vim.textObject.parentheses": true;
	"tui.vim.textObject.brackets": true;
	"tui.vim.textObject.braces": true;
	"tui.vim.textObject.doubleQuote": true;
	"tui.vim.textObject.singleQuote": true;
	"tui.vim.textObject.backtick": true;
	"tui.vim.textObject.cancel": true;
}

export type Keybinding = keyof Keybindings;

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	"tui.editor.historyPrevious": {
		defaultKeys: [],
		description: "Select previous prompt history entry",
	},
	"tui.editor.historyNext": {
		defaultKeys: [],
		description: "Select next prompt history entry",
	},
	"tui.editor.cursorLeft": {
		defaultKeys: ["left", "ctrl+b"],
		description: "Move cursor left",
	},
	"tui.editor.cursorRight": {
		defaultKeys: ["right", "ctrl+f"],
		description: "Move cursor right",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+home", "ctrl+a"],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+end", "ctrl+e"],
		description: "Move to line end",
	},
	"tui.editor.jumpForward": {
		defaultKeys: "ctrl+]",
		description: "Jump forward to character",
	},
	"tui.editor.jumpBackward": {
		defaultKeys: "ctrl+alt+]",
		description: "Jump backward to character",
	},
	"tui.editor.pageUp": { defaultKeys: ["pageUp", "ctrl+pageUp"], description: "Page up" },
	"tui.editor.pageDown": { defaultKeys: ["pageDown", "ctrl+pageDown"], description: "Page down" },
	"tui.editor.deleteCharBackward": {
		defaultKeys: ["backspace", "shift+backspace", "ctrl+h"],
		description: "Delete character backward",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: ["delete", "shift+delete", "ctrl+d"],
		description: "Delete character forward",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["alt+backspace", "ctrl+backspace", "ctrl+shift+backspace", "ctrl+w", "ctrl+alt+h"],
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: ["alt+delete", "ctrl+delete", "ctrl+shift+delete", "alt+d"],
		description: "Delete word forward",
	},
	"tui.editor.killWholeLine": {
		defaultKeys: [],
		description: "Delete the current whole line",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: "ctrl+u",
		description: "Delete to line start",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: "ctrl+k",
		description: "Delete to line end",
	},
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
	"tui.input.newLine": {
		defaultKeys: ["ctrl+j", "shift+enter", "alt+enter"],
		description: "Insert newline",
	},
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	"tui.select.up": { defaultKeys: ["up", "ctrl+p", "ctrl+k"], description: "Move selection up" },
	"tui.select.down": { defaultKeys: ["down", "ctrl+n", "ctrl+j"], description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: ["pageUp", "ctrl+b"], description: "Selection page up" },
	"tui.select.pageDown": {
		defaultKeys: ["pageDown", "ctrl+f"],
		description: "Selection page down",
	},
	"tui.select.left": { defaultKeys: ["left", "ctrl+h"], description: "Move selection left / change tab" },
	"tui.select.right": { defaultKeys: ["right", "ctrl+l"], description: "Move selection right / change tab" },
	"tui.select.top": { defaultKeys: "home", description: "First item" },
	"tui.select.bottom": { defaultKeys: "end", description: "Last item" },
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: ["escape", "ctrl+c"],
		description: "Cancel selection",
	},
	// These intentionally shadow the unmodified editor bindings in fullscreen mode.
	"tui.altScreen.pageUp": {
		defaultKeys: ["pageUp", "shift+space", "ctrl+b"],
		description: "Scroll viewport up one page",
	},
	"tui.altScreen.pageDown": {
		defaultKeys: ["pageDown", "space", "ctrl+f"],
		description: "Scroll viewport down one page",
	},
	"tui.altScreen.halfPageUp": {
		defaultKeys: "ctrl+u",
		description: "Scroll viewport up half a page",
	},
	"tui.altScreen.halfPageDown": {
		defaultKeys: "ctrl+d",
		description: "Scroll viewport down half a page",
	},
	"tui.altScreen.lineUp": {
		defaultKeys: ["k"],
		description: "Scroll viewport up one line",
	},
	"tui.altScreen.lineDown": {
		defaultKeys: ["j"],
		description: "Scroll viewport down one line",
	},
	"tui.altScreen.previousPrompt": {
		defaultKeys: ["ctrl+shift+up", "ctrl+up"],
		description: "Jump to previous semantic prompt",
	},
	"tui.altScreen.nextPrompt": {
		defaultKeys: ["ctrl+shift+down", "ctrl+down"],
		description: "Jump to next semantic prompt",
	},
	"tui.altScreen.search": {
		defaultKeys: "ctrl+shift+f",
		description: "Search the primary scroll view",
	},
	"tui.altScreen.searchNext": {
		defaultKeys: ["enter", "ctrl+g"],
		description: "Select the next search match",
	},
	"tui.altScreen.searchPrevious": {
		defaultKeys: ["shift+enter", "ctrl+shift+g"],
		description: "Select the previous search match",
	},
	"tui.altScreen.searchClose": {
		defaultKeys: "escape",
		description: "Close transcript search",
	},
	"tui.altScreen.top": { defaultKeys: "home", description: "Scroll viewport to top" },
	"tui.altScreen.bottom": { defaultKeys: "end", description: "Scroll viewport to bottom" },
	"tui.altScreen.close": { defaultKeys: ["q", "ctrl+c"], description: "Close pager overlay" },
	"tui.altScreen.closeTranscript": { defaultKeys: "ctrl+t", description: "Close detailed transcript view" },
	"tui.altScreen.find": { defaultKeys: ["f3", "/"], description: "Start transcript find" },
	"tui.vim.normal.enterInsert": { defaultKeys: ["i", "insert"], description: "Vim insert at cursor" },
	"tui.vim.normal.appendAfterCursor": { defaultKeys: "a", description: "Vim insert after cursor" },
	"tui.vim.normal.appendLineEnd": { defaultKeys: "shift+a", description: "Vim insert at end of line" },
	"tui.vim.normal.insertLineStart": { defaultKeys: "shift+i", description: "Vim insert at first nonblank" },
	"tui.vim.normal.openLineBelow": { defaultKeys: "o", description: "Vim new line below" },
	"tui.vim.normal.openLineAbove": { defaultKeys: "shift+o", description: "Vim new line above" },
	"tui.vim.normal.enterReplaceMode": { defaultKeys: "shift+r", description: "Vim replace mode" },
	"tui.vim.normal.moveLeft": { defaultKeys: ["h", "left"], description: "Vim left" },
	"tui.vim.normal.moveRight": { defaultKeys: ["l", "right"], description: "Vim right" },
	"tui.vim.normal.moveUp": { defaultKeys: ["k", "up"], description: "Vim up" },
	"tui.vim.normal.moveDown": { defaultKeys: ["j", "down"], description: "Vim down" },
	"tui.vim.normal.moveWordForward": { defaultKeys: "w", description: "Vim next word start" },
	"tui.vim.normal.moveWordBackward": { defaultKeys: "b", description: "Vim previous word start" },
	"tui.vim.normal.moveWordEnd": { defaultKeys: "e", description: "Vim word end" },
	"tui.vim.normal.moveLineStart": { defaultKeys: "0", description: "Vim line start" },
	"tui.vim.normal.moveLineEnd": { defaultKeys: "$", description: "Vim line end" },
	"tui.vim.normal.findForward": { defaultKeys: "f", description: "Vim find forward" },
	"tui.vim.normal.findBackward": { defaultKeys: "shift+f", description: "Vim find backward" },
	"tui.vim.normal.tillForward": { defaultKeys: "t", description: "Vim till forward" },
	"tui.vim.normal.tillBackward": { defaultKeys: "shift+t", description: "Vim till backward" },
	"tui.vim.normal.jumpTop": { defaultKeys: "g", description: "Vim first line (g g chord)" },
	"tui.vim.normal.jumpBottom": { defaultKeys: "shift+g", description: "Vim last line" },
	"tui.vim.normal.deleteChar": { defaultKeys: "x", description: "Vim delete char" },
	"tui.vim.normal.replaceChar": { defaultKeys: "r", description: "Vim replace char" },
	"tui.vim.normal.repeatLastChange": { defaultKeys: ".", description: "Vim repeat edit" },
	"tui.vim.normal.substituteChar": { defaultKeys: "s", description: "Vim substitute char" },
	"tui.vim.normal.deleteToLineEnd": { defaultKeys: "shift+d", description: "Vim delete to line end" },
	"tui.vim.normal.changeToLineEnd": { defaultKeys: "shift+c", description: "Vim change to line end" },
	"tui.vim.normal.yankLine": { defaultKeys: "shift+y", description: "Vim yank line" },
	"tui.vim.normal.pasteAfter": { defaultKeys: "p", description: "Vim paste after" },
	"tui.vim.normal.startDeleteOperator": { defaultKeys: "d", description: "Vim delete operator" },
	"tui.vim.normal.startYankOperator": { defaultKeys: "y", description: "Vim yank operator" },
	"tui.vim.normal.startChangeOperator": { defaultKeys: "c", description: "Vim change operator" },
	"tui.vim.normal.undo": { defaultKeys: "u", description: "Vim undo" },
	"tui.vim.normal.redo": { defaultKeys: "ctrl+r", description: "Vim redo" },
	"tui.vim.normal.cancelOperator": { defaultKeys: "escape", description: "Vim cancel operator" },
	"tui.vim.search.forward": { defaultKeys: "/", description: "Vim search forward" },
	"tui.vim.search.backward": { defaultKeys: "?", description: "Vim search backward" },
	"tui.vim.search.next": { defaultKeys: "n", description: "Vim next search match" },
	"tui.vim.search.previous": { defaultKeys: "shift+n", description: "Vim previous search match" },
	"tui.vim.operator.deleteLine": { defaultKeys: "d", description: "Vim dd delete line" },
	"tui.vim.operator.yankLine": { defaultKeys: "y", description: "Vim yy yank line" },
	"tui.vim.operator.motionLeft": { defaultKeys: "h", description: "Vim operator left" },
	"tui.vim.operator.motionRight": { defaultKeys: "l", description: "Vim operator right" },
	"tui.vim.operator.motionUp": { defaultKeys: "k", description: "Vim operator up" },
	"tui.vim.operator.motionDown": { defaultKeys: "j", description: "Vim operator down" },
	"tui.vim.operator.motionWordForward": { defaultKeys: "w", description: "Vim operator word forward" },
	"tui.vim.operator.motionWordBackward": { defaultKeys: "b", description: "Vim operator word backward" },
	"tui.vim.operator.motionWordEnd": { defaultKeys: "e", description: "Vim operator word end" },
	"tui.vim.operator.motionLineStart": { defaultKeys: "0", description: "Vim operator line start" },
	"tui.vim.operator.motionLineEnd": { defaultKeys: "$", description: "Vim operator line end" },
	"tui.vim.operator.motionFindForward": { defaultKeys: "f", description: "Vim operator find forward" },
	"tui.vim.operator.motionFindBackward": { defaultKeys: "shift+f", description: "Vim operator find backward" },
	"tui.vim.operator.motionTillForward": { defaultKeys: "t", description: "Vim operator till forward" },
	"tui.vim.operator.motionTillBackward": { defaultKeys: "shift+t", description: "Vim operator till backward" },
	"tui.vim.operator.motionJumpTop": { defaultKeys: "g", description: "Vim operator first line" },
	"tui.vim.operator.motionJumpBottom": { defaultKeys: "shift+g", description: "Vim operator last line" },
	"tui.vim.operator.selectInner": { defaultKeys: "i", description: "Vim inner text object" },
	"tui.vim.operator.selectAround": { defaultKeys: "a", description: "Vim around text object" },
	"tui.vim.operator.cancel": { defaultKeys: "escape", description: "Vim cancel operator" },
	"tui.vim.textObject.word": { defaultKeys: "w", description: "Vim word object" },
	"tui.vim.textObject.bigWord": { defaultKeys: "shift+w", description: "Vim WORD object" },
	"tui.vim.textObject.parentheses": { defaultKeys: ["(", ")", "b"], description: "Vim parentheses object" },
	"tui.vim.textObject.brackets": { defaultKeys: ["[", "]"], description: "Vim brackets object" },
	"tui.vim.textObject.braces": { defaultKeys: ["{", "}", "shift+b"], description: "Vim braces object" },
	"tui.vim.textObject.doubleQuote": {
		defaultKeys: [],
		description: "Vim double-quote object (unbound: no double-quote KeyId)",
	},
	"tui.vim.textObject.singleQuote": { defaultKeys: "'", description: "Vim single-quote object" },
	"tui.vim.textObject.backtick": { defaultKeys: "`", description: "Vim backtick object" },
	"tui.vim.textObject.cancel": { defaultKeys: "escape", description: "Vim cancel text object" },
} as const satisfies KeybindingDefinitions;

export interface KeybindingConflict {
	key: KeyId;
	keybindings: string[];
}

function normalizeKeys(keys: KeyId | KeyId[] | undefined): KeyId[] {
	if (keys === undefined) return [];
	const keyList = Array.isArray(keys) ? keys : [keys];
	const seen = new Set<KeyId>();
	const result: KeyId[] = [];
	for (const key of keyList) {
		if (!seen.has(key)) {
			seen.add(key);
			result.push(key);
		}
	}
	return result;
}

export class KeybindingsManager {
	private definitions: KeybindingDefinitions;
	private userBindings: KeybindingsConfig;
	private keysById = new Map<Keybinding, KeyId[]>();
	private conflicts: KeybindingConflict[] = [];

	constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
		this.definitions = definitions;
		this.userBindings = userBindings;
		this.rebuild();
	}

	private rebuild(): void {
		this.keysById.clear();
		this.conflicts = [];

		const userClaims = new Map<KeyId, Set<Keybinding>>();
		for (const [keybinding, keys] of Object.entries(this.userBindings)) {
			if (!(keybinding in this.definitions)) continue;
			for (const key of normalizeKeys(keys)) {
				const claimants = userClaims.get(key) ?? new Set<Keybinding>();
				claimants.add(keybinding as Keybinding);
				userClaims.set(key, claimants);
			}
		}

		for (const [key, keybindings] of userClaims) {
			if (keybindings.size > 1) {
				this.conflicts.push({ key, keybindings: [...keybindings] });
			}
		}

		for (const [id, definition] of Object.entries(this.definitions)) {
			const userKeys = this.userBindings[id];
			const keys = userKeys === undefined ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
			this.keysById.set(id as Keybinding, keys);
		}
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const keys = this.keysById.get(keybinding) ?? [];
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		return [...(this.keysById.get(keybinding) ?? [])];
	}

	getDefinition(keybinding: Keybinding): KeybindingDefinition {
		return this.definitions[keybinding];
	}

	getConflicts(): KeybindingConflict[] {
		return this.conflicts.map((conflict) => ({ ...conflict, keybindings: [...conflict.keybindings] }));
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.userBindings = userBindings;
		this.rebuild();
	}

	getUserBindings(): KeybindingsConfig {
		return { ...this.userBindings };
	}

	getResolvedBindings(): KeybindingsConfig {
		const resolved: KeybindingsConfig = {};
		for (const id of Object.keys(this.definitions)) {
			const keys = this.keysById.get(id as Keybinding) ?? [];
			resolved[id] = keys.length === 1 ? keys[0]! : [...keys];
		}
		return resolved;
	}
}

let globalKeybindings: KeybindingsManager | null = null;

export function setKeybindings(keybindings: KeybindingsManager): void {
	globalKeybindings = keybindings;
}

export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) {
		globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	}
	return globalKeybindings;
}
