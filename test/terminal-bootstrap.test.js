import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBootstrap, parseFrame, sha256 } from '../src/wire.js';

// This runs the actual in-memory loader and worker in disposable local PTYs.
// It has no browser, network listener, remote Pi, credentials, or shell profile.
// Browser/xterm DOM paste is covered separately by the browser fixture suite.
const PTY_HARNESS = String.raw`
import base64, errno, hashlib, json, os, pty, re, select, signal, sys, termios, time, zlib

config = json.load(sys.stdin)
token, root, shell = config['token'], config['root'], config['shell']
pid, master = pty.fork()
if pid == 0:
    os.chdir(root)
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': root,
           'TERM': 'xterm-256color', 'LC_ALL': 'C.UTF-8', 'HISTFILE': '/dev/null',
           'PS1': 'CRC_PROMPT> ', 'PS2': 'CRC_CONT> '}
    argv = [shell, '--noprofile', '--norc', '-i'] if shell.endswith('/bash') else [shell, '-i']
    os.execve(shell, argv, env)

os.set_blocking(master, False)
transcript = bytearray()
frames = []
sequence = 0
reaped = False
absolute_deadline = time.monotonic() + 14


def check_deadline(deadline):
    if time.monotonic() > min(deadline, absolute_deadline):
        raise AssertionError('PTY step timed out; tail=' + repr(bytes(transcript[-800:])))


def receive():
    try:
        data = os.read(master, 16384)
    except BlockingIOError:
        return
    except OSError as exc:
        if exc.errno == errno.EIO:
            return
        raise
    transcript.extend(data)
    if len(transcript) > 1048576:
        raise AssertionError('PTY transcript exceeded safety bound')


def write(data):
    offset = 0
    deadline = time.monotonic() + 5
    while offset < len(data):
        check_deadline(deadline)
        readable, writable, _ = select.select([master], [master], [], 0.05)
        if readable:
            receive()
        if writable:
            try:
                offset += os.write(master, data[offset:offset + 4096])
            except BlockingIOError:
                pass


def wait_for(predicate, start=0, seconds=5):
    deadline = time.monotonic() + seconds
    while True:
        result = predicate(bytes(transcript[start:]))
        if result is not None:
            return result
        check_deadline(deadline)
        if select.select([master], [], [], 0.03)[0]:
            receive()


def marker(data):
    return True if b'CRC_PROMPT> ' in data else None


def paste(text):
    # xterm's ordinary paste handler normalizes LF/CRLF to CR and wraps bracketed
    # paste only while the shell has enabled terminal private mode 2004.
    bracketed = transcript.rfind(b'\x1b[?2004h') > transcript.rfind(b'\x1b[?2004l')
    data = re.sub(r'\r?\n', '\r', text).encode('utf-8')
    if bracketed:
        data = b'\x1b[200~' + data + b'\x1b[201~'
    write(data)
    write(b'\r')  # Separate Enter, matching the browser bridge.
    return bracketed


def read_frame(request_id, start):
    pattern = re.compile(rb'~CRC1\|' + token.encode() + rb'\|' + request_id.encode() +
                         rb'\|([A-Za-z0-9+/=]+)\|([a-f0-9]{8})~')
    def find(data):
        match = pattern.search(re.sub(rb'\s', b'', data))
        if not match:
            return None
        body = token.encode() + b'|' + request_id.encode() + b'|' + match[1]
        assert match[2].decode() == '%08x' % (zlib.crc32(body) & 0xffffffff), 'Bad response CRC'
        raw = base64.b64decode(match[1], validate=True)
        assert base64.b64encode(raw) == match[1], 'Noncanonical response base64'
        value = json.loads(raw)
        frames.append({'id': request_id, 'frame': match[0].decode('ascii')})
        return value
    return wait_for(find, start)


def rpc(op, **fields):
    global sequence
    sequence += 1
    request_id = '%016x' % sequence
    line = json.dumps(dict(fields, id=request_id, op=op), separators=(',', ':'))
    assert len(line.encode()) <= 2048
    start = len(transcript)
    paste(line)
    response = read_frame(request_id, start)
    assert line.encode() not in transcript[start:], 'Worker echoed an RPC request'
    assert 'error' not in response, response
    return response


def terminal_settings(label):
    start = len(transcript)
    paste("printf 'CRC_" + label + "_BEGIN\\n'; stty -g; printf 'CRC_" + label + "_END\\n'")
    pattern = re.compile(('CRC_' + label + '_BEGIN\\r?\\n([0-9a-f:]+)\\r?\\nCRC_' + label + '_END').encode())
    mode = wait_for(lambda data: (m[1].decode() if (m := pattern.search(data)) else None), start)
    wait_for(marker, start)
    return mode


try:
    wait_for(marker)
    initial_settings = terminal_settings('BASELINE')
    start = len(transcript)
    bracketed = paste(config['bootstrap'])
    ready = read_frame('0000000000000000', start)
    assert ready['status'] == 'ready' and ready['protocol'] == 1 and ready['root'] == root, ready
    assert not termios.tcgetattr(master)[3] & termios.ECHO, 'Worker did not disable tty echo'
    assert termios.tcgetattr(master)[3] & termios.ICANON, 'Worker lost canonical terminal input'
    payload = json.dumps(config['payload'], separators=(',', ':'), ensure_ascii=True).encode()
    upload = rpc('upload_begin', byteLength=len(payload), sha256=hashlib.sha256(payload).hexdigest())['uploadId']
    chunks = 0
    for offset in range(0, len(payload), 768):
        chunk = payload[offset:offset + 768]
        response = rpc('upload_chunk', uploadId=upload, offset=offset, data=base64.b64encode(chunk).decode())
        assert response['offset'] == offset + len(chunk)
        chunks += 1
    job = rpc('upload_commit', uploadId=upload)['jobId']
    deadline = time.monotonic() + 3
    while True:
        status = rpc('job_status', jobId=job)
        if status['status'] == 'done':
            break
        check_deadline(deadline)
        time.sleep(0.01)
    result_bytes = bytearray()
    while True:
        part = rpc('result_read', jobId=job, offset=len(result_bytes), length=512)
        assert part['offset'] == len(result_bytes)
        result_bytes.extend(base64.b64decode(part['data'], validate=True))
        assert len(result_bytes) <= 65536
        if part['eof']:
            break
    assert len(result_bytes) == status['byteLength']
    assert hashlib.sha256(result_bytes).hexdigest() == status['sha256']
    close_start = len(transcript)
    assert rpc('close') == {'status': 'closed'}
    # A close acknowledgement alone does not prove the worker has exited. Wait
    # for the interactive shell, then compare its actual canonical stty settings.
    wait_for(marker, close_start)
    final_settings = terminal_settings('RESTORED')
    assert final_settings == initial_settings, (initial_settings, final_settings)
    paste('exit')
    deadline = time.monotonic() + 2
    while True:
        ended, exit_status = os.waitpid(pid, os.WNOHANG)
        if ended:
            reaped = True
            assert os.waitstatus_to_exitcode(exit_status) == 0
            break
        check_deadline(deadline)
        time.sleep(0.02)
    print(json.dumps({'frames': frames, 'result': json.loads(result_bytes),
                      'ready': ready, 'bracketedPaste': bracketed, 'uploadChunks': chunks,
                      'echoDisabled': True, 'settingsRestored': final_settings == initial_settings,
                      'transcriptBytes': len(transcript)}))
finally:
    if not reaped:
        try:
            foreground = os.tcgetpgrp(master)
            if foreground > 1 and foreground != os.getpgrp():
                os.killpg(foreground, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(master)
`;

