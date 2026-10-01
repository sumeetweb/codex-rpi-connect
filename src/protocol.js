import { randomBytes } from 'node:crypto';

export const PROBES = Object.freeze({
  smoke: { description: 'Print a fixed test message', command: "printf 'codex-rpi-connect OK\\n'" },
  system: { description: 'Kernel and architecture (uname -srm)', command: '/usr/bin/uname -srm' },
  uptime: { description: 'Uptime and load averages', command: '/usr/bin/uptime' },
  disk: { description: 'Root filesystem usage', command: '/usr/bin/df -h /' },
  connect: { description: 'Raspberry Pi Connect service status', command: '/usr/bin/rpi-connect status' },
});
export const MAX_OUTPUT = 8192;
export const REMOTE_TIMEOUT_SECONDS = 5;

export function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

export function buildDiagnostic(probe, nonce = randomBytes(12).toString('hex')) {
  if (!Object.hasOwn(PROBES, probe)) throw new Error('Unknown diagnostic');
  if (!/^[a-f0-9]{24}$/.test(nonce)) throw new Error('Invalid command nonce');
  const marker = `CRC_${nonce}`;
  // Split the nonce so the echoed input can never contain a complete result marker.
  const left = `CRC_${nonce.slice(0, 12)}`;
  const right = nonce.slice(12);
  const command = PROBES[probe].command;
  const body = `printf '\\n%s%s BEGIN\\n' '${left}' '${right}'; ` +
    `if [ -x /usr/bin/timeout ]; then /usr/bin/timeout --signal=TERM --kill-after=2s ${REMOTE_TIMEOUT_SECONDS}s /bin/sh -c ${shellQuote(command)} </dev/null 2>&1; r=$?; ` +
    `else printf 'Required /usr/bin/timeout is missing\\n'; r=125; fi; ` +
    `printf '\\n%s%s END %d\\n' '${left}' '${right}' "$r"`;
  return { probe, marker, line: ` /bin/sh -c ${shellQuote(body)}` };
}

export function parseTranscript(text, marker) {
  if (!/^CRC_[a-f0-9]{24}$/.test(marker)) throw new Error('Invalid marker');
  const lines = text.replaceAll('\r', '').split('\n');
  const begin = lines.findIndex(line => line.trimEnd() === `${marker} BEGIN`);
  if (begin < 0) return null;
  const endPattern = new RegExp(`^${marker} END ([0-9]{1,3})\\s*$`);
  for (let i = begin + 1; i < lines.length; i++) {
    const match = lines[i].match(endPattern);
    if (!match) continue;
    const exitCode = Number(match[1]);
    if (exitCode > 255) return null;
    const output = lines.slice(begin + 1, i).join('\n').replace(/^\n|\n$/g, '');
    return {
      status: exitCode === 124 || exitCode === 137 ? 'remote_timeout' : 'completed',
      exitCode,
      output: output.slice(0, MAX_OUTPUT),
      truncated: output.length > MAX_OUTPUT,
    };
  }
  return null;
}
