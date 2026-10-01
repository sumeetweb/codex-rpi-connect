import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectRuntime } from '../src/runtime.js';
import { ApprovalError } from '../src/approval.js';
import { sha256 } from '../src/wire.js';
import { PipeBridge } from './helpers/pipe-bridge.js';

const remoteTest = (name, fn) => test(name, { skip: process.platform !== 'linux' ? 'Remote worker integration requires Linux/Pi OS' : false }, fn);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'rpi-runtime-'));
  const bridge = new PipeBridge();
  const approvals = { calls: [], require: async function (args) { this.calls.push(args); return true; } };
  const runtime = new ConnectRuntime(bridge, approvals);
  t.after(async () => { await bridge.cleanup(); await rm(root, { recursive: true, force: true }); });
  const sessionId = randomUUID();
  await runtime.start({ sessionId, workspaceRoot: root });
  return { root, bridge, approvals, runtime, sessionId };
}
async function collect(f, jobId) {
  for (let i = 0; i < 100; i++) {
    const result = await f.runtime.job({ sessionId: f.sessionId, jobId, waitMs: 200 });
    if (result.status === 'done') return result.result;
  }
  throw new Error('Test job did not finish within its operation bound');
}

remoteTest('actual worker startup, arbitrary bounded command, cwd/env, stdout/stderr/nonzero exit and stop', async t => {
  const f = await setup(t);
  await mkdir(join(f.root, 'subdir'));
  const started = await f.runtime.exec({ sessionId: f.sessionId, command: 'printf "%s" "$DEMO_VALUE"; pwd; printf "problem" >&2; exit 7', cwd: 'subdir', env: { DEMO_VALUE: 'hello ' }, timeoutMs: 1000, maxOutputBytes: 1024 });
  const result = await collect(f, started.jobId);
  assert.equal(result.exitCode, 7);
  assert.equal(result.status, 'completed');
  assert.match(result.stdoutText, /hello .*\/subdir/);
  assert.equal(result.stderrText, 'problem');
  assert.equal(f.approvals.calls.length, 2);
  assert.equal((await f.runtime.stop({ sessionId: f.sessionId })).status, 'closed');
});

remoteTest('actual command timeout and cancellation yield terminal results', async t => {
  const f = await setup(t);
  const timed = await f.runtime.exec({ sessionId: f.sessionId, command: 'sleep 10', timeoutMs: 100, maxOutputBytes: 1024 });
  assert.equal((await collect(f, timed.jobId)).status, 'timeout');
  const active = await f.runtime.exec({ sessionId: f.sessionId, command: 'sleep 10', timeoutMs: 5000, maxOutputBytes: 1024 });
  const cancel = await f.runtime.cancel({ sessionId: f.sessionId, jobId: active.jobId });
  assert.ok(['cancelling', 'done'].includes(cancel.status));
  assert.equal((await collect(f, active.jobId)).status, 'cancelled');
});

remoteTest('bounded binary output is byte exact, truncated explicitly, and cannot flood MCP', async t => {
  const f = await setup(t);
  const started = await f.runtime.exec({ sessionId: f.sessionId, command: "python3 -c 'import sys;sys.stdout.buffer.write(bytes(range(256))*30);sys.stderr.write(\"e\"*9000)'", timeoutMs: 2000, maxOutputBytes: 1024 });
  const result = await collect(f, started.jobId);
  assert.equal(Buffer.from(result.stdout, 'base64').length, 1024);
  assert.equal(Buffer.from(result.stderr, 'base64').length, 1024);
  assert.equal(result.stdoutTruncated, true); assert.equal(result.stderrTruncated, true);
});

remoteTest('atomic file create/read/stat/list/diff/replace across chunked protocol', async t => {
  const f = await setup(t);
  const content = 'π test\n'.repeat(500);
  const data = Buffer.from(content).toString('base64');
  let result = await f.runtime.file('file_write', { sessionId: f.sessionId, path: 'notes.txt', data, expectedSha256: null });
  if (result.status !== 'done') result = { result: await collect(f, result.jobId) };
  assert.equal(result.result.sha256, sha256(Buffer.from(content)));
  const read = await f.runtime.file('file_read', { sessionId: f.sessionId, path: 'notes.txt' });
  assert.equal(read.result.text, content);
  const stat = await f.runtime.file('file_stat', { sessionId: f.sessionId, path: 'notes.txt' });
  assert.equal(stat.result.sha256, sha256(Buffer.from(content)));
  const list = await f.runtime.file('file_list', { sessionId: f.sessionId, path: '', limit: 10 });
  assert.equal(list.result.entries[0].name, 'notes.txt');
  const next = Buffer.from('next\n').toString('base64');
  const diff = await f.runtime.file('file_diff', { sessionId: f.sessionId, path: 'notes.txt', data: next, maxOutputBytes: 1024 });
  assert.equal(diff.result.changed, true); assert.equal(diff.result.truncated, true);
  const replace = await f.runtime.file('file_write', { sessionId: f.sessionId, path: 'notes.txt', data: next, expectedSha256: stat.result.sha256 });
  assert.equal(replace.result.sha256, sha256(Buffer.from('next\n')));
  assert.equal(await readFile(join(f.root, 'notes.txt'), 'utf8'), 'next\n');
  assert.ok(f.bridge.calls.filter(op => op === 'upload_chunk').length > 5);
});

