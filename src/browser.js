import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { buildDiagnostic, parseTranscript } from './protocol.js';
import { encodeRequest, parseFrame, makeBootstrap } from './wire.js';

export const CONNECT_ORIGIN = 'https://connect.raspberrypi.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const short = (text, limit = 160) => text.replace(/\s+/g, ' ').trim().slice(0, limit);

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'BridgeError'; this.code = code; }
}

export function safeUrl(url, origin = CONNECT_ORIGIN) {
  try { const u = new URL(url); return u.origin === origin ? `${u.origin}${u.pathname}` : null; }
  catch { return null; }
}

// Only ordinary rendered DOM is read. No cookies, storage, private terminal objects,
// network interception, RTC internals, signalling endpoints or hidden application state.
export async function inspectTerminal(page, includeText = true) {
  return page.evaluate(includeText => {
    const inputs = [...document.querySelectorAll('.xterm textarea.xterm-helper-textarea')];
    const roots = [...new Set(inputs.map(input => input.closest('.xterm')))];
    if (inputs.length !== 1 || roots.length !== 1) return { inputCount: inputs.length, capture: null, text: '' };
    const root = roots[0];
    const a11y = root.querySelector('.xterm-accessibility-tree');
    const dom = root.querySelector('.xterm-rows');
    const source = a11y || dom;
    if (!source) return { inputCount: 1, capture: null, text: '' };
    const rows = a11y ? [...a11y.querySelectorAll('[role="listitem"]')] : [...dom.children];
    return {
      inputCount: 1,
      capture: a11y ? 'xterm-accessibility' : 'xterm-rendered-dom',
      rowCount: rows.length,
      text: includeText ? rows.map(row => row.textContent || '').join('\n').slice(-32768) : '',
    };
  }, includeText);
}

