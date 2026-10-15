import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────────
const CONFIG_FILE = "pi-prompt-clock.json";
const MIN_WINDOW_MS = 250;
const MAX_WINDOW_MS = 60_000;
export const MIN_CHARS_PER_TOKEN = 1; // calibration clamp
export const MAX_CHARS_PER_TOKEN = 12; // calibration clamp

// ─── Config schema ────────────────────────────────────────────────────────────
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

// Effective config (defaults overlaid with the config file), plus the set of
// keys that came from the file (for `/prompt-clock config` provenance).
export const config: Config = structuredClone(DEFAULT_CONFIG);
const configSource = new Set<string>();

// ─── Colors ───────────────────────────────────────────────────────────────────
// `setStatus` and the markdown transformer have no theme object, so colors are
// hardcoded ANSI. A `#rrggbb` value becomes truecolor; named tokens cover
// theme-agnostic fallbacks.
export interface ColorPair {
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

// Recompute the active color pairs from the config overrides and theme class.
// Exposed via getters so importers always read the current pairs.
export function resolveColors(isCatppuccin: boolean): void {
	const base = isCatppuccin ? CATPPUCCIN_COLORS : FALLBACK_COLORS;
	const footer = config.colors.footer ?? base.footer;
	const timestamp = config.colors.timestamp ?? base.timestamp;
	footerColor = colorPair(footer);
	timestampColor = colorPair(timestamp);
	resolvedColors = { footer, timestamp };
}
export function getFooterColorPair(): ColorPair {
	return footerColor;
}
export function getTimestampColorPair(): ColorPair {
	return timestampColor;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// ─── Load / save ──────────────────────────────────────────────────────────────
export function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

// Read <agent-dir>/pi-prompt-clock.json into `config`, collecting warnings for
// invalid values (which fall back to defaults). Never throws.
export function loadConfigFromDisk(): string[] {
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
export function readRawConfig(): Record<string, unknown> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return isPlainObject(raw) ? raw : {};
	} catch {
		return {};
	}
}
export function writeRawConfig(raw: Record<string, unknown>): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}

// Returns an error message, or null on success.
export function setConfigValue(raw: Record<string, unknown>, key: string, value: string): string | null {
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

export function resetConfigValue(raw: Record<string, unknown>, key: string): string | null {
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
export function configLines(): string[] {
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
