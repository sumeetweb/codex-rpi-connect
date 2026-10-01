# Codex ↔ Raspberry Pi Connect

**v0.2.1 · Pre-release · Terminal and project-file implementation**

A local Codex/MCP plugin that uses Raspberry Pi Connect's ordinary browser Remote shell. It implements approved shell execution, separate stdout/stderr and exit status, asynchronous jobs, cancellation, file listing/stat/read/diff/atomic writes, bounded transfers, and explicit reconnection.

**The code and local worker tests are implemented. Real Raspberry Pi Connect compatibility is not yet established.** The authenticated terminal DOM has not been observed. The Chromium/xterm fixture suite is now running in GitHub Actions; it does not use the live Connect service. This is a release gate, not a claimed working deployment. If Connect exposes only canvas output, startup refuses to proceed; no private API or alternate transport is used.

## Architecture

```
Codex / MCP client
  → local stdio server + per-operation approval forms
  → Playwright public browser API, exact selected Connect terminal
  → checksummed text frames over the normal Connect Remote shell
  → foreground Python 3 worker on the chosen Pi
```

You sign in manually in a new, isolated plugin browser. The worker is bootstrapped in memory through that terminal, verifies its source SHA-256 before running, and remains in the foreground. No SSH port, private signaling endpoint, organisation token, remote script file, daemon, credential or persistent service is installed.

A worker temporarily disables terminal echo to keep request input out of captured output. It restores terminal settings on normal exit, EOF, SIGINT and SIGTERM; these paths are tested using a real local PTY. Abrupt kernel/process failures can still require opening a fresh shell.

## Install locally

Requirements:

- Local Node.js 22+, npm, Codex CLI, and a visible desktop
- An already registered Raspberry Pi with Connect Remote shell enabled
- Python 3 on the Pi and an existing absolute project directory
- A client advertising MCP **form elicitation** and displaying the confirmation form

