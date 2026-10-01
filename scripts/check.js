import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const dir of ['src', 'scripts', 'test', 'test/browser']) {
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
for (const file of ['package.json', '.codex-plugin/plugin.json', '.mcp.json']) JSON.parse(await readFile(file, 'utf8'));
console.log('Syntax and JSON checks passed');
