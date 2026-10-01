# Verification record — v0.2.1, 2026-10-01

## Passed

- JavaScript syntax and JSON checks
- Codex plugin manifest and skill validation
- **97 Node tests**, all passed, no skips with `RUN_NATIVE_PLUGIN_TEST=1 npm test`
  - 42 approval tests, including real MCP SDK form round trips, explicit decline/cancel, malformed input, late approval after cancellation and 120-second timeout behavior
  - Actual source-verified POSIX bootstrap and Python worker integration: arbitrary command, cwd/environment, independent stdout/stderr, binary output, nonzero exit, timeouts/cancellation, chunked file operations and integrity
  - Approval/session-change races, unknown-response no-replay, bounded local retention, stopped-tab quarantine and cancelled result download
  - CRC32/wrapped-frame parsing, corruption rejection, startup source hash enforcement and safe shell quoting
  - 15 installer/package tests, including native Codex integration
- **46 Python tests**, all passed
  - Actual subprocesses and file operations, output limits, timeout/cancel, foreground worker protocol, EOF cleanup
  - Real PTY echo restoration on close/SIGINT/SIGTERM
  - Root binding, credential-root rejection before ready, path/secret/symlink guards
  - Atomic/no-clobber writes, hash conflicts/races, new-file modes and existing-mode preservation, durability uncertainty handling
  - Listing/read/stat/diff, upload abort/expiry/limits and bounded job retention
- Native installation in isolated temporary HOME/CODEX_HOME with **Codex CLI 0.159.0-alpha.7** on Linux
  - Materialized v0.2.1 personal plugin cache; all 97 Node tests passed again after the browser-input patch
  - Cached-copy MCP handshake and connect_status
  - Real Codex app-server loaded the plugin from an unrelated cwd and discovered **all 17 tools**, with no tools error
  - A test-only hook in an isolated cached copy observed actual host elicitation capability `{"form":{},"url":{}}`; repository source and actual user profile were untouched
- Production dependency audit reported zero known vulnerabilities at the recorded check; this is not a security guarantee

The 15 installer tests and 42 approval tests are included in the 97 Node total, not additional tests. The Python suite is separate.

## GitHub browser verification

- The owner approved public source upload to [sumeetweb/codex-rpi-connect](https://github.com/sumeetweb/codex-rpi-connect)
- [Initial CI run](https://github.com/sumeetweb/codex-rpi-connect/actions/runs/36919171758) checked exact commit `b024eff0271e49227a17fe2e22d98880352bc37d`: syntax, Node and Python checks passed; Chromium installed and 12 of 16 browser cases passed
- That run found that xterm screen-reader mode intentionally ignores plain `insertText` events, and disabling accessibility alone still leaves xterm's readable default DOM renderer
- v0.2.1 uses a pinned-input standard DOM paste event, normalizes the accessibility empty-row placeholder, corrects the no-readable-output fixture, and adds a positive DOM-renderer case. The resulting 17-case browser suite is awaiting its corrective CI run

## Blocked / not established

- Local Chromium remains unavailable: the container denied a required socket, an official headless-shell download was invalid/truncated, and the supported cloud browser refused the localhost fixture. CI provides the separate supported browser execution environment; no restriction bypass was attempted
- Authenticated Raspberry Pi Connect DOM/device/terminal selectors: not observed
- Real Pi command execution, file operations, transfer, approval UI, timeout/cancel and reconnection: not tested
- GUI/native plugin behavior on macOS or Windows: not tested
- A Codex model-thread creation attempt was blocked by the container's socket-directory setup; native plugin/MCP loading succeeded independently

## What local tests mean

The Node integration harness runs the real worker through the real checksum-verified shell bootstrap over local pipes in disposable directories. Python tests use actual processes/files/PTYs. The browser fixture uses actual xterm.js with synthetic responses; it is not Raspberry Pi Connect and its accessibility configuration may differ.

No local test is presented as live Connect evidence. The main release gate is docs/morning-test.md on an explicitly authorized registered Pi. If the real terminal does not expose readable output, the browser adapter remains blocked and must be adapted from observed authorized UI evidence. General execution is never silently substituted with SSH or a private API.

## Review changes

Independent code review led to populated-capture checks, visible identity matching, pinned input handles, per-operation forms, source hash verification, explicit stopped/uncertain-session quarantine, bounded read-only timeout behavior, cache/result limit alignment, mode-approval consistency and cancellation checks during result transfer. Known OS/filesystem/focus-race limitations are documented rather than hidden.
