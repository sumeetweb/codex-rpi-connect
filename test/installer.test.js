import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPlan, applyPlan, lockedDependencies, prepareMarketplace, validateIdentifier } from '../scripts/install-plugin.js';
import { sourceFiles, packageSource } from '../scripts/package-source.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-installer-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source/codex-rpi-connect'); const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  write(path.join(source, '.codex-plugin/plugin.json'), { name: 'codex-rpi-connect', version: '1.0.0', skills: './skills/', mcpServers: './.mcp.json' });
  write(path.join(source, '.mcp.json'), { mcpServers: { rpi_connect: { command: 'node', args: ['src/server.js'], cwd: '.' } } });
  write(path.join(source, 'package.json'), { name: 'codex-rpi-connect', version: '1.0.0', dependencies: { example: '1.0.0' } });
  const info = { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: 'sha512-fixture' };
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { example: '1.0.0' } }, 'node_modules/example': info } };
  write(path.join(source, 'package-lock.json'), lock);
  write(path.join(source, 'node_modules/.package-lock.json'), { lockfileVersion: 3, packages: { 'node_modules/example': info } });
  write(path.join(source, 'node_modules/example/package.json'), { name: 'example', version: '1.0.0' });
  write(path.join(source, 'node_modules/example/index.js'), 'export default 1;\n');
  write(path.join(source, 'src/server.js'), 'console.log("fixture");\n');
  write(path.join(source, 'remote/worker.py'), '# fixture\n');
  write(path.join(source, 'skills/rpi-connect/SKILL.md'), '# Fixture\n');
  write(path.join(source, 'README.md'), '# Fixture setup\n');
  write(path.join(source, 'SECURITY.md'), '# Fixture security\n');
  write(path.join(source, 'docs/live-device-validation.md'), '# Fixture acceptance\n');
  return { temporary, source, home };
}

test('preview plans exact personal paths and makes no changes', t => {
  const { source, home } = fixture(t); const plan = createPlan({ source, home });
  assert.equal(plan.destination, path.join(home, 'plugins/codex-rpi-connect'));
  assert.equal(plan.marketplacePath, path.join(home, '.agents/plugins/marketplace.json'));
  assert.deepEqual(plan.command, ['codex', 'plugin', 'add', 'codex-rpi-connect@personal', '--json']);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.ok(!plan.files.some(file => /^(node_modules|scripts|test)\/|^auth\.json$/.test(file)));
});

test('CLI defaults to a preview and rejects unexpected flags', t => {
  const { home } = fixture(t);
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts/install-plugin.js'), ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const preview = run([]); assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /Preview only/); assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(run(['--force']).status, 1); assert.deepEqual(fs.readdirSync(home), []);
});

test('marketplace preserves metadata, order, existing entries and policies', () => {
  const old = { name: 'my_personal', interface: { displayName: 'Keep my name', extra: 'keep' }, extra: { owner: 'me' }, plugins: [{ name: 'other.plugin', source: { source: 'local', path: './plugins/other' }, custom: true }] };
  const value = prepareMarketplace(old);
  assert.deepEqual(value.plugins[0], old.plugins[0]); assert.deepEqual(value.interface, old.interface); assert.deepEqual(value.extra, old.extra); assert.equal(value.name, old.name);
  assert.equal(value.plugins[1].policy.authentication, 'ON_INSTALL'); assert.equal(old.plugins.length, 1);
  assert.deepEqual(prepareMarketplace(value), value);
});

test('rejects identifiers, duplicate entries and conflicting sources', () => {
  for (const bad of ['x;touch /tmp/x', 'bad@name', '../name', '', 'x\n']) assert.throws(() => validateIdentifier(bad));
  assert.throws(() => prepareMarketplace({ name: 'bad.name', plugins: [] }), /identifier/);
  assert.throws(() => prepareMarketplace({ name: 'personal', plugins: [{ name: 'one' }, { name: 'one' }] }), /Duplicate/);
  assert.throws(() => prepareMarketplace({ name: 'personal', plugins: [{ name: 'codex-rpi-connect', source: { source: 'local', path: './elsewhere' } }] }), /elsewhere/);
});

test('apply copies only runtime files and locked packages, then calls native plugin add', t => {
  const { source, home } = fixture(t); write(path.join(source, 'auth.json'), 'secret'); write(path.join(source, 'remote/__pycache__/worker.pyc'), 'cache');
  const calls = []; const plan = applyPlan(createPlan({ source, home }), { execute: (...args) => calls.push(args) });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 2), ['codex', ['plugin', 'add', 'codex-rpi-connect@personal', '--json']]);
  assert.equal(lockedDependencies(plan.destination).length, 1);
  assert.ok(!fs.existsSync(path.join(plan.destination, 'auth.json'))); assert.ok(!fs.existsSync(path.join(plan.destination, 'remote/__pycache__')));
  assert.equal(JSON.parse(fs.readFileSync(plan.marketplacePath)).plugins.length, 1);
  const before = fs.readFileSync(plan.marketplacePath, 'utf8');
  applyPlan(createPlan({ source, home }), { execute: (...args) => calls.push(args) });
  assert.equal(fs.readFileSync(plan.marketplacePath, 'utf8'), before); assert.equal(calls.length, 2);
});

