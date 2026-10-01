# Native Codex plugin installation

This installs the plugin through Codex's native personal-marketplace mechanism. It does not use `codex mcp add`, and it does not modify your existing standalone MCP registrations.

## Requirements

- Node.js 22 or newer, with `node` available to the Codex app/CLI process
- An official Codex CLI with `codex plugin add` support, available on `PATH`
- An extracted, trusted source folder named `codex-rpi-connect`
- npm registry access if the extracted folder does not already contain matching installed dependencies
- A supported local desktop/browser for the later Connect session; installation alone does not download Chromium or authenticate

Run these commands from the extracted source folder, **not** from the installed copy:

```sh
node scripts/install-plugin.js
node scripts/install-plugin.js --apply
```

The first command is a read-only preview. Only `--apply` changes files or starts dependency installation and native registration. Review its destination, dependency action and exact Codex command first.

The default destinations are:

- Plugin source: `~/plugins/codex-rpi-connect`
- Personal marketplace: `~/.agents/plugins/marketplace.json`
- Native registration: `codex plugin add codex-rpi-connect@personal --json`

If an existing personal marketplace has a different valid name, the installer keeps that name and uses it in the registration command. Codex discovers this personal marketplace implicitly: do **not** add it with `codex plugin marketplace add`.

After successful native registration, start a **new Codex thread** so its skills and tools are loaded. `codex plugin list --json` can confirm the enabled plugin. Registration is not proof that a live Raspberry Pi connection works.

## What the installer changes

It copies the manifest, MCP configuration, package/lock files and runtime `src/`, `remote/`, `skills/` directories, plus README/security documentation and `docs/` so installed skill references remain available. It omits Python caches. It refuses symlinked destinations or source files and unexpected hidden/authentication files in runtime directories. It creates a small ownership/hash marker used to recognize an identical retry.

The installer preserves an existing marketplace's name, interface metadata, unrelated entries and order. It appends its own entry only if absent. A matching existing entry is preserved; a conflicting path or unsupported policy blocks installation. It does not hand-edit Codex's TOML settings. The **Codex CLI** performs native installation and enables the requested plugin.

An existing unmanaged destination or an edited/different release is never overwritten. Identical re-runs are supported. If native registration fails, the command exits unsuccessfully and reports the blocker; prepared source files and the marketplace entry may remain for an explicit retry. No failed CLI invocation is described as a successful install.

### Locked dependencies

By default, the installer reuses runtime packages from a **trusted** source checkout only when their installed lock metadata and package versions match `package-lock.json`. This is a metadata consistency check, not a cryptographic audit of every installed file. Development-only packages are omitted. Source archives contain no dependencies, so an ordinary archive installation instead runs:

```sh
npm ci --omit=dev --ignore-scripts
```

That command runs only after `--apply`, in `~/plugins/codex-rpi-connect`, with Playwright browser download disabled. To require a fresh locked npm install instead of copying dependencies from the source checkout:

```sh
node scripts/install-plugin.js --dependencies=npm
node scripts/install-plugin.js --apply --dependencies=npm
```

This does not replace an existing dependency directory. If an interrupted installation left an incomplete `node_modules`, inspect it and move that directory aside yourself before retrying. No automatic dependency-directory deletion occurs.

No browser profiles, cookies, credentials, authentication tokens or private account files are copied. There is no automatic sign-in, device enrollment, publication or remote command execution. Browser installation and manual Connect sign-in are separate explicit steps described in the main README.

## Existing installations and upgrades

This installer intentionally avoids an in-place `--force` mode. Do not point it at a directory containing unrelated work or manually replace the marketplace entry.

For a different release, stop this plugin's active sessions, preserve the installed source directory by moving it to a backup location, and run the new source installer. Use the same existing marketplace entry and name. Releases with an unchanged manifest version can be cached by Codex: for an unreleased local edit, ask Codex to refresh the local plugin's cache version, then reinstall with `codex plugin add codex-rpi-connect@<existing-marketplace-name>`. The ordinary installer does not rewrite release versions. Do not edit unrelated settings or marketplace entries. Start a new thread afterward. Keep the backup until the new version has passed your checks.

## Isolated native verification

The optional integration test uses temporary `HOME` and `CODEX_HOME` directories. It never points the CLI at your actual personal marketplace or settings:

```sh
RUN_NATIVE_PLUGIN_TEST=1 node --test test/installer.test.js
```

It applies this installer, checks Codex's returned materialized cache path, performs an MCP stdio handshake and `connect_status` against that cached copy, and asks a real Codex app-server for its plugin MCP inventory from an unrelated working directory. Successful inventory demonstrates that Codex resolved the relative `.mcp.json` working directory/launch path correctly. No browser opens and no model request or account login is needed.

Verified here with Codex CLI `0.159.0-alpha.7` on Linux: native personal-marketplace materialization, cached-copy MCP status and actual host inventory of 17 tools. This does not establish cross-platform GUI behavior or live Raspberry Pi Connect compatibility.

## Source-only package

Build a portable ZIP using Node.js and Python 3:

```sh
node scripts/package-source.js --list
node scripts/package-source.js --output /desired/path/codex-rpi-connect-source.zip
```

The archive uses the `codex-rpi-connect/` top-level folder and contains the allowlisted source, tests, documentation, scripts and manifests. It excludes `node_modules`, Git history, caches, logs, common authentication/config files, browser storage-state files and private-key formats. Review the `--list` output before distributing a locally modified checkout. Credential-like contents in an arbitrarily named source file cannot be identified reliably by a filename filter; never add secrets to the source tree.

Packaging refuses source symlinks and refuses to overwrite an existing ZIP unless `--force` is explicitly supplied. It does not upload or publish the archive.
