// Focused stub test for pi-prompt-clock.ts (run with: node --experimental-strip-types)
// Verifies: factory loads, no crash, icon-less prompt timestamp, all-metrics footer, /prompt-clock.
const EXT = new URL("../src/pi-prompt-clock.ts", import.meta.url).href;

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

console.log(`\nRESULT: ${passCount} passed, ${failCount} failed`);
// Stop all tick loops so the process can exit (simulates Pi session_shutdown).
for (const inst of [t, t2, t3, t4, t5, t6, t7]) { try { inst.call("session_shutdown", { type: "session_shutdown" }); } catch {} }
process.exit(failCount > 0 ? 1 : 0);
