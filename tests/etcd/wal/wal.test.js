import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { open } from '../../../etcd/wal/wal.js';
import { replay } from '../../../etcd/wal/replay.js';
import { encode, LOG_NAME } from '../../../etcd/wal/record.js';
import { crc32c } from '../../../etcd/wal/crc32c.js';
import { tmp, replayAll } from './helpers.js';

test('round trip', () => {
  const dir = tmp();
  const w = open(dir);
  w.append(1, Buffer.from('a'));
  w.append(2, Buffer.from('bb'));
  w.append(3, Buffer.alloc(0));
  w.close();
  const { recs, result } = replayAll(dir);
  assert.deepEqual(
    recs.map((r) => [r.type, r.payload.toString()]),
    [[1, 'a'], [2, 'bb'], [3, '']],
  );
  assert.equal(result.tornTail, false);
  assert.equal(result.goodOffset, fs.statSync(path.join(dir, LOG_NAME)).size);
});

test('large payload round trips', () => {
  const dir = tmp();
  const big = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const w = open(dir);
  w.append(9, big);
  w.close();
  const { recs } = replayAll(dir);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].payload.equals(big));
});

test('replay of missing dir returns nothing', () => {
  let called = false;
  const result = replay(path.join(tmp(), 'nope'), () => { called = true; });
  assert.deepEqual(result, { goodOffset: 0, tornTail: false });
  assert.equal(called, false);
});

test('reopen appends after existing records', () => {
  const dir = tmp();
  let w = open(dir);
  w.append(1, Buffer.from('A'));
  w.close();
  w = open(dir);
  w.append(1, Buffer.from('B'));
  w.close();
  const { recs } = replayAll(dir);
  assert.deepEqual(recs.map((r) => r.payload.toString()), ['A', 'B']);
});

test('encode layout', () => {
  const b = encode(7, Buffer.from('hi'));
  assert.equal(b.length, 11);
  assert.equal(b.readUInt32LE(0), 2);
  assert.equal(b[4], 7);
  assert.equal(b.subarray(5, 7).toString(), 'hi');
  assert.equal(b.readUInt32LE(7), crc32c(Buffer.from([7, 0x68, 0x69])));
});

test('append rejects a bad type', () => {
  const w = open(tmp());
  for (const t of [256, -1, 1.5]) {
    assert.throws(() => w.append(t, Buffer.alloc(0)), RangeError);
  }
  w.close();
});
