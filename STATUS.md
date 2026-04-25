# Status

Pre-1.0. The project is actively maintained.

## Shipped

- Daemon: loopback WebSocket, JSON-RPC 2.0 control plane, bearer auth,
  atomic instance discovery.
- Built-in drivers: `claude-code` (`pty` + `exec`), `codex` (`exec`),
  `gemini` (`exec`), `ollama` (`server-http`).
- Plugins: `audit` (opt-in), `council` (multi-family code review with
  chair synthesis), `manager` (Claude-only at present), `peer`,
  three runtime registrants.
- CLI: 17 subcommands. Every one is a thin client over the same
  JSON-RPC surface.
- MCP stdio bridge for Claude Code (experimental framing — see README).

## In progress

- Driver conformance suite — single test pack that every driver passes
  (spawn / send / interrupt / teardown).
- Manager-driver pluralism — let the manager plugin spawn its driver
  through any tool-capable runtime, not just Claude.
- Architecture docs (this batch) — done; will iterate based on feedback.

## Sketched

- Full MCP stdio framing so the bridge works with any compliant MCP
  client, not only Claude Code.
- External plugin packaging — currently the loader walks an explicit
  in-tree list. A stable third-party plugin surface needs API freezes
  this project isn't ready to make pre-1.0.

Last updated: 2026-04-28.
