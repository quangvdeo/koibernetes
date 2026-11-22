import test from 'node:test';
import assert from 'node:assert/strict';
import { HEADER_SIZE, FLAGS, readHeader, writeHeader } from '../../../etcd/pager/page.js';
import {
  encodeMeta, decodeMeta, fnv1a64, MAGIC, VERSION,
  InvalidFileError, VersionError, ChecksumError,
} from '../../../etcd/pager/meta.js';

// Bytes 0..80 of page 0 of a fresh file made by bbolt v1.5.0, page size 4096 (see docs/key-knowledge/pager.md).
const BBOLT_META0 = Buffer.from(
  '0000000000000000' + '0400' + '0000' + '00000000' +
  'edda0ced' + '02000000' + '00100000' + '00000000' +
  '0300000000000000' + '0000000000000000' +
  '0200000000000000' + '0400000000000000' +
  '0000000000000000' + 'eefd8946116e5107', 'hex');

const FRESH = { pageSize: 4096, flags: 0, root: 3, sequence: 0, freelist: 2, hwm: 4, txid: 0 };

test('page header round trip', () => {
  const buf = Buffer.alloc(64);
  writeHeader(buf, { id: 7, flags: FLAGS.leaf, count: 3, overflow: 2 });
  assert.equal(HEADER_SIZE, 16);
  assert.deepEqual(readHeader(buf), { id: 7, flags: 2, count: 3, overflow: 2 });
  assert.deepEqual([...buf.subarray(0, 16)], [7, 0, 0, 0, 0, 0, 0, 0, 2, 0, 3, 0, 2, 0, 0, 0]);
});

test('encodeMeta matches real bbolt bytes', () => {
  const page = encodeMeta(FRESH, 4096);
  assert.equal(page.length, 4096);
  assert.deepEqual(page.subarray(0, 80), BBOLT_META0);
  assert.ok(page.subarray(80).every((b) => b === 0));
  assert.equal(fnv1a64(page.subarray(16, 72)), 0x07516e114689fdeen);
  assert.equal(MAGIC, 0xed0cdaed);
  assert.equal(VERSION, 2);
});

test('txid picks the header id (slot)', () => {
  assert.equal(readHeader(encodeMeta({ ...FRESH, txid: 1 }, 4096)).id, 1);
  assert.equal(readHeader(encodeMeta({ ...FRESH, txid: 6 }, 4096)).id, 0);
});

test('decodeMeta round trip', () => {
  const m = { ...FRESH, root: 9, sequence: 5, freelist: 8, hwm: 12, txid: 41 };
  assert.deepEqual(decodeMeta(encodeMeta(m, 4096)), m);
  assert.deepEqual(decodeMeta(BBOLT_META0), FRESH);
});

test('decodeMeta rejects bad files', () => {
  const bad = (mutate) => { const b = Buffer.from(BBOLT_META0); mutate(b); return b; };
  assert.throws(() => decodeMeta(bad((b) => b.writeUInt32LE(0x1234, 16))), InvalidFileError);
  assert.throws(() => decodeMeta(bad((b) => b.writeUInt32LE(3, 20))), VersionError);
  assert.throws(() => decodeMeta(bad((b) => { b[40] ^= 1; })), ChecksumError);
  // no-freelist marker (bbolt NoFreelistSync) is unsupported, with a valid checksum
  const nf = encodeMeta(FRESH, 4096);
  nf.writeBigUInt64LE(0xffffffffffffffffn, 48);
  nf.writeBigUInt64LE(fnv1a64(nf.subarray(16, 72)), 72);
  assert.throws(() => decodeMeta(nf), InvalidFileError);
  assert.throws(() => decodeMeta(Buffer.alloc(40)), InvalidFileError);
});
