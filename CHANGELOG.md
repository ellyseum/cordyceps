# Changelog

All notable changes to this project will be documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project follows [Semantic Versioning](https://semver.org/) once it hits
`1.0.0`. Pre-1.0 minors may include breaking changes (called out below).

## [0.5.5] — 2026-04-29

### Fixed
- `cordy council review/diff` now actually pins Claude reviewers to
  exec mode when `--panel claude:opus` (etc.) is used. The 0.5.3 fix
  only changed `defaultModeFor` (a heuristic for inline-vs-tool-driven
  routing), but the AgentManager's `chooseMode` still defaulted to
  `driver.modes[0]` — which is `pty` for Claude — so reviewers
  continued spawning under PTY and parse-failed silently in
  real-world panels. The mode is now set explicitly on the spawn
  profile per reviewer (and chair) when the caller didn't specify
  one.
- New helper `resolveCouncilMode(spec)` infers `mode=pty` for Claude
  when the caller passed PTY-only profile fields (`resume`,
  `continue`, `sessionId`, `isolateConfig`) without an explicit
  mode. Without this, buildExec would silently drop those fields.

## [0.5.4] — 2026-04-29

### CI/release
- Repo flipped public; npm Trusted Publisher (GitHub Actions OIDC)
  configured for `@ellyseum/cordyceps`.
- `release.yml` no longer references `NPM_TOKEN` — auth is now via
  short-lived OIDC tokens minted per workflow run. Provenance
  attestations are now signed and posted to the public transparency
  log on every tag-triggered release.

## [0.5.3] — 2026-04-29

### Changed
- `cordy council review/diff` now defaults Claude reviewers to `exec`
  mode instead of `pty`. PTY mode is still supported for interactive
  spawns but is experimental for headless review use — TUI output
  parsing dropped reviewer findings silently in real-world panels.
  Users who explicitly want PTY can pass `--panel claude:opus` with a
  spec-level `profile.mode = "pty"` override.
- `driverSupportsTools` now treats Claude in `exec` mode as
  tool-capable (Claude `--print` runs the full agent with tool access),
  so Claude exec reviewers get the path-only prompt and read the file
  via their own tools rather than being inlined.

## [0.5.2] — 2026-04-29

### Added
- `cordy council review/diff --no-chair` — skip the chair-synthesis
  step. Per-reviewer findings still returned; `synthesis` is empty.
  Saves a model call when the caller (e.g. a host LLM with all the
  reviewer outputs already in its context) wants to synthesize itself.
- `council.review` RPC method accepts a new `noChair: boolean` param.

## [0.5.1] — 2026-04-29

### Added
- `cordy --version` / `cordy -v` / `cordy version` — print the package
  version. Useful for tooling that wants to gate on cordy capabilities
  without parsing `cordy doctor`.

### Docs
- README: new "Use from Claude Code" section pointing at the
  [`claude-cordyceps`](https://github.com/ellyseum/claude-cordyceps)
  plugin as the recommended way to drive cordy from a Claude Code
  session. The MCP-bridge section is now positioned as the lower-level
  substrate the plugin builds on.

## [0.5.0] — 2026-04-28

First public release. The 0.4.x line was internal-only and never
published to npm; this is the first version to ship.

### Added
- `LICENSE` (MIT) at repo root.
- Complete `package.json` metadata (`repository`, `bugs`, `homepage`,
  `publishConfig.provenance`, tightened `engines` to `^20 || ^22 || ^24`).
- Single source of truth for the package version in `src/core/version.ts`
  (reads `package.json` at module load).
- `cordy approve` / `cordy reject` CLI wrappers around the existing
  `agents.approve` / `agents.reject` RPC methods.
- Architecture, protocol, drivers, plugins, and status docs under
  `docs/`. Self-contained Node.js client example under
  `examples/basic-agent/`.
- `SECURITY.md` with private disclosure address and threat model summary.
- GitHub Actions: CI on Node 20 + 22 + 24 (`.github/workflows/ci.yml`) and
  tag-triggered npm publish with provenance attestations
  (`.github/workflows/release.yml`).

### Changed
- **Audit logging is now opt-in.** Pass `--audit` (or `--audit-dir <path>`)
  to `cordy daemon start` to enable. Previously logged by default to
  `~/.cordyceps/audit/`.
- Bearer token now travels in the `Authorization: Bearer` header on the WS
  upgrade request. The `?token=` query string still works for backward
  compat with older clients but the new client uses the header.
- Token comparison runs constant-time on equal-length padded buffers;
  removed the length-prefix early-return.
- Upgrade handler rejects non-loopback `Host` / `Origin` headers with
  `403` before any token check.
- `cordy spawn` and `cordy council review` now resolve relative paths
  against the caller's `cwd` instead of the daemon's startup `cwd`.
- Driver probes drop the POSIX-only `which` lookup and rely on
  `execFile` `ENOENT` for binary detection. Cross-platform.
- `instancesDir()` resolves `homedir()` lazily on each call so test
  redirection via `process.env.HOME` actually takes effect.
- README rewritten for OSS surface; driver table now includes Claude
  `exec` mode; MCP stdio bridge marked experimental.

### Removed
- `--no-audit` flag (audit is now off by default; see `--audit`).
- `transport.token` is no longer published to the service bus. Plugins
  that need the bearer token can read it from
  `~/.cordyceps/instances/<pid>.json` directly.
- `path` field on `DriverProbe` (was always `undefined` after the `which`
  removal — dead surface).

### Security
- Constant-time token comparison; no length leakage in auth path.
- WS upgrade Origin/Host validation as defense in depth alongside the
  existing loopback bind.
- `sessionId` validation before path-join in
  `src/drivers/claude/session.ts`.
