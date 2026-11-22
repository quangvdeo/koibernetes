// Power-loss tests using FakeFs, which discards everything not fsynced when crash() is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../../../etcd/wal/wal.js';
import { replay } from '../../../etcd/wal/replay.js';
import { repair } from '../../../etcd/wal/repair.js';
import { encode, LOG_NAME, BROKEN_NAME } from '../../../etcd/wal/record.js';
import { FakeFs } from './fake-fs.js';

const DIR = '/wal';
const LOG = `${DIR}/${LOG_NAME}`;

function survivors(fs) {
  const got = [];
  replay(DIR, (type, payload) => got.push(payload.toString()), { fs });
  return got;
}

function appendAll(fs, payloads) {
  const w = open(DIR, { fs });
  for (const p of payloads) w.append(1, Buffer.from(p));
  w.close();
}

test('acknowledged records survive a power cut', () => {
  const fs = new FakeFs();
  appendAll(fs, ['a', 'b', 'c']);
  fs.crash();
  assert.deepEqual(survivors(fs), ['a', 'b', 'c']);
});

test('harness check: a missing file fsync loses acknowledged records', () => {
  const fs = new FakeFs({ ignoreFileFsync: true });
  appendAll(fs, ['a', 'b', 'c']);
  fs.crash();
  assert.deepEqual(survivors(fs), []);
});

test('harness check: a missing directory fsync loses the whole file', () => {
  const fs = new FakeFs({ ignoreDirFsync: true });
  appendAll(fs, ['a', 'b', 'c']);
  fs.crash();
  assert.deepEqual(survivors(fs), []);
});

test('a record is durable the moment append returns, not at close', () => {
  const fs = new FakeFs();
  const w = open(DIR, { fs });
  w.append(1, Buffer.from('a'));
  fs.crash(); // no close()
  assert.deepEqual(survivors(fs), ['a']);
  void w;
});

test('repair makes the backup durable before it cuts the log', () => {
  const fs = new FakeFs();
  const good = Buffer.concat([encode(1, Buffer.from('one')), encode(1, Buffer.from('two'))]);
  const torn = Buffer.concat([good, encode(1, Buffer.from('three')).subarray(0, 6)]);
  fs.seed(LOG, torn);
  fs.ops.length = 0;

  repair(DIR, { fs });
  const i = (op) => fs.ops.indexOf(op);
  const backup = `${DIR}/${BROKEN_NAME}`;
  assert.ok(i(`copy:${backup}`) < i(`fsync:${backup}`), 'backup file is fsynced after it is written');
  assert.ok(i(`copy:${backup}`) < i(`fsync:${DIR}`), 'directory is fsynced after the backup exists');
  assert.ok(i(`fsync:${backup}`) < i(`truncate:${LOG}`), 'backup is fsynced before the cut');
  assert.ok(i(`fsync:${DIR}`) < i(`truncate:${LOG}`), 'directory is fsynced before the cut');

  fs.crash();
  assert.ok(fs.readFileSync(backup).equals(torn), 'backup survives the power cut intact');
  assert.ok(fs.readFileSync(LOG).equals(good), 'the cut itself is durable');
});
