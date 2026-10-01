import { spawnSync } from 'node:child_process';
if (process.platform !== 'linux') {
  console.log('SKIPPED: remote worker tests require Linux (Raspberry Pi OS target). Run in Linux CI. This does not establish a remote test pass.');
  process.exit(0);
}
const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'test/remote', '-v'], { stdio: 'inherit' });
if (result.error) { console.error('Python 3 is required for the Linux worker test suite.'); process.exit(1); }
process.exit(result.status || 0);
