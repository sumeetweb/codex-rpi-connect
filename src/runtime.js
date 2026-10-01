import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { BridgeError } from './browser.js';
import { REQUEST_CHUNK_BYTES, RESULT_CHUNK_BYTES, sha256 } from './wire.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_PAYLOAD = 262144;
const MAX_RESULT = 524288;

export class ConnectRuntime {
  constructor(bridge, approvals, { sourceLoader = () => readFile(new URL('../remote/worker.py', import.meta.url), 'utf8') } = {}) {
    this.bridge = bridge; this.approvals = approvals; this.sourceLoader = sourceLoader;
    this.session = null; this.jobs = new Map(); this.submitting = false;
  }
  requireSession(sessionId) {
    if (!this.session || this.session.id !== sessionId) throw new BridgeError('WORKER_NOT_STARTED', 'Attach the selected terminal, then run connect_start with an explicitly approved workspace root.');
    return this.session;
  }
  async start({ sessionId, workspaceRoot }, signal) {
    const binding = await this.bridge.validateBinding(sessionId);
    if (this.session?.id === sessionId) throw new BridgeError('WORKER_ALREADY_STARTED', 'A worker is already running in this session.');
    if (!workspaceRoot.startsWith('/') || /[\0\r\n]/.test(workspaceRoot) || Buffer.byteLength(workspaceRoot) > 512) throw new BridgeError('INVALID_ROOT', 'Use an absolute Raspberry Pi project directory.');
    const source = await this.sourceLoader();
    await this.approvals.require({ action: 'Start a foreground Connect worker', deviceName: binding.deviceName, workspaceRoot, details: `Bundled worker SHA-256: ${sha256(source)}\nStart the bundled Python worker in the selected fresh idle shell. It remains in the foreground, temporarily disables terminal echo, and restores it on exit. No daemon, service, credential or remote file is installed. File tools are restricted to this directory. General shell commands remain able to access anything the remote Unix account can access; the root is not an execution sandbox.`, signal });
    if (signal?.aborted) throw new BridgeError('CANCELLED', 'Startup was cancelled before input.');
    const token = randomBytes(8).toString('hex');
    const ready = await this.bridge.workerStart({ sessionId, source, token, workspaceRoot });
    if (ready.status !== 'ready' || ready.protocol !== 1 || ready.root !== workspaceRoot) throw new BridgeError('WORKER_PROTOCOL', 'Worker startup did not confirm the exact workspace root and protocol. Inspect the terminal; do not replay startup.');
    this.session = { id: sessionId, token, root: ready.root, deviceName: binding.deviceName };
    this.jobs.clear();
    return { status: 'ready', sessionId, workspaceRoot: ready.root, protocol: ready.protocol, python: ready.python, instruction: 'The worker owns this terminal until connect_stop. Use connect_exec for commands and connect_job to collect their results.' };
  }
  async rpc(sessionId, op, fields = {}) {
    this.requireSession(sessionId);
    const result = await this.bridge.workerRpc({ sessionId, op, fields });
    if (result.error) throw new BridgeError(`REMOTE_${result.error.code || 'ERROR'}`, result.error.message || 'Remote operation was rejected.');
    return result;
  }
  async submit(sessionId, payload, signal) {
    const s = this.requireSession(sessionId);
    if (this.submitting) throw new BridgeError('BUSY', 'Another request is being transferred.');
    if (this.jobs.size >= 8) {
      const completed = [...this.jobs].find(([, job]) => job.state === 'done' || job.state === 'unknown');
      if (!completed) throw new BridgeError('JOBS_PENDING', 'Collect outstanding job results before starting another request.');
      this.jobs.delete(completed[0]);
    }
    this.submitting = true;
    let uploadId;
    let commitSent = false;
    try {
      const bytes = Buffer.from(JSON.stringify({ ...payload, root: s.root }));
      if (bytes.length > MAX_PAYLOAD) throw new BridgeError('PAYLOAD_TOO_LARGE', 'Request exceeds the bounded transfer limit.');
      if (signal?.aborted) throw new BridgeError('CANCELLED', 'Request cancelled before transfer.');
      const upload = await this.rpc(sessionId, 'upload_begin', { byteLength: bytes.length, sha256: sha256(bytes) });
      uploadId = upload.uploadId;
      for (let offset = 0; offset < bytes.length; offset += REQUEST_CHUNK_BYTES) {
        if (signal?.aborted) throw new BridgeError('CANCELLED', 'Transfer cancelled before execution. Start a new request; no automatic replay.');
        await this.rpc(sessionId, 'upload_chunk', { uploadId: upload.uploadId, offset, data: bytes.subarray(offset, offset + REQUEST_CHUNK_BYTES).toString('base64') });
      }
      if (signal?.aborted) throw new BridgeError('CANCELLED', 'Request cancelled before execution.');
      commitSent = true;
      const result = await this.rpc(sessionId, 'upload_commit', { uploadId: upload.uploadId });
      if (typeof result.jobId !== 'string') throw new BridgeError('WORKER_PROTOCOL', 'Missing job identity; outcome may be unknown. Do not replay.');
      this.jobs.set(result.jobId, { sessionId, kind: payload.kind, state: 'running' });
      return { jobId: result.jobId, status: result.status, kind: payload.kind, deviceName: s.deviceName };
    } catch (error) {
      if (uploadId && !commitSent && signal?.aborted) {
        try { await this.rpc(sessionId, 'upload_abort', { uploadId }); } catch { /* Expiry bounds abandoned uploads; no operation is replayed. */ }
      }
      throw error;
    } finally { this.submitting = false; }
  }
  async exec(args, signal) {
    const s = this.requireSession(args.sessionId);
    const { sessionId, command, cwd = '', timeoutMs = 30000, maxOutputBytes = 16384 } = args;
    const env = structuredClone(args.env || {});
    if (Object.keys(env).length > 32 || Object.keys(env).some(name => /^(LD_|PYTHON)|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|KEY/i.test(name))) throw new BridgeError('UNSAFE_ENV', 'Secret-bearing or security-sensitive environment overrides are not accepted. Configure needed credentials directly on the Pi outside this plugin.');
    await this.approvals.require({ action: 'Execute a shell command', deviceName: s.deviceName, workspaceRoot: s.root, details: `Exact command:\n${command}\n\nWorking directory (relative to root): ${cwd || '.'}\nEnvironment overrides: ${JSON.stringify(env)}\nTimeout: ${timeoutMs} ms\nMaximum captured bytes per stream: ${maxOutputBytes}\nThis command is not filesystem-sandboxed. Output will be returned to the MCP client.`, signal });
    if (this.session !== s) throw new BridgeError('SESSION_CHANGED', 'The worker session changed while approval was pending. Nothing was submitted.');
    return this.submit(sessionId, { kind: 'exec', command, cwd, env, timeoutMs, maxOutputBytes }, signal);
  }
  async file(kind, args, signal) {
    const s = this.requireSession(args.sessionId);
    const { sessionId, ...payload } = args;
    if (kind === 'file_write') {
      if (payload.expectedSha256 !== null && payload.mode !== undefined) throw new BridgeError('MODE_CREATE_ONLY', 'mode applies only to newly created files. Replacements preserve the existing permissions.');
      const content = Buffer.from(payload.data, 'base64');
      await this.approvals.require({ action: 'Atomically write a file', deviceName: s.deviceName, workspaceRoot: s.root, details: `Relative destination: ${payload.path}\nBytes: ${content.length}\nNew SHA-256: ${sha256(content)}\nExpected existing SHA-256: ${payload.expectedSha256 ?? 'must not exist (create-only)'}\nNew-file mode: ${payload.mode ?? '0600'}; existing permissions are always preserved\nUse connect_file_diff to review changes before approving replacement. The exact submitted bytes, path and precondition are bound to this approval.`, signal });
    }
    if (this.session !== s) throw new BridgeError('SESSION_CHANGED', 'The worker session changed while approval was pending. Nothing was submitted.');
    const started = await this.submit(sessionId, { ...payload, kind }, signal);
    return this.job({ sessionId, jobId: started.jobId, waitMs: 1000 }, signal);
  }
  async job({ sessionId, jobId, waitMs = 0 }, signal) {
    this.requireSession(sessionId);
    const record = this.jobs.get(jobId);
    if (!record || record.sessionId !== sessionId) throw new BridgeError('UNKNOWN_JOB', 'This client did not start that job in this session.');
    if (record.result) return { jobId, status: 'done', result: record.result };
    const deadline = Date.now() + Math.min(waitMs, 10000);
    let state;
    do {
      if (signal?.aborted) return { jobId, status: 'running', instruction: 'Waiting was cancelled. The command may still be running; use connect_cancel to stop this job.' };
      state = await this.rpc(sessionId, 'job_status', { jobId });
      if (state.status === 'done') break;
      if (Date.now() >= deadline) return { jobId, status: 'running', kind: record.kind };
      await sleep(100);
    } while (true);
    if (!Number.isSafeInteger(state.byteLength) || state.byteLength < 0 || state.byteLength > MAX_RESULT || !/^[a-f0-9]{64}$/.test(state.sha256)) throw new BridgeError('WORKER_PROTOCOL', 'Invalid result metadata. Outcome is uncertain; do not replay.');
    const chunks = [];
    for (let offset = 0; offset < state.byteLength;) {
      if (signal?.aborted) return { jobId, status: 'result_available', instruction: 'Result download was cancelled. The operation has finished; call connect_job again to retrieve its retained result. Do not execute it again.' };
      const chunk = await this.rpc(sessionId, 'result_read', { jobId, offset, length: RESULT_CHUNK_BYTES });
      const data = Buffer.from(chunk.data || '', 'base64');
      if (chunk.offset !== offset || !data.length || data.length > RESULT_CHUNK_BYTES || data.toString('base64') !== chunk.data) throw new BridgeError('WORKER_PROTOCOL', 'Invalid result chunk; do not replay the operation.');
      chunks.push(data); offset += data.length;
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== state.byteLength || sha256(bytes) !== state.sha256) throw new BridgeError('RESULT_INTEGRITY', 'Result checksum did not match. The operation may have completed; do not replay.');
    let result;
    try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new BridgeError('WORKER_PROTOCOL', 'Result was not valid JSON.'); }
    if (result.kind === 'exec') {
      // Preserve byte-exact base64 alongside UTF-8 rendering, including binary output.
      result.stdoutText = Buffer.from(result.stdout || '', 'base64').toString('utf8');
      result.stderrText = Buffer.from(result.stderr || '', 'base64').toString('utf8');
    }
    if (result.kind === 'file_read' && typeof result.data === 'string') {
      const raw = Buffer.from(result.data, 'base64');
      const text = raw.toString('utf8');
      if (Buffer.from(text).equals(raw)) result.text = text;
      else result.encoding = 'base64 (binary; UTF-8 text omitted)';
    }
    record.result = result; record.state = 'done';
    return { jobId, status: 'done', result };
  }
  async cancel({ sessionId, jobId }) {
    this.requireSession(sessionId);
    if (!this.jobs.has(jobId)) throw new BridgeError('UNKNOWN_JOB', 'This client did not start that job.');
    const result = await this.rpc(sessionId, 'cancel', { jobId });
    return { jobId, ...result, instruction: 'Use connect_job to verify the terminal result. Cancellation acknowledgement alone is not proof that the process exited.' };
  }
  disconnected() {
    for (const record of this.jobs.values()) { if (record.state === 'running') record.state = 'unknown'; delete record.result; }
    this.session = null;
  }
  summary() { return { worker: this.session ? { sessionId: this.session.id, workspaceRoot: this.session.root, deviceName: this.session.deviceName } : null, jobs: [...this.jobs].map(([jobId, job]) => ({ jobId, kind: job.kind, status: job.state })) }; }
  async stop({ sessionId }) {
    this.requireSession(sessionId);
    const result = await this.rpc(sessionId, 'close');
    this.bridge.binding.workerToken = null;
    this.bridge.binding.needsReattach = true;
    this.bridge.quarantined?.add(this.bridge.binding.page);
    this.session = null; this.jobs.clear();
    return { ...result, instruction: 'The worker was asked to stop and restore terminal echo. This tab is quarantined from further plugin input; open a fresh Remote shell tab to reconnect. Verify the prompt before using the old tab manually.' };
  }
}
