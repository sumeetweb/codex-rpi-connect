# Verification record — v0.2.0, 2026-10-01

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
  - Materialized v0.2.0 personal plugin cache
  - Cached-copy MCP handshake and connect_status
  - Real Codex app-server loaded the plugin from an unrelated cwd and discovered **all 17 tools**, with no tools error
  - A test-only hook in an isolated cached copy observed actual host elicitation capability `{"form":{},"url":{}}`; repository source and actual user profile were untouched
- Production dependency audit reported zero known vulnerabilities at the recorded check; this is not a security guarantee

The 15 installer tests and 42 approval tests are included in the 97 Node total, not additional tests. The Python suite is separate.

## Blocked / not established

- **Real-browser fixture suite (16 cases): not executed successfully.** Chromium failed during launch because the container denied a required local socket, including an approved environment retry. The official headless-shell download was invalid/truncated. The supported cloud browser refused the localhost fixture with `ERR_BLOCKED_BY_CLIENT`. No restriction bypass was attempted
- Authenticated Raspberry Pi Connect DOM/device/terminal selectors: not observed
- Real Pi command execution, file operations, transfer, approval UI, timeout/cancel and reconnection: not tested
- GUI/native plugin behavior on macOS or Windows: not tested
- A Codex model-thread creation attempt was blocked by the container's socket-directory setup; native plugin/MCP loading succeeded independently
- GitHub private repository creation/push and remote CI: still require the user's GitHub connection

## What local tests mean

The Node integration harness runs the real worker through the real checksum-verified shell bootstrap over local pipes in disposable directories. Python tests use actual processes/files/PTYs. The browser fixture uses actual xterm.js with synthetic responses; it is not Raspberry Pi Connect and its accessibility configuration may differ.

No local test is presented as live Connect evidence. The main release gate is docs/morning-test.md on an explicitly authorized registered Pi. If the real terminal does not expose readable output, the browser adapter remains blocked and must be adapted from observed authorized UI evidence. General execution is never silently substituted with SSH or a private API.

## Review changes

Independent code review led to populated-capture checks, visible identity matching, pinned input handles, per-operation forms, source hash verification, explicit stopped/uncertain-session quarantine, bounded read-only timeout behavior, cache/result limit alignment, mode-approval consistency and cancellation checks during result transfer. Known OS/filesystem/focus-race limitations are documented rather than hidden.
