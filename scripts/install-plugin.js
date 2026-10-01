#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const PLUGIN_NAME = 'codex-rpi-connect';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '.rpi-connect-install.json';
const FILES = ['.codex-plugin/plugin.json', '.mcp.json', 'package.json', 'package-lock.json', 'README.md', 'SECURITY.md'];
const DIRECTORIES = ['src', 'remote', 'skills', 'docs'];
const ignored = new Set(['__pycache__', '.DS_Store']);
const secretName = name => name.startsWith('.') || /^(?:auth|credentials|cookies|storage[-_]?state)\.json$/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
const hash = data => createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateIdentifier(value, marketplace = false) {
  if (typeof value !== 'string' || value.length > 64 || !(marketplace ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/).test(value)) {
    throw new Error(`Invalid ${marketplace ? 'marketplace' : 'plugin'} identifier`);
  }
  return value;
}
function noSymlinks(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symbolic-link path: ${current}`);
  }
}
function walk(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    if (secretName(entry.name)) throw new Error(`Unexpected hidden/authentication file in runtime payload: ${entry.name}`);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in runtime payload: ${path.join(directory, entry.name)}`);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...walk(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Refusing non-regular runtime file: ${relative}`);
  }
  return result;
}
export function runtimeFiles(source) {
  const result = [...FILES];
  for (const file of FILES) {
    noSymlinks(path.join(source, file));
    if (!fs.statSync(path.join(source, file)).isFile()) throw new Error(`Missing runtime file: ${file}`);
  }
  for (const directory of DIRECTORIES) {
    noSymlinks(path.join(source, directory));
    result.push(...walk(path.join(source, directory), directory));
  }
  return result.sort();
}
export function prepareMarketplace(value) {
  const marketplace = value === undefined ? { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] } : structuredClone(value);
  if (!object(marketplace)) throw new Error('Marketplace must be a JSON object');
  validateIdentifier(marketplace.name, true);
  if (marketplace.interface !== undefined && !object(marketplace.interface)) throw new Error('Marketplace interface must be an object');
  if (!Array.isArray(marketplace.plugins)) throw new Error('Marketplace plugins must be an array');
  const names = new Set();
  for (const entry of marketplace.plugins) {
    if (!object(entry)) throw new Error('Invalid marketplace entry');
    validateIdentifier(entry.name);
    if (names.has(entry.name)) throw new Error(`Duplicate marketplace entry: ${entry.name}`);
    names.add(entry.name);
  }
  const old = marketplace.plugins.find(entry => entry.name === PLUGIN_NAME);
  const source = { source: 'local', path: `./plugins/${PLUGIN_NAME}` };
  if (old) {
    if (old.source?.source !== source.source || old.source?.path !== source.path) throw new Error('Existing plugin marketplace entry points elsewhere; refusing to replace it');
    if (!['AVAILABLE', 'INSTALLED_BY_DEFAULT'].includes(old.policy?.installation) || !['ON_INSTALL', 'ON_USE'].includes(old.policy?.authentication) || typeof old.category !== 'string') throw new Error('Existing plugin marketplace policy/category is unsupported; refusing to change it');
  } else marketplace.plugins.push({ name: PLUGIN_NAME, source, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' });
  return marketplace;
}
export function lockedDependencies(source) {
  const lock = json(path.join(source, 'package-lock.json'));
  const pkg = json(path.join(source, 'package.json'));
  if (lock.lockfileVersion !== 3 || !object(lock.packages) || JSON.stringify(lock.packages['']?.dependencies) !== JSON.stringify(pkg.dependencies)) throw new Error('package-lock.json does not match package.json runtime dependencies');
  let installed;
  try { noSymlinks(path.join(source, 'node_modules/.package-lock.json')); installed = json(path.join(source, 'node_modules/.package-lock.json')); } catch { return null; }
  const paths = [];
  for (const [relative, info] of Object.entries(lock.packages)) {
    if (!relative || info.dev) continue;
    if (!/^node_modules\/(?:[@A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(relative) || relative.split('/').includes('..') || info.link) throw new Error('Unsupported package-lock dependency path/link');
    const resolved = installed.packages?.[relative];
    if (!resolved || resolved.version !== info.version || resolved.integrity !== info.integrity || resolved.resolved !== info.resolved) return null;
    try {
      noSymlinks(path.join(source, relative));
      if (json(path.join(source, relative, 'package.json')).version !== info.version) return null;
    } catch { return null; }
    paths.push(relative);
  }
  return paths.sort();
}
export function createPlan({ source = ROOT, home = os.homedir(), dependencyMode = 'auto' } = {}) {
  source = fs.realpathSync(source);
  home = fs.realpathSync(home);
  if (!['auto', 'npm'].includes(dependencyMode)) throw new Error('Dependencies must be auto or npm');
  const manifest = json(path.join(source, '.codex-plugin/plugin.json'));
  validateIdentifier(manifest.name);
  if (manifest.name !== PLUGIN_NAME || path.basename(source) !== PLUGIN_NAME) throw new Error(`Source folder and manifest must both be named ${PLUGIN_NAME}`);
  const server = json(path.join(source, '.mcp.json')).mcpServers?.rpi_connect;
  if (server?.command !== 'node' || server.cwd !== '.' || JSON.stringify(server.args) !== '["src/server.js"]') throw new Error('Unexpected MCP launch configuration; review before installing');
  const destination = path.join(home, 'plugins', PLUGIN_NAME);
  const marketplacePath = path.join(home, '.agents/plugins/marketplace.json');
  noSymlinks(destination); noSymlinks(marketplacePath);
  if (source === destination || source.startsWith(destination + path.sep)) throw new Error('Run the installer from an extracted source folder outside the installed destination');
  const marketplaceOriginal = exists(marketplacePath) ? fs.readFileSync(marketplacePath, 'utf8') : null;
  const marketplace = prepareMarketplace(marketplaceOriginal === null ? undefined : JSON.parse(marketplaceOriginal));
  const files = runtimeFiles(source);
  const hashes = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(source, file)))]));
  let alreadyPrepared = false;
  if (exists(destination)) {
    if (!fs.statSync(destination).isDirectory() || !exists(path.join(destination, MARKER))) throw new Error(`Destination exists and is not managed by this installer: ${destination}`);
    noSymlinks(path.join(destination, MARKER));
    const marker = json(path.join(destination, MARKER));
    if (marker.plugin !== PLUGIN_NAME || marker.format !== 1 || JSON.stringify(marker.hashes) !== JSON.stringify(hashes)) throw new Error('Destination contains a different release. Preserve it and use the documented upgrade flow; nothing was overwritten');
    for (const [file, expected] of Object.entries(hashes)) {
      noSymlinks(path.join(destination, file));
      if (!exists(path.join(destination, file)) || hash(fs.readFileSync(path.join(destination, file))) !== expected) throw new Error(`Installed file was modified; refusing to overwrite: ${file}`);
    }
    alreadyPrepared = true;
  }
  const dependencies = dependencyMode === 'auto' ? lockedDependencies(source) : (lockedDependencies(source), null);
  return { source, home, destination, marketplacePath, marketplaceOriginal, marketplace, files, hashes, alreadyPrepared, dependencies, command: ['codex', 'plugin', 'add', `${PLUGIN_NAME}@${marketplace.name}`, '--json'] };
}
function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}. Prepared files remain available for an explicit retry`);
}
export function applyPlan(plan, { execute = run } = {}) {
  // Recompute immediately before mutation, rather than trusting a stale preview.
  plan = createPlan({ source: plan.source, home: plan.home, dependencyMode: plan.dependencies ? 'auto' : 'npm' });
  if (!plan.alreadyPrepared) {
    fs.mkdirSync(path.dirname(plan.destination), { recursive: true });
    const stage = fs.mkdtempSync(path.join(path.dirname(plan.destination), '.rpi-connect-stage-'));
    try {
      for (const file of plan.files) {
        fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
        fs.copyFileSync(path.join(plan.source, file), path.join(stage, file), fs.constants.COPYFILE_EXCL);
        if (hash(fs.readFileSync(path.join(stage, file))) !== plan.hashes[file]) throw new Error(`Source changed during installation: ${file}`);
      }
      fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ format: 1, plugin: PLUGIN_NAME, hashes: plan.hashes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (exists(plan.destination)) throw new Error('Destination appeared during installation; refusing to replace it');
      fs.renameSync(stage, plan.destination);
    } finally { if (exists(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
  }
  const installedDependencies = lockedDependencies(plan.destination);
  if (!installedDependencies) {
    if (exists(path.join(plan.destination, 'node_modules'))) throw new Error('Installed dependency directory is incomplete or differs from the lock. Inspect and move it aside before retrying; it was not overwritten');
    if (plan.dependencies) {
      for (const relative of plan.dependencies) {
        fs.mkdirSync(path.dirname(path.join(plan.destination, relative)), { recursive: true });
        const packageSource = path.join(plan.source, relative);
        fs.cpSync(packageSource, path.join(plan.destination, relative), { recursive: true, errorOnExist: true, force: false, filter: file => { if (path.relative(packageSource, file).split(path.sep).some(part => part === 'node_modules' || part === '.bin')) return false; if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing symbolic link in dependency: ${file}`); return true; } });
      }
      fs.copyFileSync(path.join(plan.source, 'node_modules/.package-lock.json'), path.join(plan.destination, 'node_modules/.package-lock.json'));
    } else execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: plan.destination, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
    if (!lockedDependencies(plan.destination)) throw new Error('Installed dependencies did not match the locked runtime packages; native plugin registration was not attempted');
  }
  // Preserve all original metadata, entries, policies and order. Only append our absent entry.
  const current = exists(plan.marketplacePath) ? fs.readFileSync(plan.marketplacePath, 'utf8') : null;
  if (current !== plan.marketplaceOriginal) throw new Error('Marketplace changed during installation; retry after reviewing it');
  const updated = JSON.stringify(plan.marketplace, null, 2) + '\n';
  if (current === null || JSON.stringify(JSON.parse(current)) !== JSON.stringify(plan.marketplace)) {
    fs.mkdirSync(path.dirname(plan.marketplacePath), { recursive: true });
    noSymlinks(plan.marketplacePath);
    const temporary = `${plan.marketplacePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, updated, { flag: 'wx', mode: current === null ? 0o600 : fs.statSync(plan.marketplacePath).mode & 0o777 });
      fs.renameSync(temporary, plan.marketplacePath);
    } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
  }
  execute(plan.command[0], plan.command.slice(1), { cwd: plan.home, env: { ...process.env, HOME: plan.home, USERPROFILE: plan.home } });
  return plan;
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/install-plugin.js [--apply] [--dependencies=auto|npm]\nWithout --apply: preview only. Default destination: ~/plugins/codex-rpi-connect.\nDefault marketplace: ~/.agents/plugins/marketplace.json. No login or browser download.'); return;
  }
  if (args.some(arg => arg !== '--apply' && !['--dependencies=auto', '--dependencies=npm'].includes(arg))) throw new Error('Unknown argument; use --help');
  const plan = createPlan({ dependencyMode: args.find(arg => arg.startsWith('--dependencies='))?.split('=')[1] || 'auto' });
  console.log(args.includes('--apply') ? 'Applying explicit local native-plugin installation.' : 'Preview only. No files, dependencies, or settings changed.');
  console.log(`Runtime source: ${plan.source}\nInstall source: ${plan.destination}\nPersonal marketplace: ${plan.marketplacePath}`);
  console.log(plan.dependencies ? `Dependencies: copy ${plan.dependencies.length} installed runtime packages matching package-lock.json (no download).` : `Dependencies: run npm ci --omit=dev --ignore-scripts in ${plan.destination} (registry access required).`);
  console.log(`Native registration: ${plan.command.map(value => JSON.stringify(value)).join(' ')}`);
  console.log('This enables the plugin in Codex. It does not sign in, request credentials, open a browser, install Chromium, or publish anything.');
  if (!args.includes('--apply')) { console.log('To apply: node scripts/install-plugin.js --apply'); return; }
  applyPlan(plan);
  console.log('Native plugin installation succeeded. Start a new Codex thread to load its skills and tools.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(`Installation blocked: ${error.message}`); process.exitCode = 1; }
}
