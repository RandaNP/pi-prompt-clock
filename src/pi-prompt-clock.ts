import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUS_KEY = "prompt-clock";
const CONFIG_FILE = "pi-prompt-clock.json";
const TICK_ACTIVE_MS = 250; // render interval while agent is working
const TICK_IDLE_MS = 1_000; // render interval while idle (footer still updates)
const MIN_WINDOW_MS = 250;
const MAX_WINDOW_MS = 60_000;
const MIN_CHARS_PER_TOKEN = 1; // calibration clamp
const MAX_CHARS_PER_TOKEN = 12; // calibration clamp
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // pending-TTFT spinner

// ─── Config ───────────────────────────────────────────────────────────────────
interface ShowConfig {
	task: boolean;
	total: boolean;
	tps: boolean;
	ttft: boolean;
	prompts: boolean;
}
interface ColorsConfig {
	footer?: string;
	timestamp?: string;
}
interface Config {
	show: ShowConfig;
	separator: string;
	windowMs: number;
	charsPerToken: number;
	colors: ColorsConfig;
}

const DEFAULT_CONFIG: Config = {
	show: { task: true, total: true, tps: true, ttft: true, prompts: true },
	separator: " · ",
	windowMs: 5_000,
	charsPerToken: 4,
	colors: {},
};

// Color resolution. `setStatus` and the markdown transformer have no theme
// object, so colors are hardcoded ANSI. A `#rrggbb` value becomes truecolor;
// named tokens cover theme-agnostic fallbacks.
interface ColorPair {
	open: string;
	close: string;
}
const NO_COLOR: ColorPair = { open: "", close: "" };
const COLOR_TOKENS: Record<string, ColorPair> = {
	none: NO_COLOR,
	off: NO_COLOR,
	default: NO_COLOR,
	faint: { open: "\u001b[2m", close: "\u001b[22m" },
	dim: { open: "\u001b[90m", close: "\u001b[39m" },
	gray: { open: "\u001b[37m", close: "\u001b[39m" },
	grey: { open: "\u001b[37m", close: "\u001b[39m" },
	bright: { open: "\u001b[97m", close: "\u001b[39m" },
};
function colorPair(spec: string): ColorPair {
	const s = spec.trim().toLowerCase();
	if (s in COLOR_TOKENS) return COLOR_TOKENS[s];
	const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
	if (m) {
		let h = m[1];
		if (h.length === 3)
			h = h
				.split("")
				.map((c) => c + c)
				.join("");
		const r = parseInt(h.slice(0, 2), 16);
		const g = parseInt(h.slice(2, 4), 16);
		const b = parseInt(h.slice(4, 6), 16);
		return { open: `\u001b[38;2;${r};${g};${b}m`, close: "\u001b[39m" };
	}
	return NO_COLOR;
}
function isValidColor(spec: unknown): spec is string {
	if (typeof spec !== "string") return false;
	const s = spec.trim().toLowerCase();
	return s in COLOR_TOKENS || /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s);
}
// Catppuccin Mocha `dim` (overlay1) and `overlay2`, chosen by theme name;
// theme-agnostic `faint`/`gray` otherwise.
const CATPPUCCIN_COLORS = { footer: "#7f849c", timestamp: "#9399b2" };
const FALLBACK_COLORS = { footer: "faint", timestamp: "gray" };
let footerColor: ColorPair = colorPair(FALLBACK_COLORS.footer);
let timestampColor: ColorPair = colorPair(FALLBACK_COLORS.timestamp);
let resolvedColors = { ...FALLBACK_COLORS };
function resolveColors(isCatppuccin: boolean): void {
	const base = isCatppuccin ? CATPPUCCIN_COLORS : FALLBACK_COLORS;
	const footer = config.colors.footer ?? base.footer;
	const timestamp = config.colors.timestamp ?? base.timestamp;
	footerColor = colorPair(footer);
	timestampColor = colorPair(timestamp);
	resolvedColors = { footer, timestamp };
}

// Effective config (defaults overlaid with the config file), plus the set of
// keys that came from the file (for `/prompt-clock config` provenance).
const config: Config = structuredClone(DEFAULT_CONFIG);
const configSource = new Set<string>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
// Parse a number from a JSON value or command string, clamped to [min, max].
function parseNumber(v: unknown, min: number, max: number): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
	if (!Number.isFinite(n)) return null;
	return Math.min(max, Math.max(min, n));
}
function parseBool(v: string): boolean | null {
	const s = v.trim().toLowerCase();
	if (["true", "1", "on", "yes"].includes(s)) return true;
	if (["false", "0", "off", "no"].includes(s)) return false;
	return null;
}

function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