remoteTest('existing-file hash conflict cannot overwrite current bytes', async t => {
  const f = await setup(t);
  await writeFile(join(f.root, 'guard.txt'), 'current');
  const result = await f.runtime.file('file_write', { sessionId: f.sessionId, path: 'guard.txt', data: Buffer.from('replacement').toString('base64'), expectedSha256: '0'.repeat(64) });
  assert.ok(result.result.error);
  assert.equal(await readFile(join(f.root, 'guard.txt'), 'utf8'), 'current');
});

remoteTest('declined command approval causes zero request transfer and no side effect', async t => {
  const f = await setup(t);
  f.approvals.require = async () => { throw new ApprovalError('APPROVAL_DENIED', 'Declined'); };
  await assert.rejects(f.runtime.exec({ sessionId: f.sessionId, command: 'touch denied.txt' }), { code: 'APPROVAL_DENIED' });
  assert.equal(f.bridge.calls.length, 0);
  await assert.rejects(readFile(join(f.root, 'denied.txt')), { code: 'ENOENT' });
});

remoteTest('secret environment overrides are rejected before a confirmation prompt or transfer', async t => {
  const f = await setup(t);
  await assert.rejects(f.runtime.exec({ sessionId: f.sessionId, command: 'true', env: { API_TOKEN: 'not-a-real-secret' } }), { code: 'UNSAFE_ENV' });
  assert.equal(f.approvals.calls.length, 1); assert.equal(f.bridge.calls.length, 0);
});

remoteTest('changing session during approval invalidates that exact approved operation', async t => {
  const f = await setup(t);
  f.approvals.require = async () => { f.runtime.session = { ...f.runtime.session }; return true; };
  await assert.rejects(f.runtime.exec({ sessionId: f.sessionId, command: 'true' }), { code: 'SESSION_CHANGED' });
  assert.equal(f.bridge.calls.length, 0);
});

remoteTest('unknown request response is not retried or resubmitted', async t => {
  const f = await setup(t);
  let count = 0;
  f.bridge.workerRpc = async () => { count++; throw new Error('simulated uncertain response'); };
  await assert.rejects(f.runtime.exec({ sessionId: f.sessionId, command: 'true' }));
  assert.equal(count, 1);
});

remoteTest('replacement mode is rejected before approval and leaves existing permissions unchanged', async t => {
  const f = await setup(t);
  await assert.rejects(f.runtime.file('file_write', { sessionId: f.sessionId, path: 'x.txt', data: '', expectedSha256: '0'.repeat(64), mode: 384 }), { code: 'MODE_CREATE_ONLY' });
  assert.equal(f.approvals.calls.length, 1);
  assert.equal(f.bridge.calls.length, 0);
});

remoteTest('stop makes the old binding unusable even before terminal restoration finishes', async t => {
  const f = await setup(t);
  f.bridge.binding.page = {};
  f.bridge.quarantined = new WeakSet();
  await f.runtime.stop({ sessionId: f.sessionId });
  assert.equal(f.bridge.binding.needsReattach, true);
  assert.equal(f.bridge.quarantined.has(f.bridge.binding.page), true);
});

remoteTest('many collected jobs remain bounded in the local result cache', async t => {
  const f = await setup(t);
  for (let i = 0; i < 12; i++) {
    const result = await f.runtime.file('file_stat', { sessionId: f.sessionId, path: '' });
    assert.equal(result.status, 'done');
  }
  assert.equal(f.runtime.jobs.size, 8);
});

remoteTest('cancellation during result download stops transfer without replaying the operation', async t => {
  const f = await setup(t);
  const started = await f.runtime.exec({ sessionId: f.sessionId, command: "python3 -c 'print(\"x\"*4000)'", timeoutMs: 1000, maxOutputBytes: 4096 });
  const controller = new AbortController();
  const original = f.bridge.workerRpc.bind(f.bridge);
  let chunks = 0;
  f.bridge.workerRpc = async args => {
    const result = await original(args);
    if (args.op === 'result_read' && ++chunks === 1) controller.abort();
    return result;
  };
  const partial = await f.runtime.job({ sessionId: f.sessionId, jobId: started.jobId, waitMs: 1000 }, controller.signal);
  assert.equal(partial.status, 'result_available'); assert.equal(chunks, 1);
  const complete = await collect(f, started.jobId);
  assert.equal(complete.exitCode, 0);
  assert.equal(f.bridge.calls.filter(op => op === 'upload_commit').length, 1);
});
