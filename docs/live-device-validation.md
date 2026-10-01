# Live Device Validation

The terminal/file implementation is present. These checks establish whether the **real Connect UI** works with it; local worker tests cannot establish that.

## Install and client

- [ ] Install locked dependencies and official Chromium; doctor passes
- [ ] Run Node tests; on Linux also run worker tests (non-Linux skip is explicit)
- [ ] Run real browser fixture tests on an unrestricted local desktop/CI runner
- [ ] Native plugin installation succeeds, a new Codex session exposes 17 tools
- [ ] MCP client advertises form elicitation and displays a real opt-in approval form

## Browser and exact device

- [ ] `connect_open` creates a separate visible browser
- [ ] Sign in manually; choose the exact registered device and open a fresh idle Remote shell
- [ ] `connect_status` reports the expected URL/visible device heading
- [ ] `connect_attach` succeeds only with the exact name and URL
- [ ] Readable terminal capture exists. If `OUTPUT_UNAVAILABLE`, stop: no private-xterm or transport interception workaround

## Command lifecycle

- [ ] `connect_start` for an existing project directory shows exact root/source-hash approval and reaches ready
- [ ] Decline one harmless command approval: no input/job/side effect may occur
- [ ] Approve `printf 'connect test\n'`; collect job output, status completed, exit 0
- [ ] Approve `printf 'out\n'; printf 'err\n' >&2; exit 7`; verify separate streams and exit 7
- [ ] Approve `sleep 5` with 500 ms timeout; collect timeout result
- [ ] Approve another bounded sleep, cancel by job ID, collect cancelled result
- [ ] Compare captured results with expected outputs; markers/echo alone are not success

## File lifecycle in a disposable project directory

- [ ] List/stat the approved directory
- [ ] Approve create-only write of a harmless UTF-8 test file; read it back and verify exact hash/content
- [ ] Read a larger disposable file; if `result_available` is returned, repeat `connect_job` with the same job ID and verify progress increases without replaying the file operation
- [ ] Generate a diff, then approve replacement with the returned current hash
- [ ] Try a deliberately incorrect expected hash: original file must remain unchanged
- [ ] Verify absolute paths, `..`, symlinks, known credentials and oversized content are rejected
- [ ] Verify new-file mode behavior and existing-mode preservation

## Disconnect and reconnection

- [ ] Stop worker; old tab must be quarantined from new plugin input
- [ ] Open a new Remote shell tab and explicitly reconnect/approve startup
- [ ] During a harmless bounded job, close the terminal tab; report unknown if completion cannot be established
- [ ] No command/file write is automatically replayed after reconnect
- [ ] Close the plugin browser when done; do not treat close acknowledgement as proof of remote termination

## If blocked

`APPROVAL_UNAVAILABLE`: This client has no supported MCP form capability. Use a compatible local client; never bypass approval with a tool boolean.

`OUTPUT_UNAVAILABLE` / `DEVICE_NOT_VERIFIED`: The authenticated UI differs from the candidate adapter. Record safe heading wording, terminal input count and capture mode. Do not paste cookies, query-bearing session URLs or credentials.

`RESPONSE_TIMEOUT` / `OUTCOME_UNKNOWN`: The command may have run. Inspect the old tab manually and reconnect in a fresh one. Don't retry automatically.

`COMMIT_UNCERTAIN`: Inspect the target file and its hash before deciding on another write.

`REMOTE_*`: Read the specific bounded worker error; root mismatch, path/secret guards, hash conflict and size limits are intentional checks.

## Evidence to save privately

OS/Node/Codex/Python/Connect versions; test stage; exact safe error code; expected/observed status; redacted terminal screenshot if needed. Label fixture versus real Pi evidence. Never include credentials, tokens, cookie exports, serial numbers or unrelated output.