// Read <agent-dir>/pi-prompt-clock.json into `config`, collecting warnings for
// invalid values (which fall back to defaults). Never throws.
function loadConfigFromDisk(): string[] {
	const next = structuredClone(DEFAULT_CONFIG);
	const warnings: string[] = [];
	configSource.clear();
	const path = configPath();

	if (existsSync(path)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch (err) {
			warnings.push(`cannot parse ${path}: ${(err as Error).message}`);
			raw = undefined;
		}
		if (isPlainObject(raw)) {
			if (raw.show !== undefined) {
				if (isPlainObject(raw.show)) {
					for (const name of Object.keys(next.show) as (keyof ShowConfig)[]) {
						const v = raw.show[name];
						if (typeof v === "boolean") {
							next.show[name] = v;
							configSource.add(`show.${name}`);
						} else if (v !== undefined) {
							warnings.push(`show.${name} must be a boolean`);
						}
					}
				} else {
					warnings.push("show must be an object");
				}
			}
			if (raw.separator !== undefined) {
				if (typeof raw.separator === "string") {
					next.separator = raw.separator;
					configSource.add("separator");
				} else {
					warnings.push("separator must be a string");
				}
			}
			if (raw.windowMs !== undefined) {
				const n = parseNumber(raw.windowMs, MIN_WINDOW_MS, MAX_WINDOW_MS);
				if (n !== null) {
					next.windowMs = Math.round(n);
					configSource.add("windowMs");
				} else {
					warnings.push(`windowMs must be a number ${MIN_WINDOW_MS}..${MAX_WINDOW_MS}`);
				}
			}
			if (raw.charsPerToken !== undefined) {
				const n = parseNumber(raw.charsPerToken, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN);
				if (n !== null) {
					next.charsPerToken = n;
					configSource.add("charsPerToken");
				} else {
					warnings.push(`charsPerToken must be a number ${MIN_CHARS_PER_TOKEN}..${MAX_CHARS_PER_TOKEN}`);
				}
			}
			if (raw.colors !== undefined) {
				if (isPlainObject(raw.colors)) {
					for (const name of ["footer", "timestamp"] as const) {
						const v = raw.colors[name];
						if (v === undefined) continue;
						if (isValidColor(v)) {
							next.colors[name] = v;
							configSource.add(`colors.${name}`);
						} else {
							warnings.push(`colors.${name} must be #rrggbb or a known token`);
						}
					}
				} else {
					warnings.push("colors must be an object");
				}
			}
		} else if (raw !== undefined) {
			warnings.push("config root must be an object");
		}
	}

	Object.assign(config, next);
	return warnings;
}

// Raw file contents (for edits), preserving unknown keys the user may have added.
function readRawConfig(): Record<string, unknown> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return isPlainObject(raw) ? raw : {};
	} catch {
		return {};
	}
}
function writeRawConfig(raw: Record<string, unknown>): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}

// Returns an error message, or null on success.
function setConfigValue(raw: Record<string, unknown>, key: string, value: string): string | null {
	if (key.startsWith("show.")) {
		const name = key.slice(5);
		if (!(name in config.show)) return `unknown key: ${key}`;
		const b = parseBool(value);
		if (b === null) return `show.${name} expects true/false`;
		const show = isPlainObject(raw.show) ? raw.show : {};
		show[name] = b;
		raw.show = show;
		return null;
	}
	if (key === "separator") {
		raw.separator = value;
		return null;
	}
	if (key === "windowMs") {
		const n = parseNumber(value, MIN_WINDOW_MS, MAX_WINDOW_MS);
		if (n === null) return `windowMs expects a number ${MIN_WINDOW_MS}..${MAX_WINDOW_MS}`;
		raw.windowMs = Math.round(n);
		return null;
	}
	if (key === "charsPerToken") {
		const n = parseNumber(value, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN);
		if (n === null) return `charsPerToken expects a number ${MIN_CHARS_PER_TOKEN}..${MAX_CHARS_PER_TOKEN}`;
		raw.charsPerToken = n;
		return null;
	}
	if (key === "colors.footer" || key === "colors.timestamp") {
		if (!isValidColor(value)) return `${key} must be #rrggbb or faint/dim/gray/bright/none`;
		const name = key.slice("colors.".length);
		const colors = isPlainObject(raw.colors) ? raw.colors : {};
		colors[name] = value;
		raw.colors = colors;
		return null;
	}
	return `unknown key: ${key}`;
}