function runPty(config) {
  return new Promise((resolve, reject) => {
    const process = execFile('python3', ['-I', '-u', '-c', PTY_HARNESS], {
      timeout: 18000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`Local PTY regression failed: ${stderr || error.message}`));
      try { assert.equal(stderr, ''); resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
    process.stdin.on('error', reject);
    process.stdin.end(JSON.stringify(config));
  });
}

test('actual multiline loader paste runs worker RPC and restores interactive PTY terminal', {
  skip: process.platform !== 'linux' ? 'Requires Linux PTY and Python 3' : false,
  timeout: 40000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'crc-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project 'π$");
  await mkdir(root);
  const token = 'f00df00d12345678';
  const source = await readFile(new URL('../remote/worker.py', import.meta.url), 'utf8');
  const bootstrap = makeBootstrap(source, token, root);
  const payload = {
    kind: 'exec', root, command: "printf '%s' \"$GREETING\"; printf '\\000\\377'; printf 'pty stderr' >&2; exit 7",
    cwd: '', env: { GREETING: 'pty ' + 'x'.repeat(900) }, timeoutMs: 1000, maxOutputBytes: 1024,
  };
  const shells = ['/bin/sh', '/bin/bash'].filter(existsSync);
  assert.ok(shells.length, 'A local POSIX shell is required');
  for (const shell of shells) {
    const report = await runPty({ token, root, shell, bootstrap, payload });
    for (const { id, frame } of report.frames) {
      assert.ok(parseFrame(frame, token, id), `Node parser rejected actual ${shell} PTY frame`);
    }
    assert.deepEqual(parseFrame(report.frames[0].frame, token, '0000000000000000'), report.ready);
    assert.equal(report.result.status, 'completed');
    assert.equal(report.result.exitCode, 7);
    assert.equal(report.result.stdoutTruncated, false);
    assert.equal(report.result.stderrTruncated, false);
    assert.deepEqual(Buffer.from(report.result.stdout, 'base64'), Buffer.concat([Buffer.from(payload.env.GREETING), Buffer.from([0, 255])]));
    assert.equal(Buffer.from(report.result.stderr, 'base64').toString(), 'pty stderr');
    assert.equal(report.echoDisabled, true);
    assert.equal(report.settingsRestored, true);
    assert.ok(report.uploadChunks > 1, 'The PTY path must exercise multiple upload chunks');
    assert.ok(report.transcriptBytes < 1024 * 1024);
    if (shell.endsWith('/bash')) assert.equal(report.bracketedPaste, true, 'Bash should exercise xterm bracketed paste');
    const resultFrames = report.frames.filter(({ frame, id }) => parseFrame(frame, token, id)?.data !== undefined);
    const resultBytes = Buffer.concat(resultFrames.map(({ frame, id }) => Buffer.from(parseFrame(frame, token, id).data, 'base64')));
    const done = report.frames.map(({ frame, id }) => parseFrame(frame, token, id)).find(value => value.status === 'done');
    assert.equal(sha256(resultBytes), done.sha256);
    assert.equal(resultBytes.length, done.byteLength);
  }
  assert.deepEqual(await readdir(root), [], 'The bootstrap must not install worker files or shell history');
});
