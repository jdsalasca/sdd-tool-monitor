# sdd-tool-monitor

Real-time quality monitor for `sdd-tool` projects.

## What it gives you

- Live portfolio view of all projects under your sdd workspace.
- Health status per project: `healthy`, `in_progress`, `critical`.
- Stage-machine progress (`discovery` -> `runtime_start`).
- Lifecycle gate counts (`OK`, `FAIL`, `SKIP`) plus last failure reason.
- Digital review status/score when available.
- Campaign progress (cycle, elapsed minutes, target reached).
- Latest AI prompt stage from `debug/provider-prompts.metadata.jsonl`.
- Latest prompt/output preview and full payload (truncated) from debug logs.
- Recovery command per project (copy/paste from UI) to continue from current gate.
- Running process PID/command when an active `sdd-tool` process is detected.

## Install

```bash
npm install -g sdd-tool-monitor
```

Or local dev:

```bash
npm install
npm start
```

## Run

```bash
sdd-tool-monitor
```

Options:

- `--workspace <path>`: override workspace root.
- `--host <ip>`: default `127.0.0.1`.
- `--port <n>`: default `4317`.
- `--refresh-ms <n>`: default `5000`.
- `--once --json`: one-shot machine-readable snapshot.

## Quick diagnostics

```bash
sdd-tool-monitor --once --json
```

Inspect a single project:

```bash
curl http://127.0.0.1:4317/api/project/<project-name>
```

Health endpoint:

```bash
curl http://127.0.0.1:4317/api/health
```

## Data sources

- `metadata.json`
- `sdd-run-status.json`
- `.sdd-stage-state.json`
- `suite-campaign-state.json`
- `generated-app/deploy/lifecycle-report.md`
- `generated-app/deploy/lifecycle-report.json`
- `generated-app/deploy/digital-review-report.json`
- `debug/provider-prompts.metadata.jsonl`

## Notes

This monitor surfaces quality truth quickly; it does not auto-fix projects by itself.
Use it together with `sdd-tool suite ...` to run long autonomous campaigns and track progress in real time.
`sdd-tool-monitor` is independent from `sdd-tool` (no runtime coupling required).
