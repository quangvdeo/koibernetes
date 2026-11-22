import test from 'node:test';
import assert from 'node:assert/strict';
import { Freelist } from '../../../etcd/pager/freelist.js';
import { readHeader, FLAGS } from '../../../etcd/pager/page.js';

const withFree = (ids) => { const f = new Freelist(); for (const id of ids) f.addFree(id, 1); return f; };

test('allocate is first fit over contiguous runs', () => {
  const f = withFree([3, 5, 6, 7, 9]);
  assert.equal(f.allocate(2), 5);
  assert.equal(f.allocate(2), 0); // left: 3, 7, 9
  assert.equal(f.allocate(1), 3);
  assert.deepEqual(f.freeIds(), [7, 9]);
});

test('pending pages are not allocatable until released', () => {
  const f = new Freelist();
  f.free(5, 10, 0);
  f.free(6, 11, 1); // pages 11, 12
  assert.equal(f.allocate(1), 0);
  f.release(6); // releases t < 6 only
  assert.deepEqual(f.freeIds(), [10]);
  f.release(7);
  assert.deepEqual(f.freeIds(), [10, 11, 12]);
  assert.equal(f.allocate(3), 10);
});

test('double free and meta pages throw', () => {
  const f = withFree([4]);
  f.free(3, 8, 0);
  assert.throws(() => f.free(3, 8, 0), /already free/);
  assert.throws(() => f.free(3, 4, 0), /already free/);
  assert.throws(() => f.free(3, 1, 0), /meta/);
  assert.throws(() => f.addFree(4, 1), /already free/);
});

test('encode/decode round trip includes pending', () => {
  const f = withFree([9, 3]);
  f.free(2, 20, 1);
  const buf = Buffer.alloc(4096);
  f.encode(buf);
  assert.deepEqual(readHeader(buf), { id: 0, flags: FLAGS.freelist, count: 4, overflow: 0 });
  assert.deepEqual(Freelist.decode(buf).freeIds(), [3, 9, 20, 21]);
  assert.equal(f.encodedSize(), 16 + 4 * 8);
});

test('65535 or more ids use the 0xFFFF count form', () => {
  const f = new Freelist();
  f.addFree(2, 65535);
  const size = f.encodedSize();
  assert.equal(size, 16 + 8 + 65535 * 8);
  const buf = Buffer.alloc(size);
  f.encode(buf);
  assert.equal(readHeader(buf).count, 0xffff);
  assert.equal(buf.readBigUInt64LE(16), 65535n);
  const back = Freelist.decode(buf).freeIds();
  assert.equal(back.length, 65535);
  assert.equal(back[0], 2);
  assert.equal(back.at(-1), 65536);
});

test('clone is independent', () => {
  const f = withFree([3]);
  const c = f.clone();
  c.allocate(1);
  c.free(1, 7, 0);
  assert.deepEqual(f.freeIds(), [3]);
  assert.equal(f.has(7), false);
});
