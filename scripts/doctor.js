import { chromium } from 'playwright';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const major = Number(process.versions.node.split('.')[0]);
console.log(`Node: ${process.version} (requires 22+)`);
if (major < 22) { console.log('BLOCKED: upgrade to Node 22 or newer from the official distribution.'); process.exitCode = 1; }
const executable = process.env.RPI_CONNECT_CHROMIUM_PATH || chromium.executablePath();
try { await access(executable); console.log('Chromium executable: found (launch not tested)'); }
catch { console.log('Chromium executable: missing. Run npx playwright install chromium'); process.exitCode = 1; }
try {
  const source = await readFile(new URL('../remote/worker.py', import.meta.url));
  if (source.length > 49152) throw new Error('too large');
  console.log(`Bundled worker: ${source.length} bytes, SHA-256 ${createHash('sha256').update(source).digest('hex')}`);
} catch { console.log('BLOCKED: bundled remote worker is missing or exceeds bootstrap size. Reinstall from the verified source.'); process.exitCode = 1; }
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.log('No Linux display detected. Manual authentication requires a visible desktop browser.'); process.exitCode = 1;
}
console.log('MCP forms: check approvalFormsSupported using connect_status in your actual client. Unsupported forms fail closed.');
console.log('Pi requirements: Linux/Raspberry Pi OS, Python 3, Connect Remote shell, existing project root. Not checked remotely.');
console.log('Real browser/Connect session: not checked. Follow docs/morning-test.md.');
console.log('No credentials, cookies or terminal output were read.');
