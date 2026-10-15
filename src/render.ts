import type { ExtensionUIContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { config, getFooterColorPair, getTimestampColorPair } from "./config.ts";
import {
	currentTaskMs,
	displayTokPerSec,
	fmtDur,
	fmtSession,
	hms,
	nextSpin,
	rateText,
	state,
	totalActiveMs,
} from "./metrics.ts";

const STATUS_KEY = "prompt-clock";

// ─── Prompt-time transformer (rendered under each prompt) ────────────────────
export const promptTransformer: MarkdownTransformer = (markdown) => {
	try {
		// Match the rendered markdown against known prompt display texts.
		// First match wins (rare duplicate-prompt case: earliest time shown).
		const match = state.prompts.find((p) => p.text === markdown);
		if (!match) return markdown; // graceful: no match → no timestamp
		const color = getTimestampColorPair();
		return `${markdown}\n\n${color.open}${hms(match.sentAt)}${color.close}`;
	} catch {
		return markdown;
	}
};

// ─── Footer rendering ─────────────────────────────────────────────────────────
export function render(ui: ExtensionUIContext | null) {
	if (!ui) return;
	const taskMs = state.streaming ? currentTaskMs() : state.lastTaskMs;
	// The two time measures sit together with just a space: "(8.2s) 1m 03s".
	const time: string[] = [];
	if (config.show.task) time.push(`(${taskMs != null ? fmtDur(taskMs) : "--"})`);
	if (config.show.total) time.push(fmtSession(totalActiveMs()));
	const parts: string[] = [];
	if (config.show.tps) parts.push(displayTokPerSec());
	if (config.show.ttft)
		parts.push(`TTFT ${state.lastTtft != null ? state.lastTtft + "ms" : state.streaming ? nextSpin() : "--"}`);
	if (config.show.prompts) parts.push(`${state.promptIndex} prompt${state.promptIndex === 1 ? "" : "s"}`);
	const line = [time.join(" "), parts.join(config.separator)].filter(Boolean).join(config.separator);
	const color = getFooterColorPair();
	ui.setStatus(STATUS_KEY, `${color.open}${line}${color.close}`);
}

// ─── Metrics summary ──────────────────────────────────────────────────────────
export function summaryText(): string {
	const active = totalActiveMs();
	return [
		"pi-prompt-clock",
		`  active:   ${fmtSession(active)}`,
		`  tok/s:    ${rateText()}`,
		`  TTFT:     ${state.lastTtft != null ? state.lastTtft + "ms" : "n/a"}`,
		`  chars/tk: ${state.charsPerToken.toFixed(2)}`,
		`  prompts:  ${state.promptIndex}`,
	].join("\n");
}
