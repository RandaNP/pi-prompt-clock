# pi-prompt-clock

Live timing metrics in the [Pi](https://github.com/earendil-works/pi) footer, plus the
send time of every prompt rendered under the prompt itself.

Pi's built-in footer already covers token totals, cache, cost, and context usage.
`pi-prompt-clock` adds the **timing** side:

- **`(task)`** — elapsed time of the current task, kept visible after it finishes
- **cumulative active time** — total time the agent has actually been working (not idle)
- **`TTFT`** — time to first token, with a spinner while waiting
- **`~tok/s`** — live generation rate, self-calibrating; exact once a task settles
- **per-prompt send time** — a dim timestamp rendered directly under each prompt

## Footer

```
(--) 0s · ~0 tok/s · TTFT -- · 0 prompts
(8.2s) 1m 03s · 18 tok/s · TTFT 340ms · 1 prompt
```

Under each user prompt:

```
Your prompt text

14:32:07
```

## Install

```sh
pi install npm:pi-prompt-clock
```

Or add it to `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:pi-prompt-clock"] }
```

## Command

- `/prompt-clock` — print a summary (active time, tok/s, TTFT, chars/token, prompts).
  In TUI/RPC it notifies via the UI; in print/JSON it writes to stderr.

## Configuration

Edit the constants at the top of `src/pi-prompt-clock.ts`:

```ts
const WINDOW_MS = 5_000;     // sliding window for the live tok/s
const CHARS_PER_TOKEN = 4;   // initial estimate, recalibrated from real usage

const SHOW = {
  task: true,    // ( ) current / last task elapsed time
  total: true,   // cumulative active (interaction) time
  tps: true,     // live tokens/sec
  ttft: true,    // time to first token
  prompts: true, // prompt count
};

const SEP = " · ";           // separator between footer metrics
```

## How the numbers are computed

- **Task / cumulative time** come from `agent_start` → `agent_end` windows, so they only
  advance while the agent is working. On a resumed session, the cumulative total is
  reconstructed from the monotonic `durationMs` Pi records per assistant message and per
  tool result — no characters-to-milliseconds guessing.
- **TTFT** is `assistant message start` → first content delta. It persists while idle and
  resets when a new task starts.
- **tok/s** while streaming is a 5-second sliding window over generated characters,
  divided by a chars-per-token ratio that is recalibrated from the provider's real
  `usage.output` after each message. When idle it shows the exact decode rate,
  `output / (durationMs - ttft)`, matching how llama.cpp reports `predicted_per_second`.
- **Prompts** counts user messages on the active session branch; it survives resume and
  extension reload.

## Caveats

- The under-prompt timestamp is applied by matching the rendered prompt text, so if you
  send the *exact same* prompt twice, both copies show the first send time.
- `~N tok/s` while streaming is an estimate (providers do not stream per-token counts);
  the idle value is exact.
- The pending-TTFT spinner uses braille characters; it needs a font that renders them.
- The metrics are drawn with `ui.setStatus()`, which the built-in footer renders. If
  another extension installs a **custom footer** via `ui.setFooter()` that does not render
  extension statuses (for example `pi-catppuccin-tui` with `/catppuccin-tui footer on`),
  the status line will be hidden. The rest of the extension (the prompt timestamps and the
  `/prompt-clock` command) keeps working.

## Prior art / related work

Independent extensions in this space. **No code is shared with any of them**; they are
listed for context and as alternatives:

- [`pi-token-speed`](https://github.com/gsanhueza/pi-token-speed) — sliding-window tokens/sec
- [`pi-execution-time`](https://github.com/lukaspanni/pi-execution-time) — live task time in the footer
- [`pi-agent-time`](https://github.com/therynamo/pi-agent-time) — per-turn and cumulative LLM response times
- [`pi-turn-metrics`](https://github.com/leon-zym/pi-turn-metrics) — per-turn step / LLM / tool durations
- [`pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard) — separate web dashboard
- [`pi-metrics`](https://www.npmjs.com/package/pi-metrics) — elapsed HUD + TPS telemetry
- [`@yuru7/pi-metrics`](https://www.npmjs.com/package/@yuru7/pi-metrics) — settle-time metrics line + live elapsed
- [`ObservMe`](https://github.com/senad-d/ObservMe) — OpenTelemetry-based observability

`pi-prompt-clock` differs by keeping everything in the footer **and** rendering the send
time of each prompt under the prompt.

## Development

A single TypeScript file, loaded by Pi via jiti — no build step. Point Pi at it directly:

```sh
pi --extension ./src/pi-prompt-clock.ts
```

Run the tests with Node's type stripping:

```sh
npm test
```

## License

MIT
