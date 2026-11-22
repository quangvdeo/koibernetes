// Regressions for the second WAL review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { open } from '../../../etcd/wal/wal.js';
import { repair } from '../../../etcd/wal/repair.js';
import { CorruptError, LOG_NAME, encode } from '../../../etcd/wal/record.js';
import { FakeFs } from './fake-fs.js';
import { tmp, replayAll } from './helpers.js';

test('bad crc on the last record followed by junk is a torn tail', () => {
  const dir = tmp();
  const b = encode(1, Buffer.from('bbbb'));
  b[b.length - 1] ^= 0xff; // bad crc
  fs.writeFileSync(path.join(dir, LOG_NAME), Buffer.concat([encode(1, Buffer.from('a')), b, Buffer.from([0xff, 0x01, 0x7f])]));
  const { recs, result } = replayAll(dir);
  assert.deepEqual(recs.map((r) => r.payload.toString()), ['a']);
  assert.equal(result.tornTail, true);
  assert.ok(repair(dir) > 0);
  assert.equal(replayAll(dir).result.tornTail, false);
});

test('bad crc followed by a valid record is still corruption', () => {
  const dir = tmp();
  const b = encode(1, Buffer.from('bbbb'));
  b[b.length - 1] ^= 0xff;
  fs.writeFileSync(path.join(dir, LOG_NAME), Buffer.concat([b, Buffer.from([0xff]), encode(1, Buffer.from('c'))]));
  assert.throws(() => replayAll(dir), CorruptError);
});

test('append refuses to grow the log past what replay can read back', () => {
  const ffs = new FakeFs();
  const w0 = open('/w', { fs: ffs });
  w0.append(1, Buffer.from('x'));
  w0.close();
  const realFstat = ffs.fstatSync.bind(ffs);
  ffs.fstatSync = (fd) => ({ ...realFstat(fd), size: 2 ** 31 - 12 }); // log just under the 2 GiB read limit
  const w = open('/w', { fs: ffs });
  assert.throws(() => w.append(1, Buffer.from('fits?')), RangeError);
  assert.equal(ffs.readFileSync(`/w/${LOG_NAME}`).length, encode(1, Buffer.from('x')).length);
  w.append(1, Buffer.alloc(0)); // 9 bytes: exactly fills 2^31 - 3, still readable
});

test('append after close is a clear error; close twice is harmless', () => {
  const w = open(tmp());
  w.close();
  assert.throws(() => w.append(1, Buffer.from('x')), /closed/);
  w.close();
});
