import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	config,
	configLines,
	configPath,
	loadConfigFromDisk,
	readRawConfig,
	resetConfigValue,
	resolveColors,
	setConfigValue,
	writeRawConfig,
} from "./config.ts";
import {
	calibrate,
	extractUserText,
	fmtSession,
	generatedChars,
	promptDisplayText,
	rateText,
	seedFromSession,
	state,
	totalActiveMs,
} from "./metrics.ts";
import { promptTransformer, render, resetStatusCache, summaryText } from "./render.ts";

const TICK_MS = 1_000; // periodic footer refresh (elapsed time / TTFT spinner while streaming)

// ─── Extension factory ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let tickTimer: ReturnType<typeof setInterval> | null = null;
	let ui: ExtensionUIContext | null = null;

	// Register the markdown transformer once at load time so the prompt-time
	// timestamp is appended under every rendered user prompt in the TUI thread.
	pi.registerMarkdownTransformer(promptTransformer);

	function startTick() {
		stopTick();
		tickTimer = setInterval(() => {
			// Never let a render error escape and crash Pi.
			try {
				render(ui);
			} catch {
				/* ignore */
			}
		}, TICK_MS);
		// Do not let the tick timer keep the process alive on its own.
		const handle = tickTimer as unknown as { unref?: () => void };
		handle.unref?.();
	}
	function stopTick() {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	}

	// Notify through the UI when available; otherwise write to stderr so the
	// command is useful in print/json modes too.
	function notify(uiCtx: ExtensionUIContext | null | undefined, hasUI: boolean, msg: string) {
		if (hasUI && uiCtx) {
			uiCtx.notify(msg);
		} else if (process.stderr?.write) {
			process.stderr.write(msg + "\n");
		}
	}
	function themeIsCatppuccin(): boolean {
		try {
			const theme = pi.getSettings().theme;
			return typeof theme === "string" && theme.toLowerCase().includes("catppuccin");
		} catch {
			return false;
		}
	}
	function reloadConfig(ctx: ExtensionContext): string[] {
		const warnings = loadConfigFromDisk();
		resolveColors(themeIsCatppuccin());
		state.charsPerToken = config.charsPerToken;
		state.calibrationSamples = 0;
		render(ui);
		if (warnings.length > 0) notify(ctx.ui, ctx.hasUI, `pi-prompt-clock config: ${warnings.join("; ")}`);
		return warnings;
	}

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		const warnings = loadConfigFromDisk();
		resolveColors(themeIsCatppuccin());
		state.charsPerToken = config.charsPerToken;
		seedFromSession(ctx.sessionManager);
		resetStatusCache();
		render(ui);
		startTick();
		if (warnings.length > 0) notify(ctx.ui, ctx.hasUI, `pi-prompt-clock config: ${warnings.join("; ")}`);
	});

	pi.on("message_start", (event, ctx) => {
		ui = ctx.ui;
		const message = event.message;
		if (message.role === "user") {
			const now = Date.now();
			const display = promptDisplayText(extractUserText(message.content));
			state.prompts.push({ text: display, sentAt: now, displayedAt: now });
			state.promptIndex++;
			render(ui);
			return;
		}
		if (message.role === "assistant") {
			const now = Date.now();
			state.assistantStartMs = now;
			const initialChars = generatedChars(message.content);
			if (initialChars > 0) state.tokens.push({ t: now, chars: initialChars });
			state.lastContentChars = initialChars;
			state.firstTokenAt = null;
			// lastTtft is reset at agent_start, so it stays blank only if never measured.
			if (!state.streaming) {
				state.streaming = true;
				state.taskStartMs = now;
			}
			render(ui);
		}
	});

	pi.on("message_update", (event, ctx) => {
		ui = ctx.ui;
		const message = event.message;
		if (message.role !== "assistant") return;
		const now = Date.now();
		const totalChars = generatedChars(message.content);
		if (totalChars > state.lastContentChars) {
			const delta = totalChars - state.lastContentChars;
			state.tokens.push({ t: now, chars: delta });
			state.lastContentChars = totalChars;
			if (state.firstTokenAt == null) {
				state.firstTokenAt = now;
				state.lastTtft = state.assistantStartMs != null ? now - state.assistantStartMs : now;
			}
			render(ui);
		}
	});

	pi.on("message_end", (event, ctx) => {
		ui = ctx.ui;
		const message = event.message;
		if (message.role !== "assistant") return;
		const now = Date.now();
		const totalChars = generatedChars(message.content);
		if (totalChars > state.lastContentChars) {
			const delta = totalChars - state.lastContentChars;
			state.tokens.push({ t: now, chars: delta });
			state.lastContentChars = totalChars;
		}

		// Learn chars/token and exact decode rate when the provider reported usage.
		const output = message.usage.output;
		if (output > 0) {
			calibrate(totalChars, output);
			const durationMs = message.durationMs;
			const ttft =
				state.firstTokenAt != null && state.assistantStartMs != null
					? state.firstTokenAt - state.assistantStartMs
					: (state.lastTtft ?? 0);
			const totalMs =
				typeof durationMs === "number" && durationMs > 0
					? durationMs
					: Math.max(now - (state.assistantStartMs ?? now), 1);
			const decodeMs = Math.max(totalMs - ttft, 1);
			state.lastExactTokPerSec = output / (decodeMs / 1000);
		}
		render(ui);
	});

	pi.on("agent_start", (_event, ctx) => {
		ui = ctx.ui;
		if (!state.streaming) {
			state.streaming = true;
			state.firstTokenAt = null;
			// A new task clears the previous TTFT; render shows a spinner until the first token.
			state.lastTtft = null;
			state.assistantStartMs = null;
			state.taskStartMs = Date.now();
			render(ui);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		ui = ctx.ui;
		const now = Date.now();
		if (state.streaming) {
			if (state.taskStartMs != null) {
				const taskMs = now - state.taskStartMs;
				state.activeMs += taskMs;
				state.lastTaskMs = taskMs;
			}
			state.taskStartMs = null;
			state.streaming = false;
			render(ui);
		}
	});

	pi.registerCommand("/prompt-clock", {
		description:
			"Show metrics, or manage settings: /prompt-clock config [show | set <key> <value> | reset <key|all>]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "config") {
				const sub = parts[1];
				if (!sub || sub === "show") {
					notify(ctx.ui, ctx.hasUI, `pi-prompt-clock config  (${configPath()})\n${configLines().join("\n")}`);
					return;
				}
				if (sub === "set") {
					const key = parts[2];
					const value = parts.slice(3).join(" ");
					if (!key || value === "") {
						notify(ctx.ui, ctx.hasUI, "usage: /prompt-clock config set <key> <value>");
						return;
					}
					const raw = readRawConfig();
					const err = setConfigValue(raw, key, value);
					if (err) {
						notify(ctx.ui, ctx.hasUI, `pi-prompt-clock: ${err}`);
						return;
					}
					writeRawConfig(raw);
					const warnings = reloadConfig(ctx);
					notify(
						ctx.ui,
						ctx.hasUI,
						warnings.length > 0
							? `pi-prompt-clock: set ${key} (warnings: ${warnings.join("; ")})`
							: `pi-prompt-clock: set ${key} = ${value}`,
					);
					return;
				}
				if (sub === "reset") {
					const key = parts[2] ?? "all";
					const raw = readRawConfig();
					const err = resetConfigValue(raw, key);
					if (err) {
						notify(ctx.ui, ctx.hasUI, `pi-prompt-clock: ${err}`);
						return;
					}
					writeRawConfig(raw);
					reloadConfig(ctx);
					notify(ctx.ui, ctx.hasUI, `pi-prompt-clock: reset ${key}`);
					return;
				}
				notify(ctx.ui, ctx.hasUI, "usage: /prompt-clock config [show | set <key> <value> | reset <key|all>]");
				return;
			}
			notify(ctx.ui, ctx.hasUI, summaryText());
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ui = ctx.ui;
		stopTick();
		const active = totalActiveMs();
		notify(
			ctx.ui,
			ctx.hasUI,
			`pi-prompt-clock: active=${fmtSession(active)} tok/s=${rateText()} prompts=${state.promptIndex}`,
		);
	});
}
