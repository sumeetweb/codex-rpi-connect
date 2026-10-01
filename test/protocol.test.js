import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { buildDiagnostic, parseTranscript, shellQuote, MAX_OUTPUT, PROBES } from '../src/protocol.js';
const exec = promisify(execFile);
const nonce = '0123456789abcdef01234567';
const marker = `CRC_${nonce}`;

test('completion markers cannot appear in echoed command', () => {
  for (const probe of Object.keys(PROBES)) {
    const { line } = buildDiagnostic(probe, nonce);
    assert.equal(line.includes(marker), false);
    assert.equal(line.includes('\n'), false);
    assert.equal(parseTranscript(line, marker), null);
  }
});
test('fixed smoke wrapper runs in a POSIX shell and captures its real result', { skip: !existsSync('/bin/sh') || !existsSync('/usr/bin/timeout') ? 'Requires Linux paths matching Raspberry Pi OS' : false }, async () => {
  const { line } = buildDiagnostic('smoke', nonce);
  const { stdout } = await exec('/bin/sh', ['-c', line], { timeout: 9000 });
  assert.deepEqual(parseTranscript(stdout, marker), { status: 'completed', exitCode: 0, output: 'codex-rpi-connect OK', truncated: false });
});
test('shell quoting protects literal apostrophes and metacharacters', { skip: !existsSync('/bin/sh') ? 'Requires POSIX shell' : false }, async () => {
  const value = "a'b; echo NO; $(echo NO)";
  const { stdout } = await exec('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`]);
  assert.equal(stdout, value);
});
test('arbitrary commands and invalid nonce are rejected', () => {
  for (const command of ['ls', 'smoke; touch /tmp/bad', '__proto__', 'constructor']) assert.throws(() => buildDiagnostic(command));
  assert.throws(() => buildDiagnostic('smoke', 'invalid'));
});
test('requires exact begin and end markers; partial/wrong/echoed output is not success', () => {
  for (const text of ['', `${marker} END 0`, `${marker} BEGIN\npartial`, `$ echo ${marker} BEGIN\n${marker} END 0`, `${marker} BEGIN\n${marker} END 999`]) assert.equal(parseTranscript(text, marker), null);
});
test('nonzero exit, CRLF and remote timeout are preserved', () => {
  assert.equal(parseTranscript(`${marker} BEGIN\r\nerror\r\n${marker} END 7\r\n`, marker).exitCode, 7);
  for (const code of [124, 137]) assert.equal(parseTranscript(`${marker} BEGIN\n\n${marker} END ${code}`, marker).status, 'remote_timeout');
});
test('multiline output is bounded with an explicit truncation flag', () => {
  const result = parseTranscript(`${marker} BEGIN\n${'x'.repeat(MAX_OUTPUT + 10)}\n${marker} END 0`, marker);
  assert.equal(result.output.length, MAX_OUTPUT);
  assert.equal(result.truncated, true);
});
