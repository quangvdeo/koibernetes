// Regression tests for the final review's Important findings.
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

test('append rejects a string payload and writes nothing', () => {
  const dir = tmp();
  const w = open(dir);
  assert.throws(() => w.append(1, 'hello'), TypeError);
  w.close();
  assert.equal(replayAll(dir).recs.length, 0);
});

test('an all-zero tail is a torn tail and repair recovers', () => {
  const dir = build(['one', 'two']);
  const size = fs.statSync(logOf(dir)).size;
  fs.appendFileSync(logOf(dir), Buffer.alloc(117));
  const { recs, result } = replayAll(dir);
  assert.deepEqual(texts(recs), ['one', 'two']);
  assert.equal(result.tornTail, true);
  assert.equal(result.goodOffset, size);
  assert.throws(() => open(dir), TornTailError);
  repair(dir);
  open(dir).close();
});

test('a corrupted length mid-file is corruption, never a silent drop', () => {
  const dir = build(['one', 'two', 'three', 'four', 'five']);
  const bytes = fs.readFileSync(logOf(dir));
  bytes[encode(1, Buffer.from('one')).length + 3] = 0x7f; // high byte of record 2's length
  fs.writeFileSync(logOf(dir), bytes);
  assert.throws(() => replayAll(dir), CorruptError);
  assert.throws(() => repair(dir), CorruptError);
  assert.equal(fs.existsSync(path.join(dir, BROKEN_NAME)), false);
});

test('repair returns the dropped byte count and never overwrites a backup', () => {
  const dir = build(['one', 'two', 'three']);
  const cutLast = () => {
    const b = fs.readFileSync(logOf(dir));
    fs.writeFileSync(logOf(dir), b.subarray(0, b.length - 1));
  };
  cutLast();
  assert.equal(repair(dir), encode(1, Buffer.from('three')).length - 1);
  const first = fs.readFileSync(path.join(dir, BROKEN_NAME));
  const w = open(dir);
  w.append(1, Buffer.from('four'));
  w.close();
  cutLast();
  repair(dir);
  assert.ok(fs.readFileSync(path.join(dir, BROKEN_NAME)).equals(first), 'first backup must survive');
  assert.ok(fs.existsSync(path.join(dir, `${BROKEN_NAME}.1`)), 'second backup is numbered');
  assert.equal(repair(dir), 0);
});

test('a failed write truncates the partial record and poisons the wal', () => {
  const dir = tmp();
  const w = open(dir);
  w.append(1, Buffer.from('ok'));
  const realWrite = fs.writeSync;
  let calls = 0;
  fs.writeSync = (fd, buf, off, len) => {
    if (calls++ === 0) return realWrite(fd, buf, off, 5); // partial write
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  };
  try {
    assert.throws(() => w.append(1, Buffer.from('bad')), /ENOSPC/);
  } finally {
    fs.writeSync = realWrite;
  }
  assert.throws(() => w.append(1, Buffer.from('later')), /failed/);
  w.close();
  const { recs, result } = replayAll(dir);
  assert.deepEqual(texts(recs), ['ok']);
  assert.equal(result.tornTail, false);
});

test('open fsyncs the whole new directory chain, and the directory on every open', () => {
  const base = tmp();
  const target = path.join(base, 'a', 'b');
  const inodes = new Set();
  const real = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    inodes.add(fs.fstatSync(fd).ino);
    return real(fd);
  };
  try {
    open(target).close();
    for (const d of [target, path.join(base, 'a'), base]) {
      assert.ok(inodes.has(fs.statSync(d).ino), `${d} not fsynced`);
    }
    inodes.clear();
    open(target).close(); // log and directory already exist
    assert.ok(inodes.has(fs.statSync(target).ino), 'existing dir not fsynced on reopen');
  } finally {
    fs.fsyncSync = real;
  }
});
