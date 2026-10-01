import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalError, OperationApprovals, APPROVAL_TIMEOUT_MS, MAX_APPROVAL_DETAILS_BYTES } from '../src/approval.js';

const operation = Object.freeze({
  action: 'exec',
  deviceName: 'workshop-pi',
  workspaceRoot: '/home/pi/project',
  details: 'Command: printf \'ready\\n\'\nWorking directory: /home/pi/project\nTimeout: 10 seconds',
});

function fakeServer({ capabilities = { elicitation: { form: {} } }, reply = { action: 'accept', content: { approved: true } }, fail } = {}) {
  const calls = [];
  return {
    calls,
    getClientCapabilities: () => capabilities,
    async elicitInput(params, options) {
      calls.push({ params, options });
      if (fail) throw fail;
      return typeof reply === 'function' ? reply(params, options) : reply;
    },
  };
}

function isApprovalError(code) {
  return error => {
    assert.ok(error instanceof ApprovalError);
    assert.equal(error.code, code);
    return true;
  };
}

async function connectedPair(t, handler, capabilities = { elicitation: { form: {} } }) {
  const server = new McpServer({ name: 'approval-test-server', version: '1.0.0' });
  const client = new Client({ name: 'approval-test-client', version: '1.0.0' }, { capabilities });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, approvals: new OperationApprovals(server.server) };
}

test('approval sends exact JSON-encoded operation, opt-in schema, timeout and caller cancellation', async () => {
  const server = fakeServer();
  const signal = new AbortController().signal;
  assert.equal(await new OperationApprovals(server).require({ ...operation, signal }), true);
  assert.equal(server.calls.length, 1);
  const { params, options } = server.calls[0];
  assert.equal(params.mode, 'form');
  for (const value of Object.values(operation)) assert.ok(params.message.includes(JSON.stringify(value)));
  assert.equal(params.requestedSchema.type, 'object');
  assert.deepEqual(Object.keys(params.requestedSchema.properties), ['approved']);
  assert.equal(params.requestedSchema.properties.approved.type, 'boolean');
  assert.equal(params.requestedSchema.properties.approved.default, false);
  assert.deepEqual(params.requestedSchema.required, ['approved']);
  assert.deepEqual(options, { timeout: 120_000, maxTotalTimeout: 120_000, resetTimeoutOnProgress: false, signal });
});

test('every operation, including identical retries and concurrent requests, requires a fresh form', async () => {
  const server = fakeServer();
  const approvals = new OperationApprovals(server);
  for (const action of ['session_bootstrap', 'exec', 'file_write', 'exec']) {
    await approvals.require({ ...operation, action });
  }
  await Promise.all([approvals.require(operation), approvals.require(operation)]);
  assert.equal(server.calls.length, 6);
  assert.notEqual(server.calls[0].params, server.calls[1].params);
});

test('only explicit acceptance and literal own approved=true permit the operation', async t => {
  const responses = [
    { action: 'decline', content: { approved: true } },
    { action: 'accept', content: { approved: false } },
    { action: 'accept', content: { approved: 'true' } },
    { action: 'accept', content: { approved: 1 } },
    { action: 'accept', content: Object.create({ approved: true }) },
    Object.create({ action: 'accept', content: { approved: true } }),
    { action: 'accept', content: [] },
    { action: 'accept', content: {} },
    { action: 'accept', content: null },
    { action: 'accept' },
    { action: 'accepted', content: { approved: true } },
    { approved: true },
    true,
    null,
  ];
  for (const [index, reply] of responses.entries()) {
    await t.test(`non-approval response ${index + 1}`, async () => {
      await assert.rejects(new OperationApprovals(fakeServer({ reply })).require(operation), isApprovalError('APPROVAL_DENIED'));
    });
  }
});

test('declined approval is not cached and a subsequent attempt asks again', async () => {
  let attempts = 0;
  const server = fakeServer({ reply: () => ++attempts === 1 ? { action: 'decline' } : { action: 'accept', content: { approved: true } } });
  const approvals = new OperationApprovals(server);
  await assert.rejects(approvals.require(operation), isApprovalError('APPROVAL_DENIED'));
  assert.equal(await approvals.require(operation), true);
  assert.equal(server.calls.length, 2);
});