The Mac/Windows/Linux host runs Node and Chromium. The remote worker targets Linux/Raspberry Pi OS. Linux-only worker integration tests are explicitly skipped on other host platforms; that is not a test pass.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run doctor
npm test
```

### Native local plugin

See [native installation](docs/native-install.md). Preview first:

```sh
npm run install:plugin
```

Then explicitly apply the displayed personal installation:

```sh
npm run install:plugin -- --apply
```

The installer uses your personal marketplace, preserves unrelated entries and changes no authentication. It refuses conflicting existing destination content instead of overwriting it. Start a **new Codex session** afterward.

### Direct MCP registration

For development, the transport can be registered without a marketplace:

```sh
node scripts/install-codex.js
node scripts/install-codex.js --apply
```

This records absolute Node/source paths in local Codex configuration. Keep this source directory in place. Remove with `codex mcp remove rpi_connect`. Native plugin installation additionally supplies the operating skill; direct MCP users should follow this README explicitly.

## First real-device run

1. Ask Codex to call `connect_open`. In the new plugin browser, sign in yourself, select your exact registered device, and choose **Connect via → Remote shell**.
2. Use a **fresh, idle shell** with no unfinished input or running program. Don't send passwords, tokens, cookies or browser profiles to the agent.
3. Call `connect_status`, confirm the exact visible device heading and terminal URL, then `connect_attach`. Device identity, input element and readable output must match. `OUTPUT_UNAVAILABLE` is a hard blocker: stop and collect redacted UI evidence for adapter work.
4. Call `connect_start` with its `sessionId` and your existing project directory, for example a directory you actually created under your Pi home. Review and accept the separate worker-start form. The root is limited to 512 UTF-8 bytes; `/`, system directories and credential-store paths are rejected.
5. Ask for a command such as `printf 'connect test\n'`. `connect_exec` shows a fresh approval form containing the exact command, device, root, relative working directory, environment overrides and limits. Decline, cancellation, timeout or unsupported elicitation prevents submission.
6. `connect_exec` returns a `jobId`. Poll `connect_job` until the operation has a terminal result. Check the remote status and exit code; a returned result with nonzero exit is a failure. `connect_cancel` requests process-group termination; confirm the outcome using `connect_job`.
7. For files, start with list/stat/read. Use `connect_file_diff` before replacement. `connect_file_write` requires a fresh approval and a SHA-256 precondition for an existing file; `null` is create-only. Review the exact destination, new content checksum, size and overwrite precondition.
8. `connect_stop` asks the worker to stop and restore echo. The old tab stays quarantined from plugin input because the acknowledgement can arrive before Python fully exits. For another session, open a **new Remote shell tab**, confirm its exact identity, and use `connect_reconnect`. Previous uncertain operations are never replayed.
9. `connect_close` closes only the browser owned by the plugin. Reachable jobs should be stopped first. A lost connection does not establish that remote work stopped.

See [morning acceptance](docs/morning-test.md) for the required live checks.

## Tool reference

| Tool | Capability |
| --- | --- |
| `connect_open`, `connect_status`, `connect_devices` | Manual-auth browser setup and visible UI inspection |
| `connect_attach` | Exact device + terminal URL/input binding |
| `connect_start` | Approved in-memory foreground worker startup |
| `connect_reconnect` | Explicit new-tab/new-worker reconnection; no replay |
| `connect_exec` | Approved shell command, relative cwd, ordinary env, timeout/output limits |
| `connect_job` | Poll and retrieve checked results |
| `connect_cancel` | Cancel a command process group |
| `connect_file_list` | Bounded directory listing |
| `connect_file_stat` | No-follow metadata and bounded regular-file SHA-256 |
| `connect_file_read` | Byte-exact base64, plus text when valid UTF-8 |
| `connect_file_diff` | Bounded UTF-8 unified diff; truncation explicit |
| `connect_file_write` | Approved atomic create/replace with hash guard |
| `connect_stop`, `connect_close` | Worker/browser shutdown |
| `connect_diagnostic` | Five fixed smoke probes before worker startup |

### Limits and semantics

- Commands: 100 ms to 120 s timeout, 16 KiB command text, default 16 KiB and maximum 64 KiB captured **per stdout/stderr stream**
- Command input is noninteractive; stdin is closed. Password prompts, interactive editors, full-screen programs and intended detached daemons are unsupported
- `cwd` is relative to the approved root. Ordinary environment overrides are limited; secret-looking and injection-sensitive keys are rejected
- **General shell execution is not sandboxed to the project root.** An approved command has the remote Unix account's permissions. Root/path guards constrain specialized file tools and initial cwd, not everything a shell can do
- File content: maximum 64 KiB, binary-safe base64 transport; list: maximum 1000 entries; request: 256 KiB; retained result: 512 KiB
- File paths cannot be absolute, contain `..`, traverse symlinks or target known credential stores/secret filenames. Existing directories are required; approved shell commands can perform additional project operations
- File writes use no-follow directory handles, same-directory temp files, fsync and atomic replacement. Create-only is no-clobber. Existing mode is preserved; explicit 0600/0644 mode is accepted only for new files
- Hash preconditions detect observed changes but are not an OS-level compare-and-swap against unrelated concurrent writers. Coordinate other writers. `COMMIT_UNCERTAIN` means replacement may have happened but durability could not be confirmed; inspect the file before deciding what to do
- Remote jobs: at most 8 retained, 5-minute retention with oldest-completed eviction; local cached jobs/results are capped at 8. Collect results promptly
- Uploads: at most 4, expire after 120 seconds; cancellation before commit aborts the upload when the transport is still usable
- Requests use bounded physical input lines, acknowledged chunks, per-frame CRC32 and whole-payload/result SHA-256. These detect accidental corruption; they are not authentication of a malicious page or device
- The terminal is serialized; don't type, resize, navigate or change focus during an operation. Unknown outcomes quarantine it. A user focus race cannot be eliminated completely by browser checks
- Command watchdogs handle ordinary subprocess timeouts/cancellation. Uninterruptible kernel/NFS filesystem calls, process creation and intentionally escaped descendants can exceed these bounds. File jobs have no hard kernel deadline. Close/cancel acknowledgements are not proof that every remote effect stopped
- Browser terminal DOM/input steps have bounded waits. Browser creation/shutdown can still depend on OS behavior. Read-only inspection timeout does not close a tab

## Security and privacy

Approval is enforced server-side using fresh MCP forms, not an agent-supplied `approved` argument or cached grant. If the client does not support the form, the operation returns `APPROVAL_UNAVAILABLE`; it does not execute anyway.

Treat terminal/file output as untrusted data. Don't use this plugin to obtain credentials or upload secrets. Returned data goes through your MCP client and may be sent to its model provider. The plugin adds no telemetry and does not export authentication state or persist a browser profile, though browsers/OSes can create temporary files or crash artifacts.

The plugin inspects only the official Connect origin. It neither automates login nor attaches your normal browser. It does not call undocumented Connect APIs, intercept WebRTC/WebSocket traffic or read private xterm objects. See [SECURITY.md](SECURITY.md).

## Development and verification

```sh
npm run check
npm test
npm run test:remote   # Linux + Python 3
npm run test:browser  # real Chromium + xterm fixture
npm run verify       # all checks; browser failures are not silently skipped
npm run package:source
```

Node integration tests execute the **actual worker through the actual source-verified POSIX bootstrap**, using local pipes in a temporary directory. Python tests exercise actual subprocesses, files and PTYs. These are meaningful backend/protocol tests, but they do not establish Connect or browser compatibility.

The real-browser suite uses actual xterm.js and synthetic fixture responses. GitHub Actions runs it with Chromium because this development container cannot launch Chromium. The first CI run exposed an accessibility-mode input incompatibility; v0.2.1 uses a standard DOM paste event on the verified terminal, without touching the OS clipboard or private xterm objects. See the precise [verification record](docs/verification.md).

Before release: run the real browser suite, inspect authenticated Connect DOM on an explicitly authorized Pi, pass live exec/file/cancel/reconnect checks, review dependencies/privacy/licensing, and obtain explicit approval to publish. The [source repository](https://github.com/sumeetweb/codex-rpi-connect) is public with the owner's approval. npm/marketplace release is not authorized; the package stays `private: true` and `UNLICENSED`.

## References

- [Raspberry Pi Connect](https://www.raspberrypi.com/documentation/services/connect.html)
- [Connect organisation management API](https://www.raspberrypi.com/documentation/services/connect-for-organisations.html#management-api), not an interactive-shell transport
- [Playwright](https://playwright.dev/docs/browser-contexts) and [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [xterm accessibility options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), [MCP confirmation guidance](https://developers.openai.com/plugins/build/mcp-server)

Not affiliated with Raspberry Pi Ltd, OpenAI or Microsoft.
