---
name: Bug report
about: Something doesn't work the way it should
labels: bug
---

## What happened

<!-- A short description of what you saw -->

## What you expected

<!-- A short description of what you expected -->

## Reproduction

```bash
# the smallest sequence that reproduces it
cordy daemon start
cordy spawn ...
cordy send ...
```

## Environment

- cordyceps version: <!-- `cordy --version` -->
- Node version: <!-- `node -v` -->
- OS: <!-- e.g. macOS 14.5, Ubuntu 22.04, Debian 12 -->
- Driver(s) involved: <!-- claude-code, codex, gemini, ollama -->
- Driver CLI version(s): <!-- `claude --version`, `codex --version`, … -->

## Logs

<!--
If relevant, attach output from:
  cordy daemon logs --follow
or the failing command's stderr.
node-pty errors are usually unfixable without OS + Node version.
-->
