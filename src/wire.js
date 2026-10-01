import { createHash, randomBytes } from 'node:crypto';
import { shellQuote } from './protocol.js';
export const WIRE_PROTOCOL = 1;
export const MAX_REQUEST_LINE = 2048;
export const REQUEST_CHUNK_BYTES = 768;
export const RESULT_CHUNK_BYTES = 512;
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const requestId = () => { let id; do { id = randomBytes(8).toString('hex'); } while (id === '0000000000000000'); return id; };
const checkId = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);

export function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(value, 'ascii')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export function encodeRequest(op, fields = {}, id = requestId()) {
  if (!checkId(id) || !/^[a-z_]+$/.test(op)) throw new Error('Invalid wire request');
  const line = JSON.stringify({ ...fields, id, op });
  if (Buffer.byteLength(line) > MAX_REQUEST_LINE || /[\r\n]/.test(line)) throw new Error('Wire request exceeds terminal line limit');
  return { id, line };
}

export function encodeFrame(token, id, value) {
  if (!checkId(token) || !checkId(id)) throw new Error('Invalid frame identity');
  const data = Buffer.from(JSON.stringify(value)).toString('base64');
  const content = `${token}|${id}|${data}`;
  return `~CRC1|${content}|${crc32(content)}~`;
}

export function parseFrame(text, token, id) {
  if (!checkId(token) || !checkId(id)) throw new Error('Invalid frame identity');
  // Base64 records contain no whitespace. Joining rendered rows permits ordinary
  // terminal wrapping without depending on private xterm buffer/renderer objects.
  const compact = text.replace(/\s/g, '');
  const pattern = new RegExp(`~CRC1\\|${token}\\|${id}\\|([A-Za-z0-9+/=]{1,16384})\\|([a-f0-9]{8})~`, 'g');
  for (const match of compact.matchAll(pattern)) {
    const content = `${token}|${id}|${match[1]}`;
    if (crc32(content) !== match[2]) continue;
    const raw = Buffer.from(match[1], 'base64');
    if (raw.toString('base64') !== match[1]) continue;
    try { const result = JSON.parse(raw.toString('utf8')); if (result && typeof result === 'object' && !Array.isArray(result)) return result; }
    catch { /* Partial/corrupt records are never treated as successful responses. */ }
  }
  return null;
}

export function makeBootstrap(source, token, workspaceRoot) {
  if (!checkId(token) || typeof workspaceRoot !== 'string' || !workspaceRoot.startsWith('/') || /[\0\r\n]/.test(workspaceRoot)) throw new Error('Invalid worker bootstrap');
  if (Buffer.byteLength(source) > 49152) throw new Error('Worker source exceeds bootstrap limit');
  const encoded = Buffer.from(source).toString('base64');
  const chunks = encoded.match(/.{1,512}/g);
  // Each physical line is bounded. The worker is executed in memory and remains
  // foreground-only; no remote file, daemon, credential or service is installed.
  const loader = `import base64,hashlib,sys;code=base64.b64decode(sys.argv.pop(),validate=True);hashlib.sha256(code).hexdigest()=="${sha256(Buffer.from(source))}" or sys.exit("Worker checksum mismatch");exec(compile(code,"<connect-worker>","exec"))`;
  return ` python3 -I -u -c ${shellQuote(loader)} ${shellQuote(token)} ${shellQuote(workspaceRoot)} "$(printf '%s' \\\n${chunks.map(chunk => shellQuote(chunk) + ' \\').join('\n')}\n)"`;
}
