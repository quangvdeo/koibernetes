import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { open } from '../../../etcd/pager/pager.js';
import { readHeader, FLAGS } from '../../../etcd/pager/page.js';
import { encodeMeta, InvalidFileError, ChecksumError } from '../../../etcd/pager/meta.js';
import { FakeFs } from '../wal/fake-fs.js';
import { tmpFile, countingFs, durableDir, fixture } from './helpers.js';

test('create writes exactly the file bbolt v1.5.0 writes', () => {
  const p = tmpFile();
  const pager = open(p);
  assert.deepEqual(pager.meta, { pageSize: 4096, flags: 0, root: 3, sequence: 0, freelist: 2, hwm: 4, txid: 1 });
  assert.equal(pager.pageSize, 4096);
  pager.close();
  assert.deepEqual(fs.readFileSync(p), fs.readFileSync(fixture('bbolt-fresh-4096.db')));
});

test('create is durable: file and directory entry fsynced', () => {
  const ffs = new FakeFs();
  durableDir(ffs, '/d');
  open('/d/db', { fs: ffs }).close();
  assert.ok(ffs.ops.indexOf('fsync:/d/db') < ffs.ops.lastIndexOf('fsync:/d'));
  ffs.crash();
  assert.equal(open('/d/db', { fs: ffs }).meta.txid, 1);
});

test('reopen keeps the stored page size and meta', () => {
  const p = tmpFile();
  open(p, { pageSize: 16384 }).close();
  const pager = open(p, { pageSize: 4096 });
  assert.equal(pager.pageSize, 16384);
  assert.equal(pager.meta.pageSize, 16384);
  assert.equal(pager.meta.txid, 1);
  pager.close();
});

test('reads a real bbolt file', () => {
  const pager = open(fixture('bbolt-fresh-4096.db'));
  assert.equal(pager.meta.root, 3);
  assert.equal(readHeader(pager.read(3)).flags, FLAGS.leaf);
  assert.equal(readHeader(pager.read(2)).flags, FLAGS.freelist);
  pager.close();
});

test('falls back to the other meta when one is corrupt', () => {
  const p = tmpFile();
  open(p).close();
  corrupt(p, 4096 + 40); // meta 1 (txid 1)
  const pager = open(p);
  assert.equal(pager.meta.txid, 0);
  pager.close();
  corrupt(p, 40); // meta 0 too
  assert.throws(() => open(p), ChecksumError);
});

test('page 0 damaged: page size found by probing for meta 1', () => {
  const p = tmpFile();
  open(p, { pageSize: 16384 }).close();
  corrupt(p, 16); // magic of meta 0
  const pager = open(p);
  assert.equal(pager.pageSize, 16384);
  assert.equal(pager.meta.txid, 1);
  pager.close();
});

test('high-water mark past the end of the file is rejected', () => {
  const p = tmpFile();
  open(p).close();
  const page = encodeMeta({ pageSize: 4096, flags: 0, root: 3, sequence: 0, freelist: 2, hwm: 10, txid: 7 }, 4096);
  const fd = fs.openSync(p, 'r+');
  fs.writeSync(fd, page, 0, page.length, 4096); // slot 1
  fs.closeSync(fd);
  assert.throws(() => open(p), InvalidFileError);
});

test('not a bolt file', () => {
  const p = tmpFile();
  fs.writeFileSync(p, Buffer.alloc(16384, 7));
  assert.throws(() => open(p), InvalidFileError);
});

test('cached pages are read from disk once', () => {
  const p = tmpFile();
  open(p).close();
  const cfs = countingFs();
  const pager = open(p, { fs: cfs });
  const before = cfs.reads;
  const a = pager.read(3);
  const mid = cfs.reads;
  assert.ok(mid > before);
  assert.equal(pager.read(3), a);
  assert.equal(cfs.reads, mid);
  pager.close();
});

test('cache is bounded', () => {
  const p = tmpFile();
  open(p).close();
  const cfs = countingFs();
  const pager = open(p, { fs: cfs, cachePages: 1 });
  pager.read(3);
  pager.read(2); // evicts 3
  const n = cfs.reads;
  pager.read(3);
  assert.ok(cfs.reads > n);
  pager.close();
});

test('read outside the file is a RangeError', () => {
  const p = tmpFile();
  const pager = open(p);
  assert.throws(() => pager.read(4), RangeError);
  assert.throws(() => pager.read(-1), RangeError);
  assert.throws(() => pager.read(1.5), RangeError);
  pager.close();
});

test('beginRead snapshots the live meta', () => {
  const pager = open(tmpFile());
  const r = pager.beginRead();
  assert.deepEqual(r.meta, pager.meta);
  assert.notEqual(r.meta, pager.meta);
  r.release();
  r.release(); // idempotent
  pager.close();
});

function corrupt(p, off) {
  const fd = fs.openSync(p, 'r+');
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, off);
  b[0] ^= 0xff;
  fs.writeSync(fd, b, 0, 1, off);
  fs.closeSync(fd);
}
