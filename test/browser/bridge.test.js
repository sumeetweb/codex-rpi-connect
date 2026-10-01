import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { encodeFrame } from '../../src/wire.js';
import { ConnectBridge, inspectTerminal, safeUrl } from '../../src/browser.js';
let server, origin, browser;
const html = await readFile(new URL('../fixtures/terminal.html', import.meta.url));
const xtermJs = await readFile(new URL('../../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url));
const xtermCss = await readFile(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url));
before(async () => {
  server = createServer((req, res) => {
    const routes = { '/xterm.js': ['application/javascript', xtermJs], '/xterm.css': ['text/css', xtermCss] };
    const [type, body] = routes[req.url] || ['text/html', html];
    res.writeHead(200, { 'Content-Type': type }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.RPI_CONNECT_TEST_CHROMIUM_PATH ? { executablePath: process.env.RPI_CONNECT_TEST_CHROMIUM_PATH } : {}) });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function setup(t, { a11y = true, canvasOnly = false, behavior = 'shell', waitMs = 700, workerToken = '0123456789abcdef' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let commands = 0;
  await page.exposeFunction('fixtureCommand', async line => {
    commands++;
    if (behavior === 'nothing') return '';
    if (behavior === 'worker') {
      if (line.startsWith(' python3 ')) return encodeFrame(workerToken, '0000000000000000', { status: 'ready', protocol: 1, root: '/tmp/test-project', python: '3.11.0' }) + '\n';
      const request = JSON.parse(line);
      if (request.op === 'fixture_echo') return encodeFrame(workerToken, request.id, { value: request.value }) + '\n';
      return encodeFrame(workerToken, request.id, { status: 'running', jobId: '1111111111111111', note: 'wrapped response '.repeat(30) }) + '\n';
    }
    if (behavior === 'disconnect') { setTimeout(() => page.close(), 30); return ''; }
    if (behavior === 'removeCapture') { setTimeout(() => page.evaluate(() => window.fixture.removeReadableOutput()), 30); return ''; }
    // Synthetic output, deliberately no local/remote shell endpoint. Actual POSIX
    // wrapper execution is tested separately on Linux in protocol.test.js.
    assert.match(line, /^ \/bin\/sh -c '/);
    const match = line.match(/CRC_([a-f0-9]{12}).*?([a-f0-9]{12})/);
    assert.ok(match);
    const marker = `CRC_${match[1]}${match[2]}`;
    const code = behavior === 'nonzero' ? 7 : behavior === 'timeout' ? 124 : 0;
    return `\n${marker} BEGIN\ncodex-rpi-connect OK\n\n${marker} END ${code}\n`;
  });
  await page.goto(`${origin}/devices/test-pi/shell`);
  await page.waitForFunction(() => window.fixture?.ready && document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('$'));
  await page.evaluate(a11y => window.fixture.setA11y(a11y), a11y);
  if (canvasOnly) await page.evaluate(() => window.fixture.removeReadableOutput());
  const bridge = new ConnectBridge({ origin, waitMs, pollMs: 20 });
  bridge.browser = browser; bridge.context = context;
  return { bridge, page, pageErrors, commands: () => commands, attach: () => bridge.attach({ deviceName: 'test-pi', terminalUrl: page.url() }) };
}

test('safe URL prevents off-origin, deceptive origins and credential query disclosure', () => {
  assert.equal(safeUrl('https://connect.raspberrypi.com.evil.example/devices/x'), null);
  assert.equal(safeUrl('https://connect.raspberrypi.com/path?secret=hidden#token'), 'https://connect.raspberrypi.com/path');
  assert.equal(safeUrl('javascript:alert(1)'), null);
});
test('real xterm input and rendered a11y output work end-to-end with synthetic command response', async t => {
  const f = await setup(t, { waitMs: 2000 });
  const session = await f.attach();
  assert.equal(session.textCapture, 'xterm-accessibility');
  const result = await f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
  assert.equal(result.status, 'completed', JSON.stringify({ result, pageErrors: f.pageErrors, terminal: await inspectTerminal(f.page) }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'codex-rpi-connect OK');
  assert.equal(f.commands(), 1);
});
test('terminal with no readable output fails closed without sending input', async t => {
  const f = await setup(t, { a11y: false, canvasOnly: true });
  assert.equal((await inspectTerminal(f.page)).capture, null);
  await assert.rejects(f.attach(), { code: 'OUTPUT_UNAVAILABLE' });
  assert.equal(f.commands(), 0);
});
test('ordinary DOM renderer supports input and output when accessibility is disabled', async t => {
  const f = await setup(t, { a11y: false, waitMs: 2000 });
  const session = await f.attach();
  assert.equal(session.textCapture, 'xterm-rendered-dom');
  const result = await f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
  assert.equal(result.status, 'completed', JSON.stringify({ result, pageErrors: f.pageErrors, terminal: await inspectTerminal(f.page) }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'codex-rpi-connect OK');
  assert.equal(f.commands(), 1);
});
test('wrong exact device identity and off-origin URL cannot attach', async t => {
  const f = await setup(t);
  await assert.rejects(f.bridge.attach({ deviceName: 'other-pi', terminalUrl: f.page.url() }), { code: 'DEVICE_NOT_VERIFIED' });
  await assert.rejects(f.bridge.attach({ deviceName: 'test-pi', terminalUrl: 'https://evil.example/' }), { code: 'INVALID_URL' });
  assert.equal(f.commands(), 0);
});
test('duplicate terminal inputs cannot attach', async t => {
  const f = await setup(t);
  await f.page.evaluate(() => document.querySelector('.xterm').append(document.querySelector('textarea').cloneNode()));
  await assert.rejects(f.attach(), { code: 'TERMINAL_NOT_UNIQUE' });
  assert.equal(f.commands(), 0);
});
test('navigation after attach is rejected before input', async t => {
  const f = await setup(t);
  const session = await f.attach();
  await f.page.goto(`${origin}/devices/other-pi/shell`);
  await assert.rejects(f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' }), { code: 'SESSION_CHANGED' });
  assert.equal(f.commands(), 0);
});
test('changed heading after attach is rejected before input', async t => {
  const f = await setup(t);
  const session = await f.attach();
  await f.page.locator('h1').evaluate(element => { element.textContent = 'other-pi'; });
  await assert.rejects(f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' }), { code: 'DEVICE_CHANGED' });
  assert.equal(f.commands(), 0);
});
test('missing completion is unknown, serialization and retry block are enforced', async t => {
  const f = await setup(t, { behavior: 'nothing', waitMs: 200 });
  const session = await f.attach();
  const pending = f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
  await assert.rejects(f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' }), { code: 'BUSY' });
  const result = await pending;
  assert.equal(result.status, 'unknown');
  assert.equal(result.retrySafe, false);
  await assert.rejects(f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' }), { code: 'SESSION_UNCERTAIN' });
  assert.equal(f.commands(), 1);
});
test('disconnect after input is unknown and never replayed', async t => {
  const f = await setup(t, { behavior: 'disconnect' });
  const session = await f.attach();
  const result = await f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
  assert.equal(result.status, 'unknown'); assert.equal(result.retrySafe, false); assert.equal(f.commands(), 1);
});
test('terminal capture lost after input is unknown', async t => {
  const f = await setup(t, { behavior: 'removeCapture' });
  const session = await f.attach();
  const result = await f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
  assert.equal(result.status, 'unknown'); assert.equal(result.retrySafe, false);
});
test('device discovery deduplicates URLs and does not infer status without visible evidence', async t => {
  const f = await setup(t);
  await f.page.locator('body').evaluate(body => { body.insertAdjacentHTML('beforeend', '<ul><li><a href="/devices/a">alpha</a> Online</li><li><a href="/devices/a">alpha</a></li><li><a href="/devices/b">beta</a> Offline</li><li><a href="/devices/c">gamma</a></li></ul>'); });
  const result = await f.bridge.devices();
  assert.deepEqual(result.devices.map(d => [d.name, d.status]), [['alpha', 'online'], ['beta', 'offline'], ['gamma', 'unknown']]);
});
test('status returns capability without returning terminal text', async t => {
  const f = await setup(t);
  await f.page.evaluate(() => window.fixture.write('secret fixture contents\r\n'));
  const result = await f.bridge.status();
  assert.equal(JSON.stringify(result).includes('secret fixture contents'), false);
  assert.equal(result.pages[0].textCapture, 'xterm-accessibility');
});

test('fixture nonzero exit and remote timeout are never reported as success', async t => {
  for (const behavior of ['nonzero', 'timeout']) {
    const f = await setup(t, { behavior, waitMs: 2000 });
    const session = await f.attach();
    const result = await f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
    assert.equal(result.exitCode, behavior === 'nonzero' ? 7 : 124);
    assert.equal(result.status, behavior === 'nonzero' ? 'completed' : 'remote_timeout');
  }
});

test('worker bootstrap and wrapped CRC RPC response through real xterm fixture', async t => {
  const f = await setup(t, { behavior: 'worker', waitMs: 2000 });
  const binding = await f.attach();
  const token = '0123456789abcdef';
  const ready = await f.bridge.workerStart({ sessionId: binding.sessionId, token, workspaceRoot: '/tmp/test-project', source: 'print("fixture")' });
  assert.equal(ready.status, 'ready');
  const result = await f.bridge.workerRpc({ sessionId: binding.sessionId, op: 'job_status', fields: { jobId: '1111111111111111' } });
  assert.equal(result.status, 'running');
  assert.equal(result.note, 'wrapped response '.repeat(30));
  const unicode = await f.bridge.workerRpc({ sessionId: binding.sessionId, op: 'fixture_echo', fields: { value: 'π / 工作 / café' } });
  assert.equal(unicode.value, 'π / 工作 / café');
  assert.deepEqual(f.pageErrors, []);
  await assert.rejects(f.bridge.diagnostic({ sessionId: binding.sessionId, probe: 'smoke' }), { code: 'WORKER_ACTIVE' });
});

test('hidden device heading is never sufficient for attaching', async t => {
  const f = await setup(t);
  await f.page.locator('h1').evaluate(element => { element.style.display = 'none'; });
  await assert.rejects(f.attach(), { code: 'DEVICE_NOT_VERIFIED' });
});

test('same-URL replacement of terminal input is rejected before any command', async t => {
  const f = await setup(t);
  const binding = await f.attach();
  await f.page.locator('textarea.xterm-helper-textarea').evaluate(input => input.replaceWith(input.cloneNode()));
  await assert.rejects(f.bridge.diagnostic({ sessionId: binding.sessionId, probe: 'smoke' }), { code: 'TERMINAL_CHANGED' });
  assert.equal(f.commands(), 0);
});