function resetConfigValue(raw: Record<string, unknown>, key: string): string | null {
	if (key === "all") {
		for (const k of Object.keys(raw)) delete raw[k];
		return null;
	}
	if (key.startsWith("show.")) {
		const name = key.slice(5);
		if (!(name in config.show)) return `unknown key: ${key}`;
		if (isPlainObject(raw.show)) {
			delete raw.show[name];
			if (Object.keys(raw.show).length === 0) delete raw.show;
		}
		return null;
	}
	if (key === "separator" || key === "windowMs" || key === "charsPerToken") {
		delete raw[key];
		return null;
	}
	if (key === "colors.footer" || key === "colors.timestamp") {
		const name = key.slice("colors.".length);
		if (isPlainObject(raw.colors)) {
			delete raw.colors[name];
			if (Object.keys(raw.colors).length === 0) delete raw.colors;
		}
		return null;
	}
	return `unknown key: ${key}`;
}

// Rows for `/prompt-clock config`, with provenance.
function configLines(): string[] {
	const rows: [string, string][] = [
		["show.task", String(config.show.task)],
		["show.total", String(config.show.total)],
		["show.tps", String(config.show.tps)],
		["show.ttft", String(config.show.ttft)],
		["show.prompts", String(config.show.prompts)],
		["separator", JSON.stringify(config.separator)],
		["windowMs", String(config.windowMs)],
		["charsPerToken", String(config.charsPerToken)],
		["colors.footer", configSource.has("colors.footer") ? resolvedColors.footer : `${resolvedColors.footer} (auto)`],
		[
			"colors.timestamp",
			configSource.has("colors.timestamp") ? resolvedColors.timestamp : `${resolvedColors.timestamp} (auto)`,
		],
	];
	const width = Math.max(...rows.map(([k]) => k.length));
	return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v.padEnd(10)}  ${configSource.has(k) ? "file" : "default"}`);
}

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

const state = {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
let spinFrame = 0;
function nextSpin(): string {
	return SPINNER[spinFrame++ % SPINNER.length];
}
function hms(ts: number): string {
	return pad(new Date(ts).getHours()) + ":" + pad(new Date(ts).getMinutes()) + ":" + pad(new Date(ts).getSeconds());
}
function fmtDur(ms: number): string {
	const m = Math.floor(ms / 60_000);
	const s = (ms % 60_000) / 1000;
	return m > 0 ? `${m}m ${(s | 0)}s` : `${s.toFixed(1)}s`;
}
function fmtSession(ms: number): string {
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function extractUserText(content: unknown): string {
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
function promptDisplayText(text: string): string {
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
function generatedChars(content: unknown): number {
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

// How long the current step/task has been running (0 when idle).
function currentTaskMs(): number {
	return state.streaming && state.taskStartMs != null ? Date.now() - state.taskStartMs : 0;
}
// Cumulative active (interaction) time: completed windows + the running one.
// Grows only while the agent is actually working, never during idle.
function totalActiveMs(): number {
	return state.activeMs + currentTaskMs();
}
function windowTokPerSec(): number {
	const now = Date.now();
	const windowChars = state.tokens
		.filter((t) => t.t >= now - config.windowMs)
		.reduce((sum, t) => sum + t.chars, 0);
	return Math.round((windowChars / state.charsPerToken) * 1000 / config.windowMs);
}
// Learn chars/token from a finished message's real usage.output (EMA, clamped).
function calibrate(chars: number, outputTokens: number) {
	if (chars <= 0 || outputTokens <= 0) return;
	const ratio = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, chars / outputTokens));
	state.charsPerToken = state.calibrationSamples === 0 ? ratio : state.charsPerToken * 0.7 + ratio * 0.3;
	state.calibrationSamples++;
}
// Numeric rate: live estimate while streaming, exact decode rate once idle.
function rateText(): string {
	if (state.streaming) return `~${windowTokPerSec()}`;
	if (state.lastExactTokPerSec != null) return state.lastExactTokPerSec.toFixed(1);
	return String(windowTokPerSec());
}
function displayTokPerSec(): string {
	return `${rateText()} tok/s`;
}

// ─── Prompt-time transformer (rendered under each prompt) ────────────────────
const promptTransformer: MarkdownTransformer = (markdown) => {
	try {
		// Match the rendered markdown against known prompt display texts.
		// First match wins (rare duplicate-prompt case: earliest time shown).
		const match = state.prompts.find((p) => p.text === markdown);
		if (!match) return markdown; // graceful: no match → no timestamp
		return `${markdown}\n\n${timestampColor.open}${hms(match.sentAt)}${timestampColor.close}`;
	} catch {
		return markdown;
	}
};

// ─── Footer rendering ─────────────────────────────────────────────────────────
function render(ui: ExtensionUIContext | null) {
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
	ui.setStatus(STATUS_KEY, `${footerColor.open}${line}${footerColor.close}`);
}

// ─── Session seeding ──────────────────────────────────────────────────────────
function seedFromSession(sessionManager: ExtensionContext["sessionManager"]) {
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

// ─── Metrics summary ──────────────────────────────────────────────────────────
function summaryText(): string {
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
		}, state.streaming ? TICK_ACTIVE_MS : TICK_IDLE_MS);
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
