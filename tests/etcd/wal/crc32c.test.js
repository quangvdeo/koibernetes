import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32c } from '../../../etcd/wal/crc32c.js';

test('crc32c check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
});

test('crc32c of empty input is 0', () => {
  assert.equal(crc32c(Buffer.alloc(0)), 0);
});

test('crc32c chaining equals crc of concatenation', () => {
  const a = Buffer.from('hello ');
  const b = Buffer.from('world');
  assert.equal(crc32c(b, crc32c(a)), crc32c(Buffer.concat([a, b])));
});