test('copies nested locked dependencies once and excludes development-only packages', t => {
  const { source, home } = fixture(t);
  const lockPath = path.join(source, 'package-lock.json'); const lock = JSON.parse(fs.readFileSync(lockPath));
  const nested = 'node_modules/example/node_modules/nested'; const dev = 'node_modules/dev-only';
  lock.packages[nested] = { version: '2.0.0', integrity: 'sha512-nested' }; lock.packages[dev] = { version: '3.0.0', dev: true };
  write(lockPath, lock); write(path.join(source, 'node_modules/.package-lock.json'), lock);
  write(path.join(source, nested, 'package.json'), { name: 'nested', version: '2.0.0' }); write(path.join(source, nested, 'index.js'), 'nested');
  write(path.join(source, dev, 'package.json'), { name: 'dev-only', version: '3.0.0' });
  const plan = applyPlan(createPlan({ source, home }), { execute() {} });
  assert.equal(fs.readFileSync(path.join(plan.destination, nested, 'index.js'), 'utf8'), 'nested');
  assert.ok(!fs.existsSync(path.join(plan.destination, dev))); assert.equal(lockedDependencies(plan.destination).length, 2);
});

test('refuses hidden runtime auth files and unexpected MCP launch commands', t => {
  const { source, home } = fixture(t); write(path.join(source, 'src/.env'), 'secret');
  assert.throws(() => createPlan({ source, home }), /hidden\/authentication/); fs.unlinkSync(path.join(source, 'src/.env'));
  write(path.join(source, '.mcp.json'), { mcpServers: { rpi_connect: { command: 'sh', args: ['-c', 'anything'], cwd: '.' } } });
  assert.throws(() => createPlan({ source, home }), /Unexpected MCP/); assert.deepEqual(fs.readdirSync(home), []);
});

test('does not overwrite a marketplace changed during dependency installation', t => {
  const { source, home } = fixture(t); const plan = createPlan({ source, home, dependencyMode: 'npm' }); let calls = 0;
  assert.throws(() => applyPlan(plan, { execute(command, args, options) {
    calls++; fs.cpSync(path.join(source, 'node_modules'), path.join(options.cwd, 'node_modules'), { recursive: true });
    write(plan.marketplacePath, { name: 'changed_elsewhere', plugins: [] });
  } }), /Marketplace changed/);
  assert.equal(calls, 1); assert.equal(JSON.parse(fs.readFileSync(plan.marketplacePath)).name, 'changed_elsewhere');
});

test('does not replace unmanaged destinations or modified installed source', t => {
  const { source, home } = fixture(t); const destination = path.join(home, 'plugins/codex-rpi-connect');
  write(path.join(destination, 'user.txt'), 'keep'); assert.throws(() => createPlan({ source, home }), /not managed/);
  assert.equal(fs.readFileSync(path.join(destination, 'user.txt'), 'utf8'), 'keep');
  fs.rmSync(destination, { recursive: true }); const plan = applyPlan(createPlan({ source, home }), { execute() {} });
  write(path.join(plan.destination, 'src/server.js'), 'user edits'); assert.throws(() => createPlan({ source, home }), /modified/);
  assert.equal(fs.readFileSync(path.join(plan.destination, 'src/server.js'), 'utf8'), 'user edits');
});

test('blocks differing release, changed marketplace, and symbolic-link targets', t => {
  const { source, home, temporary } = fixture(t); const plan = applyPlan(createPlan({ source, home }), { execute() {} });
  write(path.join(source, 'src/server.js'), 'new release'); assert.throws(() => createPlan({ source, home }), /different release/);
  const nextHome = path.join(temporary, 'next-home'); fs.mkdirSync(nextHome); fs.symlinkSync(home, path.join(nextHome, 'plugins'));
  assert.throws(() => createPlan({ source, home: nextHome }), /symbolic-link/);
  assert.ok(fs.existsSync(plan.marketplacePath));
});

test('npm path is explicit and only runs on apply at installed location', t => {
  const { source, home } = fixture(t); const plan = createPlan({ source, home, dependencyMode: 'npm' }); const calls = [];
  assert.equal(plan.dependencies, null); assert.deepEqual(fs.readdirSync(home), []);
  applyPlan(plan, { execute(command, args, options) {
    calls.push({ command, args, options });
    if (command.startsWith('npm')) fs.cpSync(path.join(source, 'node_modules'), path.join(options.cwd, 'node_modules'), { recursive: true });
  } });
  assert.deepEqual(calls[0].args, ['ci', '--omit=dev', '--ignore-scripts']); assert.equal(calls[0].options.cwd, plan.destination); assert.equal(calls[1].command, 'codex');
});

test('npm failure does not register a marketplace or claim successful native installation', t => {
  const { source, home } = fixture(t); const plan = createPlan({ source, home, dependencyMode: 'npm' });
  assert.throws(() => applyPlan(plan, { execute() { throw new Error('network unavailable'); } }), /network unavailable/);
  assert.ok(!fs.existsSync(plan.marketplacePath));
});

