// Crash-test helper: appends numbered records forever and prints each counter only after
// append() returned (so a printed counter is an acknowledged record). Killed by crash.test.js.
// Usage: node crash-child.js <dir> <startCounter>
import fs from 'node:fs';
import { open } from '../../../etcd/wal/wal.js';

const [dir, startArg] = process.argv.slice(2);
const w = open(dir);
const filler = Buffer.alloc(100, 0x78);
for (let i = Number(startArg); ; i++) {
  const payload = Buffer.alloc(8 + filler.length);
  payload.writeBigUInt64BE(BigInt(i), 0);
  filler.copy(payload, 8);
  w.append(1, payload);
  fs.writeSync(1, `${i}\n`); // synchronous, so the parent sees an acked counter immediately
}
