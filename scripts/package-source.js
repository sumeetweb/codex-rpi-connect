#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILES = ['.mcp.json', '.gitignore', 'package.json', 'package-lock.json', 'README.md', 'SECURITY.md', 'LICENSE'];
const ROOT_DIRS = ['.codex-plugin', '.github', 'src', 'remote', 'skills', 'scripts', 'docs', 'test'];
const EXCLUDED = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', 'dist', 'coverage', 'playwright-report', 'test-results', 'auth.json', 'credentials.json', '.npmrc', '.env', 'cookies.json', 'storage-state.json', 'storageState.json']);
const excluded = name => EXCLUDED.has(name) || name.startsWith('.env.') || /\.(?:pyc|pyo|zip|log|pem|key|p12|pfx)$/i.test(name);
export function sourceFiles(root = ROOT) {
  const files = [];
  const visit = relative => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in source archive: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) if (!excluded(name)) visit(path.posix.join(relative, name));
    } else if (stat.isFile()) files.push(relative);
    else throw new Error(`Refusing non-regular source file: ${relative}`);
  };
  for (const name of ROOT_FILES) if (fs.existsSync(path.join(root, name))) visit(name);
  for (const name of ROOT_DIRS) if (fs.existsSync(path.join(root, name))) visit(name);
  if (!files.includes('.codex-plugin/plugin.json') || !files.includes('package-lock.json')) throw new Error('Not a complete plugin source tree');
  return files.sort();
}
export function packageSource({ root = ROOT, output = path.join(ROOT, 'dist/codex-rpi-connect-source.zip'), force = false } = {}) {
  root = fs.realpathSync(root);
  output = path.resolve(output);
  if (fs.existsSync(output) && !force) throw new Error(`Archive already exists: ${output}; pass --force to replace it`);
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Refusing symbolic-link archive destination');
  const files = sourceFiles(root);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const program = `import json, os, pathlib, stat, sys, tempfile, zipfile
request = json.load(sys.stdin)
root = pathlib.Path(request['root'])
output = pathlib.Path(request['output'])
fd, temporary = tempfile.mkstemp(prefix='.rpi-source-', suffix='.zip', dir=output.parent)
os.close(fd)
try:
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in request['files']:
            source = root / relative
            if source.is_symlink() or not source.is_file():
                raise ValueError('Source changed while packaging: ' + relative)
            info = zipfile.ZipInfo('codex-rpi-connect/' + relative, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if os.access(source, os.X_OK) else 0o644)) << 16
            archive.writestr(info, source.read_bytes())
    if request['force']:
        os.replace(temporary, output)
    else:
        # Exclusive creation does not overwrite an archive created concurrently.
        with open(temporary, 'rb') as src, open(output, 'xb') as dst:
            import shutil
            shutil.copyfileobj(src, dst)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
`;
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', program], { input: JSON.stringify({ root, output, files, force }), encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Python source packaging failed: ${result.error?.message || result.stderr.trim()}`);
  return { output, files: files.length, bytes: fs.statSync(output).size };
}
function main() {
  const args = process.argv.slice(2);
  let output; let force = false; let list = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) output = args[++i];
    else if (args[i] === '--force') force = true;
    else if (args[i] === '--list') list = true;
    else if (args[i] === '--help') { console.log('Usage: node scripts/package-source.js [--output FILE.zip] [--force] [--list]\nBuilds a source-only ZIP using Python 3. No dependencies, auth, Git history or browser profiles.'); return; }
    else throw new Error('Unknown or incomplete argument; use --help');
  }
  console.log(list ? sourceFiles().join('\n') : JSON.stringify(packageSource({ output, force }), null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(`Packaging blocked: ${error.message}`); process.exitCode = 1; }
}
