import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { encodeRequest, parseFrame, makeBootstrap } from '../../src/wire.js';

// Integration harness only: the same worker/protocol run over local pipes.
// Production always uses ConnectBridge's browser-terminal transport.
export class PipeBridge {
  constructor() { this.binding = { deviceName: 'local-integration-fixture' }; this.pending = new Map(); this.calls = []; }
  async validateBinding() { return this.binding; }
  wait(id) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`fixture response timeout ${id}`)); }, 8000); this.pending.set(id, { resolve: x => { clearTimeout(timer); resolve(x); }, reject }); }); }
  async workerStart({ token, workspaceRoot, source }) {
    this.token = token;
    const ready = this.wait('0000000000000000');
    this.process = spawn('/bin/sh', ['-c', makeBootstrap(source, token, workspaceRoot)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.on('error', error => { for (const p of this.pending.values()) p.reject(error); });
    const reader = createInterface({ input: this.process.stdout });
    reader.on('line', line => { for (const [id, pending] of this.pending) { const result = parseFrame(line, token, id); if (result) { this.pending.delete(id); pending.resolve(result); break; } } });
    return ready;
  }
  async workerRpc({ op, fields }) {
    this.calls.push(op);
    const request = encodeRequest(op, fields);
    const result = this.wait(request.id);
    this.process.stdin.write(`${request.line}\n`);
    return result;
  }
  async cleanup() { if (this.process) { this.process.stdin.end(); await new Promise(resolve => { if (this.process.exitCode !== null) resolve(); else this.process.once('exit', resolve); }); } }
}
