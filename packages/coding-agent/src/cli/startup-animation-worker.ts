import { writeSync } from "node:fs";
import { workerData } from "node:worker_threads";
import { LaunchLogoAnimation } from "./launch-animation.ts";

export interface StartupAnimationData {
	state: SharedArrayBuffer;
	startedAt: number;
	fd: number;
}

// Shared slots: stop, in-flight write, terminal width, terminal height, completed frames.
const data = workerData as StartupAnimationData;
const state = new Int32Array(data.state);
const logo = new LaunchLogoAnimation();
const frameInterval = 1000 / 60;
let nextFrame = performance.now();

function draw(): void {
	if (Atomics.load(state, 0)) return;
	const width = Math.max(1, Atomics.load(state, 2));
	const height = Math.max(1, Atomics.load(state, 3));
	const frame = `\x1b8${logo.render(width, height, performance.now() - data.startedAt).join("\r\n")}`;
	Atomics.store(state, 1, 1);
	try {
		// Recheck after rendering: the main thread may already have handed the terminal to the TUI.
		if (!Atomics.load(state, 0)) {
			// Worker stdout is forwarded through the parent event loop. Write directly to the shared
			// descriptor so synchronous runtime loading cannot pause presentation.
			writeSync(data.fd, frame);
			Atomics.add(state, 4, 1);
		}
	} finally {
		Atomics.store(state, 1, 0);
		Atomics.notify(state, 1);
	}
	if (Atomics.load(state, 0)) return;
	nextFrame = Math.max(nextFrame + frameInterval, performance.now());
	setTimeout(draw, Math.max(1, nextFrame - performance.now()));
}

draw();