test('dismissal, cancellation and cancellation racing acceptance fail closed', async () => {
  await assert.rejects(new OperationApprovals(fakeServer({ reply: { action: 'cancel', content: { approved: true } } })).require(operation), isApprovalError('APPROVAL_CANCELLED'));
  const aborted = new AbortController();
  aborted.abort(new Error('private cancellation reason'));
  const server = fakeServer();
  await assert.rejects(new OperationApprovals(server).require({ ...operation, signal: aborted.signal }), isApprovalError('APPROVAL_CANCELLED'));
  assert.equal(server.calls.length, 0);

  const racing = new AbortController();
  const racingServer = fakeServer({ reply: () => { racing.abort(); return { action: 'accept', content: { approved: true } }; } });
  await assert.rejects(new OperationApprovals(racingServer).require({ ...operation, signal: racing.signal }), isApprovalError('APPROVAL_CANCELLED'));
  await assert.rejects(new OperationApprovals(fakeServer({ fail: new DOMException('private reason', 'AbortError') })).require(operation), isApprovalError('APPROVAL_CANCELLED'));
});

test('unsupported, legacy unspecified and URL-only capabilities cannot prompt or approve', async t => {
  for (const capabilities of [null, {}, { elicitation: {} }, { elicitation: { url: {} } }, { elicitation: { form: false } }, { elicitation: { form: [] } }]) {
    await t.test(JSON.stringify(capabilities), async () => {
      const server = fakeServer({ capabilities });
      await assert.rejects(new OperationApprovals(server).require(operation), error => {
        isApprovalError('APPROVAL_UNAVAILABLE')(error);
        assert.match(error.message, /supports MCP form elicitation/);
        assert.match(error.message, /reconnect/);
        return true;
      });
      assert.equal(server.calls.length, 0);
    });
  }
  for (const server of [undefined, {}, { getClientCapabilities() { throw new Error('private failure'); } }, { getClientCapabilities: () => ({ elicitation: { form: {} } }) }]) {
    await assert.rejects(new OperationApprovals(server).require(operation), isApprovalError('APPROVAL_UNAVAILABLE'));
  }
});

test('timeout, disconnected and malformed client errors are sanitized without content or causes', async () => {
  const privateText = 'token-and-command-that-must-not-appear-in-an-error';
  for (const [fail, code] of [
    [new McpError(ErrorCode.RequestTimeout, privateText, { command: privateText }), 'APPROVAL_TIMEOUT'],
    [new Error(privateText), 'APPROVAL_UNAVAILABLE'],
    [new McpError(ErrorCode.InvalidParams, privateText), 'APPROVAL_UNAVAILABLE'],
  ]) {
    await assert.rejects(new OperationApprovals(fakeServer({ fail })).require(operation), error => {
      isApprovalError(code)(error);
      assert.equal(error.cause, undefined);
      assert.ok(!error.message.includes(privateText));
      assert.ok(!error.stack.includes(privateText));
      return true;
    });
  }
});

test('UTF-8 details are bounded at exactly 16 KiB and never silently truncated', async () => {
  const server = fakeServer();
  const approvals = new OperationApprovals(server);
  const details = '🙂'.repeat(MAX_APPROVAL_DETAILS_BYTES / 4);
  assert.equal(await approvals.require({ ...operation, details }), true);
  assert.ok(server.calls[0].params.message.endsWith(JSON.stringify(details)));
  for (const tooLong of [details + 'x', 'x'.repeat(MAX_APPROVAL_DETAILS_BYTES + 1)]) {
    await assert.rejects(approvals.require({ ...operation, details: tooLong }), isApprovalError('APPROVAL_DETAILS_TOO_LARGE'));
  }
  assert.equal(server.calls.length, 1);
});

test('incomplete or ambiguous operation descriptions never prompt', async () => {
  const server = fakeServer();
  const approvals = new OperationApprovals(server);
  const inputs = [
    undefined,
    null,
    true,
    [],
    {},
    ...['action', 'deviceName', 'workspaceRoot', 'details'].flatMap(field => [
      { ...operation, [field]: '' }, { ...operation, [field]: ' \n\t ' }, { ...operation, [field]: undefined },
      { ...operation, [field]: { toString: () => 'hidden details' } },
    ]),
    { ...operation, action: 'x'.repeat(161) },
    { ...operation, deviceName: 'x'.repeat(641) },
    { ...operation, workspaceRoot: 'x'.repeat(4097) },
    { ...operation, signal: {} },
  ];
  for (const input of inputs) await assert.rejects(approvals.require(input), isApprovalError('APPROVAL_INVALID_REQUEST'));
  assert.equal(server.calls.length, 0);
});

test('exact operation whitespace, control characters and multiline content are preserved as data', async () => {
  const server = fakeServer();
  const input = { ...operation, deviceName: ' Pi \'one\'\n', workspaceRoot: '/home/pi/with space ', details: '\tprintf "one"\n# second line\u0000\r\n' };
  await new OperationApprovals(server).require(input);
  const lines = server.calls[0].params.message.split('\n');
  assert.equal(JSON.parse(lines.find(line => line.startsWith('Device: ')).slice('Device: '.length)), input.deviceName);
  assert.equal(JSON.parse(lines.find(line => line.startsWith('Workspace root: ')).slice('Workspace root: '.length)), input.workspaceRoot);
  assert.equal(JSON.parse(lines.find(line => line.startsWith('Exact operation details: ')).slice('Exact operation details: '.length)), input.details);
});

