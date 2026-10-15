import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";

// ─── Constants (tweak to taste) ───────────────────────────────────────────────
const WINDOW_MS = 5_000;    // sliding window for tok/s
const TICK_ACTIVE_MS = 250;  // render interval while agent is working
const TICK_IDLE_MS = 1_000; // render interval while idle (footer still updates)
const CHARS_PER_TOKEN = 4;  // initial estimate: 1 token ≈ 4 chars (recalibrated from real usage)
const MIN_CHARS_PER_TOKEN = 1;   // calibration clamp
const MAX_CHARS_PER_TOKEN = 12;  // calibration clamp
const STATUS_KEY = "prompt-clock";
const DIM = "\u001b[90m";   // ANSI dim/gray for the timestamp under each prompt
const SEP = " · ";          // minimal dot separator between footer metrics
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // pending-TTFT spinner

// ─── Footer segments (flip to false to hide a metric) ────────────────────────
const SHOW = {
  task: true,    // ( ) current / last task elapsed time
  total: true,   // cumulative active (interaction) time
  tps: true,     // live tokens/sec (5s sliding window)
  ttft: true,    // time to first token
  prompts: true, // prompt count
};

// ─── State ────────────────────────────────────────────────────────────────────
interface TokenRecord { t: number; chars: number; }
interface PromptRecord { text: string; sentAt: number; displayedAt: number; }

const state = {
  taskStartMs: null as number | null, // start of the current active (working) window
  activeMs: 0,                        // cumulative completed active time
  lastTaskMs: null as number | null,  // elapsed time of the last completed task (null = none yet)
  streaming: false,
  // TTFT / task timing for the current assistant message
  assistantStartMs: null as number | null,
  lastContentChars: 0,      // last known content length (for delta counting)
  firstTokenAt: null as number | null,
  lastTtft: null as number | null,
  // char accumulation for the live sliding window
  tokens: [] as TokenRecord[],
  charsPerToken: CHARS_PER_TOKEN,             // recalibrated from real usage.output
  lastExactTokPerSec: null as number | null,  // exact decode rate of the last message
  calibrationSamples: 0,
  // prompt registry for the under-prompt timestamp
  prompts: [] as PromptRecord[],
  promptIndex: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pad(n: number): string { return n.toString().padStart(2, "0"); }
let spinFrame = 0;
function nextSpin(): string { return SPINNER[spinFrame++ % SPINNER.length]; }
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
// Count generated chars in a message: text, thinking, and tool-call arguments.
// Mirrors what `usage.output` counts so the two can be calibrated against each other.
function generatedChars(content: any): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (!c) continue;
    if (c.type === "text" && typeof c.text === "string") {
      n += c.text.length;
    } else if (c.type === "thinking") {
      const t = typeof c.thinking === "string" ? c.thinking : c.text;
      if (typeof t === "string") n += t.length;
    } else if (c.type === "toolCall" && c.arguments != null) {
      n += typeof c.arguments === "string" ? c.arguments.length : safeJsonLen(c.arguments);
    }
  }
  return n;
}
function safeJsonLen(a: any): number {
  try { return JSON.stringify(a)?.length ?? 0; } catch { return 0; }
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
    .filter((t) => t.t >= now - WINDOW_MS)
    .reduce((sum, t) => sum + t.chars, 0);
  return Math.round((windowChars / state.charsPerToken) * 1000 / WINDOW_MS);
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
    return `${markdown}\n\n${DIM}${hms(match.sentAt)}`;
  } catch {
    return markdown;
  }
};

// ─── Footer rendering ─────────────────────────────────────────────────────────
function render(ui: any) {
  if (!ui || typeof ui.setStatus !== "function") return;
  const taskMs = state.streaming ? currentTaskMs() : state.lastTaskMs;
  // The two time measures sit together with just a space: "(8.2s) 1m 03s".
  const time: string[] = [];
  if (SHOW.task) time.push(`(${taskMs != null ? fmtDur(taskMs) : "--"})`);
  if (SHOW.total) time.push(fmtSession(totalActiveMs()));
  const parts: string[] = [];
  if (SHOW.tps) parts.push(displayTokPerSec());
  if (SHOW.ttft) parts.push(`TTFT ${state.lastTtft != null ? state.lastTtft + "ms" : state.streaming ? nextSpin() : "--"}`);
  if (SHOW.prompts) parts.push(`${state.promptIndex} prompt${state.promptIndex === 1 ? "" : "s"}`);
  const line = [time.join(" "), parts.join(SEP)].filter(Boolean).join(SEP);
  ui.setStatus(STATUS_KEY, line);
}

