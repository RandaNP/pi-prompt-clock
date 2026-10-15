// Focused stub test for pi-prompt-clock.ts (run with: node --experimental-strip-types)
// Verifies: factory loads, no crash, icon-less prompt timestamp, all-metrics footer, /prompt-clock.
const EXT = new URL("../src/index.ts", import.meta.url).href;
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeSessionManager() {
  const entries = [];
  return { getBranch: () => entries };
}

const { default: factory } = await import(EXT);

let passCount = 0, failCount = 0;
function ok(cond, msg) { if (cond) { passCount++; console.log(`  ✓ ${msg}`); } else { failCount++; console.log(`  ✗ ${msg}`); } }

// Build a stub pi/ctx. Captures on(), registerMarkdownTransformer(), registerCommand().
function build(handlers = {}, opts = {}) {
  const captures = { status: [], notify: [], mdTransformer: null, commands: {} };
  const ctx = {
    hasUI: opts.hasUI ?? true,
    mode: (opts.hasUI ?? true) ? "tui" : "print",
    sessionManager: opts.sessionManager ?? makeSessionManager(),
    model: { provider: "local", id: "bonsai2" },
    ui: {
      notify: (m) => { captures.notify.push(m); },
      setStatus: (k, v) => { captures.status.push(v); },
      setFooter: () => {},
      setWorkingMessage: () => {},
      select: async () => "",
      confirm: async () => true,
      input: async () => "",
      onTerminalInput: () => () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
    },
  };
  const pi = {
    on: (t, h) => { (handlers[t] ?? (handlers[t] = [])).push(h); },
    registerMarkdownTransformer: (t) => { captures.mdTransformer = t; },
    registerCommand: (name, { handler }) => { captures.commands[name] = handler; },
    getSettings: () => opts.settings ?? { theme: "system" },
  };
  factory(pi);
  // Event handlers receive (event, ctx) — ctx carries ui/hasUI/sessionManager.
  const call = (t, p) => { for (const h of handlers[t] ?? []) h(p, ctx); };
  const cmd = async (name, args = "") => {
    const h = captures.commands[name];
    if (h) await h(args, ctx);
  };
  return { call, captures, cmd };
}

// ─── 1. load & idle footer (all metrics visible) ─────────────────────────────
console.log("[1] load & idle footer");
let t = build({}, {});
t.call("session_start", { type: "session_start" });
const last = t.captures.status[t.captures.status.length - 1];
ok(typeof last === "string" && last.includes("(") && last.includes(")"), `idle footer has task time in ( ): ${last}`);
ok(last.includes("·"), `footer uses dot separator: ${last}`);
ok(!last.includes(") ·"), `no separator between the time measures: ${last}`);
ok(last.includes("tok/s") && last.includes("TTFT"), `idle footer shows all metrics: ${last}`);
ok(!last.includes("⏱") && !last.includes("Σ"), `no icons in footer: ${last}`);
ok(t.captures.mdTransformer, "markdown transformer registered at load");
ok(Object.keys(t.captures.commands).includes("/prompt-clock"), "/prompt-clock command registered");

// ─── 2. prompt transformer: timestamp, no icon ───────────────────────────────
console.log("[2] prompt transformer");
const tr = t.captures.mdTransformer;
t.call("message_start", { type: "message_start", message: { role: "user", content: "Hello world", timestamp: Date.now() } });
const out = tr("Hello world");
ok(!out.includes("🕒"), `no icon under prompt: ${JSON.stringify(out)}`);
ok(out.includes("Hello world"), "original prompt preserved");
ok(/\d{2}:\d{2}:\d{2}/.test(out), "timestamp present");
const noMatch = tr("Not a prompt");
ok(noMatch === "Not a prompt", "no-match returns original");
t.call("message_start", {
  type: "message_start",
  message: { role: "user", content: '<skill name="foo" location="bar">\ncontent\n</skill>\n\nActual task here', timestamp: Date.now() },
});
const skillOut = tr("Actual task here");
ok(/\d{2}:\d{2}:\d{2}/.test(skillOut), `skill userMessage matches: ${JSON.stringify(skillOut)}`);

// ─── 3. /prompt-clock notifies ─────────────────────────────────────────────────────
console.log("[3] /prompt-clock");
await t.cmd("/prompt-clock");
ok(t.captures.notify.length > 0 && t.captures.notify[0].includes("pi-prompt-clock"), "/prompt-clock notifies with pi-prompt-clock");
ok(!Object.keys(t.captures.commands).includes("/m"), "one-letter /m alias removed");

