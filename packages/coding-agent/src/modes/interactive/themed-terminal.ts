import type { Terminal } from "@anvaya.sh/padma-tui";
import { theme } from "./theme/theme.ts";

/** Apply Padma's text colors while retaining the user's terminal background. */
export function createThemedTerminal(
	terminal: Terminal,
	onAnimationFrame?: () => void,
	onRefresh?: () => void,
): Terminal {
	let animation: ReturnType<typeof setInterval> | undefined;
	let refresh: ReturnType<typeof setInterval> | undefined;
	return new Proxy(terminal, {
		get(target, property) {
			if (property === "start")
				return (...args: Parameters<Terminal["start"]>) => {
					target.start(...args);
					if (onAnimationFrame && !animation) {
						animation = setInterval(() => {
							if (theme.name === "padma") onAnimationFrame();
						}, 50);
						animation.unref?.();
					}
					// Tips keep rotating when decorative animation is disabled.
					if (onRefresh && !refresh) {
						refresh = setInterval(onRefresh, 30000);
						refresh.unref?.();
					}
				};
			if (property === "stop")
				return () => {
					if (animation) clearInterval(animation);
					animation = undefined;
					if (refresh) clearInterval(refresh);
					refresh = undefined;
					target.stop();
				};
			if (property === "write") {
				return (data: string) => {
					if (theme.name !== "padma") return target.write(data);
					const foreground = theme.getFgAnsi("text");
					// Restore only the foreground; component backgrounds remain local to their panels.
					const styled = data.replace(/\x1b\[([\d;:]*)m/g, (sequence: string, parameters: string) => {
						const codes = parameters.split(";");
						let resetForeground = false;
						for (let i = 0; i < codes.length; i++) {
							const code = Number(codes[i].split(":")[0]);
							if (code === 0 || code === 39) resetForeground = true;
							if (code === 38 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
								resetForeground = false;
							}
							// RGB/indexed color operands are colors, not reset instructions.
							if ([38, 48, 58].includes(code) && !codes[i].includes(":")) {
								i += codes[i + 1] === "2" ? 4 : codes[i + 1] === "5" ? 2 : 0;
							}
						}
						return sequence + (resetForeground ? foreground : "");
					});
					target.write(`${foreground}${styled}\x1b[49;39m`);
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
