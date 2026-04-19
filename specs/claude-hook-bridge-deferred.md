# Claude hook bridge — deferred from Phase 3b

**Status:** Deferred, not shipped in v0.4.

## What it would be

Claude Code exposes a hooks system (PreToolUse, PostToolUse,
UserPromptSubmit, Notification, PreCompact, SessionStart, SessionEnd,
Stop, SubagentStop, etc.). Hooks are configured per-session via
`settings.json` and run as shell commands when the event fires, with
the hook payload on stdin.

A cordyceps hook bridge would:

1. **Receive side** — daemon exposes `POST /claude-hook` with bearer auth,
   accepting `{agentId, event, data}` JSON; emits
   `agent.{agentId}.claude-hook.{event}` on the service bus.

2. **Emit side** — the Claude driver writes per-session settings.json
   hooks that shell out to `curl` or a small wrapper script, POSTing the
   event + stdin payload to the daemon with the right token.

3. **Lifecycle** — hooks are set up when `profile.hookBridge: true` at
   spawn time; torn down on kill.

## Why deferred

- Claude-specific by nature, doesn't generalize to Codex/Gemini/Ollama
  the way everything else in Phase 3 does
- Requires writing (then cleaning up) per-session `settings.json` files
  in a way that interacts with the user's own claude config
- The MCP bridge (`cordy mcp-stdio`) already gives a spawned Claude
  session first-class access to cordy — different direction (Claude →
  cordy instead of cordy → Claude) but covers most immediate use cases
- Agent-message events already land on the bus via the parser; the
  specific lifecycle events (PreToolUse, PostToolUse) are the
  incremental value and can be added when there's a concrete consumer

## Design notes for whoever picks this up

- Keep the receive side minimal — just an HTTP endpoint that emits to
  the bus. Don't try to interpret Claude's per-hook payload shapes
  inside core; let plugins decide what to do with them.
- Reuse the existing bearer token. Each agent should get its own
  subordinate token (sharing the daemon's root token with every hook
  invocation widens the blast radius of a stolen token on disk).
- The settings.json write should be **additive**, not destructive —
  merge with any existing hooks the user has configured, don't
  overwrite.
- Per-agent `CLAUDE_CONFIG_DIR` (already supported via
  `profile.isolateConfig`) is a natural boundary — hook writes land
  there, not in the user's real `~/.claude/`.

## What it does NOT replace

The MCP bridge. Those are complementary: hooks are Claude → cordy
(events fire synchronously during Claude's tool execution); MCP is
cordy → Claude (Claude can call cordy methods when it wants to).
