import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeFs, CrashSignal } from '../wal/fake-fs.js';

function fresh() {
  const fs = new FakeFs();
  fs.mkdirSync('/d');
  fsyncDir(fs, '/');
  const fd = fs.openSync('/d/f', 'w+');
  return { fs, fd };
}

test('positional write and read round trip', () => {
  const { fs, fd } = fresh();
  fs.writeSync(fd, Buffer.from('abcd'), 0, 4, 0);
  fs.writeSync(fd, Buffer.from('XY'), 0, 2, 1);
  fs.writeSync(fd, Buffer.from('z'), 0, 1, 6); // past end: zero gap
  const out = Buffer.alloc(7);
  assert.equal(fs.readSync(fd, out, 0, 7, 0), 7);
  assert.deepEqual(out, Buffer.from('aXYd\0\0z'));
  const short = Buffer.alloc(4);
  assert.equal(fs.readSync(fd, short, 0, 4, 5), 2);
});

test('r+ needs an existing file, w+ truncates', () => {
  const { fs, fd } = fresh();
  fs.writeSync(fd, Buffer.from('abc'), 0, 3, 0);
  assert.throws(() => fs.openSync('/d/missing', 'r+'), { code: 'ENOENT' });
  fs.openSync('/d/f', 'w+');
  assert.equal(fs.statSync('/d/f').size, 0);
});

test('crash() keeps only durable bytes', () => {
  const { fs, fd } = fresh();
  fs.writeSync(fd, Buffer.from('aaaa'), 0, 4, 0);
  fs.fsyncSync(fd);
  fsyncDir(fs, '/d');
  fs.writeSync(fd, Buffer.from('bb'), 0, 2, 0);
  fs.crash();
  assert.deepEqual(fs.readFileSync('/d/f'), Buffer.from('aaaa'));
});

test('crash(pick) applies exactly the picked writes, prefixes allowed', () => {
  const { fs, fd } = fresh();
  fs.writeSync(fd, Buffer.from('aaaa'), 0, 4, 0);
  fs.fsyncSync(fd);
  fsyncDir(fs, '/d');
  fs.writeSync(fd, Buffer.from('bb'), 0, 2, 0);
  fs.writeSync(fd, Buffer.from('cc'), 0, 2, 2);
  const pending = fs.pendingWrites('/d/f');
  assert.equal(pending.length, 2);
  fs.crash((p, w) => [{ pos: w[1].pos, data: w[1].data.subarray(0, 1) }]);
  assert.deepEqual(fs.readFileSync('/d/f'), Buffer.from('aaca'));
});

test('crashAtOp throws CrashSignal instead of running the op', () => {
  const { fs, fd } = fresh();
  fs.crashAtOp = 1;
  fs.writeSync(fd, Buffer.from('a'), 0, 1, 0);
  assert.throws(() => fs.writeSync(fd, Buffer.from('b'), 0, 1, 1), CrashSignal);
  assert.equal(fs.statSync('/d/f').size, 1);
});

test('skipFileFsync leaves that fsync without effect', () => {
  const { fs, fd } = fresh();
  fsyncDir(fs, '/d');
  fs.skipFileFsync = (n) => n === 0;
  fs.writeSync(fd, Buffer.from('a'), 0, 1, 0);
  fs.fsyncSync(fd);
  fs.crash();
  assert.equal(fs.readFileSync('/d/f').length, 0);
});

function fsyncDir(fs, d) {
  const fd = fs.openSync(d, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}