// ─── Session seeding ──────────────────────────────────────────────────────────
function seedFromSession(sessionManager: any) {
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
  state.charsPerToken = CHARS_PER_TOKEN;
  state.calibrationSamples = 0;
  try {
    const branch = sessionManager?.getBranch ? sessionManager.getBranch() : [];
    let activeSum = 0;
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const message = entry.message ?? entry.entry?.message;
      if (!message) continue;
      if (message.role === "user") {
        state.promptIndex++;
        const display = promptDisplayText(extractUserText(message.content ?? ""));
        state.prompts.push({ text: display, sentAt: message.timestamp ?? Date.now(), displayedAt: Date.now() });
      } else if (message.role === "assistant") {
        const chars = generatedChars(message.content ?? []);
        if (chars > 0) state.tokens.push({ t: message.timestamp ?? Date.now(), chars });
        const out = message.usage?.output;
        if (typeof out === "number" && out > 0) calibrate(chars, out);
        // Reconstruct active time from the real per-message duration Pi records.
        const d = message.durationMs;
        if (typeof d === "number" && d > 0) activeSum += d;
      } else if (message.role === "toolResult") {
        const d = message.durationMs;
        if (typeof d === "number" && d > 0) activeSum += d;
      }
    }
    state.activeMs = activeSum; // actual LLM + tool execution time from the branch
  } catch { /* ignore */ }
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
export default function (pi: any) {
  let tickTimer: NodeJS.Timer | null = null;
  let ui: any = null;

  // Register the markdown transformer once at load time so the prompt-time
  // timestamp is appended under every rendered user prompt in the TUI thread.
  pi.registerMarkdownTransformer(promptTransformer);

  function startTick() {
    stopTick();
    tickTimer = (setInterval(() => render(ui), state.streaming ? TICK_ACTIVE_MS : TICK_IDLE_MS) as NodeJS.Timer);
  }
  function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  // Notify through the UI when available; otherwise write to stderr so the
  // command is useful in print/json modes too.
  function notify(uiCtx: any, hasUI: boolean, msg: string) {
    if (hasUI && uiCtx && typeof uiCtx.notify === "function") {
      uiCtx.notify(msg);
    } else if (process.stderr?.write) {
      process.stderr.write(msg + "\n");
    }
  }

  pi.on("session_start", (_event: any, ctx: any) => {
    ui = ctx.ui;
    seedFromSession(ctx.sessionManager);
    render(ui);
    startTick();
  });

  pi.on("message_start", (event: any, ctx: any) => {
    ui = ctx.ui;
    const message = event.message;
    if (!message) return;
    if (message.role === "user") {
      const now = Date.now();
      const display = promptDisplayText(extractUserText(message.content ?? ""));
      state.prompts.push({ text: display, sentAt: now, displayedAt: now });
      state.promptIndex++;
      render(ui);
      return;
    }
    if (message.role === "assistant") {
      const now = Date.now();
      state.assistantStartMs = now;
      const initialChars = generatedChars(message.content ?? "");
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

  pi.on("message_update", (event: any, ctx: any) => {
    ui = ctx.ui;
    const message = event.message;
    if (!message || message.role !== "assistant") return;
    const now = Date.now();
    const totalChars = generatedChars(message.content ?? "");
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

  pi.on("message_end", (event: any, ctx: any) => {
    ui = ctx.ui;
    const message = event.message;
    if (!message || message.role !== "assistant") return;
    const now = Date.now();
    const totalChars = generatedChars(message.content ?? "");
    if (totalChars > state.lastContentChars) {
      const delta = totalChars - state.lastContentChars;
      state.tokens.push({ t: now, chars: delta });
      state.lastContentChars = totalChars;
    }

    // Learn chars/token and exact decode rate when the provider reported usage.
    const output = message.usage?.output;
    if (typeof output === "number" && output > 0) {
      calibrate(totalChars, output);
      const durationMs = message.durationMs;
      const ttft = state.firstTokenAt != null && state.assistantStartMs != null
        ? state.firstTokenAt - state.assistantStartMs
        : state.lastTtft ?? 0;
      const totalMs = typeof durationMs === "number" && durationMs > 0
        ? durationMs
        : Math.max(now - (state.assistantStartMs ?? now), 1);
      const decodeMs = Math.max(totalMs - ttft, 1);
      state.lastExactTokPerSec = output / (decodeMs / 1000);
    }
    render(ui);
  });

  pi.on("agent_start", (_event: any, ctx: any) => {
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

  pi.on("agent_end", (_event: any, ctx: any) => {
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
    description: "Show pi-prompt-clock summary (active time, tok/s, TTFT, prompts)",
    handler: async (_args: any, ctx: any) => {
      notify(ctx?.ui, !!ctx?.hasUI, summaryText());
    },
  });

  pi.on("session_shutdown", (_event: any, ctx: any) => {
    ui = ctx.ui;
    stopTick();
    const active = totalActiveMs();
    notify(
      ctx?.ui,
      !!ctx?.hasUI,
      `pi-prompt-clock: active=${fmtSession(active)} tok/s=${rateText()} prompts=${state.promptIndex}`,
    );
  });
}
