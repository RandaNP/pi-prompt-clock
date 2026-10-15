# pi-prompt-clock

Live timing metrics in the [Pi](https://github.com/earendil-works/pi) footer, plus the
send time of every prompt rendered under the prompt itself.

> **Automatic coding project** — this extension is written by an AI coding agent.

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

## Commands

- `/prompt-clock` — print a metrics snapshot (active time, tok/s, TTFT, chars/token,
  prompts). In TUI/RPC it notifies via the UI; in print/JSON it writes to stderr.
- `/prompt-clock config` — show the effective configuration and where each value came from.
- `/prompt-clock config set <key> <value>` — validate, clamp, and persist a value.
- `/prompt-clock config reset <key|all>` — remove an override (or all of them).

```
/prompt-clock config
pi-prompt-clock config  (~/.pi/agent/pi-prompt-clock.json)
  show.task          true        default
  show.total         true        default
  show.tps           true        default
  show.ttft          true        default
  show.prompts       true        default
  separator          " · "       default
  windowMs           5000        default
  charsPerToken      4           default
  colors.footer      #7f849c (auto)
  colors.timestamp   #9399b2 (auto)
```

## Configuration

Settings live in `<agent-dir>/pi-prompt-clock.json` (default
`~/.pi/agent/pi-prompt-clock.json`) and are created on the first `set`. Every key is
optional — built-in defaults fill the gaps — so the file can be absent entirely. Edit the
file and run `/reload`, or change values with `/prompt-clock config set`.

```json
{
  "show": {
    "task": true,
    "total": true,
    "tps": true,
    "ttft": true,
    "prompts": true
  },
  "separator": " · ",
  "windowMs": 5000,
  "charsPerToken": 4,
  "colors": { "footer": "#7f849c", "timestamp": "#9399b2" }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `show.task` | boolean | `true` | `( )` current / last task elapsed time |
| `show.total` | boolean | `true` | cumulative active (working) time |
| `show.tps` | boolean | `true` | live tokens/sec |
| `show.ttft` | boolean | `true` | time to first token |
| `show.prompts` | boolean | `true` | prompt count |
| `separator` | string | `" · "` | separator between footer metrics |
| `windowMs` | number (250–60000) | `5000` | sliding window for the live tok/s |
| `charsPerToken` | number (1–12) | `4` | initial estimate; recalibrated from real usage |
| `colors.footer` | color | theme-based | footer status color |
| `colors.timestamp` | color | theme-based | under-prompt timestamp color |

Invalid values are ignored (falling back to the default) with a warning, and every key
survives a `/reload`. Precedence is simply **config file → built-in defaults**.

### Colors

The status line and the under-prompt timestamp have no access to the theme object, so
colors are ANSI codes rather than theme lookups:

- **Catppuccin** theme → defaults match the built-in footer: `#7f849c` (`overlay1`) for the
  footer and `#9399b2` (`overlay2`) for the timestamp.
- **Any other** theme → theme-agnostic defaults: `faint` for the footer and `gray` for the
  timestamp.

Override either with `colors.footer` / `colors.timestamp`. A value is one of:

- `#rrggbb` (or `#rgb`) — truecolor foreground (needs terminal truecolor support)
- `faint`, `dim`, `gray`, `bright` — ANSI attributes/colors
- `none` — no color

Theme detection is by theme name and is re-evaluated on `/reload` (or when the config
changes), not on a live `/theme` switch.

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

A small TypeScript package — `src/config.ts` (settings + colors), `src/metrics.ts`
(state + rate math), `src/render.ts` (footer + prompt timestamp), and `src/index.ts`
(the extension entry point). Loaded by Pi via jiti with no build step; point Pi at the
entry point directly:

```sh
pi --extension ./src/index.ts
```

Run the tests and typecheck:

```sh
npm test          # stub test suite (node --experimental-strip-types)
npm run typecheck # tsc --noEmit
```

## License

MIT