test('source ZIP excludes dependencies, auth, Git state and runtime caches', t => {
  const { source, temporary } = fixture(t);
  for (const file of ['auth.json', '.env', '.git/config', 'remote/__pycache__/worker.pyc', 'test/auth.json', 'docs/key.pem', 'docs/.env.production']) write(path.join(source, file), 'never archive');
  write(path.join(source, 'docs/readme.md'), 'included');
  const files = sourceFiles(source); assert.ok(files.includes('docs/readme.md')); assert.ok(!files.some(file => /node_modules|auth.json|\.env|\.git\/|pycache|\.pem/.test(file)));
  const output = path.join(temporary, 'source.zip'); const result = packageSource({ root: source, output }); assert.ok(result.bytes > 100);
  const listing = spawnSync('python3', ['-c', 'import json,sys,zipfile;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', output], { encoding: 'utf8' });
  assert.equal(listing.status, 0); assert.deepEqual(JSON.parse(listing.stdout), files.map(file => 'codex-rpi-connect/' + file));
  assert.throws(() => packageSource({ root: source, output }), /already exists/);
  const before = fs.readFileSync(output); packageSource({ root: source, output, force: true }); assert.deepEqual(fs.readFileSync(output), before);
});

test('runtime and ZIP reject source symlinks instead of following secrets', t => {
  const { source, temporary, home } = fixture(t); write(path.join(temporary, 'outside-secret'), 'secret'); fs.symlinkSync(path.join(temporary, 'outside-secret'), path.join(source, 'src/link.js'));
  assert.throws(() => sourceFiles(source), /symbolic link/); assert.throws(() => createPlan({ source, home }), /symbolic link/);
});

function rpcClient(child) {
  let next = 0; const pending = new Map(); const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) { const { resolve, reject, timer } = pending.get(message.id); clearTimeout(timer); pending.delete(message.id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); }
  });
  return { notify(method, params = {}) { child.stdin.write(JSON.stringify({ method, params }) + '\n'); }, call(method, params = {}) {
    const id = ++next; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 30000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  }, close() { lines.close(); for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('RPC closed')); } pending.clear(); } };
}

test('native Codex installs and loads MCP from materialized cache in isolated HOME', { skip: process.env.RUN_NATIVE_PLUGIN_TEST !== '1', timeout: 120000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-native-install-')); const home = path.join(temporary, 'home'); const codexHome = path.join(temporary, 'codex'); const elsewhere = path.join(temporary, 'unrelated');
  for (const directory of [home, codexHome, elsewhere]) fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  write(path.join(codexHome, 'config.toml'), 'hide_agent_reasoning = true\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  const apply = spawnSync(process.execPath, [path.join(ROOT, 'scripts/install-plugin.js'), '--apply'], { env, cwd: elsewhere, encoding: 'utf8', timeout: 60000 });
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  const match = apply.stdout.match(/"installedPath":\s*"([^"]+)"/); assert.ok(match, apply.stdout); const installedPath = match[1]; assert.ok(installedPath.startsWith(codexHome + path.sep));
  const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); assert.match(config, /plugins\."codex-rpi-connect@personal"/); assert.match(config, /hide_agent_reasoning = true/);
  const mcp = JSON.parse(fs.readFileSync(path.join(installedPath, '.mcp.json'))).mcpServers.rpi_connect;
  const client = new Client({ name: 'materialized-native-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: mcp.command, args: mcp.args, cwd: path.resolve(installedPath, mcp.cwd), env, stderr: 'pipe' }));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'connect_exec'));
    const status = await client.callTool({ name: 'connect_status', arguments: {} }); assert.equal(JSON.parse(status.content[0].text).status, 'closed');
  } finally { await client.close(); }
  // The host starts in a directory without src/server.js. A real host inventory proves
  // Codex resolved the plugin cwd/launch correctly instead of inheriting this cwd.
  const host = spawn('codex', ['app-server', '--stdio'], { env, cwd: elsewhere, stdio: ['pipe', 'pipe', 'pipe'] }); let stderr = ''; host.stderr.on('data', data => { stderr += data; }); const rpc = rpcClient(host);
  try {
    await rpc.call('initialize', { clientInfo: { name: 'rpi-native-test', version: '1.0.0' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
    const inventory = await rpc.call('mcpServerStatus/list'); const server = inventory.data.find(server => server.name === 'rpi_connect');
    assert.ok(server, stderr); assert.equal(server.pluginId, 'codex-rpi-connect@personal'); assert.equal(server.toolsError, null); assert.ok(server.tools.connect_exec); assert.ok(server.tools.connect_file_write);
    t.diagnostic(`Native materialization + cache stdio status + Codex-resolved plugin launch passed; ${Object.keys(server.tools).length} tools. No login or model turn.`);
  } finally { rpc.close(); const exited = once(host, 'exit'); host.kill('SIGTERM'); await exited; }
});
