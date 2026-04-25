# Security

## Reporting a vulnerability

Please report privately to **jocelyn@ellyseum.dev** rather than opening a
public issue. I'll respond within a few business days. If you don't hear
back within a week, please feel free to follow up.

You can also use GitHub's private vulnerability reporting on the
[ellyseum/cordyceps](https://github.com/ellyseum/cordyceps/security/advisories)
repo.

## Supported versions

Pre-1.0 — only the latest minor on the `0.x` line is supported. Once
`1.0.0` ships, the support window will broaden.

## Threat model (high-level)

Cordyceps is a **local-first** tool. The daemon binds to `127.0.0.1` and
authenticates clients with a 192-bit bearer token regenerated on every
start. The token lands in `~/.cordyceps/instances/<pid>.json` (mode `0600`)
and is presented via the `Authorization: Bearer` header on the WS upgrade
(or `?token=` query string for backward compat).

**The bearer token is shell-execution-equivalent.** Anyone who can read it
can spawn arbitrary subprocesses through the daemon's spawn API. Treat it
like an SSH key:

- Don't share `~/.cordyceps/instances/`.
- Don't run the daemon as a different user without thinking through the
  implications.
- Don't expose the daemon's loopback port through any tunnel or proxy.

## Defense-in-depth notes

- Subprocess spawning everywhere uses array args (`execFileSync`, `spawn`);
  no `shell: true`, no string concatenation.
- The plugin loader uses static imports only; no dynamic file-system
  imports, no path-traversal surface in plugin discovery.
- The WS upgrade handler rejects non-loopback `Host` / `Origin` headers
  with `403` before any token check.
- Token compare is constant-time and runs unconditionally on equal-length
  padded buffers.
- Audit logging is **opt-in** (default off). Enabling it persists agent
  message text to `~/.cordyceps/audit/` — the tradeoff is yours.
