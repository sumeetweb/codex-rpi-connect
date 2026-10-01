import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { crc32, encodeFrame, encodeRequest, parseFrame, makeBootstrap } from '../src/wire.js';
const token = '0123456789abcdef', id = 'abcdef0123456789';
test('CRC32 matches standard check vector', () => { assert.equal(crc32('123456789'), 'cbf43926'); });
test('frames survive ordinary terminal line wrapping and reject corruption/wrong identity', () => {
  const frame = encodeFrame(token, id, { ok: true, unicode: 'π🚀', n: 17 });
  assert.deepEqual(parseFrame(frame.match(/.{1,23}/g).join('\n'), token, id), { ok: true, unicode: 'π🚀', n: 17 });
  assert.equal(parseFrame(frame.replace('CRC1', 'CRC2'), token, id), null);
  assert.equal(parseFrame(frame.slice(0, -5) + '0000~', token, id), null);
  assert.equal(parseFrame(frame, token, '0000000000000000'), null);
});
test('wire requests cannot include output marker and cannot override operation identity', () => {
  const request = encodeRequest('job_status', { jobId: 'x', id: 'other', op: 'close' }, id);
  assert.equal(JSON.parse(request.line).op, 'job_status');
  assert.equal(JSON.parse(request.line).id, id);
  assert.equal(request.line.includes('~CRC1|'), false);
  assert.throws(() => encodeRequest('x', { data: 'x'.repeat(3000) }));
});
test('bootstrap bounds physical lines and shell-quotes root without installing files', () => {
  const code = 'print("ready")\n'.repeat(200);
  const bootstrap = makeBootstrap(code, token, "/tmp/a'b");
  assert.ok(bootstrap.split('\n').every(line => line.length < 800));
  assert.ok(!bootstrap.includes(' > '));
  assert.throws(() => makeBootstrap('a'.repeat(50000), token, '/tmp/root'));
});
test('bootstrap executes exact Python source with safely quoted arguments', { skip: !existsSync('/bin/sh') ? 'Requires POSIX shell' : false }, async () => {
  const root = "/tmp/a'b;$HOME";
  const script = 'import json,sys;print(json.dumps(sys.argv[1:]))';
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', makeBootstrap(script, token, root)]);
  assert.deepEqual(JSON.parse(stdout), [token, root]);
});

test('bootstrap rejects valid-base64 source corruption before executing it', { skip: !existsSync('/bin/sh') ? 'Requires POSIX shell' : false }, async () => {
  const script = 'print("must not run")';
  const encoded = Buffer.from(script).toString('base64');
  const line = makeBootstrap(script, token, '/tmp/root').replace(encoded, (encoded[0] === 'A' ? 'B' : 'A') + encoded.slice(1));
  await assert.rejects(promisify(execFile)('/bin/sh', ['-c', line]), error => error.stdout === '' && error.stderr.includes('Worker checksum mismatch'));
});
