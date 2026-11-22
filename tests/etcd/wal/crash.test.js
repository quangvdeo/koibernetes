import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replay } from '../../../etcd/wal/replay.js';
import { repair } from '../../../etcd/wal/repair.js';
import { tmp } from './helpers.js';

const CHILD = fileURLToPath(new URL('./crash-child.js', import.meta.url));

// Runs the child until it has acked `minAcks` records, SIGKILLs it, returns the highest acked counter.
function killAfter(dir, start, minAcks) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dir, String(start)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let pending = '';
    let acks = 0;
    let last = start - 1;
    let killed = false;
    child.on('error', reject);
    child.on('exit', () => resolve(last));
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop(); // incomplete last line stays pending
      for (const l of lines) {
        last = Number(l);
        acks++;
      }
      if (acks >= minAcks && !killed) {
        killed = true;
        setTimeout(() => child.kill('SIGKILL'), 3);
      }
    });
  });
}

function readCounters(dir) {
  const counters = [];
  replay(dir, (type, payload) => counters.push(Number(payload.readBigUInt64BE(0))));
  return counters;
}

test('SIGKILL keeps every acknowledged record', async () => {
  const dir = tmp();
  let lastAcked = -1;
  for (let cycle = 0; cycle < 5; cycle++) {
    repair(dir);
    const counters = readCounters(dir);
    counters.forEach((c, i) => assert.equal(c, i, `cycle ${cycle}: gap or reorder at index ${i}`));
    assert.ok(counters.length - 1 >= lastAcked, `cycle ${cycle}: lost acked record ${lastAcked}, have ${counters.length}`);
    lastAcked = await killAfter(dir, counters.length, 200);
  }
  repair(dir);
  const counters = readCounters(dir);
  counters.forEach((c, i) => assert.equal(c, i));
  assert.ok(counters.length - 1 >= lastAcked);
});