test('real MCP client/server initialization and form approval round trip', async t => {
  const received = [];
  const { approvals, server } = await connectedPair(t, (request, extra) => {
    received.push({ request, id: extra.requestId });
    return { action: 'accept', content: { approved: true } };
  });
  assert.deepEqual(server.server.getClientCapabilities().elicitation, { form: {} });
  assert.equal(await approvals.require(operation), true);
  assert.equal(await approvals.require(operation), true);
  assert.equal(received.length, 2);
  assert.notEqual(received[0].id, received[1].id);
  assert.equal(received[0].request.method, 'elicitation/create');
  assert.equal(received[0].request.params.mode, 'form');
  assert.equal(received[0].request.params.requestedSchema.properties.approved.default, false);
  assert.ok(received[0].request.params.message.includes(JSON.stringify(operation.details)));
});

test('real MCP declined, dismissed, false, missing and incorrectly typed answers cannot approve', async t => {
  for (const [reply, code] of [
    [{ action: 'decline' }, 'APPROVAL_DENIED'],
    [{ action: 'cancel' }, 'APPROVAL_CANCELLED'],
    [{ action: 'accept', content: { approved: false } }, 'APPROVAL_DENIED'],
    [{ action: 'accept' }, 'APPROVAL_DENIED'],
    [{ action: 'accept', content: {} }, 'APPROVAL_UNAVAILABLE'],
    [{ action: 'accept', content: { approved: 'true' } }, 'APPROVAL_UNAVAILABLE'],
  ]) {
    await t.test(JSON.stringify(reply), async t => {
      const { approvals } = await connectedPair(t, () => reply);
      await assert.rejects(approvals.require(operation), isApprovalError(code));
    });
  }
});

test('real MCP clients without form capability fail closed before an elicitation request', async t => {
  const { approvals } = await connectedPair(t, undefined, {});
  await assert.rejects(approvals.require(operation), isApprovalError('APPROVAL_UNAVAILABLE'));
});

test('real MCP first-request cancellation rejects locally and cannot become a late approval', async t => {
  let formStarted;
  const started = new Promise(resolve => { formStarted = resolve; });
  let answer;
  const { approvals } = await connectedPair(t, () => new Promise(resolve => {
    answer = resolve;
    formStarted();
  }));
  const controller = new AbortController();
  const result = assert.rejects(approvals.require({ ...operation, signal: controller.signal }), isApprovalError('APPROVAL_CANCELLED'));
  await started;
  controller.abort();
  await result;
  // SDK 1.31.0 ignores incoming cancellation for request ID 0. The caller must
  // nevertheless remain denied if the client later submits its stale form.
  answer({ action: 'accept', content: { approved: true } });
  await result;
});

test('real MCP in-flight cancellation propagates to the form client on nonzero request IDs', async t => {
  let formStarted;
  const started = new Promise(resolve => { formStarted = resolve; });
  let formCancelled;
  const cancelled = new Promise(resolve => { formCancelled = resolve; });
  const { approvals, server } = await connectedPair(t, (_request, extra) => new Promise(resolve => {
    extra.signal.addEventListener('abort', () => { formCancelled(); resolve({ action: 'cancel' }); }, { once: true });
    formStarted();
  }));
  // SDK 1.31.0 has a known falsy-ID cancellation bug for request ID 0. Exercise
  // its normal cancellation receiver as well as the fail-closed test above.
  await server.server.ping();
  const controller = new AbortController();
  const result = assert.rejects(approvals.require({ ...operation, signal: controller.signal }), isApprovalError('APPROVAL_CANCELLED'));
  await started;
  controller.abort(new Error('Do not expose this reason'));
  await result;
  await cancelled;
});

test('real MCP forms time out at 120 seconds and cancel the waiting client', async t => {
  let formStarted;
  const started = new Promise(resolve => { formStarted = resolve; });
  let formCancelled;
  const cancelled = new Promise(resolve => { formCancelled = resolve; });
  const { approvals, server } = await connectedPair(t, (_request, extra) => new Promise(resolve => {
    extra.signal.addEventListener('abort', () => { formCancelled(); resolve({ action: 'cancel' }); }, { once: true });
    formStarted();
  }));
  await server.server.ping();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = assert.rejects(approvals.require(operation), isApprovalError('APPROVAL_TIMEOUT'));
  await started;
  t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
  await result;
  await cancelled;
});