export async function deviceHeadings(page) {
  return page.locator('h1, h2, [data-device-name]').evaluateAll(elements => elements
    .filter(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .map(element => element.innerText))
    .then(values => [...new Set(values.map(value => short(value)).filter(Boolean))]);
}

export class ConnectBridge {
  constructor({ browserFactory, origin = CONNECT_ORIGIN, waitMs = 12000, pollMs = 100 } = {}) {
    this.origin = origin;
    this.waitMs = waitMs;
    this.pollMs = pollMs;
    this.browserFactory = browserFactory || (() => chromium.launch({
      headless: false,
      chromiumSandbox: true,
      ...(process.env.RPI_CONNECT_CHROMIUM_PATH ? { executablePath: process.env.RPI_CONNECT_CHROMIUM_PATH } : {}),
    }));
    this.browser = null;
    this.context = null;
    this.binding = null;
    this.busy = false;
    this.quarantined = new WeakSet();
    this.rpcTail = Promise.resolve();
  }

  async exclusive(operation) {
    if (this.busy) throw new BridgeError('BUSY', 'Another session operation is in progress.');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  async bounded(page, operation, ms = 2500, mode = 'action') {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (mode === 'read') {
            reject(new BridgeError('BROWSER_TIMEOUT', 'Inspection timed out. No browser action was taken; inspect the plugin browser.'));
            return;
          }
          this.quarantined.add(page);
          if (this.binding?.page === page) this.binding.needsReattach = true;
          // A timed-out keyboard request must not land in a reusable session.
          void page.close({ runBeforeUnload: false }).catch(() => {});
          reject(new BridgeError('BROWSER_TIMEOUT', 'The browser stalled. Its terminal tab was quarantined and a close was requested; inspect the browser and open a fresh shell.'));
        }, ms);
      })]);
    } finally { clearTimeout(timer); }
  }

  async open() { return this.exclusive(() => this.openUnlocked()); }

  async openUnlocked() {
    if (this.browser?.isConnected()) return { status: 'already_open', instruction: 'Use the existing plugin browser. Finish login and open a fresh Remote shell manually.' };
    this.browser = await this.browserFactory();
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } });
    this.browser.on('disconnected', () => { this.binding = null; });
    const page = await this.context.newPage();
    await page.goto(this.origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { status: 'manual_login_required', instruction: 'In the new plugin browser, sign in yourself, choose your exact device, and open Connect via → Remote shell. Credentials are not read or saved by this plugin.' };
  }

  pages() {
    if (!this.context || !this.browser?.isConnected()) throw new BridgeError('BROWSER_CLOSED', 'Run connect_open to start the plugin browser.');
    return this.context.pages().filter(page => !page.isClosed() && safeUrl(page.url(), this.origin));
  }

  async status() {
    if (!this.browser?.isConnected()) return { status: 'closed', attached: false };
    const pages = [];
    for (const page of this.pages()) {
      const terminal = await this.bounded(page, inspectTerminal(page, false), 2500, 'read');
      pages.push({ url: safeUrl(page.url(), this.origin), headings: await this.bounded(page, deviceHeadings(page), 2500, 'read'), terminalInputs: terminal.inputCount, textCapture: terminal.capture });
    }
    return { status: pages.length ? 'open' : 'manual_authentication_required', pages, attached: !!this.binding, sessionUsable: !!this.binding && !this.binding.needsReattach && !this.quarantined.has(this.binding.page), busy: this.busy };
  }

  async devices() {
    const devices = [];
    for (const page of this.pages()) {
      const candidates = await this.bounded(page, page.locator('a[href]').evaluateAll(links => links.filter(link => link.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).map(link => ({
        href: link.href,
        name: link.innerText || '',
        context: link.closest('tr,[role="row"],article,li')?.innerText || '',
      }))), 2500, 'read');
      for (const item of candidates) {
        const url = safeUrl(item.href, this.origin);
        if (!url || !/^\/devices\/[^/]+\/?$/.test(new URL(url).pathname)) continue;
        const name = short(item.name);
        if (!name || devices.some(device => device.url === url)) continue;
        const offline = /\boffline\b/i.test(item.context);
        const online = /\bonline\b/i.test(item.context);
        devices.push({ name, url, status: offline ? 'offline' : online ? 'online' : 'unknown' });
      }
    }
    return { devices, source: 'visible device links only', limitation: devices.length ? 'Status is reported only when explicitly visible beside a device.' : 'No recognized device links are visible. Finish login and open Devices in the plugin browser; a UI change may require an adapter update.' };
  }

  async attach(args) { return this.exclusive(() => this.attachUnlocked(args)); }

  async attachUnlocked({ deviceName, terminalUrl }) {
    if (this.binding?.workerToken && !this.binding.needsReattach && !this.binding.page.isClosed()) throw new BridgeError('WORKER_ACTIVE', 'Stop the active worker before switching sessions. If disconnected, close the old tab first.');
    this.binding = null;
    const clean = safeUrl(terminalUrl, this.origin);
    if (!clean || terminalUrl !== clean) throw new BridgeError('INVALID_URL', 'Use the exact HTTPS Connect terminal URL without a query string or fragment. Do not provide login links.');
    const matches = this.pages().filter(page => page.url() === terminalUrl);
    if (matches.length !== 1) throw new BridgeError('AMBIGUOUS_PAGE', 'Exactly one open terminal tab must match this URL.');
    const page = matches[0];
    if (this.quarantined.has(page)) throw new BridgeError('SESSION_UNCERTAIN', 'This tab had an uncertain result. Open a new Remote shell tab; reattaching this tab is blocked.');
    const headings = await this.bounded(page, deviceHeadings(page));
    if (!headings.includes(deviceName)) throw new BridgeError('DEVICE_NOT_VERIFIED', 'The exact device name must be visible as a page heading. No command was sent.');
    const terminal = await this.bounded(page, inspectTerminal(page));
    if (terminal.inputCount !== 1) throw new BridgeError('TERMINAL_NOT_UNIQUE', 'Expected exactly one xterm input in the selected tab. No command was sent.');
    if (!terminal.capture || !terminal.rowCount || !terminal.text.trim()) throw new BridgeError('OUTPUT_UNAVAILABLE', 'This terminal does not expose readable output in rendered DOM or accessibility rows. No command was sent. Capture must be verified before using the plugin.');
    const input = await this.bounded(page, page.locator('.xterm textarea.xterm-helper-textarea').elementHandle({ timeout: 1500 }));
    const id = randomUUID();
    this.binding = { id, page, input, deviceName, terminalUrl, capture: terminal.capture, needsReattach: false };
    await this.validateBinding(id);
    return { sessionId: id, deviceName, terminalUrl, textCapture: terminal.capture, instruction: 'Only run a diagnostic in a fresh, idle shell. Do not type or navigate in this tab during execution.' };
  }

  async validateBinding(sessionId) {
    const b = this.binding;
    if (!b || b.id !== sessionId) throw new BridgeError('SESSION_NOT_ATTACHED', 'Attach the exact device terminal first.');
    if (b.needsReattach || this.quarantined.has(b.page)) throw new BridgeError('SESSION_UNCERTAIN', 'The last result was uncertain. Open a fresh Remote shell and attach again. Do not retry in the old shell.');
    if (b.page.isClosed() || b.page.url() !== b.terminalUrl) { this.binding = null; throw new BridgeError('SESSION_CHANGED', 'The terminal tab was closed or navigated. No command was sent.'); }
    if (!(await this.bounded(b.page, deviceHeadings(b.page))).includes(b.deviceName)) { this.binding = null; throw new BridgeError('DEVICE_CHANGED', 'The device heading changed. No command was sent.'); }
    const terminal = await this.bounded(b.page, inspectTerminal(b.page));
    if (terminal.inputCount !== 1 || terminal.capture !== b.capture || !terminal.text.trim()) throw new BridgeError('CAPTURE_CHANGED', 'Terminal input or output capture changed. Reattach a fresh shell.');
    const sameInput = await this.bounded(b.page, b.input.evaluate(input => input.isConnected && input === document.querySelector('.xterm textarea.xterm-helper-textarea') && input.closest('.xterm').checkVisibility({ checkVisibilityCSS: true })));
    if (!sameInput) throw new BridgeError('TERMINAL_CHANGED', 'The verified terminal element was replaced or hidden. Open and attach a fresh shell.');
    return b;
  }

  async diagnostic(args) { return this.exclusive(() => this.diagnosticUnlocked(args)); }

  async diagnosticUnlocked({ sessionId, probe }) {
    // Reject unsupported commands before any browser interaction.
    const command = buildDiagnostic(probe);
    let b;
    let sent = false;
    try {
      b = await this.validateBinding(sessionId);
      if (b.workerToken) throw new BridgeError('WORKER_ACTIVE', 'The foreground worker owns this terminal. Use connect_exec instead of shell diagnostics.');
      await this.bounded(b.page, b.input.focus());
      await this.validateBinding(sessionId);
      if (!(await this.bounded(b.page, b.input.evaluate(input => document.activeElement === input)))) throw new BridgeError('FOCUS_CHANGED', 'Terminal focus changed. No command was sent.');
      // Mark uncertain before the first keystroke: partial typing must never be retried.
      b.needsReattach = true;
      this.quarantined.add(b.page);
      sent = true;
      await this.bounded(b.page, b.page.keyboard.insertText(command.line));
      const focused = await this.bounded(b.page, b.input.evaluate(input => input.isConnected && document.activeElement === input && input === document.querySelector('.xterm textarea.xterm-helper-textarea')));
      if (!focused || b.page.url() !== b.terminalUrl || !(await this.bounded(b.page, deviceHeadings(b.page))).includes(b.deviceName)) return { status: 'unknown', reason: 'target_changed_during_input', probe, retrySafe: false };
      await this.bounded(b.page, b.input.press('Enter', { timeout: 1500 }));
      const deadline = Date.now() + this.waitMs;
      while (Date.now() < deadline) {
        if (b.page.isClosed() || b.page.url() !== b.terminalUrl) return { status: 'unknown', reason: 'terminal_disconnected_or_navigated', probe, retrySafe: false };
        if (!(await this.bounded(b.page, deviceHeadings(b.page))).includes(b.deviceName)) return { status: 'unknown', reason: 'device_heading_changed', probe, retrySafe: false };
        const terminal = await this.bounded(b.page, inspectTerminal(b.page), Math.max(1, Math.min(2500, deadline - Date.now())));
        if (terminal.inputCount !== 1 || terminal.capture !== b.capture) return { status: 'unknown', reason: 'terminal_capture_lost', probe, retrySafe: false };
        const result = parseTranscript(terminal.text, command.marker);
        if (result) {
          b.needsReattach = false;
          this.quarantined.delete(b.page);
          return { ...result, probe, deviceName: b.deviceName, source: 'Connect terminal rendered text', retrySafe: result.status === 'completed' };
        }
        await sleep(this.pollMs);
      }
      return { status: 'unknown', reason: 'completion_marker_not_observed', probe, retrySafe: false, instruction: 'The diagnostic may have run. Do not replay it automatically. Inspect the browser, then open and attach a fresh shell.' };
    } catch (error) {
      if (!sent) throw error;
      return { status: 'unknown', reason: 'browser_interaction_failed', probe, retrySafe: false, instruction: 'No automatic retry. Inspect the browser and attach a fresh shell.' };
    }
  }

  async assertWorkerTarget(b) {
    if (b.page.isClosed() || b.page.url() !== b.terminalUrl) throw new BridgeError('SESSION_CHANGED', 'The selected terminal closed or navigated. Outcome may be unknown.');
    if (!(await this.bounded(b.page, deviceHeadings(b.page))).includes(b.deviceName)) throw new BridgeError('DEVICE_CHANGED', 'The selected device heading changed.');
    const same = await this.bounded(b.page, b.input.evaluate(input => input.isConnected && input === document.querySelector('.xterm textarea.xterm-helper-textarea') && input.closest('.xterm').checkVisibility({ checkVisibilityCSS: true })));
    if (!same) throw new BridgeError('TERMINAL_CHANGED', 'The bound terminal was replaced or hidden.');
  }

  async exchange({ sessionId, line, token, id, waitMs = 8000 }) {
    const b = await this.validateBinding(sessionId);
    await this.bounded(b.page, b.input.focus());
    await this.assertWorkerTarget(b);
    if (!(await this.bounded(b.page, b.input.evaluate(input => document.activeElement === input)))) throw new BridgeError('FOCUS_CHANGED', 'Terminal focus changed before input.');
    b.needsReattach = true;
    this.quarantined.add(b.page);
    try {
      await this.bounded(b.page, b.page.keyboard.insertText(line), 8000);
      await this.assertWorkerTarget(b);
      if (!(await this.bounded(b.page, b.input.evaluate(input => document.activeElement === input)))) throw new BridgeError('FOCUS_CHANGED', 'Terminal focus changed during input.');
      await this.bounded(b.page, b.input.press('Enter', { timeout: 1500 }));
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await this.assertWorkerTarget(b);
        const terminal = await this.bounded(b.page, inspectTerminal(b.page), Math.max(1, Math.min(2500, deadline - Date.now())));
        if (terminal.inputCount !== 1 || terminal.capture !== b.capture) throw new BridgeError('CAPTURE_CHANGED', 'Terminal text capture changed during transfer.');
        const response = parseFrame(terminal.text, token, id);
        if (response) {
          b.needsReattach = false;
          this.quarantined.delete(b.page);
          return response;
        }
        await sleep(this.pollMs);
      }
      throw new BridgeError('RESPONSE_TIMEOUT', 'No complete checksummed worker response was captured. Outcome may be unknown. Inspect the old tab and open a fresh Remote shell; never replay automatically.');
    } catch (error) {
      b.needsReattach = true;
      this.quarantined.add(b.page);
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('OUTCOME_UNKNOWN', 'Browser interaction failed after input began. The operation may have executed. Do not replay; inspect the terminal and reconnect in a new tab.');
    }
  }

  async workerStart({ sessionId, source, token, workspaceRoot }) {
    return this.exclusive(async () => {
      const b = await this.validateBinding(sessionId);
      if (b.workerToken) throw new BridgeError('WORKER_ACTIVE', 'A foreground worker is already active in this terminal.');
      const response = await this.exchange({ sessionId, line: makeBootstrap(source, token, workspaceRoot), token, id: '0000000000000000', waitMs: 15000 });
      if (response.status !== 'ready') throw new BridgeError('WORKER_STARTUP_FAILED', response.error?.message || 'Python worker did not report ready. Inspect Python 3 availability and the project directory.');
      b.workerToken = token;
      return response;
    });
  }

  async workerRpc({ sessionId, op, fields }) {
    const task = this.rpcTail.catch(() => {}).then(() => this.exclusive(async () => {
      const b = await this.validateBinding(sessionId);
      if (!b.workerToken) throw new BridgeError('WORKER_NOT_STARTED', 'Start the foreground worker before sending requests.');
      const request = encodeRequest(op, fields);
      return this.exchange({ sessionId, line: request.line, token: b.workerToken, id: request.id });
    }));
    this.rpcTail = task.then(() => {}, () => {});
    return task;
  }

  async close() { return this.exclusive(() => this.closeUnlocked()); }

  async closeUnlocked() {
    await this.browser?.close();
    this.browser = null; this.context = null; this.binding = null;
    return { status: 'closed', instruction: 'The plugin browser and its in-memory login session are closed.' };
  }
}
