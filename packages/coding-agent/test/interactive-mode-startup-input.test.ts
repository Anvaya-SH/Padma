import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		sessionId: string;
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	ui: { requestRender: (force?: boolean) => void };
	welcomeSubmittedSessionId?: string;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type WelcomeContext = {
	session: { messages: object[]; sessionId: string };
	welcomeSubmittedSessionId?: string;
	options: { initialMessage?: string; initialMessages?: string[]; initialImages?: object[] };
	customHeader?: object;
	editor: object;
	editorContainer: { children: object[] };
	getStartupExpansionState: () => boolean;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	shouldShowWelcomeScreen(this: WelcomeContext): boolean;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			sessionId: "new-session",
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		ui: { requestRender: vi.fn() },
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Ārambha [starting] · Preparing your workspace…");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
		expect(context.welcomeSubmittedSessionId).toBe("new-session");
		expect(context.ui.requestRender).toHaveBeenCalledWith(true);
	});

	it("keeps the welcome screen on an empty submission", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("   ");
		expect(context.welcomeSubmittedSessionId).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.ui.requestRender).not.toHaveBeenCalled();
	});

	it("switches layout before delivering the first prompt", async () => {
		const context = createSubmitContext();
		context.onInputCallback = vi.fn(() => {
			expect(context.welcomeSubmittedSessionId).toBe("new-session");
		});
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("hello");
		expect(context.onInputCallback).toHaveBeenCalledWith("hello");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});

describe("InteractiveMode welcome visibility", () => {
	function createWelcomeContext(): WelcomeContext {
		const editor = {};
		return {
			session: { messages: [], sessionId: "fresh" },
			options: {},
			editor,
			editorContainer: { children: [editor] },
			getStartupExpansionState: () => false,
		};
	}

	it("shows only for an empty session with its normal editor", () => {
		const context = createWelcomeContext();
		expect(interactiveModePrototype.shouldShowWelcomeScreen.call(context)).toBe(true);
		context.session.messages.push({ role: "user" });
		expect(interactiveModePrototype.shouldShowWelcomeScreen.call(context)).toBe(false);
	});

	it("does not return between submission and the first persisted message", () => {
		const context = createWelcomeContext();
		context.welcomeSubmittedSessionId = "fresh";
		expect(interactiveModePrototype.shouldShowWelcomeScreen.call(context)).toBe(false);
		context.session.sessionId = "another-new-session";
		expect(interactiveModePrototype.shouldShowWelcomeScreen.call(context)).toBe(true);
	});

	it("uses conversation layout for an initial command-line prompt", () => {
		const context = createWelcomeContext();
		context.options.initialMessage = "initial prompt";
		expect(interactiveModePrototype.shouldShowWelcomeScreen.call(context)).toBe(false);
	});

	it("gives selectors and expanded help the normal layout", () => {
		const context = createWelcomeContext();
		context.editorContainer.children = [{}];
		expect(interactiveModePrototype.shouldShowWelcomeScreen.call(context)).toBe(false);
		context.editorContainer.children = [context.editor];
		context.getStartupExpansionState = () => true;
		expect(interactiveModePrototype.shouldShowWelcomeScreen.call(context)).toBe(false);
	});
});