// ─── 4. active footer: task time in ( ), last task persists ──────────────────
console.log("[4] active footer & last-task persistence");
let t2 = build({}, {});
t2.call("session_start", { type: "session_start" });
t2.call("message_start", { type: "message_start", message: { role: "user", content: "hi", timestamp: Date.now() } });
t2.call("agent_start", {});
t2.call("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
t2.call("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] }, assistantMessageEvent: { type: "text_delta" } });
const a = t2.captures.status[t2.captures.status.length - 1];
ok(typeof a === "string" && a.includes("(") && a.includes(")"), `active footer has task time in ( ): ${a}`);
ok(/~\d+ tok\/s/.test(a), `live rate marked as estimate: ${a}`);
ok(t2.captures.status.some((s) => s.includes("tok/s")), "footer shows tok/s");
ok(t2.captures.status.some((s) => /TTFT \d+ms/.test(s)), "footer shows TTFT after first token");
// After agent_end, the last task's time and TTFT must remain visible.
t2.call("agent_end", { type: "agent_end", messages: [] });
const afterEnd = t2.captures.status[t2.captures.status.length - 1];
ok(/\(0\.0s\)/.test(afterEnd) || /\((?!\-\-)[^)]+\)/.test(afterEnd), `last task time persists after end: ${afterEnd}`);
ok(/TTFT \d+ms/.test(afterEnd), `last TTFT persists while idle: ${afterEnd}`);
// A new task starts: lastTtft resets and a spinner replaces it until the first token.
t2.call("agent_start", {});
const newTask = t2.captures.status[t2.captures.status.length - 1];
ok(!/TTFT \d+ms/.test(newTask), `TTFT reset at new task start: ${newTask}`);
ok(/TTFT [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(newTask), `spinner shown for pending TTFT: ${newTask}`);

// ─── 5. /prompt-clock non-UI → stderr (no UI notify) ──────────────────────────────
console.log("[5] /prompt-clock non-UI → stderr");
let t3 = build({}, { hasUI: false });
t3.call("session_start", { type: "session_start" });
await t3.cmd("/prompt-clock");
ok(t3.captures.notify.length === 0, "non-UI does not notify UI");

// ─── 6. full event flow (no crash) ───────────────────────────────────────────
console.log("[6] full event flow (no crash)");
let t4 = build({}, {});
t4.call("session_start", { type: "session_start" });
t4.call("message_start", { type: "message_start", message: { role: "user", content: "do it", timestamp: Date.now() } });
t4.call("agent_start", {});
t4.call("turn_start", {});
t4.call("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
for (let i = 1; i <= 5; i++) t4.call("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(i * 12) }] }, assistantMessageEvent: { type: "text_delta" } });
t4.call("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "aaaaaa" }], usage: { input: 10, output: 10 }, timestamp: Date.now() } });
t4.call("turn_end", {});
t4.call("agent_end", { type: "agent_end", messages: [] });
ok(true, "full flow completed without throw");

// ─── 7. token delta (no double count) ────────────────────────────────────────
console.log("[7] token delta (no double count)");
let t5 = build({}, {});
t5.call("session_start", { type: "session_start" });
t5.call("agent_start", {});
t5.call("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
for (let i = 1; i <= 5; i++) {
  const len = i * 12;
  t5.call("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(len) }] }, assistantMessageEvent: { type: "text_delta" } });
}
t5.call("agent_end", {});
ok(true, "delta flow ran without throw");

// ─── 8. exact usage + calibration ────────────────────────────────────────────
console.log("[8] exact usage & calibration");
let t6 = build({}, {});
t6.call("session_start", { type: "session_start" });
t6.call("agent_start", {});
t6.call("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
const body = "Hello world!!!"; // 14 chars
 t6.call("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: body }] }, assistantMessageEvent: { type: "text_delta" } });
// Real usage: 4 output tokens over ~100ms => exact decode rate ~40 tok/s.
t6.call("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: body }], usage: { input: 10, output: 4 }, durationMs: 100 } });
t6.call("agent_end", { type: "agent_end", messages: [] });
await t6.cmd("/prompt-clock");
const summary = t6.captures.notify[t6.captures.notify.length - 1];
ok(/tok\/s:\s+40\.0/.test(summary), `exact decode rate = 40.0 tok/s: ${summary.replace(/\n/g, " | ")}`);
ok(/chars\/tk:\s+3\.50/.test(summary), `calibrated to 3.50 chars/token (14/4): ${summary.replace(/\n/g, " | ")}`);

// ─── 9. restored-session active time uses real durations ─────────────────────
console.log("[9] restored-session active time");
const branch = [
  { type: "message", message: { role: "user", content: "hi", timestamp: Date.now() } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }], usage: { input: 1, output: 2 }, durationMs: 3000, timestamp: Date.now() } },
  { type: "message", message: { role: "toolResult", toolName: "read", content: [], isError: false, durationMs: 500, timestamp: Date.now() } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 }, durationMs: 1500, timestamp: Date.now() } },
];
let t7 = build({}, { sessionManager: { getBranch: () => branch } });
t7.call("session_start", { type: "session_start" });
await t7.cmd("/prompt-clock");
const s7 = t7.captures.notify[t7.captures.notify.length - 1];
ok(/active:\s+5s/.test(s7), `restored active = 3000+500+1500 = 5s: ${s7.replace(/\n/g, " | ")}`);

// ─── 10. config file + /prompt-clock config ─────────────────────────────
console.log("[10] config file + /prompt-clock config");
const agentDir = mkdtempSync(join(tmpdir(), "ppc-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const cfgPath = join(agentDir, "pi-prompt-clock.json");

// 10a. valid file is applied
writeFileSync(cfgPath, JSON.stringify({
  show: { task: false, total: true, tps: true, ttft: false, prompts: true },
  separator: " | ",
  windowMs: 2000,
  charsPerToken: 3,
}));
let t8 = build({}, {});
t8.call("session_start", { type: "session_start" });
let f = t8.captures.status[t8.captures.status.length - 1];
ok(!f.includes("("), `show.task=false hides (task): ${f}`);
ok(!f.includes("TTFT"), `show.ttft=false hides TTFT: ${f}`);
ok(f.includes(" | "), `custom separator " | " used: ${f}`);

// 10b. config show reports value + source
await t8.cmd("/prompt-clock", "config");
const shown = t8.captures.notify[t8.captures.notify.length - 1];
ok(/show\.task\s+false\s+file/.test(shown), `config show marks file values: ${shown.split("\n").slice(1, 3).join(" | ")}`);
ok(/windowMs\s+2000\s+file/.test(shown), "config show reports windowMs from file");

// 10c. config set writes the file and applies immediately
await t8.cmd("/prompt-clock", "config set show.ttft true");
f = t8.captures.status[t8.captures.status.length - 1];
ok(f.includes("TTFT"), `set show.ttft=true re-renders TTFT: ${f}`);
ok(JSON.parse(readFileSync(cfgPath, "utf-8")).show.ttft === true, "set persisted to file");

// 10d. config reset removes an override
await t8.cmd("/prompt-clock", "config reset show.ttft");
ok(JSON.parse(readFileSync(cfgPath, "utf-8")).show.ttft === undefined, "reset removed show.ttft from file");

// 10e. invalid set is rejected
await t8.cmd("/prompt-clock", "config set windowMs abc");
const err = t8.captures.notify[t8.captures.notify.length - 1];
ok(/expects a number/.test(err), `invalid set rejected: ${err}`);

// 10f. invalid file value falls back with a warning
writeFileSync(cfgPath, JSON.stringify({ windowMs: "nope", charsPerToken: 99 }));
let t9 = build({}, {});
t9.call("session_start", { type: "session_start" });
const warn = t9.captures.notify.find((m) => /config:/.test(m));
ok(!!warn, `invalid file value warns: ${warn}`);
delete process.env.PI_CODING_AGENT_DIR;
rmSync(agentDir, { recursive: true, force: true });

// ─── 11. colors: theme detection + config override ─────────────────────────
console.log("[11] colors");
// catppuccin theme → catppuccin palette
let t10 = build({}, { settings: { theme: "catppuccin-tui-mocha" } });
t10.call("session_start", { type: "session_start" });
const cfCat = t10.captures.status[t10.captures.status.length - 1];
ok(cfCat.includes("\u001b[38;2;127;132;156m"), `catppuccin footer = overlay1: ${JSON.stringify(cfCat)}`);
const tr10 = t10.captures.mdTransformer;
t10.call("message_start", { type: "message_start", message: { role: "user", content: "hi", timestamp: Date.now() } });
ok(tr10("hi").includes("\u001b[38;2;147;153;178m"), `catppuccin timestamp = overlay2: ${JSON.stringify(tr10("hi"))}`);
// non-catppuccin theme → theme-agnostic fallback
let t11 = build({}, { settings: { theme: "system" } });
t11.call("session_start", { type: "session_start" });
const cfFallback = t11.captures.status[t11.captures.status.length - 1];
ok(cfFallback.startsWith("\u001b[2m"), `fallback footer = faint: ${JSON.stringify(cfFallback)}`);
ok(!cfFallback.includes("38;2;"), "fallback footer not truecolor");
// config override wins over theme detection
const colorDir = mkdtempSync(join(tmpdir(), "ppc-color-"));
process.env.PI_CODING_AGENT_DIR = colorDir;
writeFileSync(join(colorDir, "pi-prompt-clock.json"), JSON.stringify({ colors: { footer: "#ff0000", timestamp: "bright" } }));
let t12 = build({}, { settings: { theme: "catppuccin-tui-mocha" } });
t12.call("session_start", { type: "session_start" });
const cfOverride = t12.captures.status[t12.captures.status.length - 1];
ok(cfOverride.includes("\u001b[38;2;255;0;0m"), `config override footer = #ff0000: ${JSON.stringify(cfOverride)}`);
const tr12 = t12.captures.mdTransformer;
t12.call("message_start", { type: "message_start", message: { role: "user", content: "yo", timestamp: Date.now() } });
ok(tr12("yo").includes("\u001b[97m"), `config override timestamp = bright: ${JSON.stringify(tr12("yo"))}`);
delete process.env.PI_CODING_AGENT_DIR;
rmSync(colorDir, { recursive: true, force: true });

console.log(`\nRESULT: ${passCount} passed, ${failCount} failed`);
// Stop all tick loops so the process can exit (simulates Pi session_shutdown).
for (const inst of [t, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12]) { try { inst.call("session_shutdown", { type: "session_shutdown" }); } catch {} }
process.exit(failCount > 0 ? 1 : 0);
