import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { config, MAX_CHARS_PER_TOKEN, MIN_CHARS_PER_TOKEN } from "./config.ts";

// ─── Constants ────────────────────────────────────────────────────────────────
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // pending-TTFT spinner

// ─── State ────────────────────────────────────────────────────────────────────
interface TokenRecord {
	t: number;
	chars: number;
}
interface PromptRecord {
	text: string;
	sentAt: number;
	displayedAt: number;
}

export const state = {
	taskStartMs: null as number | null, // start of the current active (working) window
	activeMs: 0, // cumulative completed active time
	lastTaskMs: null as number | null, // elapsed time of the last completed task (null = none yet)
	streaming: false,
	// TTFT / task timing for the current assistant message
	assistantStartMs: null as number | null,
	lastContentChars: 0, // last known content length (for delta counting)
	firstTokenAt: null as number | null,
	lastTtft: null as number | null,
	// char accumulation for the live sliding window
	tokens: [] as TokenRecord[],
	charsPerToken: config.charsPerToken, // recalibrated from real usage.output
	lastExactTokPerSec: null as number | null, // exact decode rate of the last message
	calibrationSamples: 0,
	// prompt registry for the under-prompt timestamp
	prompts: [] as PromptRecord[],
	promptIndex: 0,
};

// ─── Formatting helpers ───────────────────────────────────────────────────────
function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
let spinFrame = 0;
export function nextSpin(): string {
	return SPINNER[spinFrame++ % SPINNER.length];
}
export function hms(ts: number): string {
	return pad(new Date(ts).getHours()) + ":" + pad(new Date(ts).getMinutes()) + ":" + pad(new Date(ts).getSeconds());
}
export function fmtDur(ms: number): string {
	const m = Math.floor(ms / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
export function fmtSession(ms: number): string {
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── Message content helpers ──────────────────────────────────────────────────
export function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c && (c as { type?: string }).type === "text")
			.map((c) => (c as { text?: string }).text ?? "")
			.join("");
	}
	return "";
}
// What the TUI renders for a user prompt. For skill-block prompts this is the
// text AFTER the skill block (what parseSkillBlock exposes as userMessage),
// which is exactly what UserMessageComponent passes to markdown transformers.
export function promptDisplayText(text: string): string {
	const m = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (m) {
		const userMessage = m[4]?.trim();
		if (userMessage) return userMessage;
	}
	return text;
}

// The content union seen across user / assistant / tool-result messages.
type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;

// Count generated chars in a message: text, thinking, and tool-call arguments.
// Mirrors what `usage.output` counts so the two can be calibrated against each other.
export function generatedChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const c = raw as ContentBlock;
		if (c.type === "text") n += c.text.length;
		else if (c.type === "thinking") n += c.thinking.length;
		else if (c.type === "toolCall") n += safeJsonLen(c.arguments);
	}
	return n;
}
function safeJsonLen(a: unknown): number {
	try {
		return JSON.stringify(a)?.length ?? 0;
	} catch {
		return 0;
	}
}

// ─── Timing / rate math ───────────────────────────────────────────────────────
// How long the current step/task has been running (0 when idle).
export function currentTaskMs(): number {
	return state.streaming && state.taskStartMs != null ? Date.now() - state.taskStartMs : 0;
}
// Cumulative active (interaction) time: completed windows + the running one.
// Grows only while the agent is actually working, never during idle.
export function totalActiveMs(): number {
	return state.activeMs + currentTaskMs();
}
export function windowTokPerSec(): number {
	const now = Date.now();
	const windowChars = state.tokens
		.filter((t) => t.t >= now - config.windowMs)
		.reduce((sum, t) => sum + t.chars, 0);
	return Math.round((windowChars / state.charsPerToken) * 1000 / config.windowMs);
}
// Learn chars/token from a finished message's real usage.output (EMA, clamped).
export function calibrate(chars: number, outputTokens: number) {
	if (chars <= 0 || outputTokens <= 0) return;
	const ratio = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, chars / outputTokens));
	state.charsPerToken = state.calibrationSamples === 0 ? ratio : state.charsPerToken * 0.7 + ratio * 0.3;
	state.calibrationSamples++;
}
// Numeric rate: live estimate while streaming, exact decode rate once idle.
export function rateText(): string {
	if (state.streaming) return `~${windowTokPerSec()}`;
	if (state.lastExactTokPerSec != null) return state.lastExactTokPerSec.toFixed(1);
	return String(windowTokPerSec());
}
export function displayTokPerSec(): string {
	return `${rateText()} tok/s`;
}

// ─── Session seeding ──────────────────────────────────────────────────────────
export function seedFromSession(sessionManager: ExtensionContext["sessionManager"]) {
	state.taskStartMs = null;
	state.activeMs = 0;
	state.lastTaskMs = null;
	state.streaming = false;
	state.assistantStartMs = null;
	state.lastContentChars = 0;
	state.firstTokenAt = null;
	state.lastTtft = null;
	state.tokens = [];
	state.prompts = [];
	state.promptIndex = 0;
	state.lastExactTokPerSec = null;
	state.charsPerToken = config.charsPerToken;
	state.calibrationSamples = 0;
	try {
		const branch = sessionManager.getBranch();
		let activeSum = 0;
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") {
				state.promptIndex++;
				const display = promptDisplayText(extractUserText(message.content));
				state.prompts.push({ text: display, sentAt: message.timestamp, displayedAt: Date.now() });
			} else if (message.role === "assistant") {
				const chars = generatedChars(message.content);
				if (chars > 0) state.tokens.push({ t: message.timestamp, chars });
				const out = message.usage.output;
				if (out > 0) calibrate(chars, out);
				// Reconstruct active time from the real per-message duration Pi records.
				const d = message.durationMs;
				if (typeof d === "number" && d > 0) activeSum += d;
			} else if (message.role === "toolResult") {
				const d = message.durationMs;
				if (typeof d === "number" && d > 0) activeSum += d;
			}
		}
		state.activeMs = activeSum; // actual LLM + tool execution time from the branch
	} catch {
		/* ignore */
	}
}
