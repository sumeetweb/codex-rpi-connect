import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectBridge, safeUrl } from '../src/browser.js';

// State-machine tests use an explicit in-memory browser double. They do not
// establish Playwright/Connect compatibility; test:browser covers actual xterm.
function fixture({ output = '$ ', capture = 'xterm-accessibility', headings = ['pi'], rowCount = 20, behavior = 'complete' } = {}) {
  let closed = false, currentUrl = 'https://connect.raspberrypi.com/devices/pi/shell';
  let text = output, inserts = 0, enters = 0, sameInput = true, focused = true, visible = true;
  const input = {
    focus: async () => { focused = true; },
    evaluate: async (fn, value) => {
      const source = fn.toString();
      if (source.includes('new ClipboardEvent')) {
        if (!sameInput || !visible || !focused) return false;
        await insertText(value);
        return true;
      }
      if (source.includes('isConnected')) return sameInput && visible && (!source.includes('activeElement') || focused);
      return focused;
    },
    press: async () => {
      enters++;
      if (behavior === 'disconnect') closed = true;
    },
  };
  const page = {
    url: () => currentUrl, isClosed: () => closed,
    close: async () => { closed = true; },
    evaluate: async (_fn, includeText) => ({ inputCount: 1, capture, rowCount, text: includeText ? text : '' }),
    locator: selector => selector === '.xterm textarea.xterm-helper-textarea'
      ? { elementHandle: async () => input }
      : { evaluateAll: async () => headings },
  };
  const insertText = async line => {
      inserts++;
      if (behavior === 'complete') {
        const match = line.match(/CRC_([a-f0-9]{12}).*?([a-f0-9]{12})/);
        assert.ok(match);
        const marker = `CRC_${match[1]}${match[2]}`;
        text = `${marker} BEGIN\ncodex-rpi-connect OK\n${marker} END 0`;
      }
      if (behavior === 'lostFocus') focused = false;
      if (behavior === 'replaceAfterInsert') sameInput = false;
  };
  const bridge = new ConnectBridge({ waitMs: 15, pollMs: 1 });
  bridge.browser = { isConnected: () => true };
  bridge.context = { pages: () => [page] };
  return {
    bridge, page, input,
    attach: () => bridge.attach({ deviceName: 'pi', terminalUrl: page.url() }),
    counts: () => ({ inserts, enters }),
    replace: () => { sameInput = false; },
    navigate: () => { currentUrl += '/changed'; },
    hide: () => { visible = false; },
  };
}

test('URL allowlist rejects deceptive origins, userinfo and secrets for attach', async () => {
  assert.equal(safeUrl('https://connect.raspberrypi.com.evil.example/'), null);
  assert.equal(safeUrl('https://connect.raspberrypi.com/path?token=secret'), 'https://connect.raspberrypi.com/path');
  const f = fixture();
  for (const url of ['http://connect.raspberrypi.com/', 'https://connect.raspberrypi.com/devices/pi/shell?token=x', 'https://user:pass@connect.raspberrypi.com/devices/pi/shell']) {
    await assert.rejects(f.bridge.attach({ deviceName: 'pi', terminalUrl: url }), { code: 'INVALID_URL' });
  }
});
test('empty/canvas-only terminal fails closed', async () => {
  for (const options of [{ output: '' }, { output: ' ' }, { rowCount: 0 }, { capture: null }]) {
    const f = fixture(options);
    await assert.rejects(f.attach(), { code: 'OUTPUT_UNAVAILABLE' });
    assert.deepEqual(f.counts(), { inserts: 0, enters: 0 });
  }
});
test('wrong identity fails closed', async () => {
  const f = fixture({ headings: ['other-pi'] });
  await assert.rejects(f.attach(), { code: 'DEVICE_NOT_VERIFIED' });
});
test('matching complete result succeeds without repeating input', async () => {
  const f = fixture(); const session = await f.attach();
  const result = await f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
  assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'codex-rpi-connect OK');
  assert.deepEqual(f.counts(), { inserts: 1, enters: 1 });
});
test('uncertain result quarantines the same page even after attempted reattach', async () => {
  const f = fixture({ behavior: 'nothing' }); const session = await f.attach();
  const result = await f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
  assert.equal(result.status, 'unknown'); assert.equal(result.retrySafe, false);
  await assert.rejects(f.attach(), { code: 'SESSION_UNCERTAIN' });
  assert.deepEqual(f.counts(), { inserts: 1, enters: 1 });
});
test('stale, hidden or navigated terminal is rejected before typing', async () => {
  for (const mutate of ['replace', 'hide', 'navigate']) {
    const f = fixture(); const session = await f.attach(); f[mutate]();
    await assert.rejects(f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' }));
    assert.deepEqual(f.counts(), { inserts: 0, enters: 0 });
  }
});
test('focus/input replacement during insertion prevents Enter and quarantines', async () => {
  for (const behavior of ['lostFocus', 'replaceAfterInsert']) {
    const f = fixture({ behavior }); const session = await f.attach();
    const result = await f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(f.counts(), { inserts: 1, enters: 0 });
    await assert.rejects(f.attach(), { code: 'SESSION_UNCERTAIN' });
  }
});
test('all mutating lifecycle operations serialize while a diagnostic is running', async () => {
  const f = fixture({ behavior: 'nothing' }); const session = await f.attach();
  const pending = f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' });
  for (const operation of [() => f.attach(), () => f.bridge.close(), () => f.bridge.open(), () => f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' })]) await assert.rejects(operation(), { code: 'BUSY' });
  await pending;
});
test('stalled browser call has a bounded failure and quarantines/closes the page', async () => {
  const f = fixture();
  await assert.rejects(f.bridge.bounded(f.page, new Promise(() => {}), 5), { code: 'BROWSER_TIMEOUT' });
  assert.equal(f.page.isClosed(), true);
  assert.equal(f.bridge.quarantined.has(f.page), true);
});
test('status inspection requests capability only and returns no terminal output', async () => {
  const f = fixture({ output: 'private fixture output' });
  const original = f.page.evaluate;
  f.page.evaluate = async (fn, includeText) => { assert.equal(includeText, false); return original(fn, includeText); };
  const status = await f.bridge.status();
  assert.equal(JSON.stringify(status).includes('private fixture output'), false);
});

test('pre-input quarantine blocks the existing session even if browser close fails', async () => {
  const f = fixture(); const session = await f.attach();
  f.page.close = async () => { throw new Error('simulated browser close failure'); };
  await assert.rejects(f.bridge.bounded(f.page, new Promise(() => {}), 5), { code: 'BROWSER_TIMEOUT' });
  assert.equal(f.page.isClosed(), false);
  await assert.rejects(f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' }), { code: 'SESSION_UNCERTAIN' });
  assert.deepEqual(f.counts(), { inserts: 0, enters: 0 });
});
test('quarantine is enforced independently of the mutable binding flag', async () => {
  const f = fixture(); const session = await f.attach();
  f.bridge.quarantined.add(f.page);
  f.bridge.binding.needsReattach = false;
  await assert.rejects(f.bridge.diagnostic({ sessionId: session.sessionId, probe: 'smoke' }), { code: 'SESSION_UNCERTAIN' });
});
test('read-only inspection timeout never closes or quarantines a tab', async () => {
  const f = fixture();
  await assert.rejects(f.bridge.bounded(f.page, new Promise(() => {}), 5, 'read'), { code: 'BROWSER_TIMEOUT' });
  assert.equal(f.page.isClosed(), false);
  assert.equal(f.bridge.quarantined.has(f.page), false);
});
