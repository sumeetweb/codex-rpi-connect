import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const script = fileURLToPath(new URL('../src/server.js', import.meta.url));
const args = ['mcp', 'add', 'rpi_connect', '--', process.execPath, script];
if (process.argv.includes('--apply')) {
  console.log('Registering this local MCP server in Codex. No browser login is performed.');
  const result = spawnSync('codex', args, { stdio: 'inherit' });
  if (result.error) { console.error('Could not run codex. Install the official Codex CLI first.'); process.exit(1); }
  process.exit(result.status || 0);
}
console.log('Preview only. No settings changed.');
console.log(['codex', ...args].map(arg => JSON.stringify(arg)).join(' '));
console.log('To register it, run: node scripts/install-codex.js --apply');
