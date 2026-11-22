import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { open } from '../../../etcd/wal/wal.js';
import { repair } from '../../../etcd/wal/repair.js';
import { CorruptError, TornTailError, LOG_NAME, BROKEN_NAME, encode } from '../../../etcd/wal/record.js';
import { tmp, replayAll } from './helpers.js';

const logOf = (dir) => path.join(dir, LOG_NAME);
const texts = (recs) => recs.map((r) => r.payload.toString());

function build(payloads) {
  const dir = tmp();
  const w = open(dir);
  for (const p of payloads) w.append(1, Buffer.from(p));
  w.close();
  return dir;
}

test('torn tail at every offset inside the last record', () => {
  const dir = build(['one', 'two', 'three']);
  const bytes = fs.readFileSync(logOf(dir));
  const end2 = encode(1, Buffer.from('one')).length + encode(1, Buffer.from('two')).length;
  for (let cut = end2; cut < bytes.length; cut++) {
    const d = tmp();
    fs.writeFileSync(logOf(d), bytes.subarray(0, cut));
    const { recs, result } = replayAll(d);
    assert.deepEqual(texts(recs), ['one', 'two'], `cut=${cut}`);
    assert.equal(result.tornTail, cut !== end2, `cut=${cut}`);
    assert.equal(result.goodOffset, end2, `cut=${cut}`);
  }
});

test('mid-file corruption throws CorruptError', () => {
  const dir = build(['one', 'two', 'three']);
  const bytes = fs.readFileSync(logOf(dir));
  bytes[5] ^= 0xff; // first payload byte of record 1
  fs.writeFileSync(logOf(dir), bytes);
  assert.throws(() => replayAll(dir), CorruptError);
});

test('bad crc on the last record is a torn tail', () => {
  const dir = build(['one', 'two', 'three']);
  const bytes = fs.readFileSync(logOf(dir));
  bytes[bytes.length - 5] ^= 0xff; // last payload byte
  fs.writeFileSync(logOf(dir), bytes);
  const { recs, result } = replayAll(dir);
  assert.deepEqual(texts(recs), ['one', 'two']);
  assert.equal(result.tornTail, true);
});

test('huge length field is a torn tail, not an allocation', () => {
  const dir = build(['one']);
  const header = Buffer.alloc(9);
  header.writeUInt32LE(0xffffffff, 0);
  fs.appendFileSync(logOf(dir), header);
  const { recs, result } = replayAll(dir);
  assert.deepEqual(texts(recs), ['one']);
  assert.equal(result.tornTail, true);
  assert.equal(result.goodOffset, encode(1, Buffer.from('one')).length);
});

test('open refuses a file with a torn tail', () => {
  const dir = build(['one', 'two']);
  const bytes = fs.readFileSync(logOf(dir));
  fs.writeFileSync(logOf(dir), bytes.subarray(0, bytes.length - 1));
  assert.throws(() => open(dir), TornTailError);
});

test('repair backs up, truncates, and appends continue', () => {
  const dir = build(['one', 'two', 'three']);
  const bytes = fs.readFileSync(logOf(dir));
  const torn = bytes.subarray(0, bytes.length - 1);
  fs.writeFileSync(logOf(dir), torn);
  repair(dir);
  assert.ok(fs.readFileSync(path.join(dir, BROKEN_NAME)).equals(torn));
  const w = open(dir);
  w.append(1, Buffer.from('four'));
  w.close();
  const { recs, result } = replayAll(dir);
  assert.deepEqual(texts(recs), ['one', 'two', 'four']);
  assert.equal(result.tornTail, false);
});

test('repair is a no-op on a clean or missing log', () => {
  const dir = build(['one']);
  repair(dir);
  assert.equal(fs.existsSync(path.join(dir, BROKEN_NAME)), false);
  assert.doesNotThrow(() => repair(path.join(tmp(), 'nope')));
});
